import { BreakdownRow, breakdownView } from './breakdown-view';

function row(): BreakdownRow {
  return {
    breakdown_id: 1n,
    breakdown_no: 'MLF-1',
    equipment_id: 2n,
    reported_at: new Date('2026-09-01T00:00:00Z'),
    reported_by: null,
    symptom_code: null,
    description: '유압 누유',
    severity_code: null,
    status_code: 'HANDLING',
    started_at: new Date('2026-09-01T01:00:00Z'),
    completed_at: null,
    root_cause: '기존 원문',
    occurrence_state_code: 'STOPPED',
    stopped_at: new Date('2026-08-31T23:00:00Z'),
    notify_assignee: true,
    reporter_worker_no: 'W-1',
    cause_code: 'LEGACY-CAUSE',
    handling_note: '씰 교체',
    handled_by: 3n,
    handled_at: new Date('2026-09-01T02:00:00Z'),
    created_at: new Date(),
    created_by: null,
    updated_at: new Date(),
    updated_by: null,
    version_no: 7,
    equipment: { equipment_code: 'EQ-1' },
  };
}

describe('breakdownView', () => {
  it('상세는 Breakdown 16칸과 handling 5칸을 원문 그대로 반환한다', () => {
    const view = breakdownView(row(), 9, {
      linkedDowntimeCount: 3,
      linkedDowntimeMinutes: 2,
      openLinkedDowntimeCount: 1,
    });
    expect(Object.keys(view)).toHaveLength(16);
    expect(Object.keys(view.handling)).toHaveLength(5);
    expect(view).toMatchObject({
      breakdownId: 1,
      equipmentCode: 'EQ-1',
      symptom: '유압 누유',
      occurrenceStateCode: 'STOPPED',
      reporterWorkerNo: 'W-1',
      statusCode: 'HANDLING',
      linkedDowntimeCount: 3,
      linkedDowntimeMinutes: 2,
      openLinkedDowntimeCount: 1,
      handling: {
        causeCode: 'LEGACY-CAUSE',
        handlingNote: '씰 교체',
        handledByUserId: 3,
        maintenanceOrderId: 9,
      },
      attachments: [],
    });
    expect(JSON.stringify(view)).not.toContain('기존 원문');
    expect(view).not.toHaveProperty('versionNo');
  });

  it('목록 집계는 0이고 상세 전용 두 필드는 생략한다', () => {
    const view = breakdownView({ ...row(), notify_assignee: null }, null);
    expect(view.linkedDowntimeCount).toBe(0);
    expect(view).not.toHaveProperty('linkedDowntimeMinutes');
    expect(view).not.toHaveProperty('openLinkedDowntimeCount');
    expect(view).not.toHaveProperty('notifyAssignee');
  });

  it.each(['occurrence_state_code', 'reporter_worker_no', 'reported_at']) (
    '필수 결손 %s를 가짜 정상으로 보완하지 않는다',
    (name) => {
      // 설계 미정 — 문의 091: 기간·계정·상태에서 required 값을 도출하지 않는다.
      expect(() => breakdownView({ ...row(), [name]: null } as BreakdownRow, null)).toThrow();
    },
  );

  it.each(['OPEN', 'CANCELLED', ''])('미등록 저장 상태 %s는 내부 불변식 실패다', (code) => {
    expect(() => breakdownView({ ...row(), status_code: code }, null)).toThrow(
      'Invalid stored breakdown status',
    );
  });
});
