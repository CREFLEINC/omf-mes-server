import { omitEmpty } from '../../common/http/omit-empty';
import { NotificationView } from '../notification/notification-view';
import type { AvailabilityFigures } from './dashboard-availability.service';
import type {
  DashboardEquipment,
  DashboardProduction,
  DashboardQuality,
  DashboardShipment,
} from './dashboard-sections';

export type DashboardCardCode =
  | 'PRODUCTION_QTY'
  | 'YIELD_RATE'
  | 'PERFORMANCE_RATE'
  | 'AVAILABILITY_RATE'
  | 'UNHANDLED_ALARM'
  | 'OEE';

export interface DashboardCard {
  cardCode: DashboardCardCode;
  label: string;
  value: number;
  unit?: string;
  deltaRatio?: number;
  note?: string | null;
  valueStatusCode: 'AVAILABLE' | 'NOT_YET' | 'PARTIAL';
  excludedCount?: number | null;
}

export interface DashboardTrend {
  seriesName: string;
  unit: string;
  targetValue: number | null;
  points: { label: string; value: number }[];
  asOf: string;
}

export interface DashboardSummary {
  baseDate: string;
  plantId?: number;
  cards: DashboardCard[];
  alerts: NotificationView[];
  asOf: string;
  trend: DashboardTrend;
  /**
   * 아래 셋은 계약보다 앞선 선택 섹션이다(장부 P-59). ⛔ 데이터가 없어도 생략하지 않는다 —
   * 클라이언트는 키가 없으면 「서버가 아직 지원하지 않음」으로 읽는다(빈 값과 구분한다).
   */
  production?: DashboardProduction;
  equipment?: DashboardEquipment;
  shipment?: DashboardShipment;
  quality?: DashboardQuality;
}

/** 일자별 생산 합 — 재작업 W/O 실적은 `reworkGoodQty` 로만 들어온다(총생산에 넣지 않는다). */
export interface DailyProduction {
  readonly day: string;
  readonly totalQty: number;
  readonly goodQty: number;
  /** 불량+폐기+재작업(보류 제외) — 재작업 합격 이동 전 값. */
  readonly ngQty: number;
  readonly holdQty: number;
  readonly reworkGoodQty: number;
}

export const TREND_DAYS = 9;

