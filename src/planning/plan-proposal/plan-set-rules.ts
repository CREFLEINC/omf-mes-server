import { ERROR_CODE, ErrorItem } from '../../common/errors';

/**
 * 확정 본문의 계획 구성 판정 — 키·기존 작성중 계획 선택. 재검증과 확정이 이 한 벌을 쓴다.
 * 한 ERP W/O 는 전부 확정하거나 아무것도 하지 않는다(일부 계획만 확정하는 정책은 없다). 사람은 계획을 나누거나 더할 수 있다.
 */

/** 작성중 계획이 있는 ERP W/O 에서 사람이 고른 것 — 이어서(작성중 계획을 편집 기준으로) · 새로(작성중 계획을 지우고 새 계획으로). */
export type ExistingDraftAction = 'CONTINUE' | 'REPLACE';

export const EXISTING_DRAFT_ACTION_REQUIRED = 'EXISTING_DRAFT_ACTION_REQUIRED';
export const DUPLICATE_PLAN_KEY = 'DUPLICATE_PLAN_KEY';

export interface DraftRef {
  productionPlanId: bigint;
  versionNo: number;
  planNo: string;
}

export interface PlanSetBody {
  existingDraftAction?: ExistingDraftAction | null;
  replacedDrafts?: { productionPlanId: number; versionNo: number }[];
  plans: { proposalPlanKey: string; savedVersionNo?: number | null; splitFromPlanKey?: string | null }[];
}

const draftKeyOf = (productionPlanId: bigint): string => `plan-${String(productionPlanId)}`;
const field = (name: string, code: string, message: string): ErrorItem => ({ scope: 'field', field: name, code, message });

/** 본문 계획의 바탕 — 작성중 계획이 없으면 고를 것이 없어 새 계획이다. */
export function draftActionOf(drafts: readonly DraftRef[], body: PlanSetBody): ExistingDraftAction {
  return drafts.length > 0 && body.existingDraftAction === 'CONTINUE' ? 'CONTINUE' : 'REPLACE';
}

/** 작성중 계획이 있는데 고르지 않았으면 작성중 계획을 건드리지 않고 거부한다 — 묵시적 기본값이 없다. */
export function draftChoiceErrors(drafts: readonly DraftRef[], body: PlanSetBody): ErrorItem[] {
  if (drafts.length === 0) return [];
  const names = drafts.map((draft) => draft.planNo).join(', ');
  if (body.existingDraftAction === undefined || body.existingDraftAction === null) {
    return [field('existingDraftAction', EXISTING_DRAFT_ACTION_REQUIRED, `이 ERP W/O 에 작성중 계획(${names})이 있습니다. 「이어서 한다」와 「새로 한다」 가운데 하나를 고르세요.`)];
  }
  if (body.existingDraftAction === 'REPLACE' && (body.replacedDrafts ?? []).length === 0) {
    return [field('replacedDrafts', ERROR_CODE.REQUIRED, `새로 하려면 지울 작성중 계획(${names})을 id·판으로 적어 보내세요.`)];
  }
  return [];
}

/**
 * 사람이 본 작성중 계획과 지금이 다르다 — 확정은 409 PROPOSAL_CHANGED(basis plans)다. REPLACE 는 지울 계획의 id·판 집합,
 * CONTINUE 는 편집 기준으로 쓴 계획의 판(savedVersionNo)을 견준다.
 */
export function draftsChanged(drafts: readonly DraftRef[], body: PlanSetBody): boolean {
  if (drafts.length === 0) return false;
  const current = new Map(drafts.map((draft) => [draftKeyOf(draft.productionPlanId), draft.versionNo]));
  if (body.existingDraftAction === 'REPLACE') {
    const sent = body.replacedDrafts ?? [];
    return sent.length !== current.size || new Set(sent.map((ref) => ref.productionPlanId)).size !== sent.length
      || sent.some((ref) => current.get(`plan-${ref.productionPlanId}`) !== ref.versionNo);
  }
  return body.plans.some((plan) => {
    const version = current.get(plan.proposalPlanKey);
    return version !== undefined && plan.savedVersionNo !== undefined && plan.savedVersionNo !== null && plan.savedVersionNo !== version;
  });
}

