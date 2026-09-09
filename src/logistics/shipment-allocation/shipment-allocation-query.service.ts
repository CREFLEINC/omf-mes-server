import { Injectable } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OqcInspectionRow,
  ShipmentInspectionLine,
  oqcPassed as lineOqcPassed,
} from '../shipment-request/shipment-inspection';
import {
  MatchReasonCode,
  ShipmentAllocationMatch,
  ShipmentAllocationRow,
  ShipmentLotAllocationView,
  matchView,
  shipmentLotAllocationView,
} from './shipment-allocation-view';

/** ③a `oqcResults` 와 같은 좁히기 — 판정은 그 함수(`lineOqcPassed`)가 다시 한다. */
const OQC = 'OQC';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

export interface ShipmentAllocationFilters {
  shipmentId?: number;
  shipmentLineId?: number;
  lotId?: number;
  handlingUnitId?: number;
  unpackedOnly?: boolean;
  oqcPassed?: boolean;
  q?: string;
  lotQ?: string;
  page?: number;
  size?: number;
}

export interface ShipmentAllocationListResponse extends PagedResponse<ShipmentLotAllocationView> {
  match?: ShipmentAllocationMatch;
}

export interface BuiltWhere {
  sql: string;
  params: unknown[];
}

const FROM_SQL = `logistics.shipment_lot_allocation a
    JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
    JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
    JOIN mdm.item i ON i.item_id = sl.item_id
    JOIN trace.lot lt ON lt.lot_id = a.lot_id`;

interface QueryRow extends ShipmentAllocationRow {
  shipment_request_line_id: bigint;
}

/** `q` 는 겨냥할 칸이 없다(계약 명시 · R-8) — 다른 필터를 바인딩하지 않고 `FALSE` 하나로 끝낸다. */
export function allocationWhereSql(filters: ShipmentAllocationFilters): BuiltWhere {
  if (filters.q !== undefined) return { sql: 'FALSE', params: [] };
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  const and: string[] = [];
  if (filters.shipmentId !== undefined) and.push(`sl.shipment_id = ${bind(filters.shipmentId)}::bigint`);
  if (filters.shipmentLineId !== undefined) {
    and.push(`a.shipment_line_id = ${bind(filters.shipmentLineId)}::bigint`);
  }
  if (filters.lotId !== undefined) and.push(`a.lot_id = ${bind(filters.lotId)}::bigint`);
  if (filters.handlingUnitId !== undefined) {
    and.push(`a.handling_unit_id = ${bind(filters.handlingUnitId)}::bigint`);
  }
  if (filters.unpackedOnly === true) and.push('a.handling_unit_id IS NULL');
  return { sql: and.length === 0 ? 'TRUE' : and.join('\n      AND '), params };
}

/**
 * `GET /logistics/shipment-lot-allocations` — P-04-01 매칭 스캔 · P-04-02 발행 대상 목록.
 * ⛔ 등록 경로가 없다(계약 명시) — 배분은 출하 처리(I-23)가 만든다.
 */
