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
 * 여기서는 «범위»만 본다. 범위를 벗어난 값은 거절하지 않고 자른다 — 계약이 `minimum` 을
 * 3자리에만 선언해 400 을 낼 근거가 없고, 목록 조회에서 0쪽·음수쪽은 뜻이 없다.
 */
export function pageRequest(query: { page?: number; size?: number } = {}): PageRequest {
  const page = Math.max(DEFAULT_PAGE, Math.trunc(query.page ?? DEFAULT_PAGE) || DEFAULT_PAGE);
  const requested = Math.trunc(query.size ?? DEFAULT_SIZE) || DEFAULT_SIZE;
  const size = Math.min(MAX_SIZE, Math.max(1, requested));

  return { page, size, skip: (page - 1) * size, take: size };
}

export function pagedResponse<T>(items: T[], total: number, request: PageRequest): PagedResponse<T> {
  return { items, page: { page: request.page, size: request.size, total } };
}
