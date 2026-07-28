import { Prisma } from '@prisma/client';

/**
 * 멱등 키 UNIQUE 위반인가.
 *
 * 같은 키의 요청 둘이 동시에 들어오면 선제 조회를 둘 다 통과한다 — 진 쪽이 이 오류를
 * 받는다. 이긴 쪽이 만든 결과를 돌려주는 것이 멱등이므로, 전역 필터(409)로 흘려보내지
 * 않고 서비스가 여기서 가로챈다.
 *
 * **다른 UNIQUE 위반과 구분한다** — 채번 중복·회차 중복은 그대로 409가 맞다.
 */
export function isDuplicateIdempotencyKey(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return fields.includes('idempotency_key');
}
