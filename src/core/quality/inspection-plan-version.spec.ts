import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { inspectionPlanMissing, resolveInspectionPlanVersion } from './inspection-plan-version';

type Row = { id: bigint; plan?: bigint; version?: number };

/** 품목 칸 값(`item_id`)별로 활성 버전을 돌려주는 스텁. `null` 은 「전 품목 공통」이다. 기준을 안 적으면 버전마다 다른 기준이다. */
function stub(byItem: Map<number | null, (bigint | Row)[]>) {
  const asked: (number | null)[] = [];
  const tx = {
    inspection_plan_version: {
      findMany: async ({ where }: { where: { inspection_plan: { item_id: number | null } } }) => {
        asked.push(where.inspection_plan.item_id);
        return (byItem.get(where.inspection_plan.item_id) ?? []).map((row) => {
          const { id, plan = id, version = 1 } = typeof row === 'bigint' ? { id: row } : row;
          return { inspection_plan_version_id: id, inspection_plan_id: plan, plan_version: version };
        });
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, asked };
}

describe('resolveInspectionPlanVersion — 품목 전용 기준만 (omf-all-around#366)', () => {
  it('품목 전용 기준을 쓰고 공통 기준(품목 없음)은 묻지 않는다', async () => {
    const { tx, asked } = stub(new Map([[10, [1n]], [null, [2n]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).resolves.toBe(1n);
    expect(asked).toEqual([10]);
  });

  it.each(['IQC', 'OQC'])('%s 는 품목 전용 기준이 없으면 공통 기준이 있어도 400 이다', async (type) => {
    const { tx, asked } = stub(new Map([[null, [2n]]]));

    await expect(resolveInspectionPlanVersion(tx, type, 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
    expect(asked).toEqual([10]);
  });

  it('한 기준에 확정 버전이 여럿이면 최신 버전을 쓴다 (omf-all-around#208)', async () => {
    const { tx } = stub(new Map([[10, [{ id: 25n, plan: 7n, version: 2 }, { id: 24n, plan: 7n, version: 1 }]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).resolves.toBe(25n);
  });

  it('기준이 둘이면 각 기준의 최신만 세도 여러 개라 400 이다', async () => {
    const { tx } = stub(new Map([[10, [{ id: 25n, plan: 7n, version: 2 }, { id: 24n, plan: 7n, version: 1 }, { id: 30n, plan: 8n }]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
  });
});

describe('inspectionPlanMissing — 기준 없는 품목은 생략 (omf-all-around#366)', () => {
  it.each<[string, Map<number | null, bigint[]>, boolean]>([
    ['품목 전용 기준이 없으면 참(공통 기준은 치지 않는다)', new Map([[null, [2n]]]), true],
    ['하나면 거짓', new Map([[10, [1n]]]), false],
    ['둘 이상이면 거짓(없는 것이 아니다)', new Map([[10, [1n, 3n]]]), false],
  ])('%s', async (_label, byItem, expected) => {
    await expect(inspectionPlanMissing(stub(byItem).tx, 'IQC', 10, '2026-10-16')).resolves.toBe(expected);
  });
});
