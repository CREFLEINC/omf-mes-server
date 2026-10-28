import type { Prisma } from '@prisma/client';

/**
 * LOT 수량(실적 배분 누계)은 정정되지 않은 실적(잎)의 배분만 센다 — 정정본은 원본의 대체값이라 둘 다 세면 두 번 센다.
 * W/O 합계의 잎 규칙(`work-order-progress.ts` 의 `ACTIVE_RESULT_WHERE`)과 같은 규칙의 배분판이다.
 */
export const LIVE_ALLOCATION = {
  production_result: { corrected_by_production_results: { none: {} } },
} satisfies Prisma.production_result_lot_allocationWhereInput;

/** `LIVE_ALLOCATION` 의 SQL 판 — `alias` 는 `production_result_lot_allocation` 의 별칭이다. */
export function liveAllocationSql(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM production.production_result lx WHERE lx.corrects_production_result_id = ${alias}.production_result_id)`;
}
