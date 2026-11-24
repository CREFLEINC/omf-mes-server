import { Prisma } from '@prisma/client';

import { loadStockUomTable, toStockUom, type StockUomTable } from '../bom/stock-uom';
import { issueMaterialLotBatchWithin, type MaterialLotBatchActor, type MaterialPackageInput } from './lot-registry-batch';
import type { Tx } from './lot-registry.service';

// 자재 관리 LOT 을 P/O 몫만큼 미리 만든다(피처 014 · data-model §4 · R-2·R-3). ⭐ 몫은 (공장·공급사·품목) 합으로 센다 — 입하 마감이 LOT 의
// 라인을 보지 않고 발주일 순으로 배정하므로, 「받은 양에 아직 들어가지 않은 자동 LOT」 합을 같은 차례로 덮고 남는 양만 만든다(FR-020).
export type MaterialLotDefaultsStatus = 'OK' | 'NO_DEFAULT' | 'NO_CONVERSION';

/** LOT 하나의 수량(품목 기본 단위)과 LOT 당 패키징 수량(없으면 패키징 없는 LOT). */
export interface MaterialLotDefaults {
  lotQty: Prisma.Decimal;
  packageCount: number | null;
}

/** 발주일 → P/O 번호 → 라인 번호 차례. 남은 양 = 발주 − 받은 양(0 아래는 0). */
export interface PoPlanLine {
  purchaseOrderLineId: bigint;
  remainingQty: Prisma.Decimal;
}

export interface PlannedLot {
  purchaseOrderLineId: bigint;
  qty: Prisma.Decimal;
  packageCount: number | null;
  qtyPerPackage: Prisma.Decimal | null;
}

const ZERO = new Prisma.Decimal(0);

interface ItemLotDefaults {
  item_id: bigint;
  default_lot_storage_uom_id: bigint | null;
  default_production_lot_size: Prisma.Decimal | null;
  default_package_count: number | null;
}

export function materialLotDefaultsOf(
  item: ItemLotDefaults,
  table: StockUomTable,
): { status: 'OK'; defaults: MaterialLotDefaults } | { status: 'NO_DEFAULT' | 'NO_CONVERSION' } {
  if (item.default_lot_storage_uom_id === null || item.default_production_lot_size === null) return { status: 'NO_DEFAULT' };
  const converted = toStockUom(table, item.item_id, item.default_lot_storage_uom_id, item.default_production_lot_size);
  if (converted.stockQty === null || converted.stockQty.lessThanOrEqualTo(0)) return { status: 'NO_CONVERSION' };
  return { status: 'OK', defaults: { lotQty: converted.stockQty, packageCount: item.default_package_count } };
}

/**
 * 라인마다 기본 크기 LOT 과 나머지 LOT 하나. 패키징이 있으면 나머지는 패키징 크기(크기 ÷ 수)로 올린다(FR-004) — 그 초과분은
 * 덮은 양에 더해 다음 라인 몫에서 빠진다. 그래서 앞쪽 몇 개를 만든 뒤 다시 계산해도 같은 차례의 나머지가 나온다.
 */
export function planMaterialLotShares(
  lines: readonly PoPlanLine[],
  outstandingQty: Prisma.Decimal,
  defaults: MaterialLotDefaults,
): PlannedLot[] {
  const size = defaults.lotQty;
  const packSize = packageSizeOf(defaults);
  const planned: PlannedLot[] = [];
  let covered = outstandingQty;
  for (const line of lines) {
    const take = Prisma.Decimal.min(covered, Prisma.Decimal.max(ZERO, line.remainingQty));
    covered = covered.minus(take);
    const need = Prisma.Decimal.max(ZERO, line.remainingQty).minus(take);
    if (need.lessThanOrEqualTo(0)) continue;
    const full = need.dividedToIntegerBy(size).toNumber();
    for (let i = 0; i < full; i += 1) planned.push(lotOf(line.purchaseOrderLineId, size, defaults.packageCount, packSize));
    const rest = need.minus(size.times(full));
    if (rest.lessThanOrEqualTo(0)) continue;
    if (packSize === null) {
      planned.push(lotOf(line.purchaseOrderLineId, rest, null, null));
      continue;
    }
    const packs = rest.dividedBy(packSize).ceil().toNumber();
    const qty = packSize.times(packs);
    planned.push(lotOf(line.purchaseOrderLineId, qty, packs, packSize));
    covered = covered.plus(qty.minus(rest));
  }
  return planned;
}

