import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { toDateString } from '../../common/master';
import { ExistingDraft, Proposal } from './proposal-builder';

/** 감사 기록의 대상 — 기존 작성중 계획을 대체한 일은 ERP W/O 에 남기고, 확정 요청의 Idempotency-Key 를 correlationId 로 묶는다. */
export const PRODUCTION_ORDER_AUDIT_TARGET = 'PRODUCTION_ORDER';
export const PLAN_DRAFT_REPLACED = 'PLAN_DRAFT_REPLACED';

const SPLIT_CHILD_MESSAGE = '지울 작성중 계획에 분할 계획이 매달려 있습니다. 계획 화면에서 먼저 정리하세요.';

/**
 * 「새로 한다」로 지울 작성중 계획을 다른 계획이 분할 원본으로 가리키면 지우지 못한다(계획 삭제 `remove` 와 같은 규칙) — 그 문장, 아니면 null.
 * 확정은 채번 전 판정에서 409 INVALID_STATE 로, 재검증은 같은 문장으로 errors 에 낸다.
 */
export function splitChildConflict(proposal: Proposal, action: string | null | undefined): string | null {
  if (action !== 'REPLACE') return null;
  const pinned = proposal.drafts.filter((draft) => draft.splitChildIds.length > 0);
  return pinned.length === 0 ? null : `${SPLIT_CHILD_MESSAGE} (${pinned.map(({ row }) => row.plan_no).join(', ')})`;
}

/**
 * 「새로 한다」 — 작성중 계획을 지운다. 호출자가 그 계획들과 ERP W/O 를 잠갔고 판(`draftsChanged`)과 분할 자식(`splitChildConflict`)을 봤다.
 * 분할 자식 검사는 잠금 밖 경합의 마지막 그물이다.
 */
export async function deleteDrafts(tx: Prisma.TransactionClient, drafts: readonly ExistingDraft[]): Promise<void> {
  const ids = drafts.map(({ row }) => row.production_plan_id);
  const children = await tx.production_plan.count({ where: { split_of_plan_id: { in: ids }, production_plan_id: { notIn: ids } } });
  if (children > 0) throw new ConflictException('user', SPLIT_CHILD_MESSAGE, { code: 'INVALID_STATE' });
  await tx.production_plan.deleteMany({ where: { production_plan_id: { in: ids }, status_code: { not: 'CONFIRMED' } } });
}

/**
 * 사람이 기존 작성중 계획을 대체하기로 고른 일을 남긴다 — 확정과 같은 트랜잭션이라 롤백되면 기록도 없다.
 * 저장 규약은 다른 업무 기록(`request-lifecycle.ts`)과 같다 — 유형은 시스템 소유 값(DELETE)이고 사건은 afterValue.eventCode, 내용은 afterValue.detail 이다.
 */
export async function recordDraftsReplaced(
  tx: Prisma.TransactionClient,
  entry: { orderId: bigint; drafts: readonly ExistingDraft[]; newPlanIds: readonly bigint[]; actorId: number | undefined; correlationId: string },
): Promise<void> {
  await tx.audit_event.create({
    data: {
      occurred_at: new Date(),
      target_type_code: PRODUCTION_ORDER_AUDIT_TARGET,
      target_id: entry.orderId,
      event_type_code: 'DELETE',
      performed_by: entry.actorId === undefined ? null : BigInt(entry.actorId),
      correlation_id: entry.correlationId,
      before_value: {
        drafts: entry.drafts.map(({ row }) => ({
          productionPlanId: Number(row.production_plan_id),
          planNo: row.plan_no,
          versionNo: row.version_no,
          planDate: toDateString(row.plan_date),
          plannedQty: row.planned_qty.toNumber(),
        })),
      },
      after_value: { eventCode: PLAN_DRAFT_REPLACED, detail: { newPlanIds: entry.newPlanIds.map(Number) } },
    },
  });
}
