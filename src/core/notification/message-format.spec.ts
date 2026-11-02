import { EMPTY_PARAM, EVENT_PARAMS, ZALO_PARAMS, formatZaloEventTime, notificationMessage, templateData } from './message-format';

// 2026-10-21 07:30 UTC = 14:30 하노이
const AT = new Date('2026-10-21T07:30:00.000Z');

describe('message-format', () => {
  it('6개 이벤트의 template_data 키가 고객사 등록 템플릿과 정확히 같다', () => {
    const expected: Record<string, string[]> = {
      WORK_SESSION_STARTED: ['line', 'product', 'work_order', 'event_time'],
      WORK_SESSION_STOPPED: ['line', 'work_order', 'event_time', 'reason'],
      WORK_SESSION_ENDED: ['line', 'work_order', 'event_time', 'result'],
      WORK_ORDER_CLOSED: ['line', 'work_order', 'quantity', 'event_time'],
      EQUIPMENT_BREAKDOWN_OCCURRED: ['line', 'equipment', 'event_time', 'description'],
      APPROVAL_ACTION_REQUIRED: ['requester', 'request_type', 'request_no', 'event_time'],
    };
    for (const [eventCode, keys] of Object.entries(expected)) {
      expect(Object.keys(templateData(eventCode, {}, AT, 100)).sort()).toEqual([...keys].sort());
    }
    expect(Object.keys(ZALO_PARAMS).sort()).toEqual(Object.keys(EVENT_PARAMS).sort());
  });

  it('template_data 는 payload 값을 템플릿 키로 옮기고 zaloValues 를 덮는다', () => {
    const values = { wo_no: 'WO-1', item: 'P100 사출 커버', process: '사출', line: 'L1', reason: '금형 이상', actor: '홍길동' };
    expect(templateData('WORK_SESSION_STARTED', values, AT, 100, { product: '사출 커버' })).toEqual({
      line: 'L1', product: '사출 커버', work_order: 'WO-1', event_time: '14:30:00 21/10/2026',
    });
    expect(templateData('WORK_SESSION_STOPPED', values, AT, 100)).toMatchObject({ work_order: 'WO-1', reason: '금형 이상' });
    expect(templateData('WORK_SESSION_ENDED', values, AT, 100, { result: '95/100 EA' }).result).toBe('95/100 EA');
    expect(templateData('WORK_ORDER_CLOSED', values, AT, 100, { quantity: '95 EA' }).quantity).toBe('95 EA');
    expect(
      templateData('EQUIPMENT_BREAKDOWN_OCCURRED', { equipment: 'EQ-1 사출기 1호', symptom: '유압 누유', line: 'L1' }, AT, 100, { equipment: '사출기 1호' }),
    ).toEqual({ line: 'L1', equipment: '사출기 1호', event_time: '14:30:00 21/10/2026', description: '유압 누유' });
    expect(
      templateData(
        'APPROVAL_ACTION_REQUIRED',
        { approval_type: '재고 조정', request_no: 'AR-1', requester: '김', reason: '실사 차이', step: '1/2' },
        AT,
        100,
        { request_type: 'Inventory adjustment' },
      ),
    ).toEqual({ requester: '김', request_type: 'Inventory adjustment', request_no: 'AR-1', event_time: '14:30:00 21/10/2026' });
  });

  it('event_time 은 UTC 를 UTC+7 HH:mm:ss dd/MM/yyyy 로 바꾼다 — 자정을 넘기는 날짜도', () => {
    expect(formatZaloEventTime(AT)).toBe('14:30:00 21/10/2026');
    expect(formatZaloEventTime(new Date('2026-10-21T17:05:09.000Z'))).toBe('00:05:09 22/10/2026');
    expect(formatZaloEventTime(AT).length).toBeLessThanOrEqual(20);
  });

  it('모든 값은 문자열이고 maxLength 로 자르며 빈 값은 - 이다', () => {
    const data = templateData('WORK_SESSION_STARTED', { wo_no: 'WO-1', line: null }, AT, 30, { product: 'X'.repeat(50) });
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
    expect(data.product).toHaveLength(30);
    expect(data.work_order).toBe('WO-1');
    expect(data.line).toBe(EMPTY_PARAM);
  });

  it('자르기는 코드 포인트 단위다 — 이모지를 반으로 자르지 않는다', () => {
    const data = templateData('EQUIPMENT_BREAKDOWN_OCCURRED', { symptom: 'ab😀cd' }, AT, 3);
    expect(data.description).toBe('ab😀');
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
