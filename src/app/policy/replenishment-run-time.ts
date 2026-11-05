import { Prisma } from '@prisma/client';

import { RUN_TIME_PATTERN, SCOPES, axisCandidates, winnerOf } from './operation-policy-rules';

/** 공장 정책이 없으면 자동 보충은 공장 현지 01:00 에 돈다(피처 004 · research R-10). */
export const DEFAULT_REPLENISHMENT_RUN_TIME = '01:00';

export interface PlantRunTime {
  runTime: string;
  source: 'POLICY' | 'SERVER_DEFAULT';
}

/**
 * 공장의 자동 보충 실행 시각. `effective()` 와 같은 우선순위로 이기는 정책 하나를 읽고, 없거나 형식이 틀리면 01:00 이다.
 * @param onDate 공장 현지 날짜(YYYY-MM-DD).
 */
export async function plantReplenishmentRunTime(
  tx: Prisma.TransactionClient,
  plantId: number | bigint,
  onDate: string,
): Promise<PlantRunTime> {
  const on = new Date(`${onDate}T00:00:00.000Z`);
  const scope = { plantId: Number(plantId) };
  const rows = await tx.operation_policy.findMany({
    where: {
      policy_code: 'REPLENISHMENT_RUN_TIME',
      effective_from: { lte: on },
      AND: [
        { OR: [{ effective_to: null }, { effective_to: { gte: on } }] },
        ...SCOPES.map(({ column }) => ({ OR: [{ [column]: null }, ...axisCandidates(column, scope)] })),
      ],
    },
  });
  const value = winnerOf(rows)?.value_text;
  return value != null && RUN_TIME_PATTERN.test(value)
    ? { runTime: value, source: 'POLICY' }
    : { runTime: DEFAULT_REPLENISHMENT_RUN_TIME, source: 'SERVER_DEFAULT' };
}
