const DAY_MS = 24 * 60 * 60 * 1000;

/** 0 = 일요일. 주 5일제는 월~금, 주 6일제는 월~토가 근무일이다. 공휴일·근무달력은 보지 않는다(spec 가정). */
export function isWorkingDay(date: Date, weeklyWorkingDays: 5 | 6): boolean {
  const weekday = date.getUTCDay();
  return weekday !== 0 && (weeklyWorkingDays === 6 || weekday !== 6);
}

/**
 * 출고 작업일 — 생산일에서 근무일만 `n` 일 거슬러 간 날(기본 1 = 직전 근무일). 생산일이 휴일이어도 그 앞
 * 근무일이다.
 *
 * 날짜는 공장 현지 날짜(YYYY-MM-DD)로 주고받는다. 요일은 그 문자열의 달력 날짜로만 세므로 시간대 변환이 없다.
 */
export function issueWorkDate(productionDate: string, weeklyWorkingDays: 5 | 6, n = 1): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(productionDate)) throw new Error(`YYYY-MM-DD 가 아니다: ${productionDate}`);
  let date = new Date(`${productionDate}T00:00:00.000Z`);
  for (let counted = 0; counted < n; ) {
    date = new Date(date.getTime() - DAY_MS);
    if (isWorkingDay(date, weeklyWorkingDays)) counted += 1;
  }
  return date.toISOString().slice(0, 10);
}
