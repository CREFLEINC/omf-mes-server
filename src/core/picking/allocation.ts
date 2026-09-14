import { Prisma } from '@prisma/client';

/**
 * 자재 출고요청 → 피킹 지시 배정(문의 045 해소 · P-12 · 사용자 결정 2026-09-15). 순수 함수다 —
 * 무엇을 후보로 읽을지(창고 유형·품질·보류)는 `picking-generation.ts` 가 정한다.
 *
 * ⓐ 출발 창고: 품목마다 후보 창고 중 **남은 가용 합이 큰** 창고 하나(동률은 `warehouse_id` 작은
 *   쪽). 다른 창고로 넘쳐 채우지 않는다 — 한 품목은 한 창고에서만 집는다.
 * ⓑ 예약을 걸지 않는다 — 여기서 정한 LOT·위치를 라인에 박을 뿐이다.
 * ⓒ 선출: FIFO = LOT 생성 시각 → `lot_id` → `location_id` 오름차순. FEFO 는 앞에 유효기한
 *   오름차순(기한 없음은 뒤)을 둔다. 한 LOT 으로 모자라면 다음 LOT 으로 라인을 나눈다.
 * ⓓ 결품: 못 채운 양은 라인을 만들지 않고 `shortages` 로만 돌려준다.
 * 같은 품목의 요청 라인이 여럿이면 앞 라인이 쓴 양을 뺀 나머지에서 집는다.
 */

export interface PickingDemand {
  lineNo: number;
  itemId: bigint;
  uomId: bigint;
  qty: Prisma.Decimal;
}

export interface StockCandidate {
  warehouseId: bigint;
  locationId: bigint;
  lotId: bigint;
  itemId: bigint;
  uomId: bigint;
  availableQty: Prisma.Decimal;
  expiryDate: Date | null;
  lotCreatedAt: Date;
}

export interface PickingLineDraft {
  lineNo: number;
  itemId: bigint;
  lotId: bigint;
  locationId: bigint;
  uomId: bigint;
  plannedQty: Prisma.Decimal;
}

export interface PickingOrderDraft {
  warehouseId: bigint;
  lines: PickingLineDraft[];
}

export interface PickingShortage {
  requestLineNo: number;
  itemId: bigint;
  shortQty: Prisma.Decimal;
}

export interface PickingAllocation {
  orders: PickingOrderDraft[];
  shortages: PickingShortage[];
}

type Slot = { candidate: StockCandidate; left: Prisma.Decimal };

export function allocatePicking(
  demands: PickingDemand[],
  candidates: StockCandidate[],
  fefoItemIds: ReadonlySet<bigint>,
): PickingAllocation {
  const slots: Slot[] = candidates.map((candidate) => ({ candidate, left: candidate.availableQty }));
  const linesByWarehouse = new Map<bigint, Omit<PickingLineDraft, 'lineNo'>[]>();
  const shortages: PickingShortage[] = [];

  for (const demand of demands) {
    // 단위가 다르면 수량을 견줄 수 없다 — 환산 규칙이 없어 같은 단위의 재고만 본다.
    const pool = slots.filter(
      ({ candidate }) => candidate.itemId === demand.itemId && candidate.uomId === demand.uomId,
    );
    const warehouseId = sourceWarehouse(pool);
    let need = demand.qty;
    if (warehouseId !== null) {
      const ordered = pool
        .filter(({ candidate }) => candidate.warehouseId === warehouseId)
        .sort((a, b) => lotOrder(a.candidate, b.candidate, fefoItemIds.has(demand.itemId)));
      for (const slot of ordered) {
        if (need.lte(0)) break;
        const take = Prisma.Decimal.min(need, slot.left);
        if (take.lte(0)) continue;
        slot.left = slot.left.minus(take);
        need = need.minus(take);
        const lines = linesByWarehouse.get(warehouseId) ?? [];
        lines.push({
          itemId: demand.itemId,
          lotId: slot.candidate.lotId,
          locationId: slot.candidate.locationId,
          uomId: demand.uomId,
          plannedQty: take,
        });
        linesByWarehouse.set(warehouseId, lines);
      }
    }
    if (need.gt(0)) shortages.push({ requestLineNo: demand.lineNo, itemId: demand.itemId, shortQty: need });
  }

  const orders = [...linesByWarehouse.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([warehouseId, lines]) => ({
      warehouseId,
      lines: lines.map((line, index) => ({ ...line, lineNo: index + 1 })),
    }));
  return { orders, shortages };
}

function sourceWarehouse(pool: Slot[]): bigint | null {
  const sums = new Map<bigint, Prisma.Decimal>();
  for (const { candidate, left } of pool) {
    if (left.lte(0)) continue;
    sums.set(candidate.warehouseId, (sums.get(candidate.warehouseId) ?? new Prisma.Decimal(0)).plus(left));
  }
  let best: [bigint, Prisma.Decimal] | null = null;
  for (const entry of sums) {
    if (best === null || entry[1].gt(best[1]) || (entry[1].eq(best[1]) && entry[0] < best[0])) best = entry;
  }
  return best === null ? null : best[0];
}

function lotOrder(a: StockCandidate, b: StockCandidate, fefo: boolean): number {
  if (fefo) {
    const byExpiry = compareExpiry(a.expiryDate, b.expiryDate);
    if (byExpiry !== 0) return byExpiry;
  }
  return (
    a.lotCreatedAt.getTime() - b.lotCreatedAt.getTime() ||
    compareIds(a.lotId, b.lotId) ||
    compareIds(a.locationId, b.locationId)
  );
}

function compareExpiry(a: Date | null, b: Date | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a.getTime() - b.getTime();
}

function compareIds(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
