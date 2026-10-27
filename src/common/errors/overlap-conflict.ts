import { Prisma } from '@prisma/client';

import { ConflictException } from './conflict.exception';

/** 교착·직렬화 실패 — DB 가 한쪽 트랜잭션을 끊은 겹침이라 다시 하면 풀린다. */
const OVERLAP_SQLSTATES = new Set(['40001', '40P01']);

/**
 * 잠금 순서가 다른 경로끼리 같은 행에서 겹쳐 DB 가 끊은 트랜잭션을 409 로 바꾼다 — 500 이 아니라 재시도 안내다.
 * 서로 반대 순서인 경로를 다 맞출 수 없는 자리(예: 피킹은 지시 라인 → 잔액, 출하 등록은 잔액 → 지시 라인)에서 쓴다.
 */
export async function overlapsAsConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isOverlap(error)) throw error;
    throw new ConflictException('user', '다른 작업과 겹쳤습니다 — 잠시 뒤 다시 시도하세요.');
  }
}

export function isOverlap(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2034' || OVERLAP_SQLSTATES.has(String((error.meta ?? {}).code ?? ''));
  }
  if (typeof error !== 'object' || error === null) return false;
  return OVERLAP_SQLSTATES.has(String((error as { code?: unknown }).code ?? ''));
}
