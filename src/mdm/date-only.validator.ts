import { registerDecorator } from 'class-validator';

/**
 * `@db.Date` 컬럼이다 — `2026-08-07` 형태만 받는다.
 *
 * `IsDateString` 을 쓰면 안 된다. `2026-01-01T00:00:00Z`(시각 포함)도, `2026-02-30`
 * (없는 날)도 통과한다 — 확인해봤다. 앞은 타임존을 태워 하루를 밀 수 있고, 뒤는
 * Prisma 를 지나 DB 에서 터져 500 이 된다.
 *
 * 형태를 정규식으로 보고, 그 문자열이 **왕복해서 그대로 나오는지**로 실재하는 날인지
 * 본다 — `2026-02-30` 은 `2026-03-02` 로 굴러가 걸린다.
 */
export function IsDateOnly() {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isDateOnly(value),
        defaultMessage: () => 'YYYY-MM-DD 형태의 실재하는 날짜여야 합니다.',
      },
    });
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
