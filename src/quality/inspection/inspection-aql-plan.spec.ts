import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { acceptanceNumberOf, aqlPlanOf, inspectionAqlPlan } from './inspection-aql-plan';

/** omf-all-around#264 — 의뢰 수량을 LOT 크기로 본 AQL 시료 계획. */
describe('inspectionAqlPlan', () => {
  const prismaOf = (version: object | null) =>
    ({ inspection_plan_version: { findUnique: jest.fn().mockResolvedValue(version) } }) as unknown as PrismaService;
  const request = (qty: number) => ({ inspection_plan_version_id: 1n, target_qty: new Prisma.Decimal(qty) });
  const aqlVersion = { sampling_method_code: 'AQL', aql_value: new Prisma.Decimal(0.4), aql_inspection_level_code: 'G-II' };

  it('AQL 버전이면 의뢰 수량으로 표에서 낸다', async () => {
    await expect(inspectionAqlPlan(prismaOf(aqlVersion), request(770))).resolves.toEqual({
      aqlValue: 0.4,
      aqlInspectionLevelCode: 'G-II',
      codeLetter: 'J',
      sampleSize: 125,
      acceptanceNumber: 1,
      rejectionNumber: 2,
    });
  });

  it('다른 검사 방식이거나 기준 버전이 없으면 없다', async () => {
    await expect(
      inspectionAqlPlan(prismaOf({ ...aqlVersion, sampling_method_code: 'SAMPLE_BY_LOT' }), request(770)),
    ).resolves.toBeNull();
    await expect(
      inspectionAqlPlan(prismaOf(aqlVersion), { inspection_plan_version_id: null, target_qty: new Prisma.Decimal(770) }),
    ).resolves.toBeNull();
  });

  it('자동 판정의 합격판정개수 — AQL 버전이면 표의 Ac, 아니면 버전에 적은 값이다', () => {
    const qty = new Prisma.Decimal(770);
    const aql = { ...aqlVersion, acceptance_number: 0 };
    const sample = { ...aqlVersion, sampling_method_code: 'SAMPLE_BY_LOT', acceptance_number: 0 };
    expect(acceptanceNumberOf(aql, aqlPlanOf(aql, qty))).toBe(1);
    expect(acceptanceNumberOf(sample, aqlPlanOf(sample, qty))).toBe(0);
    expect(acceptanceNumberOf(null, aqlPlanOf(null, qty))).toBeNull();
  });
});
