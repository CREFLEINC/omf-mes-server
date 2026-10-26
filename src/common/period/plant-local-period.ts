import { ERROR_CODE, field, one } from '../errors';

/** 현황·추적 목록이 한 번에 훑는 기간의 상한 — 기간 없이 부르면 표 전체를 훑는다. */
export const MAX_PERIOD_DAYS = 366;

export interface PeriodFields {
  /** 질의 칸 이름(오류가 짚는 칸) */
  from: string;
  to: string;
  /** 문구에 쓰는 이름 — 「입고일」·「출하일」 */
  label: string;
}

export interface LocalPeriod {
  from: string;
  to?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 공장 현지 날짜 기간을 받는다. 시작은 필수, 종료는 선택(없으면 오늘까지로 길이를 잰다), 양 끝 포함.
 * 형식(YYYY-MM-DD)은 계약 검증이 이미 봤다.
 */
export function localPeriod(from: string | undefined, to: string | undefined, fields: PeriodFields, today = new Date()): LocalPeriod {
  if (from === undefined) {
    throw one(field(fields.from, ERROR_CODE.REQUIRED,
      `${fields.label} 시작(${fields.from})이 비었습니다. 시작일을 넣어 다시 조회하세요 — 기간은 최대 ${MAX_PERIOD_DAYS}일입니다.`));
  }
  if (to !== undefined && to < from) {
    throw one(field(fields.to, ERROR_CODE.INVALID,
      `${fields.label} 종료(${to})가 시작(${from})보다 앞섭니다. 종료일을 시작일 이후로 고쳐 다시 조회하세요.`));
  }
  const end = to ?? today.toISOString().slice(0, 10);
  const days = Math.round((Date.parse(end) - Date.parse(from)) / DAY_MS) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw one(field(to === undefined ? fields.from : fields.to, ERROR_CODE.RANGE,
      `${fields.label} 기간이 ${days}일입니다. ${MAX_PERIOD_DAYS}일 이내로 줄여 다시 조회하세요` +
        (to === undefined ? ' — 종료일을 넣지 않으면 오늘까지로 셉니다.' : '.')));
  }
  return to === undefined ? { from } : { from, to };
}

/**
 * `column` 이 공장 현지 날짜로 기간 안인가. `timezone` 은 행마다 공장 시간대를 내는 SQL 식이다 —
 * 한 목록에 공장이 섞일 수 있어 요청 하나를 시간대 하나로 접지 않는다.
 * ⭐ 앞의 두 조건은 시간대와 무관한 UTC 하루 여유 경계다. 행마다 시간대가 다른 식만 두면 인덱스 범위 검색을 못 탄다.
 */
export function localPeriodSql(column: string, timezone: string, period: LocalPeriod, bind: (value: unknown) => string): string {
  const from = bind(period.from);
  const and = [
    `${column} >= ((${from}::date - 1)::timestamp AT TIME ZONE 'UTC')`,
    `${column} >= ((${from}::date)::timestamp AT TIME ZONE ${timezone})`,
  ];
  if (period.to !== undefined) {
    const to = bind(period.to);
    and.push(
      `${column} < ((${to}::date + 2)::timestamp AT TIME ZONE 'UTC')`,
      `${column} < ((${to}::date + 1)::timestamp AT TIME ZONE ${timezone})`,
    );
  }
  return and.join(' AND ');
}
