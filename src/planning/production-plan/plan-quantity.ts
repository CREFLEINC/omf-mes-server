import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/**
 * ERP W/O 의 계획 수량 정의 — 이 파일이 한 곳이다.
 *  - 확정 계획량: 확정 계획 가운데 W/O 가 모두 취소되지 않은 것의 수량 합. 취소는 그 계획에서 전개한 W/O 가 하나 이상이고 전부
 *    CANCELLED 인 경우다(W/O 가 하나도 없으면 취소가 아니다).
 *  - 작성 수량: 작성중 계획 수량 합.
 *  - 잔량: 오더량 − 확정 계획량 − 작성 수량. 초과 계획이 이미 있으면 음수다.
 * ⛔ 정의를 바꾸면 아래 SQL 조각과 순수 함수(`planQuantities`·`sumPlanQty`)를 함께 고친다 — 응답 칸·목록 필터·자동 계획 판정·초과 검사가
 * 전부 이 두 벌을 쓴다. 갈리면 화면의 잔량과 서버가 막는 수량이 달라진다.
 */
export const PLAN_STATUSES = ['UNPLANNED', 'PARTIAL', 'PLANNED'] as const;
/** UNPLANNED 미계획(확정+작성 0) · PARTIAL 부분계획(잔량 남음) · PLANNED 계획완료(잔량 0 이하 — 작성중만으로 채워도 포함). */
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanQtyFact {
  confirmed: boolean;
  /** 확정 계획의 W/O 가 모두 취소됐는가 — `isPlanCancelled`. 작성중 계획은 W/O 가 없어 늘 false. */
  cancelled: boolean;
  plannedQty: Prisma.Decimal;
}

export interface PlanQuantities {
  confirmedQty: Prisma.Decimal;
  draftQty: Prisma.Decimal;
  remainingQty: Prisma.Decimal;
  status: PlanStatus;
}

export function isPlanCancelled(workOrderStatuses: readonly string[]): boolean {
  return workOrderStatuses.length > 0 && workOrderStatuses.every((status) => status === 'CANCELLED');
}

export function sumPlanQty(plans: readonly PlanQtyFact[]): Pick<PlanQuantities, 'confirmedQty' | 'draftQty'> {
  const zero = new Prisma.Decimal(0);
  const total = (selected: readonly PlanQtyFact[]): Prisma.Decimal => selected.reduce((sum, plan) => sum.plus(plan.plannedQty), zero);
  return {
    confirmedQty: total(plans.filter((plan) => plan.confirmed && !plan.cancelled)),
    draftQty: total(plans.filter((plan) => !plan.confirmed)),
  };
}

export function planQuantities(orderQty: Prisma.Decimal, confirmedQty: Prisma.Decimal, draftQty: Prisma.Decimal): PlanQuantities {
  const planned = confirmedQty.plus(draftQty);
  const remainingQty = orderQty.minus(planned);
  const status: PlanStatus = planned.lte(0) ? 'UNPLANNED' : remainingQty.lte(0) ? 'PLANNED' : 'PARTIAL';
  return { confirmedQty, draftQty, remainingQty, status };
}

/** 계획 별칭 `p`. */
const PLAN_CANCELLED_SQL = Prisma.sql`(EXISTS (SELECT 1 FROM production.work_order w WHERE w.production_plan_id = p.production_plan_id)
  AND NOT EXISTS (SELECT 1 FROM production.work_order w WHERE w.production_plan_id = p.production_plan_id AND w.status_code <> 'CANCELLED'))`;

/** 오더 별칭 `o`. */
export const CONFIRMED_PLAN_QTY_SQL = Prisma.sql`COALESCE((SELECT sum(p.planned_qty) FROM planning.production_plan p
   WHERE p.production_order_id = o.production_order_id AND p.status_code = 'CONFIRMED' AND NOT ${PLAN_CANCELLED_SQL}), 0)`;

export const DRAFT_PLAN_QTY_SQL = Prisma.sql`COALESCE((SELECT sum(p.planned_qty) FROM planning.production_plan p
   WHERE p.production_order_id = o.production_order_id AND p.status_code <> 'CONFIRMED'), 0)`;

/** 오더 별칭 `o` — `planQuantities().status` 와 같은 식. */
export const PLAN_STATUS_SQL = Prisma.sql`CASE
  WHEN (${CONFIRMED_PLAN_QTY_SQL}) + (${DRAFT_PLAN_QTY_SQL}) <= 0 THEN 'UNPLANNED'
  WHEN o.order_qty - (${CONFIRMED_PLAN_QTY_SQL}) - (${DRAFT_PLAN_QTY_SQL}) <= 0 THEN 'PLANNED'
  ELSE 'PARTIAL'
END`;

/**
 * 「확정 계획량 + 작성 수량 + 이번 변경분 ≤ 오더량」을 보장한다. ERP W/O 행을 먼저 잠가 같은 오더의 동시 등록·수정·확정이 줄을 선다 —
 * 합계를 읽는 문장은 잠금을 얻은 «뒤»의 별개 문장이라야 앞선 쪽이 커밋한 계획이 보인다.
 * `delta` 는 이번 쓰기가 합계에 더하는 수량이다: 등록은 수량, 수정은 수량 차, 확정은 0(작성 → 확정은 합계를 바꾸지 않는다).
 * `fieldName` 이 없으면 화면 오류다(본문 칸이 없는 확정).
 */
export async function assertWithinOrder(
  tx: Prisma.TransactionClient,
  productionOrderId: bigint,
  delta: Prisma.Decimal,
  fieldName?: string,
): Promise<void> {
  const locked = await tx.$queryRaw<{ order_qty: Prisma.Decimal }[]>`
    SELECT order_qty FROM planning.production_order WHERE production_order_id = ${productionOrderId} FOR UPDATE`;
  if (locked.length === 0) return;
  const sums = await tx.$queryRaw<{ confirmed: Prisma.Decimal; draft: Prisma.Decimal }[]>(Prisma.sql`
    SELECT ${CONFIRMED_PLAN_QTY_SQL} AS confirmed, ${DRAFT_PLAN_QTY_SQL} AS draft
      FROM planning.production_order o WHERE o.production_order_id = ${productionOrderId}`);
  const orderQty = new Prisma.Decimal(locked[0].order_qty);
  const { confirmedQty, draftQty, remainingQty } = planQuantities(orderQty, new Prisma.Decimal(sums[0].confirmed), new Prisma.Decimal(sums[0].draft));
  if (remainingQty.minus(delta).gte(0)) return;

  const message =
    `ERP W/O 수량을 넘는 계획입니다 — ERP W/O ${orderQty.toString()} · 확정 계획 ${confirmedQty.toString()} · 작성 ${draftQty.toString()}` +
    ` · 잔량 ${remainingQty.toString()}. 계획 수량을 줄이세요.`;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    fieldName === undefined
      ? { scope: 'screen', code: ERROR_CODE.PLAN_QTY_EXCEEDS_ORDER, message }
      : { scope: 'field', field: fieldName, code: ERROR_CODE.PLAN_QTY_EXCEEDS_ORDER, message },
  ]);
}
