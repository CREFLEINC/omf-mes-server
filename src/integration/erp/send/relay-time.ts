/**
 * 중계 표의 datetime 칸에 넣을 공장 현지 시각 `YYYY-MM-DD HH:mm:ss` — 시간대 없는 칸이라 문자열로 넘긴다
 * (mssql 드라이버는 Date 를 UTC 로 바꿔 넣는다). 현지 시각은 고객 답(질문 9) 전까지의 기준이다.
 */
export function relayDateTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
