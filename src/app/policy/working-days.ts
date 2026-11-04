import { Prisma } from '@prisma/client';

import { SCOPES, WEEKLY_WORKING_DAYS, WeeklyWorkingDays, axisCandidates, winnerOf } from './operation-policy-rules';

/** 설정하지 않은 공장은 주 5일제로 계산한다(FR-033) — 운영 정책 가운데 이 코드만 서버가 기본값을 쓴다. */
export const DEFAULT_WEEKLY_WORKING_DAYS: WeeklyWorkingDays = 5;

/**
 * 공장의 주간 근무일. `effective()` 와 같은 우선순위로 이기는 정책 하나를 읽고, 없으면 5 다.
 *
 * @param onDate 공장 현지 날짜(YYYY-MM-DD). 설정을 바꿔도 이미 만든 요청의 날짜는 그대로다 — 계산은
 *   요청을 만들 때 한 번이다(FR-033).
 */
export async function weeklyWorkingDays(
  tx: Prisma.TransactionClient,
  plantId: number | bigint,
  onDate: string,
): Promise<WeeklyWorkingDays> {
  const on = new Date(`${onDate}T00:00:00.000Z`);
  const scope = { plantId: Number(plantId) };
  const rows = await tx.operation_policy.findMany({
    where: {
      policy_code: 'WEEKLY_WORKING_DAYS',
      effective_from: { lte: on },
      AND: [
        { OR: [{ effective_to: null }, { effective_to: { gte: on } }] },
        ...SCOPES.map(({ column }) => ({ OR: [{ [column]: null }, ...axisCandidates(column, scope)] })),
      ],
    },
  });
  const value = Number(winnerOf(rows)?.value_numeric);
  return (WEEKLY_WORKING_DAYS as readonly number[]).includes(value)
    ? (value as WeeklyWorkingDays)
    : DEFAULT_WEEKLY_WORKING_DAYS;
}
