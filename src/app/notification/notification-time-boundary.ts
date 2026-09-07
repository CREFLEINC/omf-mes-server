/** PostgreSQL의 마이크로초 격자에서 >= from, < to는 두 경계를 모두 올려야 보존된다. */
export function notificationTimeBoundary(value: string): string {
  // Ajv는 단일 공백류 구분자와 +HHMM/+HH도 받지만 Prisma는 정규 표기가 필요하다.
  const normalized = value
    .replace(/[t\s]/i, 'T')
    .replace(/z$/i, 'Z')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  const match = /^(.+)\.(\d+)(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (match === null || match[2].length <= 6) return normalized;

  const [, seconds, fraction, offset] = match;
  const micros = Number(fraction.slice(0, 6)) + (/[1-9]/.test(fraction.slice(6)) ? 1 : 0);
  if (micros < 1_000_000) {
    return `${seconds}.${String(micros).padStart(6, '0')}${offset}`;
  }
  return `${nextSecond(seconds)}.000000${offset}`;
}

/** 계약 검증을 지난 날짜·시각의 자리만 이월하며 입력 offset을 바꾸지 않는다. */
function nextSecond(value: string): string {
  let [year, month, day, hour, minute, second] = value.split(/\D/).map(Number);
  second += 1;
  if (second >= 60) {
    second -= 60;
    minute += 1;
  }
  if (minute === 60) {
    minute = 0;
    hour += 1;
  }
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) {
    day = 1;
    month += 1;
  }
  if (month === 13) {
    month = 1;
    year += 1;
  }
  const [monthText, dayText, hourText, minuteText, secondText] = [
    month,
    day,
    hour,
    minute,
    second,
  ].map((part) => String(part).padStart(2, '0'));
  return `${String(year).padStart(4, '0')}-${monthText}-${dayText}${value[10]}${hourText}:${minuteText}:${secondText}`;
}
