import { EquipmentSignals, equipmentStatus } from './dashboard-equipment-status';

const at = (iso: string) => new Date(iso);
const idleSignals: EquipmentSignals = {
  breakdown: null,
  downtime: null,
  session: null,
  idle: undefined,
  lastSessionEndedAt: null,
};
const running = { stopped: false, since: at('2026-10-16T01:00:00Z'), reasonCode: null, reasonName: null };

describe('dashboard equipment status', () => {
  it('고장이 다른 모든 신호보다 먼저다 — 사유 코드는 없고 설명을 이름으로 싣는다', () => {
    const result = equipmentStatus({
      ...idleSignals,
      breakdown: { since: at('2026-10-16T02:00:00Z'), description: '유압 누유' },
      downtime: { since: at('2026-10-16T01:00:00Z'), reasonCode: 'MOLD_CHANGE', reasonName: '금형 교체' },
      session: running,
    });
    expect(result).toEqual({
      statusCode: 'STOPPED',
      statusSince: '2026-10-16T02:00:00.000Z',
      statusReasonCode: null,
      statusReasonName: '유압 누유',
    });
  });

  it('비가동 기록은 사유가 MOLD_CHANGE 면 교체, 아니면 정지다', () => {
    const downtime = (reasonCode: string) => ({ since: at('2026-10-16T01:00:00Z'), reasonCode, reasonName: null });
    expect(equipmentStatus({ ...idleSignals, downtime: downtime('MOLD_CHANGE') }).statusCode).toBe('CHANGEOVER');
    expect(equipmentStatus({ ...idleSignals, downtime: downtime('MATERIAL_WAIT') }).statusCode).toBe('STOPPED');
  });

  it('진행 중 세션의 STOP 은 사유가 MOLD_CHANGE 면 교체, 아니면 정지 — 계획 정지보다 먼저다', () => {
    const stopped = (reasonCode: string) => ({ ...running, stopped: true, reasonCode });
    const idle = { idle: { since: at('2026-10-16T00:00:00Z'), reasonCode: null, reasonName: null } };
    expect(equipmentStatus({ ...idleSignals, ...idle, session: stopped('MOLD_CHANGE') }).statusCode).toBe('CHANGEOVER');
    expect(equipmentStatus({ ...idleSignals, ...idle, session: stopped('MATERIAL_WAIT') }).statusCode).toBe('STOPPED');
  });

  it('비근무·계획 정지는 진행 중 세션보다 먼저고, 그다음이 가동, 나머지는 대기다', () => {
    const offShift = { since: null, reasonCode: null, reasonName: null };
    expect(equipmentStatus({ ...idleSignals, idle: offShift, session: running })).toEqual({
      statusCode: 'IDLE',
      statusSince: null,
      statusReasonCode: null,
      statusReasonName: null,
    });
    const plannedStop = { since: at('2026-10-16T02:00:00Z'), reasonCode: 'PM', reasonName: '예방정비' };
    expect(equipmentStatus({ ...idleSignals, idle: plannedStop, session: running })).toEqual({
      statusCode: 'IDLE',
      statusSince: '2026-10-16T02:00:00.000Z',
      statusReasonCode: 'PM',
      statusReasonName: '예방정비',
    });
    expect(equipmentStatus({ ...idleSignals, session: running })).toMatchObject({
      statusCode: 'RUNNING',
      statusSince: '2026-10-16T01:00:00.000Z',
    });
    expect(
      equipmentStatus({ ...idleSignals, lastSessionEndedAt: at('2026-10-15T09:00:00Z') }),
    ).toMatchObject({ statusCode: 'WAITING', statusSince: '2026-10-15T09:00:00.000Z' });
  });
});