/**
 * 봉지당 양 = 기본 단위로 바꾼 LOT 크기 ÷ 패키징 수(6자리 = `qty_per_package` scale).
 * ⚠️ 딱 떨어지지 않으면 알림 없이 **패키징 없는 LOT** 으로 만든다(T049) — `ck_lot_package` 가 「수 × 봉지당 양 = 수량」을 요구해서다.
 * 품목 저장(W-06-05 `assertPackageDefault`)이 환산까지 넣어 이런 기본값을 막으므로, 여기에 오는 것은 그 검사 전에 저장된 옛 데이터이거나
 * 저장 뒤 환산 비율이 바뀐 경우뿐이다. 그때도 생성을 멈추지 않고 작업자가 출력 전 수정(FR-016)으로 패키징을 붙인다.
 */
function packageSizeOf(defaults: MaterialLotDefaults): Prisma.Decimal | null {
  if (defaults.packageCount === null) return null;
  const packSize = defaults.lotQty.dividedBy(defaults.packageCount).toDecimalPlaces(6);
  return packSize.times(defaults.packageCount).equals(defaults.lotQty) ? packSize : null;
}

function lotOf(lineId: bigint, qty: Prisma.Decimal, packageCount: number | null, qtyPerPackage: Prisma.Decimal | null): PlannedLot {
  return { purchaseOrderLineId: lineId, qty, packageCount: qtyPerPackage === null ? null : packageCount, qtyPerPackage };
}

export interface EnsureMaterialLotsInput {
  plantId: number;
  supplierId: number;
  itemId: number;
  upTo: number; // 이번에 만들 수 있는 최대 개수(쪽 단위)
  businessDate: string;
}

export interface EnsureMaterialLotsResult {
  status: MaterialLotDefaultsStatus;
  createdLotIds: bigint[];
  creatableRemaining: number; // 이번에 만든 뒤에도 아직 만들 수 있는 개수
}

/**
 * 잠금(공장·공급사·품목) 안에서 계산하고 `upTo` 개까지 라인 차례로 만든다 — 동시에 골라도 두 번째 요청은 첫 요청이 만든 것을 보고
 * 계산한다(SC-002). 라인마다 묶음 하나(`AUTO`), 나머지 LOT 은 수량이 달라 따로 묶음. 번호 충돌 재시도는 호출자 몫이다.
 */
export async function ensureMaterialLotsWithin(
  tx: Tx,
  input: EnsureMaterialLotsInput,
  actor: MaterialLotBatchActor,
): Promise<EnsureMaterialLotsResult> {
  await lockMaterialLotPlanWithin(tx, input);
  const plan = await planMaterialLotsWithin(tx, input);
  if (plan.status !== 'OK') return { status: plan.status, createdLotIds: [], creatableRemaining: 0 };
  const toMake = plan.lots.slice(0, Math.max(0, input.upTo));
  const createdLotIds: bigint[] = [];
  for (const group of sameLotRuns(toMake)) {
    const { lot } = group;
    const pack: MaterialPackageInput | null = plan.packageUomId === null || lot.packageCount === null || lot.qtyPerPackage === null
      ? null : { uomId: Number(plan.packageUomId), count: lot.packageCount, qtyPerPackage: lot.qtyPerPackage.toNumber() };
    const created = await issueMaterialLotBatchWithin(tx, {
      plantId: input.plantId, supplierId: input.supplierId, itemId: input.itemId, lotQty: lot.qty.toNumber(),
      package: pack, lotCount: group.count, businessDate: input.businessDate,
    }, actor, 'AUTO');
    await tx.material_lot_po_plan.createMany({
      data: created.lotIds.map((lotId) => ({ lot_id: lotId, purchase_order_line_id: lot.purchaseOrderLineId })),
    });
    createdLotIds.push(...created.lotIds);
  }
  return { status: 'OK', createdLotIds, creatableRemaining: plan.lots.length - toMake.length };
}

