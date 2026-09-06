import { PrecheckDecisionRow, precheckDecisionView } from './precheck-decision-view';

function baseRow(overrides: Partial<PrecheckDecisionRow> = {}): PrecheckDecisionRow {
  return {
    precheck_decision_id: 1n,
    work_order_id: 10n,
    equipment_id: 20n,
    decided_at: new Date('2026-09-07T01:00:00.000Z'),
    control_level_code: 'WARN',
    decision_code: 'PASSED',
    basis_inspection_id: null,
    override_reason_code: null,
    worker_no: null,
    created_at: new Date('2026-09-07T01:00:00.000Z'),
    created_by: null,
    ...overrides,
  } as PrecheckDecisionRow;
}

describe('precheckDecisionView', () => {
  it('basisInspectionId·overrideReasonCode·workerNo 가 NULL 이면 키를 생략한다', () => {
    const view = precheckDecisionView(baseRow());
    expect(view).not.toHaveProperty('basisInspectionId');
    expect(view).not.toHaveProperty('overrideReasonCode');
    expect(view).not.toHaveProperty('workerNo');
  });

  it('값이 있으면 그대로 싣는다', () => {
    const view = precheckDecisionView(
      baseRow({
        basis_inspection_id: 30n,
        decision_code: 'OVERRIDDEN',
        override_reason_code: 'EMERGENCY_WORK_ORDER',
        worker_no: '100027',
      }),
    );
    expect(view).toMatchObject({
      basisInspectionId: 30,
      decisionCode: 'OVERRIDDEN',
      overrideReasonCode: 'EMERGENCY_WORK_ORDER',
      workerNo: '100027',
    });
  });

  it('필수 칸을 1:1 로 옮긴다', () => {
    const view = precheckDecisionView(baseRow());
    expect(view).toMatchObject({
      precheckDecisionId: 1,
      workOrderId: 10,
      equipmentId: 20,
      decidedAt: '2026-09-07T01:00:00.000Z',
      controlLevelCode: 'WARN',
      decisionCode: 'PASSED',
    });
  });
});
