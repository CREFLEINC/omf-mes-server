import { Prisma } from '@prisma/client';

import { PICKABLE_BALANCE } from '../picking/picking-generation';

/**
 * 출고 예정 재고(피처 003 · research R-3·R-4). 표를 두지 않고 활성 요청 줄에서 계산한다 — 별도 표는
 * 요청·피킹·출고·취소 경로마다 증감을 맞춰야 하고 어긋나면 「미출고 합 = 예정」(SC-003)이 깨진다.
 *
 * 줄의 예정 = `requested_qty − 그 줄을 가리키는 취소 안 된 피킹 줄의 picked_qty 합`. 집은 양은 이미 잔액의
 * `available_qty` 에서 빠지므로(피킹이 `picked_qty` 를 올리고 출고가 `on_hand` 를 내린다) 빼야 이중 차감이 없다.
 * 출발 창고가 없는 요청(이 기능 전 · 생산 창고 없는 공장)과 닫힌 요청(W/O 취소·마감)은 넣지 않는다.
 */

export const ACTIVE_REQUEST_STATUSES = ['WAITING', 'REGISTERED'];
const PICKING_CANCELLED = 'CANCELLED';
const ZERO = new Prisma.Decimal(0);

export interface PlannedLine {
  warehouseId: bigint;
  itemId: bigint;
  requestId: bigint;
  requestLineId: bigint;
  issueWorkDate: Date | null;
  plannedQty: Prisma.Decimal;
}

export interface LineShortage {
  requestLineId: bigint;
  requestId: bigint;
  shortageQty: Prisma.Decimal;
}

export interface DynamicShortage {
  warehouseId: bigint;
  itemId: bigint;
  availableQty: Prisma.Decimal;
  plannedQty: Prisma.Decimal;
  shortageQty: Prisma.Decimal;
  lines: LineShortage[];
}

/** (창고, 품목) 열쇠 — Map 이 bigint 쌍을 값으로 비교하지 못한다. */
export const pairKey = (warehouseId: bigint, itemId: bigint): string => `${warehouseId}:${itemId}`;

/** 한 줄의 예정. 더 집었으면(초과 피킹) 0 이다 — 음수로 다른 줄의 예정을 깎지 않는다. */
export function openQty(requested: Prisma.Decimal, picked: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.max(requested.minus(picked), ZERO);
}

/**
 * 예정이 가용을 넘은 양(`excess`)을 출고 작업일이 늦은 줄부터 나눈다(FR-018) — 늦은 요청일수록 보충할 시간이
 * 있다. 같은 날이면 나중에 만든 줄부터. 줄마다 그 줄의 예정을 넘지 않는다.
 */
export function distributeShortage(excess: Prisma.Decimal, lines: readonly PlannedLine[]): LineShortage[] {
  const ordered = [...lines].sort(
    (a, b) =>
      (b.issueWorkDate?.getTime() ?? 0) - (a.issueWorkDate?.getTime() ?? 0) ||
      (a.requestLineId < b.requestLineId ? 1 : a.requestLineId > b.requestLineId ? -1 : 0),
  );
  const result: LineShortage[] = [];
  let left = excess;
  for (const line of ordered) {
    if (left.lte(0)) break;
    const take = Prisma.Decimal.min(left, line.plannedQty);
    if (take.lte(0)) continue;
    result.push({ requestLineId: line.requestLineId, requestId: line.requestId, shortageQty: take });
    left = left.minus(take);
  }
  return result;
}

/** 줄 단위 예정. `warehouseIds` 를 비우면 공장의 모든 출발 창고다(`plantId` 필수). */
export async function plannedLines(
  db: Prisma.TransactionClient,
  scope: { warehouseIds?: bigint[]; plantId?: bigint; itemIds?: bigint[] },
): Promise<PlannedLine[]> {
  const rows = await db.material_issue_request_line.findMany({
    where: {
      ...(scope.itemIds === undefined ? {} : { item_id: { in: scope.itemIds } }),
      material_issue_request: {
        status_code: { in: ACTIVE_REQUEST_STATUSES },
        closed_at: null,
        source_warehouse_id: scope.warehouseIds === undefined ? { not: null } : { in: scope.warehouseIds },
        ...(scope.plantId === undefined ? {} : { source_warehouse: { plant_id: scope.plantId } }),
      },
    },
    select: {
      material_issue_request_line_id: true,
      item_id: true,
      requested_qty: true,
      material_issue_request: {
        select: { material_issue_request_id: true, source_warehouse_id: true, issue_work_date: true },
      },
      picking_line: {
        where: { picking_order: { status_code: { not: PICKING_CANCELLED } } },
        select: { picked_qty: true },
      },
    },
  });
  return rows.map((row) => ({
    warehouseId: row.material_issue_request.source_warehouse_id as bigint,
    itemId: row.item_id,
    requestId: row.material_issue_request.material_issue_request_id,
    requestLineId: row.material_issue_request_line_id,
    issueWorkDate: row.material_issue_request.issue_work_date,
    plannedQty: openQty(
      row.requested_qty,
      row.picking_line.reduce((sum, line) => sum.plus(line.picked_qty), ZERO),
    ),
  }));
}