/** 나누기 전 키를 따라가다 자기 자신으로 돌아오는가(new-1 → new-2 → new-1). */
function inSplitCycle(plans: PlanSetBody['plans'], key: string): boolean {
  const parentOf = new Map(plans.map((plan) => [plan.proposalPlanKey, plan.splitFromPlanKey ?? null]));
  const seen = new Set<string>();
  for (let current = parentOf.get(key) ?? null; current !== null; current = parentOf.get(current) ?? null) {
    if (current === key) return true;
    if (seen.has(current)) return false;
    seen.add(current);
  }
  return false;
}

/**
 * 계획 구성 — 키가 겹치지 않고, plan-{id} 는 CONTINUE 일 때 이 ERP W/O 의 작성중 계획만(판 필수), CONTINUE 면 작성중 계획을 하나도 빼지 않고,
 * splitFromPlanKey 는 본문의 다른 계획을 가리킨다. 확정할 제안이 없으면(기준정보 사유) 계획을 받지 않는다.
 */
export function planSetErrors(proposable: boolean, drafts: readonly DraftRef[], action: ExistingDraftAction, body: PlanSetBody): ErrorItem[] {
  if (!proposable) return [field('plans', ERROR_CODE.INVALID, '이 ERP W/O 는 확정할 계획 제안이 없습니다. 제안을 다시 조회하세요.')];
  const errors: ErrorItem[] = [];
  const draftKeys = new Set(drafts.map((draft) => draftKeyOf(draft.productionPlanId)));
  const keys = body.plans.map((plan) => plan.proposalPlanKey);
  body.plans.forEach((plan, index) => {
    const path = `plans[${index}]`;
    const key = plan.proposalPlanKey;
    if (keys.indexOf(key) !== index) errors.push(field(`${path}.proposalPlanKey`, DUPLICATE_PLAN_KEY, `계획 키 ${key} 가 겹칩니다 — 계획마다 다른 키를 쓰세요.`));
    else if (key.startsWith('plan-') && !(action === 'CONTINUE' && draftKeys.has(key))) {
      errors.push(field(`${path}.proposalPlanKey`, ERROR_CODE.INVALID, action === 'CONTINUE' || drafts.length === 0
        ? `${key} 는 이 ERP W/O 의 작성중 계획이 아닙니다 — 확정된 계획이나 다른 ERP W/O 의 계획은 싣지 않습니다. 새 계획은 new-N 키로 보내세요.`
        : `새로 한다면 작성중 계획(${key})을 싣지 않습니다 — 새 계획은 new-N 키로 보내세요.`));
    } else if (key.startsWith('plan-') && (plan.savedVersionNo === undefined || plan.savedVersionNo === null)) {
      errors.push(field(`${path}.savedVersionNo`, ERROR_CODE.REQUIRED, '이어서 하는 작성중 계획은 본 판(savedVersionNo)을 함께 보내야 합니다.'));
    }
    const split = plan.splitFromPlanKey;
    if (split !== undefined && split !== null && (split === key || !keys.includes(split))) {
      errors.push(field(`${path}.splitFromPlanKey`, ERROR_CODE.INVALID, '나누기 전 계획의 키는 본문의 다른 계획 키여야 합니다.'));
    } else if (inSplitCycle(body.plans, key)) {
      errors.push(field(`${path}.splitFromPlanKey`, ERROR_CODE.INVALID, '나누기 전 계획이 서로를 가리킵니다 — 나눈 계획은 원본 하나를 가리켜야 합니다.'));
    }
  });
  if (action === 'CONTINUE') {
    const missing = drafts.filter((draft) => !keys.includes(draftKeyOf(draft.productionPlanId)));
    if (missing.length > 0) {
      errors.push(field('plans', ERROR_CODE.INVALID, `작성중 계획(${missing.map((draft) => draft.planNo).join(', ')})을 빼고 이어서 할 수 없습니다 — 지우려면 「새로 한다」를 고르세요.`));
    }
  }
  return errors;
}
