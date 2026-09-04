import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE } from './error-codes';
import { ErrorItem } from './error-response';

/**
 * Prisma 가 던지는 «알려진» 오류를 계약 봉투로 옮긴다.
 *
 * ⛔ 이것은 **그물이지 검증이 아니다.** 도메인 서비스는 지금처럼 먼저 손으로 막는다 —
 * 그래야 필드 이름과 문구가 그 도메인의 것이 된다(`mold` 의 코드 중복이 그렇다).
 * 여기 걸리는 것은 «빠뜨린 자리»고, 빠뜨린 자리가 500 으로 나가면 화면은 사용자가
 * 고칠 수 있는 입력 오류를 서버 장애로 보인다 — 그게 실제로 나던 증상이다.
 *
 * ⚠ meta 모양은 **실측했다**(Prisma 6.19 · PostgreSQL 16). 짐작하지 않는다.
 *
 * | 코드 | meta | 뜻 |
 * |---|---|---|
 * | `P2003` | `{ constraint: 'mold_plant_id_fkey' }` | 없는 FK — «컬럼이 아니라 제약 이름»이다 |
 * | `P2002` | `{ target: ['plant_id','mold_code'] }` | 유일 위반 — 이쪽은 컬럼 목록이다 |
 * | `P2025` | `{ cause: '...' }` | 대상 행이 없다 |
 *
 * ⛔ CHECK 위반은 여기 오지 않는다 — `PrismaClientUnknownRequestError` 라 알려진 오류가
 * 아니다. 그것은 서비스가 짝 검사를 빠뜨린 «우리» 버그이므로 500 이 맞다.
 */
export function prismaErrorResponse(
  exception: unknown,
): { status: number; errors: ErrorItem[] } | undefined {
  if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const meta = (exception.meta ?? {}) as Record<string, unknown>;

  if (exception.code === 'P2003') {
    return badRequest(fkField(meta.constraint, meta.modelName), {
      code: ERROR_CODE.INVALID,
      message: '참조하는 대상이 없습니다.',
    });
  }

  if (exception.code === 'P2002') {
    const uniqueScope = columns(meta.target).map(camel);
    return badRequest(uniqueScope[0], {
      code: ERROR_CODE.UNIQUE_VIOLATION,
      message: '이미 있는 값입니다.',
      ...(uniqueScope.length === 0 ? {} : { uniqueScope }),
    });
  }

  if (exception.code === 'P2025') {
    // 계약이 code 를 「등」으로 열어 두었고, 필터가 다른 404 에 쓰는 이름과 맞춘다.
    return {
      status: HttpStatus.NOT_FOUND,
      errors: [{ scope: 'screen', code: 'NOT_FOUND', message: '대상을 찾을 수 없습니다.' }],
    };
  }

  return undefined;
}

/** 짚을 필드를 알면 인라인, 모르면 배너다 — 공유계약 `G-1` 이 가른 두 자리. */
function badRequest(
  field: string | undefined,
  rest: Omit<ErrorItem, 'scope' | 'field'>,
): { status: number; errors: ErrorItem[] } {
  const item: ErrorItem =
    field === undefined ? { scope: 'screen', ...rest } : { scope: 'field', field, ...rest };
  return { status: HttpStatus.BAD_REQUEST, errors: [item] };
}

/**
 * `mold_plant_id_fkey` → `plantId`.
 *
 * FK 이름을 Prisma 기본형(`<표>_<컬럼>_fkey`)으로 통일해 두었기에 컬럼을 되뽑을 수 있다.
 * 형태가 다르면 **짚지 않는다** — 틀린 필드를 짚으면 화면이 엉뚱한 칸에 빨간 줄을 그린다.
 */
function fkField(constraint: unknown, modelName: unknown): string | undefined {
  if (typeof constraint !== 'string' || typeof modelName !== 'string') return undefined;
  const prefix = `${modelName}_`;
  const suffix = '_fkey';
  if (!constraint.startsWith(prefix) || !constraint.endsWith(suffix)) return undefined;
  const column = constraint.slice(prefix.length, -suffix.length);
  return column === '' ? undefined : camel(column);
}

/** `target` 은 컬럼 배열로 왔다(실측). 문자열 하나로 오는 판이면 짚지 않는다. */
function columns(target: unknown): string[] {
  return Array.isArray(target) ? target.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * `plant_id` → `plantId`.
 *
 * ⚠ 계약 필드 이름은 `x-source-column` 이 잇는데, 그 잇는 규칙이 대개 이 변환과 같다.
 * 이름을 바꾼 칸(예: 품목의 옛 컬럼)에서는 어긋날 수 있다 — 그래도 500 보다 낫고,
 * 도메인이 손으로 막으면 여기까지 오지 않는다.
 */
function camel(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}