@Injectable()
export class ShipmentAllocationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ShipmentAllocationFilters): Promise<ShipmentAllocationListResponse> {
    const page = pageRequest(query);
    const where = allocationWhereSql(query);
    // ⛔ `count(*) OVER()` 를 쓰지 않는다 — `oqcPassed` 가 파생 축이라 SQL 만으로 페이지를 못
    //    자른다. 후보 전건을 읽어 TS 에서 거르고 자른다.
    const rows = await this.prisma.$queryRawUnsafe<QueryRow[]>(
      `SELECT a.shipment_lot_allocation_id, a.shipment_line_id, a.lot_id, a.handling_unit_id,
              a.allocated_qty, a.uom_id, sl.shipment_id, sl.item_id, sl.shipment_request_line_id,
              s.warehouse_id, i.item_code, lt.lot_no
         FROM ${FROM_SQL}
        WHERE ${where.sql}
        ORDER BY a.shipment_lot_allocation_id DESC`,
      ...where.params,
    );
    const oqcByLine = await this.oqcPassedByLine(rows.map((row) => row.shipment_request_line_id));
    let views = rows.map((row) =>
      shipmentLotAllocationView(row, oqcByLine.get(String(row.shipment_request_line_id)) ?? true),
    );
    if (query.oqcPassed !== undefined) views = views.filter((view) => view.oqcPassed === query.oqcPassed);
    const paged = views.slice(page.skip, page.skip + page.take);
    const match = await this.matchFor(query.shipmentId, query.lotQ);
    const response: ShipmentAllocationListResponse = pagedResponse(paged, views.length, page);
    if (match !== undefined) response.match = match;
    return response;
  }

  /**
   * `shipment_line → shipment_request_line` 을 타고 ③a 의 `oqcPassed` 를 그대로 부른다(R-10) —
   * LOT 축만으로 내면 헤더 대상 OQC 를 가진 출하에서 「합격인데 라벨을 영원히 못 뽑는」 영구
   * 상태가 된다. ⭐ LOT 모집단은 «후보 행»이 아니라 그 라인에 매달린 배분 «전건»으로 세운다 —
   * 필터가 좁혀도(예: `handlingUnitId`) 같은 배분의 `oqcPassed` 가 필터에 따라 갈리면 안 된다.
   */
  private async oqcPassedByLine(lineIds: bigint[]): Promise<Map<string, boolean>> {
    const ids = [...new Set(lineIds.map(String))].map(BigInt);
    if (ids.length === 0) return new Map();
    const lines = await this.prisma.shipment_request_line.findMany({
      where: { shipment_request_line_id: { in: ids } },
      select: {
        shipment_request_line_id: true,
        shipment_request_id: true,
        shipping_inspection_required: true,
      },
    });
    const allocations = await this.prisma.shipment_lot_allocation.findMany({
      where: { shipment_line: { shipment_request_line_id: { in: ids } } },
      select: { lot_id: true, shipment_line: { select: { shipment_request_line_id: true } } },
    });
    const lotsByLine = new Map<string, Set<string>>();
    for (const row of allocations) {
      const key = String(row.shipment_line.shipment_request_line_id);
      const set = lotsByLine.get(key) ?? new Set<string>();
      set.add(String(row.lot_id));
      lotsByLine.set(key, set);
    }
    const inspections = await this.oqcResults(
      lines.map((line) => line.shipment_request_id),
      [...new Set(allocations.map((row) => row.lot_id))],
    );
    const result = new Map<string, boolean>();
    for (const line of lines) {
      const key = String(line.shipment_request_line_id);
      const inspectionLine: ShipmentInspectionLine = {
        shipmentRequestId: line.shipment_request_id,
        shippingInspectionRequired: line.shipping_inspection_required,
        lotIds: [...(lotsByLine.get(key) ?? new Set<string>())].map((id) => BigInt(id)),
      };
      result.set(key, lineOqcPassed(inspectionLine, inspections));
    }
    return result;
  }

  /** ③a `oqcResults` 와 같은 좁히기(둘째 그물은 `lineOqcPassed` 가 다시 판다). */
  private async oqcResults(shipmentRequestIds: bigint[], lotIds: bigint[]): Promise<OqcInspectionRow[]> {
    const rows = await this.prisma.inspection_result.findMany({
      where: {
        inspection_request: {
          inspection_type_code: OQC,
          OR: [
            { lot_id: { in: lotIds } },
            { target_type_code: LOT, target_id: { in: lotIds } },
            { target_type_code: SHIPMENT_REQUEST, target_id: { in: shipmentRequestIds } },
          ],
        },
      },
      include: { inspection_request: true },
    });
    return rows.map((row) => ({
      inspectionRequestId: row.inspection_request_id,
      inspectionTypeCode: row.inspection_request.inspection_type_code,
      targetTypeCode: row.inspection_request.target_type_code,
      targetId: row.inspection_request.target_id,
      lotId: row.inspection_request.lot_id,
      statusCode: row.status_code,
      inspectionRound: row.inspection_round,
      overallJudgmentCode: row.overall_judgment_code,
    }));
  }

  /** `lotQ` + `shipmentId` 삼분기(§4-4) — `shipmentId` 가 없으면 `match` 자체를 안 만든다(A-13·A-17). */
  private async matchFor(
    shipmentId: number | undefined,
    lotQ: string | undefined,
  ): Promise<ShipmentAllocationMatch | undefined> {
    if (shipmentId === undefined || lotQ === undefined) return undefined;
    const hit = await this.prisma.shipment_lot_allocation.findFirst({
      where: { lot: { lot_no: lotQ }, shipment_line: { shipment_id: BigInt(shipmentId) } },
    });
    if (hit !== null) return matchView(true);
    const lot = await this.prisma.lot.findFirst({ where: { lot_no: lotQ } });
    // ⚠ 스캔값이 어떤 LOT 도 못 찾아도 「배분되지 않았다」가 더 가깝다 — enum 이 품목불일치·
    //   미배정 둘뿐이라 존재 확인 실패를 미배정 쪽으로 접는다.
    const reason: MatchReasonCode = 'LOT_NOT_ALLOCATED';
    if (lot === null) return matchView(false, reason);
    const lines = await this.prisma.shipment_line.findMany({
      where: { shipment_id: BigInt(shipmentId) },
      select: { item_id: true },
    });
    const sameItem = lines.some((line) => line.item_id === lot.item_id);
    return matchView(false, sameItem ? reason : 'LABEL_ITEM_MISMATCH');
  }
}
