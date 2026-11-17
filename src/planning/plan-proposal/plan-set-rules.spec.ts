import { DraftRef, PlanSetBody, draftActionOf, draftChoiceErrors, draftsChanged, planSetErrors } from './plan-set-rules';

const DRAFTS: DraftRef[] = [
  { productionPlanId: 11n, versionNo: 2, planNo: 'PP-11' },
  { productionPlanId: 12n, versionNo: 1, planNo: 'PP-12' },
];
const plans = (...keys: string[]): PlanSetBody['plans'] => keys.map((key) => ({ proposalPlanKey: key, ...(key.startsWith('plan-') ? { savedVersionNo: key === 'plan-11' ? 2 : 1 } : {}) }));
const fields = (errors: { field?: string; code: string }[]) => errors.map((error) => [error.field, error.code]);

describe('draftChoiceErrors — 작성중 계획이 있으면 사람이 고른다', () => {
  it('작성중 계획이 없으면 고를 것이 없다', () => {
    expect(draftChoiceErrors([], { plans: plans('new-1') })).toEqual([]);
    expect(draftActionOf([], { existingDraftAction: 'CONTINUE', plans: [] })).toBe('REPLACE');
  });

  it('고르지 않으면 EXISTING_DRAFT_ACTION_REQUIRED — 묵시적 기본값이 없다', () => {
    expect(fields(draftChoiceErrors(DRAFTS, { plans: plans('new-1') }))).toEqual([['existingDraftAction', 'EXISTING_DRAFT_ACTION_REQUIRED']]);
    expect(fields(draftChoiceErrors(DRAFTS, { existingDraftAction: null, plans: plans('new-1') }))).toEqual([['existingDraftAction', 'EXISTING_DRAFT_ACTION_REQUIRED']]);
  });

  it('새로 한다면 지울 작성중 계획을 적어야 한다', () => {
    expect(fields(draftChoiceErrors(DRAFTS, { existingDraftAction: 'REPLACE', plans: plans('new-1') }))).toEqual([['replacedDrafts', 'REQUIRED']]);
    expect(draftChoiceErrors(DRAFTS, { existingDraftAction: 'CONTINUE', plans: plans('plan-11', 'plan-12') })).toEqual([]);
  });
});

describe('draftsChanged — 사람이 본 작성중 계획과 지금이 다르면 409', () => {
  const replace = (refs: [number, number][]): PlanSetBody => ({
    existingDraftAction: 'REPLACE',
    replacedDrafts: refs.map(([productionPlanId, versionNo]) => ({ productionPlanId, versionNo })),
    plans: plans('new-1'),
  });

  it('새로 — id·판 집합이 같으면 그대로, 하나라도 다르면 바뀐 것', () => {
    expect(draftsChanged(DRAFTS, replace([[12, 1], [11, 2]]))).toBe(false);
    expect(draftsChanged(DRAFTS, replace([[11, 1], [12, 1]]))).toBe(true);
    expect(draftsChanged(DRAFTS, replace([[11, 2]]))).toBe(true);
    expect(draftsChanged(DRAFTS, replace([[11, 2], [11, 2], [12, 1]]))).toBe(true);
  });

  it('이어서 — 편집 기준으로 쓴 판이 다르면 바뀐 것', () => {
    expect(draftsChanged(DRAFTS, { existingDraftAction: 'CONTINUE', plans: plans('plan-11', 'plan-12') })).toBe(false);
    expect(draftsChanged(DRAFTS, { existingDraftAction: 'CONTINUE', plans: [{ proposalPlanKey: 'plan-11', savedVersionNo: 1 }, ...plans('plan-12')] })).toBe(true);
  });
});

describe('planSetErrors — 계획 구성', () => {
  it('나누고 더한 새 계획은 받는다 — 나누기 전 키는 본문의 다른 계획', () => {
    const body: PlanSetBody = { plans: [{ proposalPlanKey: 'new-1' }, { proposalPlanKey: 'new-2', splitFromPlanKey: 'new-1' }, { proposalPlanKey: 'new-3' }] };
    expect(planSetErrors(true, [], 'REPLACE', body)).toEqual([]);
  });

  it('겹친 키 · 남의 계획 · 잘못된 분할 원본은 칸마다 오류', () => {
    const body: PlanSetBody = { plans: [{ proposalPlanKey: 'new-1' }, { proposalPlanKey: 'new-1' }, { proposalPlanKey: 'plan-99', savedVersionNo: 1 }, { proposalPlanKey: 'new-4', splitFromPlanKey: 'new-9' }] };
    expect(fields(planSetErrors(true, [], 'REPLACE', body))).toEqual([
      ['plans[1].proposalPlanKey', 'DUPLICATE_PLAN_KEY'],
      ['plans[2].proposalPlanKey', 'INVALID'],
      ['plans[3].splitFromPlanKey', 'INVALID'],
    ]);
  });

  it('새로 한다면 작성중 계획을 싣지 않는다', () => {
    expect(fields(planSetErrors(true, DRAFTS, 'REPLACE', { plans: plans('plan-11', 'new-1') }))).toEqual([['plans[0].proposalPlanKey', 'INVALID']]);
  });

  it('이어서 하면 작성중 계획을 빼지 않고 판을 싣는다 — 새 계획을 더할 수 있다', () => {
    expect(planSetErrors(true, DRAFTS, 'CONTINUE', { plans: plans('plan-11', 'plan-12', 'new-1') })).toEqual([]);
    expect(fields(planSetErrors(true, DRAFTS, 'CONTINUE', { plans: plans('plan-11') }))).toEqual([['plans', 'INVALID']]);
    expect(fields(planSetErrors(true, DRAFTS, 'CONTINUE', { plans: [{ proposalPlanKey: 'plan-11' }, ...plans('plan-12')] }))).toEqual([['plans[0].savedVersionNo', 'REQUIRED']]);
  });

  it('나누기 전 키가 서로를 가리키면(순환) 둘 다 INVALID', () => {
    const body: PlanSetBody = { plans: [{ proposalPlanKey: 'new-1', splitFromPlanKey: 'new-2' }, { proposalPlanKey: 'new-2', splitFromPlanKey: 'new-1' }, { proposalPlanKey: 'new-3', splitFromPlanKey: 'new-1' }] };
    expect(fields(planSetErrors(true, [], 'REPLACE', body))).toEqual([['plans[0].splitFromPlanKey', 'INVALID'], ['plans[1].splitFromPlanKey', 'INVALID']]);
  });

  it('확정할 제안이 없으면 계획을 받지 않는다', () => {
    expect(fields(planSetErrors(false, [], 'REPLACE', { plans: plans('new-1') }))).toEqual([['plans', 'INVALID']]);
  });
});
