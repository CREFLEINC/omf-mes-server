import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { itemIqcDefaultSkipped, resolveInspectionPlanVersion } from './inspection-plan-version';

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

describe('resolveInspectionPlanVersion — 전 품목 공통 기준 (omf-all-around#101)', () => {
  it('품목 전용 기준이 있으면 그것을 쓰고 공통 기준은 보지 않는다', async () => {
    const { tx, asked } = stub(new Map([[10, [1n]], [null, [2n]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).resolves.toBe(1n);
    expect(asked).toEqual([10]);
  });

  it('품목 전용 기준이 없으면 공통 기준을 쓴다', async () => {
    const { tx } = stub(new Map([[null, [2n]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).resolves.toBe(2n);
  });

  it('둘 다 없으면 종전처럼 400 이다', async () => {
    const { tx } = stub(new Map());

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
  });

  it('OQC 는 공통 기준으로 내려가지 않는다 — 품목 전용 기준이 없으면 종전처럼 400 이다', async () => {
    const { tx, asked } = stub(new Map([[null, [2n]]]));

    await expect(resolveInspectionPlanVersion(tx, 'OQC', 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
    expect(asked).toEqual([10]);
  });

  it('공통 기준이 여러 개면 종전처럼 400 이다', async () => {
    const { tx } = stub(new Map([[null, [2n, 3n]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
  });

  it('한 기준에 확정 버전이 여럿이면 최신 버전을 쓴다 (omf-all-around#208)', async () => {
    const { tx } = stub(new Map([[null, [{ id: 25n, plan: 7n, version: 2 }, { id: 24n, plan: 7n, version: 1 }]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).resolves.toBe(25n);
  });

  it('기준이 둘이면 각 기준의 최신만 세도 여러 개라 400 이다', async () => {
    const { tx } = stub(new Map([[10, [{ id: 25n, plan: 7n, version: 2 }, { id: 24n, plan: 7n, version: 1 }, { id: 30n, plan: 8n }]]]));

    await expect(resolveInspectionPlanVersion(tx, 'IQC', 10, '2026-10-16')).rejects.toBeInstanceOf(ContractException);
  });
});

describe('itemIqcDefaultSkipped — 품목 전용 IQC 기준의 기본 생략 (omf-all-around#215)', () => {
  const tx = (rows: { inspection_plan_id?: bigint; plan_version?: number; inspection_plan: { default_skip: boolean } }[]) => {
    const findMany = jest.fn().mockResolvedValue(rows.map((row, index) => ({ inspection_plan_id: BigInt(index + 1), plan_version: 1, ...row })));
    return { tx: { inspection_plan_version: { findMany } } as unknown as Prisma.TransactionClient, findMany };
  };

  it('품목 전용 기준 하나가 기본 생략이면 참 — 공통 기준(품목 없음)은 묻지 않는다', async () => {
    const { tx: client, findMany } = tx([{ inspection_plan: { default_skip: true } }]);
    await expect(itemIqcDefaultSkipped(client, 10, '2026-10-29')).resolves.toBe(true);
    expect(findMany.mock.calls[0][0].where.inspection_plan).toEqual({ item_id: 10, inspection_type_code: 'IQC', is_active: true });
  });

  it.each([
    ['기본 생략이 아니면', [{ inspection_plan: { default_skip: false } }]],
    ['기준이 없으면', []],
    ['둘 이상이면(고르지 않는다)', [{ inspection_plan: { default_skip: true } }, { inspection_plan: { default_skip: true } }]],
  ])('%s 거짓', async (_label, rows) => {
    await expect(itemIqcDefaultSkipped(tx(rows).tx, 10, '2026-10-29')).resolves.toBe(false);
  });

  it('한 기준의 확정 버전이 여럿이어도 하나로 센다 (omf-all-around#208)', async () => {
    const rows = [1, 2].map((version) => ({ inspection_plan_id: 7n, plan_version: version, inspection_plan: { default_skip: true } }));
    await expect(itemIqcDefaultSkipped(tx(rows).tx, 10, '2026-10-29')).resolves.toBe(true);
  });
});
