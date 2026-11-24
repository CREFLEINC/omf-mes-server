import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { inboundLineLotSql, productionRootOf } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LIVE_CONSUMPTION } from '../flow/flow-sql';
import { SHIPMENT_DONE, TraceLotRow, traceLotRows } from './trace-lot-row';

export type TraceDirection = 'FORWARD' | 'BACKWARD';
export type MatchedBy = 'MATERIAL_LOT_NO' | 'INBOUND_LOT_NO' | 'SUPPLIER_LOT_NO' | 'PRODUCT_LOT_NO' | 'SHIPMENT_NO' | 'SERIAL_NO';

export interface TraceStartQuery {
  plantId: number;
  direction: TraceDirection;
  q: string;
}

export interface TraceStartMatch {
  matchedBy: MatchedBy;
  label: string;
  serialNo: string | null;
  otherDirection: boolean;
  truncated: boolean;
  lots: TraceLotRow[];
}

/** 화면 권한 — 정방향은 자재 기준 생산 추적, 역방향은 제품 기준 역추적. 경로 권한은 둘 중 하나라 여기서 방향에 맞는지 다시 본다. */
export const DIRECTION_PERMISSION: Record<TraceDirection, string> = { FORWARD: 'W-02-13', BACKWARD: 'W-02-14' };
/** 한 번호로 줄 수 있는 LOT 수 — 화면 스캔 목록 상한과 같다. */
export const START_LOT_CAP = 200;

interface Found {
  matchedBy: MatchedBy;
  label: string;
  serialNo: string | null;
  lotIds: bigint[];
}

/**
 * 번호 하나를 목록 줄 모양의 LOT 들로 푼다(피처 015 · R-5·R-6). 번호 종류는 서버가 알아내고, 같은 글자가 여러 종류에 맞으면
 * 모두 준다(`matchedBy` 나열 순). 공장 밖 번호는 없는 것과 같다.
 */