/** (창고, 품목)별 예정 합. */
export function sumPlanned(lines: readonly PlannedLine[]): Map<string, Prisma.Decimal> {
  const sums = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    const key = pairKey(line.warehouseId, line.itemId);
    sums.set(key, (sums.get(key) ?? ZERO).plus(line.plannedQty));
  }
  return sums;
}

/** (창고, 품목)별 가용 합 — 피킹이 집을 수 있는 잔액만(보류·불량 제외)이다. */
export async function availableQty(
  db: Prisma.TransactionClient,
  warehouseIds: bigint[],
  itemIds: bigint[],
): Promise<Map<string, Prisma.Decimal>> {
  const rows = await db.inventory_balance.groupBy({
    by: ['warehouse_id', 'item_id'],
    where: { ...PICKABLE_BALANCE, warehouse_id: { in: warehouseIds }, item_id: { in: itemIds } },
    _sum: { available_qty: true },
  });
  return new Map(rows.map((row) => [pairKey(row.warehouse_id, row.item_id), row._sum.available_qty ?? ZERO]));
}

/** 쓸 수 있는 양 = 가용 − 예정(음수일 수 있다). 출발 창고 선택과 새 요청 상한이 같은 식이다. */
export async function freeQty(
  db: Prisma.TransactionClient,
  warehouseIds: bigint[],
  itemIds: bigint[],
): Promise<{ available: Map<string, Prisma.Decimal>; planned: Map<string, Prisma.Decimal> }> {
  const [available, lines] = await Promise.all([
    availableQty(db, warehouseIds, itemIds),
    plannedLines(db, { warehouseIds, itemIds }),
  ]);
  return { available, planned: sumPlanned(lines) };
}

/**
 * (창고, 품목) 쌍마다 트랜잭션 자물쇠. 같은 재고를 두 요청이 약속하지 않게 한다(SC-004) — 읽고 나서 만드는
 * 사이를 막는다. ⭐ 정렬된 순서로 잡아 교착을 피한다. 트랜잭션이 끝나면 풀린다.
 */
export async function lockPairs(
  tx: Prisma.TransactionClient,
  pairs: readonly { warehouseId: bigint; itemId: bigint }[],
): Promise<void> {
  const keys = [...new Set(pairs.map((pair) => `mir:${pairKey(pair.warehouseId, pair.itemId)}`))].sort();
  if (keys.length === 0) return;
  // 한 문장으로 잡는다 — ORDER BY 가 잡는 순서를 정한다.
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(k, 0))::text
      FROM unnest(${keys}::text[]) AS k ORDER BY k`;
}

/**
 * 동적 부족(FR-014·018) — 예정이 지금 가용을 넘은 (창고, 품목)과 그 초과분을 받는 요청 줄. 저장하지 않는다 —
 * 재고가 움직일 때마다 갱신해야 해서다.
 */
export async function dynamicShortages(
  db: Prisma.TransactionClient,
  scope: { plantId?: bigint; warehouseId?: bigint },
): Promise<DynamicShortage[]> {
  const lines = await plannedLines(db, {
    ...(scope.plantId === undefined ? {} : { plantId: scope.plantId }),
    ...(scope.warehouseId === undefined ? {} : { warehouseIds: [scope.warehouseId] }),
  });
  if (lines.length === 0) return [];
  const planned = sumPlanned(lines);
  const available = await availableQty(
    db,
    [...new Set(lines.map((line) => line.warehouseId))],
    [...new Set(lines.map((line) => line.itemId))],
  );
  const result: DynamicShortage[] = [];
  for (const [key, plannedQty] of planned) {
    const availableQty = available.get(key) ?? ZERO;
    const excess = plannedQty.minus(availableQty);
    if (excess.lte(0)) continue;
    const pairLines = lines.filter((line) => pairKey(line.warehouseId, line.itemId) === key);
    result.push({
      warehouseId: pairLines[0].warehouseId,
      itemId: pairLines[0].itemId,
      availableQty,
      plannedQty,
      shortageQty: excess,
      lines: distributeShortage(excess, pairLines),
    });
  }
  return result;
}
