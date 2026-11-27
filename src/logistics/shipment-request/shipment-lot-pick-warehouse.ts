import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { LockedBalanceRow, lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { TerminalShipmentScope, lineOutOfScopeReason } from './shipment-request-scope';

/**
 * 줄 출고 창고 피킹(피처 012 R-3 · FR-009·FR-012). 경로의 줄은 품목 힌트일 뿐이고, 스캔한 LOT 의 잔액이 있는 창고로
 * 같은 품목·단말 범위 안 줄을 고른 뒤 그 창고의 잔액만 통째로 잡는다. 창고 없는 옛 줄은 이 길을 타지 않는다(FR-027).
 */

export const WAREHOUSE_PICK_CONFLICT = {
  LOT_NOT_IN_LINE_WAREHOUSE: 'LOT_NOT_IN_LINE_WAREHOUSE',
  LINE_WAREHOUSE_UNAVAILABLE: 'LINE_WAREHOUSE_UNAVAILABLE',
} as const;

/** 고를 수 있는 줄 — 줄 번호 순. `picked`·`allocated` 는 그 줄의 피킹 합과 목표. */
export interface CandidateLine {
  lineId: bigint;
  lineNo: number;
  warehouseId: bigint;
  allocated: Prisma.Decimal;
  picked: Prisma.Decimal;
}

export type LineChoice =
  | { kind: 'LINE'; line: CandidateLine }
  | { kind: 'NOT_IN_LINE_WAREHOUSE' }
  | { kind: 'TARGET_REACHED'; line: CandidateLine };

/**
 * 줄 고르기(빈 곳 ⑤) — ① LOT 이 있는 창고가 지정된 줄을 먼저 찾고(없으면 `NOT_IN_LINE_WAREHOUSE`), ② 그중 남은 수량이 있는
 * 앞 줄을 고른다. 창고 맞는 줄이 모두 목표를 채웠을 때만 `TARGET_REACHED` 다.
 */
export function chooseLine(lines: readonly CandidateLine[], lotWarehouseIds: ReadonlySet<string>): LineChoice {
  const matching = [...lines].sort((a, b) => a.lineNo - b.lineNo).filter((line) => lotWarehouseIds.has(String(line.warehouseId)));
  if (matching.length === 0) return { kind: 'NOT_IN_LINE_WAREHOUSE' };
  const open = matching.find((line) => line.picked.lessThan(line.allocated));
  return open === undefined ? { kind: 'TARGET_REACHED', line: matching[0] } : { kind: 'LINE', line: open };
}

interface LotRow {
  lot_id: bigint;
  item_id: bigint;
  lot_type_code: string;
  status_code: string;
  expiry_date: Date | null;
}

/**
 * 사업부 지시서의 LOT 찾기 — LOT 번호는 공장 안에서만 유일하다. id 면 그대로, 번호면 지시서 사업부 공장들의 LOT 중
 * 단말 공장 것을 먼저 고른다. 다른 공장에 있는 LOT 도 찾아야 「LOT 이 있는 창고」를 알려 줄 수 있다(US2-5).
 */
export async function findBusinessUnitLot(
  tx: Prisma.TransactionClient,
  body: { lotId?: number; lotNo?: string },
  businessUnitId: bigint | null,
  terminalPlantId: bigint | undefined,
): Promise<LotRow> {
  const select = { lot_id: true, item_id: true, lot_type_code: true, status_code: true, plant_id: true, expiry_date: true };
  const lots = body.lotId !== undefined
    ? await tx.lot.findMany({ where: { lot_id: BigInt(body.lotId) }, select })
    : await tx.lot.findMany({ where: { lot_no: (body.lotNo as string).trim(), plant: { business_unit_id: businessUnitId } }, select });
  const lot = lots.find((row) => row.plant_id === terminalPlantId) ?? lots[0];
  if (lot === undefined) throw one(field(body.lotId !== undefined ? 'lotId' : 'lotNo', ERROR_CODE.INVALID, '이 사업부의 LOT 이 아닙니다.'));
  return lot;
}

export interface CandidateLineRow {
  shipment_request_line_id: bigint;
  line_no: number;
  warehouse_id: bigint;
  uom_id: bigint;
  allocated_qty: Prisma.Decimal;
  minimum_remaining_shelf_life_days: number | null;
  warehouse_plant_id: bigint;
  warehouse_active: boolean;
  warehouse_business_unit_id: bigint;
}

/** 같은 지시서·같은 품목의 창고 줄을 줄 id 순으로 잠근다(동시 스캔이 같은 줄을 넘치게 채우지 않게 · 교착 없는 순서). */
export async function lockItemLines(tx: Prisma.TransactionClient, requestId: bigint, itemId: bigint): Promise<CandidateLineRow[]> {
  return tx.$queryRaw<CandidateLineRow[]>`
    SELECT l.shipment_request_line_id, l.line_no, l.warehouse_id, l.uom_id, l.allocated_qty, l.minimum_remaining_shelf_life_days,
           w.plant_id AS warehouse_plant_id, w.is_active AS warehouse_active, w.business_unit_id AS warehouse_business_unit_id
      FROM logistics.shipment_request_line l
      JOIN mdm.warehouse w ON w.warehouse_id = l.warehouse_id
     WHERE l.shipment_request_id = ${requestId} AND l.item_id = ${itemId}
     ORDER BY l.shipment_request_line_id
       FOR UPDATE OF l`;
}

/** 단말 범위 안 줄만 — 세션 호출(단말 없음)은 거르지 않는다. */
export function inTerminalScope(rows: CandidateLineRow[], scope: TerminalShipmentScope | undefined): CandidateLineRow[] {
  if (scope === undefined) return rows;
  return rows.filter((row) => lineOutOfScopeReason(
    { warehouseId: row.warehouse_id, warehousePlantId: row.warehouse_plant_id, requestPlantId: null }, scope,
  ) === null);
}

/** LOT 의 가용 잔액 행 — 보유 > 0 이고 불량창고가 아닌 것(모든 공장). 잠금은 코어 순서(`inventory_balance_id`)다. */
export async function lockLotBalances(tx: Prisma.TransactionClient, lot: LotRow): Promise<LockedBalanceRow[]> {
  const locked = (await lockBalancesByItemLot(tx, lot.item_id, lot.lot_id)).filter((row) => new Prisma.Decimal(row.on_hand_qty).greaterThan(0));
  if (locked.length === 0) return [];
  const defect = new Set((await tx.warehouse.findMany({
    where: { warehouse_id: { in: [...new Set(locked.map((row) => row.warehouseId))] }, is_defect: true }, select: { warehouse_id: true },
  })).map((row) => String(row.warehouse_id)));
  return locked.filter((row) => !defect.has(String(row.warehouseId)));
}

/** 409 `LOT_NOT_IN_LINE_WAREHOUSE` — LOT 이 있는 창고(공장)를 싣는다(PDA 「LOT 이 있는 창고: …」). */
export async function notInLineWarehouse(tx: Prisma.TransactionClient, rows: LockedBalanceRow[]): Promise<ConflictException> {
  const warehouses = await tx.warehouse.findMany({
    where: { warehouse_id: { in: [...new Set(rows.map((row) => row.warehouseId))] } },
    select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant: { select: { plant_id: true, plant_name: true } } },
    orderBy: { warehouse_id: 'asc' },
  });
  const names = warehouses.map((row) => `${row.warehouse_name}(${row.plant.plant_name})`).join(', ');
  return new ConflictException('user', `이 지시서의 출고 창고에 없는 LOT 입니다. LOT 이 있는 창고: ${names || '없음'}`, {
    code: WAREHOUSE_PICK_CONFLICT.LOT_NOT_IN_LINE_WAREHOUSE,
    warehouses: warehouses.map((row) => ({
      warehouseId: Number(row.warehouse_id), warehouseCode: row.warehouse_code, warehouseName: row.warehouse_name,
      plantId: Number(row.plant.plant_id), plantName: row.plant.plant_name,
    })),
  });
}
