import { DispositionDecisionRendered, DispositionDecisionRow, assertFollowUpInvariant, dispositionDecisionView } from './disposition-view';

/**
 * `disposition-view.ts` 단위 시험 — 매퍼의 널 정책(§1-4-0)과 §2 의 런타임 불변식 대조.
 * ⭐⭐ 불변식 대조는 e2e 로는 못 잠근다(정상 구현이면 SQL 과 함수가 «항상» 같은 값을 낸다 —
 * 갈리는 자리는 코드가 실제로 어긋날 때뿐이다). 여기서 값을 «직접 구성»해 대조 함수가
 * 어긋남을 실제로 잡는지 확인한다.
 */
const BASE_ROW: DispositionDecisionRow = {
  disposition_decision_id: 1,
  nonconformance_id: 10,
  disposition_type_code: 'SCRAP',
  decision_qty: '50.000000',
  uom_id: 100,
  reason: '사유',
  decided_by: 200,
  decided_at: new Date('2026-09-01T00:00:00.000Z'),
  approval_request_id: null,
  nonconformance_no: 'NC-0001',
  item_id: 300,
  item_code: 'IT-1',
  item_name: '품목1',
  decided_by_name: '판정자',
  lot_id: 400,
  lot_no: 'LOT-1',
  posted_qty: '0',
};

describe('dispositionDecisionView', () => {
  it('SCRAP·후속 0 — NOT_STARTED·followUpPending=true(§0 #3)', () => {
    const { view, followUp } = dispositionDecisionView(BASE_ROW);
    expect(view).toMatchObject({ followUpStatusCode: 'NOT_STARTED', followUpQty: 0, decisionQty: 50 });
    expect(followUp).toMatchObject({ followUpPending: true, reinstatable: false });
  });

  it('⭐ 후속 전기 합이 decisionQty 와 «같으면»(한계와 같은 값) COMPLETED·followUpPending=false', () => {
    const { view, followUp } = dispositionDecisionView({ ...BASE_ROW, posted_qty: '50.000000' });
    expect(view).toMatchObject({ followUpStatusCode: 'COMPLETED', followUpQty: 50 });
    expect(followUp.followUpPending).toBe(false);
  });

  it('⭐⭐ R-13 — lotId·lotNo·approvalRequestId 가 null 이면 키를 생략한다(널이 아니다)', () => {
    const { view } = dispositionDecisionView({ ...BASE_ROW, lot_id: null, lot_no: null, approval_request_id: null });
    expect(view).not.toHaveProperty('lotId');
    expect(view).not.toHaveProperty('lotNo');
    expect(view).not.toHaveProperty('approvalRequestId');
  });

  it('approvalRequestId 가 있으면 숫자로 싣는다', () => {
    const { view } = dispositionDecisionView({ ...BASE_ROW, approval_request_id: 900 });
    expect(view.approvalRequestId).toBe(900);
  });

  it('NORMAL 은 reinstatable=true·followUpPending=false(폐기 축이 아니다)', () => {
    const { followUp } = dispositionDecisionView({ ...BASE_ROW, disposition_type_code: 'NORMAL', posted_qty: '0' });
    expect(followUp).toMatchObject({ reinstatable: true, followUpPending: false });
  });
});

describe('assertFollowUpInvariant — §2 런타임 대조', () => {
  const rowOf = (id: number, followUp: DispositionDecisionRendered['followUp']): DispositionDecisionRendered => ({
    view: { ...dispositionDecisionView(BASE_ROW).view, dispositionDecisionId: id },
    followUp,
  });
  const followUp = (overrides: Partial<DispositionDecisionRendered['followUp']> = {}) => ({
    followUpStatusCode: 'PARTIAL' as const,
    followUpQty: 30,
    followUpPending: true,
    reinstatable: false,
    ...overrides,
  });

  it('필터를 안 주면 절대 던지지 않는다', () => {
    expect(() => assertFollowUpInvariant({}, [rowOf(1, followUp({ followUpPending: false }))])).not.toThrow();
  });

  it('SQL 이 고른 followUpPending 값과 행의 판정이 같으면 통과한다', () => {
    expect(() => assertFollowUpInvariant({ followUpPending: true }, [rowOf(1, followUp({ followUpPending: true }))])).not.toThrow();
  });

  it('⭐⭐ SQL 은 followUpPending=true 로 골랐는데 행이 실제로는 false(=COMPLETED) — 던진다', () => {
    // 증상 재현 — 「목록에 떴는데 그 행이 COMPLETED」.
    expect(() => assertFollowUpInvariant({ followUpPending: true }, [rowOf(1, followUp({ followUpPending: false }))])).toThrow(/followUpPending/);
  });

  it('⭐ reinstatable 도 같은 방식으로 대조한다', () => {
    expect(() => assertFollowUpInvariant({ reinstatable: true }, [rowOf(1, followUp({ reinstatable: false }))])).toThrow(/reinstatable/);
  });

  it('⭐⭐ 리뷰 Minor-1 — 여러 행 중 «둘째»만 어긋나도 던진다(첫 행만 보면 못 잡는다)', () => {
    const good = rowOf(1, followUp({ followUpPending: true }));
    const bad = rowOf(2, followUp({ followUpPending: false })); // 표본만 보면(예: rows[0] 만) 이 행을 놓친다
    expect(() => assertFollowUpInvariant({ followUpPending: true }, [good, bad])).toThrow(/#2.*followUpPending/);
  });
});
