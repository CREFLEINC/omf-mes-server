import { Prisma } from '@prisma/client';

import { PUTAWAY_STAGING, WAREHOUSE_WHOLE } from '../../common/master/system-location';
import { PRODUCTION_LOT_TYPE, WIP_LOT_TYPE } from '../../core/lot';

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** 분리 거절 사유 — 409 `ShipmentConflictResponse.code` 와 스캔 조회 `blocked.code`(research R-8). */
export const SPLIT_BLOCK = {
  NOT_PRODUCTION_LOT: 'NOT_PRODUCTION_LOT',
  /** 공정 반제품 LOT — 생산 LOT 이 아니지만 사유를 따로 알린다(피처 016). */
  SEMI_FINISHED_LOT: 'SEMI_FINISHED_LOT',
  SPLIT_SERIAL_LOT: 'SPLIT_SERIAL_LOT',
  INVALID_STATE: 'INVALID_STATE',
  LOT_SPLIT_UNCONFIRMED: 'LOT_SPLIT_UNCONFIRMED',
  LOT_ALREADY_RESERVED: 'LOT_ALREADY_RESERVED',
  PUTAWAY_PENDING: 'PUTAWAY_PENDING',
  NOT_PRODUCT_WAREHOUSE: 'NOT_PRODUCT_WAREHOUSE',
  MIXED_STOCK_STATUS: 'MIXED_STOCK_STATUS',
} as const;

export interface SplitBlock {
  code: string;
  /** 화면 문구에 쓸 값 — 상태 코드·확인 대기 분리 시각·잡은 지시서 번호. 없으면 null. */
  detail: string | null;
}

export interface SplitLotFacts {
  lot_id: bigint;
  lot_no: string;
  lot_type_code: string;
  item_id: bigint;
  item_code: string;
  item_name: string;
  serial_control_type_code: string;
  uom_id: bigint;
  uom_code: string;
  decimal_scale: number;
  status_code: string;
  lifecycle_status_code: string | null;
  source_type_code: string;
  open_hold: string | null;
  unconfirmed_split_at: Date | null;
  busy: boolean;
  picked_request_no: string | null;
}

export interface SplitLocationFacts {
  location_id: bigint;
  location_code: string;
  system_role_code: string | null;
  warehouse_id: bigint;
  warehouse_code: string;
  warehouse_type_code: string;
  is_defect: boolean;
  on_hand: Prisma.Decimal;
  kinds: number;
  open_putaway: boolean;
}

/** 공장 안 LOT 하나 — 번호 또는 id. 없으면 undefined. 보류·확인 대기 분리·잡힌 잔액을 함께 읽는다. */
export async function loadSplitLotFacts(db: Db, plantId: bigint, by: { lotId: bigint } | { lotNo: string }): Promise<SplitLotFacts | undefined> {
  const where = 'lotId' in by ? Prisma.sql`l.lot_id = ${by.lotId}` : Prisma.sql`l.lot_no = ${by.lotNo}`;
  const [row] = await db.$queryRaw<SplitLotFacts[]>`
    SELECT l.lot_id, l.lot_no, l.lot_type_code, l.item_id, i.item_code, i.item_name, i.serial_control_type_code,
           l.uom_id, u.uom_code, u.decimal_scale::int AS decimal_scale, l.status_code, l.lifecycle_status_code, l.source_type_code,
           (SELECT h.reason_code FROM trace.lot_hold h WHERE h.lot_id = l.lot_id AND h.released_at IS NULL LIMIT 1) AS open_hold,
           (SELECT s.split_at FROM trace.product_lot_split s
             WHERE (s.parent_lot_id = l.lot_id OR s.child_lot_id = l.lot_id) AND s.confirmed_at IS NULL
             ORDER BY s.split_at LIMIT 1) AS unconfirmed_split_at,
           EXISTS (SELECT 1 FROM inventory.inventory_balance b
                    WHERE b.lot_id = l.lot_id AND (b.reserved_qty > 0 OR b.picked_qty > 0 OR b.blocked_qty > 0)) AS busy,
           (SELECT r.shipment_request_no FROM logistics.shipment_request_lot p
              JOIN logistics.shipment_request_line ln ON ln.shipment_request_line_id = p.shipment_request_line_id
              JOIN logistics.shipment_request r ON r.shipment_request_id = ln.shipment_request_id
             WHERE p.lot_id = l.lot_id AND p.status_code = 'PICKED' LIMIT 1) AS picked_request_no
      FROM trace.lot l
      JOIN mdm.item i ON i.item_id = l.item_id
      JOIN mdm.uom u ON u.uom_id = l.uom_id
     WHERE l.plant_id = ${plantId} AND ${where}`;
  return row;
}

