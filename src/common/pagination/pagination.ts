import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../errors';

/**
 * 목록 응답의 봉투. 계약이 `{ items, page }` 로 균일하다 —
 * `page`·`size` 를 받는 GET **92건 전부**가 이 형태다(실측).
 *
 * ⚠ 계약이 기본값을 **68/92 에만** 선언했고 나머지 24 는 `example` 만 있다. 선언된 값이
 * 서로 다르지 않으므로(page=1 · size=50) 그것을 전건에 쓴다.
 *
 * ⚠ 상한(`maximum: 200`)은 **3자리에만** 선언돼 있다. 그러나 상한 없는 목록 질의는
 * `size=1000000` 한 번으로 서버를 재우므로 전건에 건다 — 계약이 값을 정한 유일한 자리를
 * 따르는 것이고, 넓히는 결정이 아니라 **안전장치**다.
 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_SIZE = 50;
export const MAX_SIZE = 200;

export interface PageRequest {
  page: number;
  size: number;
  /** Prisma 에 그대로 넘긴다. */
  skip: number;
  take: number;
}

export interface PageMeta {
  page: number;
  size: number;
  total: number;
}

export interface PagedResponse<T> {
  items: T[];
  page: PageMeta;
}

/**
 * 질의에서 쪽 요청을 만든다.
 *
 * 계약 검증 가드가 이미 타입을 강제하고 문자열을 숫자로 바꿔 두었으므로(`#94`)
 * 여기서는 «범위»만 본다. 아래쪽 범위를 벗어난 값은 거절하지 않고 자른다 — 계약이
 * `minimum` 을 3자리에만 선언해 400 을 낼 근거가 없고, 목록 조회에서 0쪽·음수쪽은 뜻이 없다.
 *
 * ⚠ 위쪽만 «거절»한다. 계약이 `page` 를 `format: int64` **없이** `type: integer` 로만 적어
 * 계약 검증기의 int64 범위 검사가 이 칸을 지나간다. 그대로 두면 `skip` 이 부풀어 Prisma 가
 * 그것을 int8 로 못 접고 **500** 이 났다(`?page=1e20` 실측). 자르지 않고 거절하는 것은
 * 저장소가 이미 고른 답이다 — `document-issue`·`maintenance/order`·`maintenance/result`
 * 세 조회 서비스가 같은 판정을 «각자» 베껴 두고 있었다(`!Number.isSafeInteger(page.skip)`
 * → 400 `RANGE`). `skip` 을 만드는 자리가 여기 하나뿐이라 여기로 모은다.
 * `size` 는 `MAX_SIZE` 로 이미 잘려 이 문제가 없다.
 */
export function pageRequest(query: { page?: number; size?: number } = {}, maxSize = MAX_SIZE): PageRequest {
  const page = Math.max(DEFAULT_PAGE, Math.trunc(query.page ?? DEFAULT_PAGE) || DEFAULT_PAGE);
  const requested = Math.trunc(query.size ?? DEFAULT_SIZE) || DEFAULT_SIZE;
  const size = Math.min(maxSize, Math.max(1, requested));

  const skip = (page - 1) * size;
  if (!Number.isSafeInteger(skip)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field('page', ERROR_CODE.RANGE, '페이지 범위가 너무 큽니다.'),
    ]);
  }

  return { page, size, skip, take: size };
}

export function pagedResponse<T>(items: T[], total: number, request: PageRequest): PagedResponse<T> {
  return { items, page: { page: request.page, size: request.size, total } };
}
