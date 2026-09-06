import {
  WorkSessionEventRow,
  WorkSessionRow,
  WorkSessionWorkerRow,
  reasonKey,
  workSessionEventView,
  workSessionView,
  workSessionWorkerView,
} from './work-session-view';

function sessionRow(overrides: Partial<WorkSessionRow> = {}): WorkSessionRow {
  return {
    work_session_id: 1n,
    work_order_id: 10n,
    session_no: 1,
    shift_id: 20n,
    equipment_id: null,
    mold_id: null,
    terminal_id: 30n,
    started_at: new Date('2026-09-07T01:00:00.000Z'),
    ended_at: null,
    status_code: 'RUNNING',
    stop_reason_code: null,
    remarks: null,
    created_at: new Date('2026-09-07T01:00:00.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-07T01:00:00.000Z'),
    updated_by: null,
    version_no: 1,
    idempotency_key: 'WSVIEW-1',
    ...overrides,
  } as WorkSessionRow;
}

function eventRow(overrides: Partial<WorkSessionEventRow> = {}): WorkSessionEventRow {
  return {
    work_session_event_id: 1n,
    work_session_id: 1n,
    event_type_code: 'STOP',
    occurred_at: new Date('2026-09-07T02:00:00.000Z'),
    reason_code: 'MOLD_CHANGE',
    performed_by: null,
    terminal_id: null,
    created_at: new Date('2026-09-07T02:00:01.000Z'),
    ...overrides,
  } as WorkSessionEventRow;
}

function workerRow(overrides: Partial<WorkSessionWorkerRow> = {}): WorkSessionWorkerRow {
  return {
    work_session_worker_id: 1n,
    work_session_id: 1n,
    worker_id: 40n,
    worker_role_code: 'MAIN',
    joined_at: new Date('2026-09-07T01:00:00.000Z'),
    left_at: null,
    created_at: new Date('2026-09-07T01:00:00.000Z'),
    created_by: null,
    ...overrides,
  } as WorkSessionWorkerRow;
}

describe('workSessionView', () => {
  it('nullable 칸(shiftId·equipmentId·moldId·endedAt)이 비면 키를 생략한다', () => {
    const view = workSessionView(sessionRow({ shift_id: null }));
    expect(view).not.toHaveProperty('shiftId');
    expect(view).not.toHaveProperty('equipmentId');
    expect(view).not.toHaveProperty('moldId');
    expect(view).not.toHaveProperty('endedAt');
    // ⛔ `stopReasonCode` 는 물리에 값이 있어도 계약이 비우기로 정했다(A-21·A-25).
    expect(view).not.toHaveProperty('stopReasonCode');
  });

  it('값이 있으면 그대로 싣는다', () => {
    const view = workSessionView(
      sessionRow({ shift_id: 21n, equipment_id: 22n, mold_id: 23n, ended_at: new Date('2026-09-07T05:00:00.000Z') }),
    );
    expect(view).toMatchObject({ shiftId: 21, equipmentId: 22, moldId: 23, endedAt: '2026-09-07T05:00:00.000Z' });
  });

  it('terminalId 는 항상 채워진다', () => {
    expect(workSessionView(sessionRow()).terminalId).toBe(30);
  });
});

describe('workSessionEventView', () => {
  it('recordedAt 은 created_at(서버 수신 시각)이다', () => {
    const view = workSessionEventView(eventRow(), undefined);
    expect(view.recordedAt).toBe('2026-09-07T02:00:01.000Z');
  });

  it('reasonName 이 없으면 키를 생략한다', () => {
    const view = workSessionEventView(eventRow({ reason_code: null }), undefined);
    expect(view).not.toHaveProperty('reasonName');
  });

  it('reasonName 이 있으면 싣는다', () => {
    const view = workSessionEventView(eventRow(), '금형 교체');
    expect(view.reasonName).toBe('금형 교체');
  });

  it('performedBy·terminalId 가 NULL 이면 키를 생략한다', () => {
    const view = workSessionEventView(eventRow(), undefined);
    expect(view).not.toHaveProperty('performedBy');
    expect(view).not.toHaveProperty('terminalId');
  });
});

describe('reasonKey', () => {
  it('STOP 은 WORK_SESSION_EVENT_REASON 그룹 키를 낸다', () => {
    expect(reasonKey({ event_type_code: 'STOP', reason_code: 'MOLD_CHANGE' })).toBe(
      'WORK_SESSION_EVENT_REASON:MOLD_CHANGE',
    );
  });

  it('CONTROL_OVERRIDE 는 CONTROL_OVERRIDE_REASON 그룹 키를 낸다', () => {
    expect(reasonKey({ event_type_code: 'CONTROL_OVERRIDE', reason_code: 'OTHER' })).toBe(
      'CONTROL_OVERRIDE_REASON:OTHER',
    );
  });

  it('reason_code 가 NULL 이거나 유형이 그룹을 안 가지면 undefined 다', () => {
    expect(reasonKey({ event_type_code: 'STOP', reason_code: null })).toBeUndefined();
    expect(reasonKey({ event_type_code: 'START', reason_code: 'X' })).toBeUndefined();
  });
});

describe('workSessionWorkerView', () => {
  it('leftAt 이 NULL 이면 키를 생략한다', () => {
    expect(workSessionWorkerView(workerRow())).not.toHaveProperty('leftAt');
  });

  it('leftAt 이 있으면 싣는다', () => {
    const view = workSessionWorkerView(workerRow({ left_at: new Date('2026-09-07T05:00:00.000Z') }));
    expect(view.leftAt).toBe('2026-09-07T05:00:00.000Z');
  });
});
