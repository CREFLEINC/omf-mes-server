import { toApprovalRequest } from './approval.mapper';

type Row = Parameters<typeof toApprovalRequest>[0];

const row = (approvalTypeCode: string, targetTypeCode: string): Row => ({
  approval_request_id: 7n, approval_request_no: 'AP-1', approval_type_code: approvalTypeCode,
  requested_by: 1n, requested_worker_id: null, app_user: { user_name: '관리자' }, requested_worker: null,
  requested_at: new Date('2026-11-19T00:00:00.000Z'), status_code: 'APPROVED', reason: '잘못 나감',
  target_type_code: targetTypeCode, target_id: 5n, target_summary: null, approval_step: [],
}) as unknown as Row;

describe('결재 대상 열기(피처 010 검증 1회차)', () => {
  it('US4-4·D-10 출하 취소 결재의 대상은 W-04-02 로 연다 — 승인된 취소는 그 지시서 상세 「출하」 칸에서 실행한다(피처 012)', () => {
    const view = toApprovalRequest(row('SHIPMENT_CANCEL', 'SHIPMENT'), { currentStepNo: null, isMyTurn: false }, { name: '출하 SH-1' });

    expect(view.target).toMatchObject({ targetTypeCode: 'SHIPMENT', targetId: 5, displayName: '출하 SH-1', openable: true, screenId: 'W-04-02' });
  });

  it('E-5 배포 전에 상신한 출하 취소 결재(진행 중이든 끝났든)도 W-04-02 로 연다 — 저장값이 아니라 응답 매핑이다', () => {
    for (const status of ['PENDING', 'APPROVED', 'REJECTED']) {
      const view = toApprovalRequest({ ...row('SHIPMENT_CANCEL', 'SHIPMENT'), status_code: status } as Row, { currentStepNo: null, isMyTurn: false });
      expect(view.target).toMatchObject({ screenId: 'W-04-02' });
    }
  });

  it('다른 결재 유형은 그대로 열 수 없다(screenId 없음)', () => {
    const view = toApprovalRequest(row('OQC_SKIP', 'SHIPMENT_REQUEST'), { currentStepNo: null, isMyTurn: false });

    expect(view.target.openable).toBe(false);
    expect(view.target).not.toHaveProperty('screenId');
  });
});
