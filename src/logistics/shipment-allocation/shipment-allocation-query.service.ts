import { Injectable, NotFoundException } from '@nestjs/common';

import { PagedResponse, PageRequest, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { oqcPassedByLine } from '../shipment-request/shipment-oqc';
import {
  MatchReasonCode,
  ShipmentAllocationMatch,
  ShipmentAllocationRow,
  ShipmentLotAllocationView,
  matchView,
  shipmentLotAllocationView,
} from './shipment-allocation-view';

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

const SELECT_SQL = `SELECT a.shipment_lot_allocation_id, a.shipment_line_id, a.lot_id, a.handling_unit_id,
              a.allocated_qty, a.uom_id, sl.shipment_id, sl.item_id, sl.shipment_request_line_id,
              s.warehouse_id, i.item_code, lt.lot_no
         FROM ${FROM_SQL}`;

interface QueryRow extends ShipmentAllocationRow {
  shipment_request_line_id: bigint;
}

/**
 * `q` 는 겨냥할 칸이 없다(계약 명시 · R-8) — 다른 필터를 바인딩하지 않고 `FALSE` 하나로 끝낸다.
 * `q=''`(빈 문자열)도 마찬가지다 — 값과 무관하게 항상 빈 목록이다.
 */
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
    // ⭐ `oqcPassed` 를 준 요청만 SQL 로 못 자른다(파생 축이라) — 그때만 후보 전건을 읽어 TS 에서
    //   거르고 자른다. 준 게 없으면(대부분) SQL `LIMIT/OFFSET` + 별도 `count(*)` 를 그대로 쓴다.
    //   ⛔ `count(*) OVER ()` 는 쓰지 않는다 — 범위 밖 쪽에서 `total` 이 0 으로 접힌다(PR ④ 선례).
    const { rows, total: sqlTotal } =
      query.oqcPassed === undefined ? await this.fetchPage(where, page) : { rows: await this.fetchAll(where), total: 0 };
    const oqcByLine = await oqcPassedByLine(this.prisma, rows.map((row) => row.shipment_request_line_id));
    let views = rows.map((row) =>
      shipmentLotAllocationView(row, oqcByLine.get(String(row.shipment_request_line_id)) ?? false),
    );
    let total = sqlTotal;
    if (query.oqcPassed !== undefined) {
      views = views.filter((view) => view.oqcPassed === query.oqcPassed);
      total = views.length;
      views = views.slice(page.skip, page.skip + page.take);
    }
    const match = await this.matchFor(query.shipmentId, query.lotQ);
    const response: ShipmentAllocationListResponse = pagedResponse(views, total, page);
    if (match !== undefined) response.match = match;
    return response;
  }

  /**
   * ⑦b 의 되읽기 — 목록과 «같은» SELECT · 같은 `oqcPassed` 함수 · 같은 뷰를 탄다(§3-3 ⑨).
   * ⛔ 쓰기 쪽에서 다시 세우지 마라 — `oqcPassed` 의 LOT 모집단이 «예약 축»이라(Major-1) 두 벌을
   * 만들면 「목록이 판정한 것」과 「연결 응답이 말하는 것」이 갈린다.
   * ⚠ 오늘은 ⑦b 가 이미 잠그고 404 로 판정한 뒤라 0행이 «도달 불가»지만, **I-23 이 배분 삭제
   *   경로를 만든다** — 그때 잠금과 되읽기 사이가 벌어지면 `row` 가 `undefined` 다.
   */
  async get(shipmentLotAllocationId: number): Promise<ShipmentLotAllocationView> {
    const [row] = await this.prisma.$queryRawUnsafe<QueryRow[]>(
      `${SELECT_SQL} WHERE a.shipment_lot_allocation_id = $1::bigint`,
      shipmentLotAllocationId,
    );
    if (row === undefined) throw new NotFoundException('없는 출하 LOT 배분입니다.');
    const oqcByLine = await oqcPassedByLine(this.prisma, [row.shipment_request_line_id]);
    return shipmentLotAllocationView(row, oqcByLine.get(String(row.shipment_request_line_id)) ?? false);
  }

  private async fetchPage(where: BuiltWhere, page: PageRequest): Promise<{ rows: QueryRow[]; total: number }> {
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRawUnsafe<QueryRow[]>(
        `${SELECT_SQL}
        WHERE ${where.sql}
        ORDER BY a.shipment_lot_allocation_id DESC
        LIMIT ${page.take} OFFSET ${page.skip}`,
        ...where.params,
      ),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(
        `SELECT count(*)::int AS total FROM ${FROM_SQL} WHERE ${where.sql}`,
        ...where.params,
      ),
    ]);
    return { rows, total: counted[0].total };
  }

  private async fetchAll(where: BuiltWhere): Promise<QueryRow[]> {
    return this.prisma.$queryRawUnsafe<QueryRow[]>(
      `${SELECT_SQL}
        WHERE ${where.sql}
        ORDER BY a.shipment_lot_allocation_id DESC`,
      ...where.params,
    );
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
    const reason: MatchReasonCode = 'LOT_NOT_ALLOCATED';
    // ⚠ `lot_no` 는 저장소 전체가 아니라 «공장» 단위로만 유일하다(`uq_lot`: `plant_id`+`lot_no`) —
    //   공장을 안 좁히면 다공장에서 동명 LOT 이 임의로 잡혀 사유가 뒤집힌다.
    const shipment = await this.prisma.shipment.findUnique({
      where: { shipment_id: BigInt(shipmentId) },
      select: { warehouse: { select: { plant_id: true } } },
    });
    const lot =
      shipment === null
        ? null
        : await this.prisma.lot.findFirst({ where: { lot_no: lotQ, plant_id: shipment.warehouse.plant_id } });
    // ⚠ 스캔값이 어떤 LOT 도 못 찾아도 「배분되지 않았다」가 더 가깝다 — enum 이 품목불일치·
    //   미배정 둘뿐이라 존재 확인 실패를 미배정 쪽으로 접는다.
    if (lot === null) return matchView(false, reason);
    const lines = await this.prisma.shipment_line.findMany({
      where: { shipment_id: BigInt(shipmentId) },
      select: { item_id: true },
    });
    const sameItem = lines.some((line) => line.item_id === lot.item_id);
    return matchView(false, sameItem ? reason : 'LABEL_ITEM_MISMATCH');
  }
}
