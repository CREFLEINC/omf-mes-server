import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { itemIqcDefaultSkipped, resolveInspectionPlanVersion } from './inspection-plan-version';

/** 품목 칸 값(`item_id`)별로 활성 버전 id 를 돌려주는 스텁. `null` 은 「전 품목 공통」이다. */
function stub(byItem: Map<number | null, bigint[]>) {
  const asked: (number | null)[] = [];
  const tx = {
    inspection_plan_version: {
      findMany: async ({ where }: { where: { inspection_plan: { item_id: number | null } } }) => {
        asked.push(where.inspection_plan.item_id);
        return (byItem.get(where.inspection_plan.item_id) ?? []).map((id) => ({ inspection_plan_version_id: id }));
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
});

describe('itemIqcDefaultSkipped — 품목 전용 IQC 기준의 기본 생략 (omf-all-around#215)', () => {
  const tx = (rows: { inspection_plan: { default_skip: boolean } }[]) => {
    const findMany = jest.fn().mockResolvedValue(rows);
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
});
