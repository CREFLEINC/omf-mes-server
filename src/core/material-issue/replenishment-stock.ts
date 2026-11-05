import { Prisma } from '@prisma/client';

import { ACTIVE_REQUEST_STATUSES, availableQty, pairKey, plannedLines, sumPlanned } from './planned-stock';

/**
 * 생산 창고의 보충 판단 값(피처 004 · data-model 「계산 값」). 관리 품목 목록과 자동 보충이 같은 식을 쓴다 — 저장하지 않는다.
 * - 가용: 피킹이 집을 수 있는 잔액(적치 대기 위치 포함)
 * - 출고 예정: 그 생산 창고가 출발지인 활성 요청 줄의 미피킹 양(003)
 * - 쓸 수 있는 양 = 가용 − 출고 예정(음수일 수 있다)
 * - 진행 중 보충: 그 생산 창고로 들어오는 활성·닫히지 않은 창고 보충 요청 줄의 미출고 합
 */

const ZERO = new Prisma.Decimal(0);

export interface ReplenishmentStock {
  availableQty: Prisma.Decimal;
  plannedQty: Prisma.Decimal;
  usableQty: Prisma.Decimal;
  inProgressQty: Prisma.Decimal;
  /** 진행 중 보충 요청 수(요청 단위) — 관리 품목을 지울 때 안내용. */
  inProgressRequestCount: number;
}

/** (생산 창고, 품목) 쌍마다. 질의 수는 쌍 수와 상관없이 셋이다. */
export async function replenishmentStock(
  db: Prisma.TransactionClient,
  pairs: readonly { warehouseId: bigint; itemId: bigint }[],
): Promise<Map<string, ReplenishmentStock>> {
  const result = new Map<string, ReplenishmentStock>();
  if (pairs.length === 0) return result;
  const warehouseIds = [...new Set(pairs.map((p) => p.warehouseId))];
  const itemIds = [...new Set(pairs.map((p) => p.itemId))];
  const [available, planned, incoming] = await Promise.all([
    availableQty(db, warehouseIds, itemIds),
    plannedLines(db, { warehouseIds, itemIds }).then(sumPlanned),
    db.material_issue_request_line.findMany({
      where: {
        item_id: { in: itemIds },
        material_issue_request: {
          request_type_code: 'REPLENISHMENT',
          status_code: { in: ACTIVE_REQUEST_STATUSES },
          closed_at: null,
          location: { warehouse_id: { in: warehouseIds } },
        },
      },
      select: {
        item_id: true,
        requested_qty: true,
        issued_qty: true,
        material_issue_request_id: true,
        material_issue_request: { select: { location: { select: { warehouse_id: true } } } },
      },
    }),
  ]);
  const inProgress = new Map<string, { qty: Prisma.Decimal; requests: Set<bigint> }>();
  for (const line of incoming) {
    const key = pairKey(line.material_issue_request.location.warehouse_id, line.item_id);
    const cur = inProgress.get(key) ?? { qty: ZERO, requests: new Set<bigint>() };
    cur.requests.add(line.material_issue_request_id);
    inProgress.set(key, { qty: cur.qty.plus(Prisma.Decimal.max(line.requested_qty.minus(line.issued_qty), ZERO)), requests: cur.requests });
  }
  for (const { warehouseId, itemId } of pairs) {
    const key = pairKey(warehouseId, itemId);
    const avail = available.get(key) ?? ZERO;
    const plan = planned.get(key) ?? ZERO;
    const incomingPair = inProgress.get(key);
    result.set(key, {
      availableQty: avail,
      plannedQty: plan,
      usableQty: avail.minus(plan),
      inProgressQty: incomingPair?.qty ?? ZERO,
      inProgressRequestCount: incomingPair?.requests.size ?? 0,
    });
  }
  return result;
}
