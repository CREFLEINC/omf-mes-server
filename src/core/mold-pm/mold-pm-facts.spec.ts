import { moldPmFacts } from './mold-pm-facts';

const base = {
  triggerTypeCode: 'BOTH',
  guaranteedShotCount: 100n,
  currentShotCount: 50n,
  lastPmDate: new Date('2026-01-31T00:00:00Z'),
  cycleInterval: 1,
  cycleUnitCode: 'MONTH',
  today: '2026-02-27',
};

describe('툴 PM 사실 계산', () => {
  it('월말을 자르고 아직 날짜·타발수 어느 축도 도래하지 않으면 축이 없다', () => {
    expect(moldPmFacts(base)).toEqual({
      nextPmDate: '2026-02-28',
      pmDue: false,
      pmDueAxisCode: null,
      shotCountAtDue: 50n,
      guaranteedShotCountAtDue: 100n,
    });
  });

  it.each([
    ['DAY', 2, '2026-02-02'],
    ['WEEK', 2, '2026-02-14'],
    ['YEAR', 1, '2027-01-31'],
  ])('%s 주기의 다음 예정일을 계산한다', (cycleUnitCode, cycleInterval, expected) => {
    expect(moldPmFacts({ ...base, cycleUnitCode, cycleInterval }).nextPmDate).toBe(expected);
  });

  it('타발수 축이 먼저 도래하면 SHOT과 bigint 스냅샷을 보존한다', () => {
    expect(
      moldPmFacts({ ...base, triggerTypeCode: 'SHOT', currentShotCount: 100n }),
    ).toMatchObject({
      pmDue: true,
      pmDueAxisCode: 'SHOT',
      shotCountAtDue: 100n,
      guaranteedShotCountAtDue: 100n,
    });
  });

  it('날짜 축이 도래하면 DATE다', () => {
    expect(
      moldPmFacts({ ...base, triggerTypeCode: 'DATE', today: '2026-02-28' }),
    ).toMatchObject({ pmDue: true, pmDueAxisCode: 'DATE' });
  });

  it('BOTH의 두 축이 동시에 도래하면 기존 잠정 규칙대로 SHOT이 우선한다', () => {
    expect(
      moldPmFacts({ ...base, currentShotCount: 100n, today: '2026-02-28' }).pmDueAxisCode,
    ).toBe('SHOT');
  });

  it.each([
    ['날짜 기준이 없을 때', { lastPmDate: null }],
    ['주기 단위를 알 수 없을 때', { cycleUnitCode: 'UNKNOWN' }],
  ])('%s 날짜 도래를 추측하지 않는다', (_caseName, override) => {
    expect(moldPmFacts({ ...base, ...override, today: '9999-12-31' })).toMatchObject({
      nextPmDate: null,
      pmDue: false,
      pmDueAxisCode: null,
    });
  });
});
