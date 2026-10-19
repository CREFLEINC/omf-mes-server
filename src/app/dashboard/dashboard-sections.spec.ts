import { EquipmentSignals, equipmentStatus, pickDowntime } from './dashboard-equipment-status';
import { JudgmentRow, passRate, qualityTypeBlock } from './dashboard-inspection';
import { fullReinspect, topEquipmentDefectRates } from './dashboard-quality.service';
import { dashboardPeriod } from './dashboard-scope';

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

  it('열린 비가동이 여럿이면 하나라도 MOLD_CHANGE 가 아니면 정지, 모두 MOLD_CHANGE 일 때만 교체다', () => {
    const row = (reasonCode: string | null, since: string) => ({ since: at(since), reasonCode });
    const mixed = [row('MATERIAL_WAIT', '2026-10-16T01:00:00Z'), row('MOLD_CHANGE', '2026-10-16T02:00:00Z')];
    expect(pickDowntime(mixed)).toEqual(mixed[0]);
    expect(equipmentStatus({ ...idleSignals, downtime: { ...mixed[0], reasonName: null } })).toMatchObject({
      statusCode: 'STOPPED',
      statusReasonCode: 'MATERIAL_WAIT',
    });
    // 사유 없는 기록도 MOLD_CHANGE 가 아니다 → 정지
    expect(pickDowntime([row('MOLD_CHANGE', '2026-10-16T01:00:00Z'), row(null, '2026-10-16T00:30:00Z')])?.reasonCode).toBeNull();
    const molds = [row('MOLD_CHANGE', '2026-10-16T01:00:00Z'), row('MOLD_CHANGE', '2026-10-16T02:00:00Z')];
    expect(pickDowntime(molds)).toEqual(molds[1]);
    expect(pickDowntime([])).toBeNull();
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

describe('dashboard quality block', () => {
  const row = (local_date: string, judgment: JudgmentRow['judgment'], lot_count: number, rejected_qty = '0'): JudgmentRow => ({
    type: 'IQC',
    local_date,
    judgment,
    lot_count,
    rejected_qty,
  });

  it('하루 조회의 누계는 당월 1일~기준일 · 전월이다(기본 화면 유지)', () => {
    expect(dashboardPeriod({ from: '2026-03-05', to: '2026-03-05' })).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-05',
      previousFrom: '2026-02-01',
      previousTo: '2026-02-28',
    });
  });

  it('기간 조회의 누계는 그 기간 · 바로 앞 같은 길이 기간이고, 일별은 기간 안의 날이다', () => {
    const period = dashboardPeriod({ from: '2026-10-14', to: '2026-10-16' });
    expect(period).toMatchObject({ from: '2026-10-14', to: '2026-10-16', previousFrom: '2026-10-11', previousTo: '2026-10-13' });
    expect(period.chartDays).toEqual(['2026-10-14', '2026-10-15', '2026-10-16']);
  });

  it('합격률은 보류를 빼고, 모수가 0 이면 null 이다', () => {
    expect(passRate({ accepted: 3, rejected: 1, held: 5 })).toBe(75);
    expect(passRate({ accepted: 0, rejected: 0, held: 2 })).toBeNull();
  });

  it('당월·전월·일별·오늘을 현지 날짜로 가르고, 당월 불합격 수량을 더한다', () => {
    const block = qualityTypeBlock(
      [
        row('2026-09-30', 'REJECTED', 1, '5'),
        row('2026-10-01', 'ACCEPTED', 3),
        row('2026-10-16', 'ACCEPTED', 1),
        row('2026-10-16', 'REJECTED', 1, '7'),
        row('2026-10-16', 'HELD', 2),
      ],
      dashboardPeriod({ from: '2026-10-16', to: '2026-10-16' }),
      [],
      [],
    );
    expect(block.monthLots).toEqual({ accepted: 4, rejected: 1, held: 2 });
    expect(block.monthPassRate).toBe(80);
    expect(block.prevMonthPassRate).toBe(0);
    expect(block.todayLots).toEqual({ accepted: 1, rejected: 1, held: 2 });
    expect(block.monthDefectQty).toBe(7);
    expect(block.dailyPassRates).toHaveLength(9);
    expect(block.dailyPassRates.at(-1)).toEqual({ date: '2026-10-16', passRate: 50 });
    expect(block.dailyPassRates[0]).toEqual({ date: '2026-10-08', passRate: null });
  });
});

describe('dashboard equipment defect rates', () => {
  const row = (id: number, code: string, total: number, ng: number) => ({
    equipment_id: BigInt(id),
    equipment_code: code,
    total_qty: String(total),
    ng_qty: String(ng),
  });

  it('불량률 → NG 수 → 설비 코드 자연 정렬 순 상위 8, 총생산 0 은 뺀다', () => {
    const rows = [
      row(1, 'E-1-10', 100, 5),
      row(2, 'E-1-2', 100, 5),
      row(3, 'E-1-3', 200, 10),
      row(4, 'E-1-4', 100, 9),
      row(5, 'E-1-5', 0, 0),
      ...Array.from({ length: 6 }, (_, index) => row(10 + index, `E-2-${index}`, 100, 1)),
    ];
    const top = topEquipmentDefectRates(rows);
    expect(top.map((item) => item.equipmentCode)).toEqual([
      'E-1-4',
      'E-1-3',
      'E-1-2',
      'E-1-10',
      'E-2-0',
      'E-2-1',
      'E-2-2',
      'E-2-3',
    ]);
    expect(top[0]).toEqual({ equipmentId: 4, equipmentCode: 'E-1-4', defectRate: 9, ngQty: 9 });
  });
});

describe('dashboard iqc full reinspect', () => {
  it('재검사 회차의 검사 수량 합 = 투입, 합격 수량 합 = 양품 복원이다', () => {
    expect(fullReinspect({ input_qty: '30.500000', restored_qty: '18.000000' })).toEqual({ inputQty: 30.5, restoredQty: 18 });
  });

  it('재검사 회차가 없으면 null 이 아니라 0 이다 — 화면이 칸을 숨기지 않는다', () => {
    expect(fullReinspect({ input_qty: '0', restored_qty: '0' })).toEqual({ inputQty: 0, restoredQty: 0 });
    expect(fullReinspect(undefined)).toEqual({ inputQty: 0, restoredQty: 0 });
  });
});
