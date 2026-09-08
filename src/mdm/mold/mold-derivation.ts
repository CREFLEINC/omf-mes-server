import { Prisma } from '@prisma/client';

import { toDateString } from '../../common/master';
import { MoldPmDueAxis, moldPmFacts } from '../../core/mold-pm';

/**
 * 툴의 도출값 — 저장하지 않고 그때그때 만드는 여섯 칸과 목록 요약·정렬.
 *
 * ⛔ 컬럼으로 두지 않는 이유는 계약이 적었다 — 「아무도 아무것도 하지 않아도 날짜가
 * 지나면 바뀌는 값」이라 저장하면 그 순간부터 틀린다.
 */

/**
 * 「임박」의 임계. **화면이 이 값을 그대로 문구에 쓴다** — 화면이 90 을 지어내지 않도록
 * 요약에 실어 내린다(계약).
 *
 * ⚠ 계약이 값의 출처를 정하지 않았다. 고객이 조절할 값이 되면 `app.operation_policy`
 * 로 옮긴다 — 그때 고칠 자리가 여기 하나이도록 상수로 모아 둔다.
 */
export const PM_NEAR_THRESHOLD_PERCENT = 90;

export type PmDueAxis = MoldPmDueAxis;
export type MoldSort = 'SHOT_USAGE_DESC' | 'NEXT_PM_ASC' | 'CODE';

/** 계약 `Mold` 와 동형. 뒤쪽 여섯 칸은 저장하지 않고 그때그때 도출한다. */
export interface MoldView {
  moldId: number;
  plantId: number;
  moldCode: string;
  moldName: string;
  toolTypeCode: string;
  cavityCount: number;
  guaranteedShotCount: number | null;
  currentShotCount: number;
  statusCode: string;
  isActive: boolean;
  pmTriggerTypeCode: string;
  pmCycleInterval: number | null;
  pmCycleUnitCode: string | null;
  lastPmDate: string | null;
  availableShotCount: number | null;
  nextPmDate: string | null;
  pmDue: boolean;
  pmDueAxisCode?: PmDueAxis;
  shotUsageRatio: number | null;
}

/** 계약 목록 응답의 `summary` — ⚠ 페이지가 아니라 **필터 전체** 기준이다. */
export interface MoldSummary {
  pmDueCount: number;
  pmNearCount: number;
  criteriaMissingCount: number;
  pmNearThresholdPercent: number;
}

type MoldRow = Prisma.moldGetPayload<object>;

export function summarize(rows: readonly MoldView[]): MoldSummary {
  return {
    pmDueCount: rows.filter((row) => row.pmDue).length,
    // 도래한 것도 임계를 넘었으므로 함께 센다 — 계약이 「사용률이 임계 이상」으로만 적었다.
    pmNearCount: rows.filter(
      (row) => row.shotUsageRatio !== null && row.shotUsageRatio >= PM_NEAR_THRESHOLD_PERCENT,
    ).length,
    // 「판정이 서지 않는」 툴이다. 숨기지 않고 세어 보인다(계약).
    criteriaMissingCount: rows.filter(
      (row) => row.guaranteedShotCount === null && row.pmCycleInterval === null,
    ).length,
    pmNearThresholdPercent: PM_NEAR_THRESHOLD_PERCENT,
  };
}

export function sorter(sort: MoldSort): (a: MoldView, b: MoldView) => number {
  const byCode = (a: MoldView, b: MoldView): number =>
    a.plantId - b.plantId || a.moldCode.localeCompare(b.moldCode);
  if (sort === 'SHOT_USAGE_DESC') {
    return (a, b) =>
      nullsLast(a.shotUsageRatio, b.shotUsageRatio, (x, y) => y - x) || byCode(a, b);
  }
  if (sort === 'NEXT_PM_ASC') {
    return (a, b) => nullsLast(a.nextPmDate, b.nextPmDate, (x, y) => x.localeCompare(y)) || byCode(a, b);
  }
  return byCode;
}

/**
 * 산출 불가(null)는 정렬 «방향과 무관하게» 뒤로 보낸다 — 「모름」이 위험 순위 맨 앞에
 * 오면 적체 화면이 거짓말을 한다.
 */
function nullsLast<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

/** `Asia/Ho_Chi_Minh` 같은 IANA 이름으로 그 지역의 오늘을 뽑는다(`plant.timezone_code`). */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 저장된 칸에서 도출값 여섯을 만든다. `today` 는 그 툴이 선 공장의 로컬 오늘이다. */
export function view(row: MoldRow, today: string): MoldView {
  const facts = moldPmFacts({
    triggerTypeCode: row.pm_trigger_type_code,
    guaranteedShotCount: row.guaranteed_shot_count,
    currentShotCount: row.current_shot_count,
    lastPmDate: row.last_pm_date,
    cycleInterval: row.pm_cycle_interval,
    cycleUnitCode: row.pm_cycle_unit_code,
    today,
  });
  const guaranteed =
    facts.guaranteedShotCountAtDue === null ? null : Number(facts.guaranteedShotCountAtDue);
  const current = Number(facts.shotCountAtDue);
  const lastPmDate = toDateString(row.last_pm_date);

  // 적정타수가 비면 「산출 불가」다 — 0 으로 채우면 화면이 여유가 없다고 읽는다(계약).
  const available = guaranteed === null ? null : guaranteed - current;
  const ratio = guaranteed === null || guaranteed === 0
    ? null
    : Math.round((current / guaranteed) * 1000) / 10;

  return {
    moldId: Number(row.mold_id),
    plantId: Number(row.plant_id),
    moldCode: row.mold_code,
    moldName: row.mold_name,
    toolTypeCode: row.tool_type_code,
    cavityCount: row.cavity_count,
    guaranteedShotCount: guaranteed,
    currentShotCount: current,
    statusCode: row.status_code,
    isActive: row.is_active,
    pmTriggerTypeCode: row.pm_trigger_type_code,
    pmCycleInterval: row.pm_cycle_interval,
    pmCycleUnitCode: row.pm_cycle_unit_code,
    lastPmDate,
    availableShotCount: available,
    nextPmDate: facts.nextPmDate,
    pmDue: facts.pmDue,
    // ⛔ 도래하지 않았으면 «칸을 빼고» 내린다. 계약 설명은 「null 이다」인데 스키마가
    // enum: [SHOT, DATE] 라 null 이 그 스키마를 통과하지 못한다 — 설명과 스키마가
    // 어긋난 자리다. 스키마를 따르고 되돌림 문서에 적어 설계팀에 묻는다.
    ...(facts.pmDueAxisCode === null ? {} : { pmDueAxisCode: facts.pmDueAxisCode }),
    shotUsageRatio: ratio,
  };
}
