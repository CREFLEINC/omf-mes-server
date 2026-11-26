import { Prisma } from '@prisma/client';

import { ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { LotKey, lotOrder } from '../picking/allocation';
import { PICKABLE_BALANCE } from '../picking/picking-generation';
import { lockPairs, pairKey, plannedLines, sumPlanned } from './planned-stock';
import { PRODUCTION_WAREHOUSE } from './production-warehouse';

/**
 * 출고 요청의 출발 생산 창고(피처 003 · research R-5).
 *
 * ① tx 밖 — 공장 모드·생산창고 집합 D·입고지(라인 생산 현장)를 정하고, 빠진 기준정보를 모아 400 으로 낸다.
 * ② tx 안 — 예정 재고 자물쇠 뒤에 자재마다 D 가운데 가용 재고가 있는 창고(후보)에서 쓸 수 있는 양이 가장 큰
 *    창고를 고른다. 동점은 그 창고 가용 재고의 가장 이른 선출 키(피킹과 같은 키) → 창고 코드. 후보가 없으면
 *    요청에 넣지 않는다(FR-007a). 한 자재는 한 창고에서만 나간다 — 나눠 출고하지 않는다(SC-007).
 */

const FEFO = 'FEFO';

export interface SourceScope {
  warehouseIds: bigint[];
  destinationLocationId: bigint;
}

export interface SourceCandidate {
  warehouseId: bigint;
  warehouseCode: string;
  availableQty: Prisma.Decimal;
  plannedQty: Prisma.Decimal;
  /** 그 창고 가용 재고 가운데 선출 순서가 가장 앞선 LOT. */
  earliest: LotKey;
}

export interface ChosenSource {
  warehouseId: bigint;
  /** 가용 − 예정. 음수면 0 — 새 요청 상한이다(FR-012). */
  freeQty: Prisma.Decimal;
}

export interface SourceChoice {
  chosen: Map<bigint, ChosenSource>;
  /** 후보가 하나도 없는 자재 — 「재고 있는 생산 창고 없음」 부족으로 남긴다. */
  unsourced: bigint[];
}

/**
 * 공장 모드(FR-009a) — 그 공장에 생산창고가 하나라도 있으면(사용 중지 포함) 새 규칙이다.
 * 아니면 이 기능 전 경로를 그대로 탄다(자재 창고에서 즉시 피킹, 대기·예정·분할 없음).
 */
export async function usesProductionWarehouses(db: Prisma.TransactionClient, plantId: bigint): Promise<boolean> {
  const row = await db.warehouse.findFirst({
    where: { plant_id: plantId, warehouse_type_code: PRODUCTION_WAREHOUSE },
    select: { warehouse_id: true },
  });
  return row !== null;
}

/** D 는 «W/O 공장의 활성» 생산창고 전부다 — 라인을 가리지 않는다. 라인은 입고지(생산 현장)만 준다. */
export async function resolveCandidates(
  db: Prisma.TransactionClient,
  input: { plantId: bigint; productionLineId: bigint },
): Promise<SourceScope | { errors: ErrorItem[]; warehouseIds: bigint[] }> {
  const [line, warehouses] = await Promise.all([
    db.production_line.findUnique({
      where: { production_line_id: input.productionLineId },
      select: { default_wip_location_id: true },
    }),
    db.warehouse.findMany({
      where: { plant_id: input.plantId, warehouse_type_code: PRODUCTION_WAREHOUSE },
      select: { warehouse_id: true, is_active: true },
      orderBy: { warehouse_id: 'asc' },
    }),
  ]);
  const errors: ErrorItem[] = [];
  const warehouseIds = warehouses.filter((row) => row.is_active).map((row) => row.warehouse_id);
  if (warehouseIds.length === 0) {
    // 생산창고는 있는데 모두 사용 중지면 고칠 자리가 다르다 — 창고를 다시 쓰거나 다른 창고를 생산창고로 둔다.
    const message =
      warehouses.length === 0
        ? '이 공장에 사용 중인 생산창고가 없습니다. 창고 유형을 생산창고로 둔 창고가 있어야 합니다.'
        : '이 공장의 생산창고가 모두 사용 중지되었습니다. 창고를 다시 쓰거나 다른 창고를 생산창고로 둬야 합니다.';
    errors.push(field('plantId', ERROR_CODE.PRODUCTION_WAREHOUSE_MISSING, message));
  }
  if (line?.default_wip_location_id == null) {
    errors.push(
      field('productionLineId', ERROR_CODE.PRODUCTION_FLOOR_LOCATION_MISSING, '생산라인에 생산 현장 위치를 지정해야 합니다.'),
    );
  }
  if (errors.length > 0 || line?.default_wip_location_id == null) return { errors, warehouseIds };
  return { warehouseIds, destinationLocationId: line.default_wip_location_id };
}

/** 후보 가운데 하나 — 쓸 수 있는 양 → 선출 키 → 창고 코드. 가용이 없는 창고는 후보가 아니다. */
export function pickSource(candidates: readonly SourceCandidate[], fefo: boolean): SourceCandidate | null {
  const pool = candidates.filter((candidate) => candidate.availableQty.gt(0));
  if (pool.length === 0) return null;
  const free = (c: SourceCandidate) => c.availableQty.minus(c.plannedQty);
  return [...pool].sort(
    (a, b) =>
      free(b).comparedTo(free(a)) ||
      lotOrder(a.earliest, b.earliest, fefo) ||
      a.warehouseCode.localeCompare(b.warehouseCode),
  )[0];
}

/** ② — 반드시 트랜잭션 안에서 부른다. 고르기 전에 모든 (후보 창고, 자재) 쌍을 잠근다. */
export async function chooseSources(
  tx: Prisma.TransactionClient,
  input: { warehouseIds: bigint[]; itemIds: bigint[] },
): Promise<SourceChoice> {
  const itemIds = [...new Set(input.itemIds)];
  await lockPairs(
    tx,
    input.warehouseIds.flatMap((warehouseId) => itemIds.map((itemId) => ({ warehouseId, itemId }))),
  );
  const [lines, balances, warehouses, fefoItems] = await Promise.all([
    plannedLines(tx, { warehouseIds: input.warehouseIds, itemIds }),
    tx.inventory_balance.findMany({
      where: { ...PICKABLE_BALANCE, warehouse_id: { in: input.warehouseIds }, item_id: { in: itemIds } },
      select: {
        warehouse_id: true,
        item_id: true,
        lot_id: true,
        location_id: true,
        available_qty: true,
        lot: { select: { expiry_date: true, created_at: true } },
      },
    }),
    tx.warehouse.findMany({
      where: { warehouse_id: { in: input.warehouseIds } },
      select: { warehouse_id: true, warehouse_code: true },
    }),
    tx.item.findMany({ where: { item_id: { in: itemIds }, fifo_policy_code: FEFO }, select: { item_id: true } }),
  ]);
  const codeOf = new Map(warehouses.map((w) => [w.warehouse_id, w.warehouse_code]));
  const fefo = new Set(fefoItems.map((row) => row.item_id));

  const planned = sumPlanned(lines);
  // 가용 합과 가장 이른 LOT 을 같은 잔액 행에서 한 번에 센다 — 피킹이 집을 수 있는 행만이다.
  const available = new Map<string, Prisma.Decimal>();
  const earliest = new Map<string, LotKey>();
  for (const row of balances) {
    if (row.lot_id === null || row.lot === null) continue;
    const key = pairKey(row.warehouse_id, row.item_id);
    available.set(key, (available.get(key) ?? new Prisma.Decimal(0)).plus(row.available_qty ?? 0));
    const lot: LotKey = {
      lotId: row.lot_id,
      locationId: row.location_id,
      expiryDate: row.lot.expiry_date,
      lotCreatedAt: row.lot.created_at,
    };
    const current = earliest.get(key);
    if (current === undefined || lotOrder(lot, current, fefo.has(row.item_id)) < 0) earliest.set(key, lot);
  }

  const chosen = new Map<bigint, ChosenSource>();
  const unsourced: bigint[] = [];
  const zero = new Prisma.Decimal(0);
  for (const itemId of itemIds) {
    const candidates = input.warehouseIds.flatMap((warehouseId): SourceCandidate[] => {
      const key = pairKey(warehouseId, itemId);
      const lot = earliest.get(key);
      return lot === undefined
        ? []
        : [
            {
              warehouseId,
              warehouseCode: codeOf.get(warehouseId) ?? '',
              availableQty: available.get(key) ?? zero,
              plannedQty: planned.get(key) ?? zero,
              earliest: lot,
            },
          ];
    });
    const source = pickSource(candidates, fefo.has(itemId));
    if (source === null) {
      unsourced.push(itemId);
      continue;
    }
    chosen.set(itemId, {
      warehouseId: source.warehouseId,
      freeQty: Prisma.Decimal.max(source.availableQty.minus(source.plannedQty), zero),
    });
  }
  return { chosen, unsourced };
}

/**
 * W-02-10 출발 창고 칸(W/O 상세) — 이 W/O 공장이 새 규칙인가와, 이 공장의 활성 생산창고(코드순).
 * 지금 방식 공장이면 빈 배열이다. 공장 모드는 배포와 같은 판정이다(FR-009a).
 */
export async function productionWarehouseChoices(
  db: Prisma.TransactionClient,
  workOrderId: bigint,
): Promise<{ productionWarehouseMode: boolean; productionWarehouses: { warehouseId: number; warehouseCode: string; warehouseName: string }[] }> {
  const workOrder = await db.work_order.findUnique({
    where: { work_order_id: workOrderId },
    select: { production_plan: { select: { production_order: { select: { plant_id: true } } } } },
  });
  const plantId = workOrder?.production_plan?.production_order.plant_id;
  if (plantId === undefined || !(await usesProductionWarehouses(db, plantId))) {
    return { productionWarehouseMode: false, productionWarehouses: [] };
  }
  const warehouses = await db.warehouse.findMany({
    where: { plant_id: plantId, warehouse_type_code: PRODUCTION_WAREHOUSE, is_active: true },
    select: { warehouse_id: true, warehouse_code: true, warehouse_name: true },
    orderBy: { warehouse_code: 'asc' },
  });
  return {
    productionWarehouseMode: true,
    productionWarehouses: warehouses.map((warehouse) => ({
      warehouseId: Number(warehouse.warehouse_id),
      warehouseCode: warehouse.warehouse_code,
      warehouseName: warehouse.warehouse_name,
    })),
  };
}
