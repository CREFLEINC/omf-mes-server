import { Prisma } from '@prisma/client';

import { PolicyCode, SCOPES, axisCandidates, winnerOf } from './operation-policy-rules';

/**
 * 공장 범위 글자 정책의 값 — `effective()` 와 같은 우선순위로 이기는 정책 하나. 없으면 `null` 이다(기본값을 지어내지 않는다).
 *
 * @param onDate 공장 현지 날짜(YYYY-MM-DD).
 */
export async function plantPolicyText(
  tx: Pick<Prisma.TransactionClient, 'operation_policy'>,
  policyCode: PolicyCode,
  plantId: number | bigint,
  onDate: string,
): Promise<string | null> {
  const on = new Date(`${onDate}T00:00:00.000Z`);
  const scope = { plantId: Number(plantId) };
  const rows = await tx.operation_policy.findMany({
    where: {
      policy_code: policyCode,
      effective_from: { lte: on },
      AND: [
        { OR: [{ effective_to: null }, { effective_to: { gte: on } }] },
        ...SCOPES.map(({ column }) => ({ OR: [{ [column]: null }, ...axisCandidates(column, scope)] })),
      ],
    },
  });
  return winnerOf(rows)?.value_text ?? null;
}
