import { toDateString } from '../../common/master';

export type MoldPmDueAxis = 'SHOT' | 'DATE';

export interface MoldPmFactInput {
  triggerTypeCode: string;
  guaranteedShotCount: bigint | null;
  currentShotCount: bigint;
  lastPmDate: Date | null;
  cycleInterval: number | null;
  cycleUnitCode: string | null;
  today: string;
}

export interface MoldPmFacts {
  nextPmDate: string | null;
  pmDue: boolean;
  pmDueAxisCode: MoldPmDueAxis | null;
  shotCountAtDue: bigint;
  guaranteedShotCountAtDue: bigint | null;
}

/** 저장된 PM 기준에서 도래 여부와 발행 검증용 타발수 스냅샷을 계산한다. */
export function moldPmFacts(input: MoldPmFactInput): MoldPmFacts {
  const nextPmDate =
    input.lastPmDate === null || input.cycleInterval === null || input.cycleUnitCode === null
      ? null
      : addCycle(input.lastPmDate, input.cycleInterval, input.cycleUnitCode);
  const shotDue =
    (input.triggerTypeCode === 'SHOT' || input.triggerTypeCode === 'BOTH') &&
    input.guaranteedShotCount !== null &&
    input.currentShotCount >= input.guaranteedShotCount;
  const dateDue =
    (input.triggerTypeCode === 'DATE' || input.triggerTypeCode === 'BOTH') &&
    nextPmDate !== null &&
    nextPmDate <= input.today;
  // 두 축의 최초 도달 시각은 기록되지 않는다. 기존 MDM의 잠정 SHOT 우선을 보존한다.
  const pmDueAxisCode: MoldPmDueAxis | null = shotDue ? 'SHOT' : dateDue ? 'DATE' : null;
  return {
    nextPmDate,
    pmDue: pmDueAxisCode !== null,
    pmDueAxisCode,
    shotCountAtDue: input.currentShotCount,
    guaranteedShotCountAtDue: input.guaranteedShotCount,
  };
}

/** 월·연 주기에서 말일을 넘으면 대상 월의 마지막 날로 자른다. */
function addCycle(from: Date, interval: number, unit: string): string | null {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  if (unit === 'DAY' || unit === 'WEEK') {
    const step = unit === 'WEEK' ? interval * 7 : interval;
    return toDateString(new Date(Date.UTC(year, month, day + step)));
  }
  const months = unit === 'MONTH' ? interval : unit === 'YEAR' ? interval * 12 : null;
  if (months === null) return null;
  const lastDay = new Date(Date.UTC(year, month + months + 1, 0)).getUTCDate();
  return toDateString(new Date(Date.UTC(year, month + months, Math.min(day, lastDay))));
}
