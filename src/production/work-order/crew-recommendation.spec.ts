import { busyShiftIds, isWorkerBusy, orderShifts, pickWorkers } from './crew-recommendation';

const rule = { dayStart: '08:00:00', timezone: 'Asia/Ho_Chi_Minh' };
/** 하노이 벽시계 → UTC 순간. */
const hanoi = (local: string): Date => new Date(new Date(`${local}Z`).getTime() - 7 * 60 * 60 * 1000);

describe('orderShifts — 교대 추천 순서', () => {
  it('비어 있는 교대가 먼저, 그다음 시작 시각 순이다', () => {
    const shifts = [
      { shiftId: 2, startTime: '20:00:00', busy: false },
      { shiftId: 1, startTime: '08:00:00', busy: true },
      { shiftId: 3, startTime: '14:00:00', busy: false },
    ];
    expect(orderShifts(shifts).map((shift) => shift.shiftId)).toEqual([3, 2, 1]);
  });
});

describe('busyShiftIds — 같은 설비·같은 근무일의 교대', () => {
  const target = { plannedEquipmentId: 51n, plannedStartAt: hanoi('2026-10-20T08:00:00') };

  it('같은 근무일의 다른 W/O 교대가 막힌다 — 자정 넘은 야간도 같은 근무일이다', () => {
    const rivals = [
      { planned_shift_id: 1n, planned_start_at: hanoi('2026-10-20T08:00:00'), planned_end_at: null },
      { planned_shift_id: 2n, planned_start_at: hanoi('2026-10-21T02:00:00'), planned_end_at: null },
      { planned_shift_id: 3n, planned_start_at: hanoi('2026-10-21T09:00:00'), planned_end_at: null },
    ];
    expect([...busyShiftIds(target, rivals, rule)].sort()).toEqual([1n, 2n]);
  });

  it('설비나 시작 시각이 없으면 아무 교대도 막지 않는다', () => {
    const rivals = [{ planned_shift_id: 1n, planned_start_at: hanoi('2026-10-20T08:00:00'), planned_end_at: null }];
    expect(busyShiftIds({ ...target, plannedEquipmentId: null }, rivals, rule).size).toBe(0);
    expect(busyShiftIds({ ...target, plannedStartAt: null }, rivals, rule).size).toBe(0);
  });
});

describe('isWorkerBusy — 작업자가 다른 W/O 를 맡고 있는가', () => {
  const start = hanoi('2026-10-20T08:00:00');
  const end = hanoi('2026-10-20T16:00:00');

  it('교대가 있으면 같은 교대·같은 근무일로 본다', () => {
    const target = { plannedShiftId: 1n, plannedStartAt: start, plannedEndAt: end };
    expect(isWorkerBusy(target, [{ planned_shift_id: 1n, planned_start_at: hanoi('2026-10-20T10:00:00'), planned_end_at: null }], rule)).toBe(true);
    expect(isWorkerBusy(target, [{ planned_shift_id: 2n, planned_start_at: hanoi('2026-10-20T10:00:00'), planned_end_at: null }], rule)).toBe(false);
    expect(isWorkerBusy(target, [{ planned_shift_id: 1n, planned_start_at: hanoi('2026-10-21T10:00:00'), planned_end_at: null }], rule)).toBe(false);
  });

  it('이 W/O 에 교대가 있어도 상대에 교대가 없으면 겹치는 계획 시간으로 본다 — 전개는 교대를 비워 둔다', () => {
    const target = { plannedShiftId: 1n, plannedStartAt: start, plannedEndAt: end };
    expect(isWorkerBusy(target, [{ planned_shift_id: null, planned_start_at: hanoi('2026-10-20T08:00:00'), planned_end_at: hanoi('2026-10-21T08:00:00') }], rule)).toBe(true);
    expect(isWorkerBusy(target, [{ planned_shift_id: null, planned_start_at: hanoi('2026-10-21T08:00:00'), planned_end_at: hanoi('2026-10-22T08:00:00') }], rule)).toBe(false);
  });

  it('교대가 없으면 겹치는 계획 시간으로 본다 — 끝이 맞닿으면 겹치지 않는다', () => {
    const target = { plannedShiftId: null, plannedStartAt: start, plannedEndAt: end };
    expect(isWorkerBusy(target, [{ planned_shift_id: null, planned_start_at: hanoi('2026-10-20T15:00:00'), planned_end_at: hanoi('2026-10-20T18:00:00') }], rule)).toBe(true);
    expect(isWorkerBusy(target, [{ planned_shift_id: null, planned_start_at: end, planned_end_at: hanoi('2026-10-20T18:00:00') }], rule)).toBe(false);
  });

  it('이 W/O 에 시작 시각이 없으면 바쁘다고 하지 않는다', () => {
    expect(isWorkerBusy({ plannedShiftId: 1n, plannedStartAt: null, plannedEndAt: null }, [{ planned_shift_id: 1n, planned_start_at: start, planned_end_at: end }], rule)).toBe(false);
  });
});

describe('pickWorkers — 출처 순서·중복 제거·자격 없는 사람 제외', () => {
  it('설비 → 라인 → 공정 → 자격 순으로, 앞 출처에 나온 사람은 다시 넣지 않는다', () => {
    const picked = pickWorkers(
      [
        { source: 'EQUIPMENT', workerIds: [1n, 2n, 1n] },
        { source: 'LINE', workerIds: [2n, 3n] },
        { source: 'PROCESS', workerIds: [9n, 4n] },
        { source: 'QUALIFIED', workerIds: [5n] },
      ],
      new Set([1n, 2n, 3n, 4n, 5n]),
    );
    expect(picked).toEqual([
      { workerId: 1n, source: 'EQUIPMENT' },
      { workerId: 2n, source: 'EQUIPMENT' },
      { workerId: 3n, source: 'LINE' },
      { workerId: 4n, source: 'PROCESS' },
      { workerId: 5n, source: 'QUALIFIED' },
    ]);
  });

  it('최대 다섯 명이다', () => {
    const ids = [1n, 2n, 3n, 4n, 5n, 6n, 7n];
    expect(pickWorkers([{ source: 'PROCESS', workerIds: ids }], new Set(ids))).toHaveLength(5);
  });
});
