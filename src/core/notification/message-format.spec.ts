import { EMPTY_PARAM, EVENT_PARAMS, formatEventTime, notificationMessage, templateData } from './message-format';

// 2026-10-21 07:30 UTC = 14:30 하노이
const AT = new Date('2026-10-21T07:30:00.000Z');

describe('message-format', () => {
  it('6개 이벤트의 template_data 키가 data-model §6 과 정확히 같다', () => {
    const expected: Record<string, string[]> = {
      WORK_SESSION_STARTED: ['wo_no', 'item', 'process', 'line'],
      WORK_SESSION_STOPPED: ['wo_no', 'item', 'process', 'line', 'reason'],
      WORK_SESSION_ENDED: ['wo_no', 'item', 'process', 'line', 'plan_qty', 'good_qty'],
      WORK_ORDER_CLOSED: ['wo_no', 'item', 'process', 'line', 'plan_qty', 'good_qty'],
      EQUIPMENT_BREAKDOWN_OCCURRED: ['equipment', 'location', 'line', 'symptom'],
      APPROVAL_ACTION_REQUIRED: ['approval_type', 'request_no', 'requester', 'reason', 'step'],
    };
    for (const [eventCode, keys] of Object.entries(expected)) {
      expect(Object.keys(templateData(eventCode, {}, AT, 100)).sort()).toEqual([...keys, 'event_time', 'actor'].sort());
    }
    expect(Object.keys(EVENT_PARAMS).sort()).toEqual(Object.keys(expected).sort());
  });

  it('event_time 은 UTC 를 UTC+7 dd/MM/yyyy HH:mm 으로 바꾼다 — 자정을 넘기는 날짜도', () => {
    expect(formatEventTime(AT)).toBe('21/10/2026 14:30');
    expect(formatEventTime(new Date('2026-10-21T17:05:00.000Z'))).toBe('22/10/2026 00:05');
  });

  it('모든 값은 문자열이고 maxLength 로 자르며 빈 값은 - 이다', () => {
    const data = templateData('WORK_SESSION_ENDED', { wo_no: 'WO-1', item: 'X'.repeat(50), plan_qty: 100, good_qty: 0, actor: null }, AT, 20);
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
    expect(data.item).toHaveLength(20);
    expect(data.plan_qty).toBe('100');
    expect(data.good_qty).toBe('0');
    expect(data.actor).toBe(EMPTY_PARAM);
    expect(data.process).toBe(EMPTY_PARAM);
  });

  it('자르기는 코드 포인트 단위다 — 이모지를 반으로 자르지 않는다', () => {
    const data = templateData('EQUIPMENT_BREAKDOWN_OCCURRED', { symptom: 'ab😀cd' }, AT, 3);
    expect(data.symptom).toBe('ab😀');
  });

  it('message 는 값을 · 로 잇고 중단 사유·수량에만 한국어 라벨을 붙인다', () => {
    const base = { wo_no: 'WO-20261021-003', item: 'P100 사출 커버', process: '사출', line: 'L1', actor: '홍길동' };
    expect(notificationMessage('WORK_SESSION_STOPPED', { ...base, reason: '금형 이상' }, AT)).toBe(
      'WO-20261021-003 · P100 사출 커버 · 사출 · L1 · 중단 사유: 금형 이상 · 홍길동 · 10-21 14:30',
    );
    expect(notificationMessage('WORK_SESSION_ENDED', { ...base, plan_qty: '100', good_qty: '95' }, AT)).toBe(
      'WO-20261021-003 · P100 사출 커버 · 사출 · L1 · 계획 100 · 양품 95 · 홍길동 · 10-21 14:30',
    );
  });

  it('message 는 빈 값을 건너뛰고, 결재는 요청자를 두 번 쓰지 않는다', () => {
    expect(notificationMessage('WORK_SESSION_STARTED', { wo_no: 'WO-1', item: '', line: null }, AT)).toBe('WO-1 · 10-21 14:30');
    expect(
      notificationMessage(
        'APPROVAL_ACTION_REQUIRED',
        { approval_type: '재고 조정', request_no: 'AR-1', requester: '김', reason: '실사 차이', step: '1/2', actor: '김' },
        AT,
      ),
    ).toBe('재고 조정 · AR-1 · 김 · 사유: 실사 차이 · 1/2 · 10-21 14:30');
  });

  it('정의가 없는 이벤트는 던진다', () => {
    expect(() => templateData('UNKNOWN', {}, AT, 100)).toThrow();
  });
});
