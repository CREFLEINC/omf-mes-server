import { toApprovalRequest } from './approval.mapper';

type Row = Parameters<typeof toApprovalRequest>[0];

const row = (approvalTypeCode: string, targetTypeCode: string): Row => ({
  approval_request_id: 7n, approval_request_no: 'AP-1', approval_type_code: approvalTypeCode,
  requested_by: 1n, requested_worker_id: null, app_user: { user_name: '관리자' }, requested_worker: null,
  requested_at: new Date('2026-11-19T00:00:00.000Z'), status_code: 'APPROVED', reason: '잘못 나감',
  target_type_code: targetTypeCode, target_id: 5n, target_summary: null, approval_step: [],
}) as unknown as Row;

describe('결재 대상 열기(피처 010 검증 1회차)', () => {
  it('US6-1·Q13 출하 취소 결재의 대상은 W-04-12 로 연다 — 승인된 취소는 그 화면에서 실행한다', () => {
    const view = toApprovalRequest(row('SHIPMENT_CANCEL', 'SHIPMENT'), { currentStepNo: null, isMyTurn: false }, { name: '출하 SH-1' });

    expect(view.target).toMatchObject({ targetTypeCode: 'SHIPMENT', targetId: 5, displayName: '출하 SH-1', openable: true, screenId: 'W-04-12' });
  });

  it('다른 결재 유형은 그대로 열 수 없다(screenId 없음)', () => {
    const view = toApprovalRequest(row('OQC_SKIP', 'SHIPMENT_REQUEST'), { currentStepNo: null, isMyTurn: false });

    expect(view.target.openable).toBe(false);
    expect(view.target).not.toHaveProperty('screenId');
  });
});
