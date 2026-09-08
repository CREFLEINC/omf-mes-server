import { ERROR_CODE, field, one } from '../common/errors';

export interface MaintenanceInstant {
  readonly epochMicroseconds: bigint;
  readonly utcIso: string;
  readonly sqlTimestamp: string;
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[t\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(z|([+-])(\d{2})(?::?(\d{2}))?)$/i;
const MIN_EPOCH_MICROSECONDS = -62_167_219_200_000_000n;
const MAX_EPOCH_MICROSECONDS = 253_402_300_799_999_999n;

function inputError(fieldName: string, code: string): never {
  const message =
    code === ERROR_CODE.INVALID
      ? '유효한 date-time 형식이 아닙니다.'
      : '마이크로초로 보존할 수 없는 시각입니다.';
  throw one(field(fieldName, code, message));
}

function calendarSecond(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): bigint | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return BigInt(date.getTime() / 1000);
}

export function maintenanceInstantFromEpoch(value: string | bigint): MaintenanceInstant {
  if (typeof value !== 'string' && typeof value !== 'bigint') {
    throw new Error('Invalid stored maintenance epoch microseconds');
  }
  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value)) {
    throw new Error('Invalid stored maintenance epoch microseconds');
  }
  let epochMicroseconds: bigint;
  try {
    epochMicroseconds = BigInt(value);
  } catch {
    throw new Error('Invalid stored maintenance epoch microseconds');
  }
  if (
    epochMicroseconds < MIN_EPOCH_MICROSECONDS ||
    epochMicroseconds > MAX_EPOCH_MICROSECONDS
  ) {
    throw new Error('Stored maintenance instant is outside the UTC response range');
  }

  let milliseconds = epochMicroseconds / 1000n;
  let remainingMicroseconds = epochMicroseconds % 1000n;
  if (remainingMicroseconds < 0n) {
    milliseconds -= 1n;
    remainingMicroseconds += 1000n;
  }
  const millisecondIso = new Date(Number(milliseconds)).toISOString();
  const utcIso = `${millisecondIso.slice(0, 23)}${remainingMicroseconds.toString().padStart(3, '0')}Z`;
  const sqlTimestamp =
    utcIso.startsWith('0000-')
      ? `0001-${utcIso.slice(5, -1).replace('T', ' ')}+00 BC`
      : `${utcIso.slice(0, -1).replace('T', ' ')}+00`;
  return { epochMicroseconds, utcIso, sqlTimestamp };
}

export function parseMaintenanceInstant(value: string, fieldName: string): MaintenanceInstant {
  const match = DATE_TIME.exec(value);
  if (!match) inputError(fieldName, ERROR_CODE.INVALID);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] =
    match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = values;
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (hour > 23 || minute > 59 || offsetHour > 23 || offsetMinute > 59) {
    inputError(fieldName, ERROR_CODE.INVALID);
  }
  if (second >= 60) inputError(fieldName, ERROR_CODE.RANGE);
  const localSecond = calendarSecond(year, month, day, hour, minute, second);
  if (localSecond === undefined) inputError(fieldName, ERROR_CODE.INVALID);
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
    inputError(fieldName, ERROR_CODE.RANGE);
  }
  const microseconds = BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  const offsetSign = match[9] === '-' ? -1n : 1n;
  const offsetSeconds = offsetSign * BigInt(offsetHour * 3600 + offsetMinute * 60);
  const epochMicroseconds = (localSecond - offsetSeconds) * 1_000_000n + microseconds;
  try {
    return maintenanceInstantFromEpoch(epochMicroseconds);
  } catch {
    inputError(fieldName, ERROR_CODE.RANGE);
  }
}
