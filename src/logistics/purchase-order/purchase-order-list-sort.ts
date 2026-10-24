import { Prisma } from '@prisma/client';

import { localToday } from '../../app/dashboard/dashboard-scope';
import { ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { INBOUND_STAGE_GROUPS, InboundStageGroup } from './inbound-stage';
import { CLOSED_ORDER_STATUSES, orderReceiptSummary } from './purchase-order-receipt';

/**
 * P/O 목록 열 정렬(`sort=열,방향` · 장부 P-116) — 입고 관리 왼쪽 표의 열이다. 쪽 단위 목록이라 화면이 정렬하면 보이는
 * 20건 안에서만 섞이므로 서버가 한다. 같은 값끼리는 늘 `purchase_order_id` 내림차순이다.
 */
export const DB_SORT_KEYS = ['orderDate', 'purchaseOrderNo', 'supplierName', 'expectedReceiptDate'] as const;
/** 조건에 맞는 발주를 모두 읽어 판정한 뒤 정렬하는 열 — `inboundStage` 필터와 같은 방식이라 발주 수만큼 든다. */
export const COMPUTED_SORT_KEYS = ['overdue', 'openLineCount', 'inboundStage'] as const;
export type OrderSortKey = (typeof DB_SORT_KEYS)[number] | (typeof COMPUTED_SORT_KEYS)[number];
export interface OrderSort {
  key: OrderSortKey;
  direction: 'asc' | 'desc';
}

const SORT_KEYS: readonly string[] = [...DB_SORT_KEYS, ...COMPUTED_SORT_KEYS];

/** `열` 또는 `열,방향`(기본 asc). 틀리면 400 `sort` `INVALID` 를 `errors` 에 싣는다. */
export function readSort(raw: Record<string, unknown>, errors: ErrorItem[]): OrderSort | undefined {
  const value = raw.sort;
  if (value === undefined) return undefined;
  const [key, direction = 'asc', extra] = typeof value === 'string' ? value.split(',') : [];
  if (extra === undefined && SORT_KEYS.includes(key) && (direction === 'asc' || direction === 'desc')) {
    return { key: key as OrderSortKey, direction };
  }
  errors.push(field('sort', ERROR_CODE.INVALID, `${SORT_KEYS.join(' · ')} 중 하나에 ,asc 나 ,desc 를 붙입니다.`));
  return undefined;
}

export function isComputedSort(sort: OrderSort | undefined): sort is OrderSort {
  return sort !== undefined && (COMPUTED_SORT_KEYS as readonly string[]).includes(sort.key);
}

const TIE: Prisma.purchase_orderOrderByWithRelationInput = { purchase_order_id: 'desc' };

/** DB 열 정렬 — 정렬이 없으면 지금 순서(발주일 최신 → id). 납기 없는 발주는 방향과 상관없이 맨 뒤다. */
export function orderByOf(sort: OrderSort | undefined): Prisma.purchase_orderOrderByWithRelationInput[] {
  if (sort === undefined) return [{ order_date: 'desc' }, TIE];
  const { direction } = sort;
  switch (sort.key) {
    case 'orderDate':
      return [{ order_date: direction }, TIE];
    case 'purchaseOrderNo':
      return [{ purchase_order_no: direction }, TIE];
    case 'supplierName':
      return [{ partner: { partner_name: direction } }, TIE];
    case 'expectedReceiptDate':
      return [{ expected_receipt_date: { sort: direction, nulls: 'last' } }, TIE];
    default:
      throw new Error(`DB 로 정렬하지 않는 열: ${sort.key}`);
  }
}

export interface SortableOrder {
  purchase_order_id: bigint;
  status_code: string;
  expected_receipt_date: Date | null;
  plant: { timezone_code: string };
  purchase_order_line: Parameters<typeof orderReceiptSummary>[1];
}

/** 상태 순위 — 지연(0) → 정상(1) → 끝남(2). 지연은 `overdueOnly` 와 같다: 남은 발주이고 납기 < 그 공장 현지 오늘. */
function overdueRank(row: SortableOrder, now: Date): number {
  const open =
    !CLOSED_ORDER_STATUSES.includes(row.status_code) && orderReceiptSummary(row.status_code, row.purchase_order_line).openLineCount > 0;
  if (!open) return 2;
  const due = row.expected_receipt_date?.toISOString().slice(0, 10);
  return due !== undefined && due < localToday(now, row.plant.timezone_code) ? 0 : 1;
}

/**
 * 진행 열의 값 — 가장 뒤처진 묶음(흐름 순서 LABEL → … → PUTAWAY)과 그 묶음의 수. 묶음이 없는 발주는 `null`(방향과
 * 상관없이 맨 뒤).
 */
function stageKey(counts: Partial<Record<InboundStageGroup, number>> | undefined): [number, number] | null {
  for (const [index, group] of INBOUND_STAGE_GROUPS.entries()) {
    const count = counts?.[group] ?? 0;
    if (count > 0) return [index, count];
  }
  return null;
}

/** 계산 열 정렬 — 값이 같으면 `purchase_order_id` 내림차순. */
export function sortComputed<T extends SortableOrder>(
  rows: readonly T[],
  sort: OrderSort,
  now: Date,
  stageCounts: Map<bigint, Partial<Record<InboundStageGroup, number>>>,
): T[] {
  const keyOf = (row: T): number[] | null => {
    if (sort.key === 'overdue') return [overdueRank(row, now)];
    if (sort.key === 'openLineCount') return [orderReceiptSummary(row.status_code, row.purchase_order_line).openLineCount];
    return stageKey(stageCounts.get(row.purchase_order_id));
  };
  const sign = sort.direction === 'asc' ? 1 : -1;
  const keyed = rows.map((row) => ({ row, key: keyOf(row) }));
  keyed.sort((left, right) => {
    if (left.key === null || right.key === null) {
      if (left.key !== right.key) return left.key === null ? 1 : -1;
    } else {
      for (let index = 0; index < left.key.length; index += 1) {
        if (left.key[index] !== right.key[index]) return (left.key[index] - right.key[index]) * sign;
      }
    }
    return left.row.purchase_order_id < right.row.purchase_order_id ? 1 : left.row.purchase_order_id > right.row.purchase_order_id ? -1 : 0;
  });
  return keyed.map((entry) => entry.row);
}