/** 같은 라인·같은 수량이 이어지면 한 묶음 — 묶음은 수량·패키징이 하나다(`ck_material_lot_batch_package`). */
function sameLotRuns(lots: readonly PlannedLot[]): { lot: PlannedLot; count: number }[] {
  const runs: { lot: PlannedLot; count: number }[] = [];
  for (const lot of lots) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.lot.purchaseOrderLineId === lot.purchaseOrderLineId && last.lot.qty.equals(lot.qty)) last.count += 1;
    else runs.push({ lot, count: 1 });
  }
  return runs;
}

/** (공장·공급사·품목) 트랜잭션 자물쇠 — 같은 트랜잭션이 다시 잡아도 막히지 않아, 호출자가 먼저 잡고 미출력 수를 세도 된다. */
export async function lockMaterialLotPlanWithin(tx: Tx, combo: { plantId: number; supplierId: number; itemId: number }): Promise<void> {
  const key = `material-lot-po-plan:${String(combo.plantId)}:${String(combo.supplierId)}:${String(combo.itemId)}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
}

/** 만들지 않고 계산만 — 목록의 「만들 수 있는 수」도 이것을 쓴다. */
export async function planMaterialLotsWithin(
  tx: Tx,
  input: Pick<EnsureMaterialLotsInput, 'plantId' | 'supplierId' | 'itemId' | 'businessDate'>,
): Promise<{ status: 'OK'; lots: PlannedLot[]; packageUomId: bigint | null } | { status: 'NO_DEFAULT' | 'NO_CONVERSION' }> {
  const item = await tx.item.findUniqueOrThrow({
    where: { item_id: input.itemId },
    select: { item_id: true, base_uom_id: true, default_lot_storage_uom_id: true, default_production_lot_size: true,
      default_package_count: true, default_package_uom_id: true },
  });
  const defaults = materialLotDefaultsOf(item, await loadStockUomTable(tx, [item.item_id], input.businessDate));
  if (defaults.status !== 'OK') return defaults;
  const [lines, outstanding] = await Promise.all([
    tx.purchase_order_line.findMany({
      where: { item_id: item.item_id, uom_id: item.base_uom_id, cancelled_at: null,
        purchase_order: { plant_id: input.plantId, supplier_id: input.supplierId, status_code: { notIn: ['CLOSED', 'CANCELLED'] } } },
      select: { purchase_order_line_id: true, ordered_qty: true, received_qty: true },
      orderBy: [{ purchase_order: { order_date: 'asc' } }, { purchase_order: { purchase_order_no: 'asc' } }, { line_no: 'asc' }],
    }),
    // 받은 양에 아직 들어가지 않은 자동 LOT — 대기(미출력·출력됨), 또는 받았지만 입하 마감 전. 마감되면 `received_qty` 로 넘어간다.
    tx.$queryRaw<{ qty: Prisma.Decimal | null }[]>`
      SELECT sum(l.initial_qty) AS qty
        FROM trace.material_lot_po_plan p
        JOIN trace.lot l ON l.lot_id = p.lot_id
        JOIN logistics.purchase_order_line pol ON pol.purchase_order_line_id = p.purchase_order_line_id
        JOIN logistics.purchase_order po ON po.purchase_order_id = pol.purchase_order_id
        LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = l.inbound_lot_id
       WHERE l.plant_id = ${input.plantId} AND l.item_id = ${input.itemId} AND po.supplier_id = ${input.supplierId}
         AND (l.lifecycle_status_code = 'WAITING' OR (l.lifecycle_status_code = 'ACTIVE' AND il.status_code = 'RECEIVING'))`,
  ]);
  const lots = planMaterialLotShares(
    lines.map((line) => ({ purchaseOrderLineId: line.purchase_order_line_id, remainingQty: line.ordered_qty.minus(line.received_qty) })),
    outstanding[0]?.qty ?? ZERO,
    defaults.defaults,
  );
  return { status: 'OK', lots, packageUomId: item.default_package_uom_id };
}