/** LOT 의 공장 안 보유 위치(보유 > 0) — 위치마다 보유 합·차원 종류 수·그 자리에서 출발하는 열린 적치 지시. */
export async function loadSplitLocations(db: Db, plantId: bigint, lotId: bigint): Promise<SplitLocationFacts[]> {
  return db.$queryRaw<SplitLocationFacts[]>`
    SELECT b.location_id, loc.location_code, loc.system_role_code, w.warehouse_id, w.warehouse_code, w.warehouse_type_code, w.is_defect,
           SUM(b.on_hand_qty) AS on_hand,
           COUNT(DISTINCT (b.quality_status_code, b.inventory_status_code, b.ownership_type_code, COALESCE(b.owner_partner_id, 0)))::int AS kinds,
           EXISTS (SELECT 1 FROM logistics.putaway_task t
                    WHERE t.lot_id = b.lot_id AND t.from_location_id = b.location_id AND t.status_code = 'PENDING') AS open_putaway
      FROM inventory.inventory_balance b
      JOIN mdm.location loc ON loc.location_id = b.location_id
      JOIN mdm.warehouse w ON w.warehouse_id = b.warehouse_id
     WHERE b.lot_id = ${lotId} AND b.plant_id = ${plantId} AND b.on_hand_qty > 0
     GROUP BY b.lot_id, b.location_id, loc.location_code, loc.system_role_code, w.warehouse_id, w.warehouse_code, w.warehouse_type_code, w.is_defect
     ORDER BY loc.location_code`;
}

/** LOT 단위 막힘(R-8 ①~⑤) — 첫 번째 사유 하나. */
export function lotBlocked(lot: SplitLotFacts): SplitBlock | null {
  if (lot.lot_type_code === WIP_LOT_TYPE) return { code: SPLIT_BLOCK.SEMI_FINISHED_LOT, detail: lot.lot_type_code };
  if (lot.lot_type_code !== PRODUCTION_LOT_TYPE) return { code: SPLIT_BLOCK.NOT_PRODUCTION_LOT, detail: lot.lot_type_code };
  if (lot.serial_control_type_code !== 'NONE') return { code: SPLIT_BLOCK.SPLIT_SERIAL_LOT, detail: lot.serial_control_type_code };
  if (lot.status_code === 'DEFECTIVE' || lot.status_code === 'SCRAPPED') return { code: SPLIT_BLOCK.INVALID_STATE, detail: lot.status_code };
  if (lot.lifecycle_status_code === 'VOIDED') return { code: SPLIT_BLOCK.INVALID_STATE, detail: 'VOIDED' };
  if (lot.open_hold !== null) return { code: SPLIT_BLOCK.INVALID_STATE, detail: 'HOLD' };
  if (lot.unconfirmed_split_at !== null) {
    return { code: SPLIT_BLOCK.LOT_SPLIT_UNCONFIRMED, detail: lot.unconfirmed_split_at.toISOString() };
  }
  if (lot.busy) return { code: SPLIT_BLOCK.LOT_ALREADY_RESERVED, detail: lot.picked_request_no };
  return null;
}

/** 위치 단위 막힘(R-8 ⑥~⑧). 불량 창고·전체 위치·제품 창고 밖은 같은 사유다. */
export function locationBlocked(location: SplitLocationFacts): SplitBlock | null {
  if (location.system_role_code === PUTAWAY_STAGING || location.open_putaway) return { code: SPLIT_BLOCK.PUTAWAY_PENDING, detail: null };
  if (location.warehouse_type_code !== 'PRODUCT' || location.is_defect || location.system_role_code === WAREHOUSE_WHOLE) {
    return { code: SPLIT_BLOCK.NOT_PRODUCT_WAREHOUSE, detail: null };
  }
  if (location.kinds > 1) return { code: SPLIT_BLOCK.MIXED_STOCK_STATUS, detail: null };
  return null;
}

/** ⑨ 0 < 수량 < 그 위치 보유, 단위 소수 자리 안 — 어기면 메시지(400 RANGE), 맞으면 null. */
export function qtyViolation(qty: Prisma.Decimal, onHand: Prisma.Decimal, decimalScale: number): string | null {
  if (!qty.isFinite() || qty.lte(0)) return '분리 수량은 0보다 커야 합니다.';
  if (qty.gte(onHand)) return `분리 수량은 그 위치 재고(${onHand.toString()})보다 작아야 합니다.`;
  if (qty.decimalPlaces() > decimalScale) return decimalScale === 0 ? '이 단위는 정수만 받습니다.' : `소수 ${decimalScale}자리까지 받습니다.`;
  return null;
}