/** baseDate 를 끝으로 하는 연속 날짜(오름차순). 달력 날짜 산술이라 UTC 로 세도 시간대와 무관하다. */
export function trailingDays(baseDate: string, count: number): string[] {
  const end = Date.parse(`${baseDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * 대시보드의 률(%)은 0~100 이다(사용자 결정 2026-10-19 · 장부 P-59). 정의상 넘을 수 있는 률(성능률·양품률)은
 * 100 에서 자른다 — 넘었다는 사실은 그 카드의 기존 note 가 있으면 그것으로만 알린다.
 */
export function capRate(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function notYet(cardCode: DashboardCardCode, label: string, note?: string): DashboardCard {
  return omitEmpty({ cardCode, label, value: 0, note, valueStatusCode: 'NOT_YET' as const });
}

/**
 * 총생산 = 양품+불량+보류+폐기+재작업. 양품률 = 양품 ÷ 총생산 — 재작업 W/O 에서 합격한 수량은
 * 그 실적이 난 날 NG 에서 양품으로 옮긴다(#116 사용자 결정). 그래서 지난날 NG 의 재작업이
 * 몰린 날은 계산값이 100% 를 넘을 수 있다 — 값은 100 에서 자르고 note 로 알린다(capRate).
 */
export function productionCards(
  byDay: ReadonlyMap<string, DailyProduction>,
  baseDate: string,
): DashboardCard[] {
  const [previousDate] = trailingDays(baseDate, 2);
  const today = byDay.get(baseDate);
  const previous = byDay.get(previousDate);
  const totalQty = today?.totalQty ?? 0;
  const previousQty = previous?.totalQty ?? 0;
  const production: DashboardCard = omitEmpty({
    cardCode: 'PRODUCTION_QTY' as const,
    label: '생산 수량',
    value: totalQty,
    unit: 'EA',
    deltaRatio: previousQty > 0 ? (totalQty - previousQty) / previousQty : undefined,
    valueStatusCode: 'AVAILABLE' as const,
  });
  if (today === undefined || totalQty <= 0) {
    return [production, notYet('YIELD_RATE', '양품률', '생산 실적이 없습니다.')];
  }
  const raw = ((today.goodQty + today.reworkGoodQty) / totalQty) * 100;
  const yieldRate: DashboardCard = omitEmpty({
    cardCode: 'YIELD_RATE' as const,
    label: '양품률',
    value: capRate(raw),
    unit: '%',
    note: raw > 100 ? '재작업 합격분 포함' : undefined,
    valueStatusCode: 'AVAILABLE' as const,
  });
  return [production, yieldRate];
}

export function productionTrend(
  byDay: ReadonlyMap<string, DailyProduction>,
  baseDate: string,
  asOf: string,
): DashboardTrend {
  return {
    seriesName: '일일 생산실적',
    unit: 'EA',
    targetValue: null,
    points: trailingDays(baseDate, TREND_DAYS).map((day) => ({
      label: day.slice(5),
      value: byDay.get(day)?.totalQty ?? 0,
    })),
    asOf,
  };
}

/** 성능률 분자 — Σ(표준 C/T × 생산수량 ÷ 캐비티수), 재작업 W/O 실적 포함. 표준 C/T 나 설비가 없는 실적은 빠진다. */
export interface PerformanceFigures {
  readonly idealSec: number;
  readonly includedResultCount: number;
  readonly excludedResultCount: number;
}

const APPROXIMATE = '표준 C/T 기준 근사값입니다.';

function partialIf(excluded: number): Pick<DashboardCard, 'valueStatusCode' | 'excludedCount'> {
  return excluded > 0 ? { valueStatusCode: 'PARTIAL', excludedCount: excluded } : { valueStatusCode: 'AVAILABLE' };
}

export function availabilityCard(figures: AvailabilityFigures): DashboardCard {
  const label = '시간가동률';
  if (figures.equipmentCount === 0) return notYet('AVAILABILITY_RATE', label, '작업세션이 있는 설비가 없습니다.');
  if (figures.plannedMs === null) {
    return notYet('AVAILABILITY_RATE', label, '근무달력·교대가 등록되지 않은 설비가 있습니다.');
  }
  if (figures.plannedMs <= 0) return notYet('AVAILABILITY_RATE', label, '계획 가동시간이 없습니다.');
  return {
    cardCode: 'AVAILABILITY_RATE',
    label,
    // 분자를 분모와 같은 구간으로 잘라 계산상 100 을 넘지 않는다(DashboardAvailabilityService.actual).
    value: capRate((figures.actualMs / figures.plannedMs) * 100),
    unit: '%',
    note: `계획 가동시간 기준입니다(설비 비가동 집계와 정의가 다릅니다). 작업한 설비 ${figures.equipmentCount}대.`,
    ...partialIf(figures.excludedSessionCount),
  };
}

/** 100% 에서 자른다(사용자 결정 2026-10-19 — 「100% 초과는 그대로 표시」 #118 결정을 대체). */
export function performanceCard(figures: PerformanceFigures, availability: AvailabilityFigures): DashboardCard {
  const label = '성능가동률';
  if (figures.includedResultCount === 0) return notYet('PERFORMANCE_RATE', label, '표준 C/T 가 있는 실적이 없습니다.');
  if (availability.actualMs <= 0) return notYet('PERFORMANCE_RATE', label, '실제 가동시간이 없습니다.');
  return {
    cardCode: 'PERFORMANCE_RATE',
    label,
    value: capRate(((figures.idealSec * 1000) / availability.actualMs) * 100),
    unit: '%',
    note: APPROXIMATE,
    ...partialIf(figures.excludedResultCount),
  };
}

export function oeeCard(parts: readonly DashboardCard[]): DashboardCard {
  const label = 'OEE';
  if (parts.some((card) => card.valueStatusCode === 'NOT_YET')) {
    return notYet('OEE', label, '시간가동률·성능가동률·양품률 중 아직 없는 값이 있습니다.');
  }
  // 세 비율이 이미 0~100 이라 곱도 그 안이다.
  return {
    cardCode: 'OEE',
    label,
    value: parts.reduce((product, card) => product * (card.value / 100), 1) * 100,
    unit: '%',
    note: APPROXIMATE,
    valueStatusCode: parts.some((card) => card.valueStatusCode === 'PARTIAL') ? 'PARTIAL' : 'AVAILABLE',
  };
}

/**
 * 공장 단위 생산 합 — 1차 생산 수량·양품률 카드와 같은 원천·규칙이다(같은 일자 집계를 쓴다).
 * 재작업 합격분은 NG 에서 양품으로 옮긴다. 그래서 지난 NG 의 재작업이 몰린 날은 NG 가 음수일 수 있다 — 수량은 깎지 않고
 * 불량률만 0~100 으로 자른다(capRate · 양품률 카드와 짝).
 */
export function productionSection(byDay: ReadonlyMap<string, DailyProduction>, baseDate: string): DashboardProduction {
  const today = byDay.get(baseDate);
  const totalQty = today?.totalQty ?? 0;
  const ngQty = (today?.ngQty ?? 0) - (today?.reworkGoodQty ?? 0);
  return {
    totalQty,
    goodQty: (today?.goodQty ?? 0) + (today?.reworkGoodQty ?? 0),
    ngQty,
    holdQty: today?.holdQty ?? 0,
    defectRate: totalQty > 0 ? capRate((ngQty / totalQty) * 100) : null,
  };
}
