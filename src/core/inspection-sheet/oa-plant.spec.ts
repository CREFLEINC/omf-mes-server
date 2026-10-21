import type { Prisma } from '@prisma/client';

import { oaPlantIds, oaPlantsInScope } from './oa-plant';

/** omf-all-around#89 · 장부 P-102 — 사업부(VIETNAM)가 부품(PL11)·OA(PL13) 공장을 함께 가져 공장 코드로 OA 를 가린다. */
const PLANTS = [
  { plant_id: 1n, business_unit_id: 1n, plant_code: 'PL11' },
  { plant_id: 2n, business_unit_id: 1n, plant_code: 'PL13' },
];

function prisma(codes: string[] = ['PL13']) {
  return {
    code_value: { findMany: jest.fn().mockResolvedValue(codes.map((code) => ({ code }))) },
    plant: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { plant_code: { in: string[] } } }) =>
        Promise.resolve(PLANTS.filter((p) => where.plant_code.in.includes(p.plant_code))),
      ),
    },
  } as unknown as Pick<Prisma.TransactionClient, 'plant' | 'code_value'>;
}

describe('OA 공장 판단', () => {
  it('공통코드 INSPECTION_SHEET_PLANT 의 공장 코드로 OA 공장을 찾는다', async () => {
    await expect(oaPlantIds(prisma())).resolves.toEqual([2n]);
    await expect(oaPlantIds(prisma([]))).resolves.toEqual([]);
  });

  it('OA 공장 범위 계정은 그 공장을 쓴다', async () => {
    await expect(oaPlantsInScope(prisma(), [{ businessUnitId: 1, plantId: 2 }])).resolves.toEqual([2n]);
  });

  it('부품 공장 범위만 있는 계정은 OA 공장이 없다', async () => {
    await expect(oaPlantsInScope(prisma(), [{ businessUnitId: 1, plantId: 1 }])).resolves.toEqual([]);
  });

  it('공장 없이 사업부만 있는 범위는 그 사업부의 모든 공장이다 — OA 공장도 덮는다', async () => {
    await expect(oaPlantsInScope(prisma(), [{ businessUnitId: 1 }])).resolves.toEqual([2n]);
  });

  it('범위가 없으면 OA 공장도 없다', async () => {
    await expect(oaPlantsInScope(prisma(), [])).resolves.toEqual([]);
  });
});
