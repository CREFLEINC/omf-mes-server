import { ERROR_CODE, field, one } from '../errors';

/**
 * 선택 칸을 Prisma `data` 에 넣을지 말지 가른다.
 *
 * `undefined` 는 「본문에 없었다」이고 `null` 은 「비우라고 보냈다」다. 계약이 둘을
 * 갈라 쓰므로(`type: ["integer","null"]` 이면서 required 가 아닌 칸들) 여기서도 가른다 —
 * `undefined` 를 그대로 넘기면 Prisma 가 무시하지만, 그 사실에 기대면 `null` 을 보낸
 * 요청이 조용히 무시되는 날이 온다.
 */
export function optional<T>(column: string, value: T | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [column]: value };
}

/** `@db.Date` 칸. 계약은 `format: date` 문자열로 주고받는다. */
export function optionalDate(
  column: string,
  value: string | null | undefined,
): Record<string, unknown> {
  if (value === undefined) return {};
  return { [column]: value === null ? null : new Date(value) };
}

/** `@db.Date` 를 계약의 `format: date` 로 되돌린다 — 시각을 붙이면 어긋난다. */
export function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** 계약의 `format: date` 문자열을 `@db.Date` 값으로 — 형식이 아니면 400. 시각·타임존을 붙이지 않는다. */
export function day(name: string, value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw one(field(name, ERROR_CODE.INVALID, 'YYYY-MM-DD 형식입니다.'));
}