@Injectable()
export class TraceStartsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(query: TraceStartQuery, permissions: readonly string[]): Promise<{ matches: TraceStartMatch[] }> {
    if (!permissions.includes(DIRECTION_PERMISSION[query.direction])) {
      throw new ContractException(HttpStatus.FORBIDDEN, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '이 기능을 쓸 권한이 없습니다.' }]);
    }
    const q = query.q.trim();
    if (q === '') return { matches: [] };
    const plant = BigInt(query.plantId);
    const found = query.direction === 'FORWARD'
      ? [await this.byLotNo(plant, q, 'MATERIAL_LOT_NO'), await this.byInboundLot(plant, q), await this.bySupplierLot(plant, q)]
      : [await this.byLotNo(plant, q, 'PRODUCT_LOT_NO'), await this.byShipment(plant, q), await this.bySerial(plant, q)];
    const matches: TraceStartMatch[] = [];
    for (const match of found) {
      if (match === null || match.lotIds.length === 0) continue;
      const shown = match.lotIds.slice(0, START_LOT_CAP);
      matches.push({
        matchedBy: match.matchedBy,
        label: match.label,
        serialNo: match.serialNo,
        otherDirection: await this.otherDirection(match, query.direction),
        truncated: match.lotIds.length > START_LOT_CAP,
        lots: await traceLotRows(this.prisma, shown, query.direction === 'FORWARD' ? 'MATERIAL' : 'PRODUCT'),
      });
    }
    return { matches };
  }

  /**
   * 반대 방향 LOT 인가(FR-016) — 정방향에 생산으로 만들어졌고 다시 투입되지 않은 LOT(완제품·그 분리 자식), 역방향에 생산으로
   * 만들어지지 않은 LOT(자재·분할 자재). 반제품(생산 LOT 이면서 투입됨)은 두 방향 모두 아니다. LOT 번호로 찾은 것만 가린다.
   */
  private async otherDirection(match: Found, direction: TraceDirection): Promise<boolean> {
    if (match.matchedBy !== 'MATERIAL_LOT_NO' && match.matchedBy !== 'PRODUCT_LOT_NO') return false;
    const [lotId] = match.lotIds;
    const produced = (await productionRootOf(this.prisma, [lotId])).get(lotId) !== null;
    if (direction === 'BACKWARD') return !produced;
    if (!produced) return false;
    const [consumed] = await this.prisma.$queryRawUnsafe<{ yes: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM production.material_consumption mc WHERE mc.lot_id = $1::bigint AND ${LIVE_CONSUMPTION}) AS yes`, lotId,
    );
    return !consumed.yes;
  }

  private async byLotNo(plant: bigint, q: string, matchedBy: MatchedBy): Promise<Found | null> {
    const lot = await this.prisma.lot.findUnique({ where: { plant_id_lot_no: { plant_id: plant, lot_no: q } }, select: { lot_id: true, lot_no: true } });
    return lot === null ? null : { matchedBy, label: lot.lot_no, serialNo: null, lotIds: [lot.lot_id] };
  }

  /** 입하 LOT 에 직접 든 관리 LOT — 분할 자손은 입하 LOT 칸이 비어 있어 빠진다(계보가 따라간다). */
  private async byInboundLot(plant: bigint, q: string): Promise<Found | null> {
    const rows = await this.ids(
      `SELECT lt.lot_id FROM trace.inbound_lot il JOIN trace.lot lt ON lt.inbound_lot_id = il.inbound_lot_id
        WHERE il.plant_id = $1::bigint AND il.inbound_lot_no = $2`, plant, q,
    );
    return { matchedBy: 'INBOUND_LOT_NO', label: q, serialNo: null, lotIds: rows };
  }

  /** 공급사 LOT — 005 이후는 `lot_external_identifier`(SUPPLIER_LOT), 그 전은 옛 입하 줄 칸(F-6). */
  private async bySupplierLot(plant: bigint, q: string): Promise<Found | null> {
    const rows = await this.ids(
      `SELECT x.lot_id FROM trace.lot_external_identifier x JOIN trace.lot lt ON lt.lot_id = x.lot_id
        WHERE x.identifier_type_code = 'SUPPLIER_LOT' AND x.external_identifier = $2 AND lt.plant_id = $1::bigint
       UNION
       SELECT lt.lot_id FROM logistics.inbound_receipt_line irl
         JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
         JOIN trace.lot lt ON ${inboundLineLotSql('lt', 'irl')}
        WHERE irl.supplier_lot_no = $2 AND ir.plant_id = $1::bigint AND lt.plant_id = $1::bigint`, plant, q,
    );
    return { matchedBy: 'SUPPLIER_LOT_NO', label: q, serialNo: null, lotIds: rows };
  }

  /** 출하 — 출하 완료분의 배분 LOT. 피킹만 된 출하는 대상이 아니다(R-6). */
  private async byShipment(plant: bigint, q: string): Promise<Found | null> {
    const rows = await this.ids(
      `SELECT a.lot_id FROM logistics.shipment s
         JOIN logistics.shipment_line sl ON sl.shipment_id = s.shipment_id
         JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
         JOIN trace.lot lt ON lt.lot_id = a.lot_id
        WHERE s.shipment_no = $2 AND ${SHIPMENT_DONE('s')} AND lt.plant_id = $1::bigint`, plant, q,
    );
    return { matchedBy: 'SHIPMENT_NO', label: q, serialNo: null, lotIds: rows };
  }

  private async bySerial(plant: bigint, q: string): Promise<Found | null> {
    const serial = await this.prisma.serial_number.findUnique({ where: { serial_no: q }, select: { lot_id: true, serial_no: true, lot: { select: { plant_id: true } } } });
    if (serial === null || serial.lot.plant_id !== plant) return null;
    return { matchedBy: 'SERIAL_NO', label: serial.serial_no, serialNo: serial.serial_no, lotIds: [serial.lot_id] };
  }

  /** 겹치지 않는 LOT id — LOT 번호 순이 아니라 id 순(만든 순서)이다. 상한 + 1 까지만 읽어 넘쳤는지 안다. */
  private async ids(sql: string, plant: bigint, q: string): Promise<bigint[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ lot_id: bigint }[]>(
      `SELECT DISTINCT lot_id FROM (${sql}) m ORDER BY lot_id LIMIT ${START_LOT_CAP + 1}`, plant, q,
    );
    return rows.map((row) => row.lot_id);
  }
}
