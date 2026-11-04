import { Prisma } from '@prisma/client';

import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { inspectionQty, preparePqcRequest } from './work-order-pqc-request';

/** PQC 의뢰 검사 수량(omf-all-around#201 · 장부 P-141) — 개수 또는 비율(%) 중 하나로 정한다. */
describe('inspectionQty', () => {
  const version = (samplingRatio: number | null, samplingQty: number | null, samplingMethodCode = 'SAMPLE_BY_UNIT') => ({
    inspectionPlanVersionId: 1n,
    samplingMethodCode,
    samplingRatio: samplingRatio === null ? null : new Prisma.Decimal(samplingRatio),
    samplingQty: samplingQty === null ? null : new Prisma.Decimal(samplingQty),
    defaultSkip: false,
  });
  const qty = (order: number, v: ReturnType<typeof version> | null): number => inspectionQty(new Prisma.Decimal(order), v).toNumber();

  it('⭐ 개수로 정한 기준은 그 개수, 지시수량보다 크면 지시수량이다', () => {
    expect(qty(100, version(null, 5))).toBe(5);
    expect(qty(3, version(null, 5))).toBe(3);
  });

  it('비율은 올림하고 최소 1개, 전수·기준 없음은 지시수량이다', () => {
    expect(qty(100, version(3.5, null))).toBe(4);
    expect(qty(10, version(1, null))).toBe(1);
    expect(qty(100, version(null, null, 'FULL_INSPECTION'))).toBe(100);
    expect(qty(100, null)).toBe(100);
  });
});

/** PQC 기준 고르기 — 제품에 붙은 기준, 없으면 「전 품목 공통」(사용자 결정 2026-11-04). */
describe('preparePqcRequest — 제품 PQC 기준', () => {
  const row = (id: bigint) => ({
    inspection_plan_version_id: id,
    inspection_plan_id: id,
    plan_version: 1,
    sampling_method_code: 'FULL_INSPECTION',
    sampling_ratio: null,
    sampling_qty: null,
    inspection_plan: { default_skip: false },
  });
  const run = async (byItem: Map<bigint | null, ReturnType<typeof row>[]>) => {
    const asked: unknown[] = [];
    const prisma = {
      inspection_plan_version: {
        findMany: async ({ where }: { where: { inspection_plan: { item_id: bigint | null } } }) => {
          asked.push(where.inspection_plan);
          return byItem.get(where.inspection_plan.item_id) ?? [];
        },
      },
    } as unknown as PrismaService;
    const numbering = { next: jest.fn().mockResolvedValue('IR-1') } as unknown as NumberingService;
    const plan = await preparePqcRequest(prisma, numbering, {
      inspectionManaged: true, itemId: 10n,
      orderQty: new Prisma.Decimal(100), businessDate: '2026-11-04',
    });
    return { plan, asked };
  };

  it('⭐ 제품 기준을 공정 · 라우팅 조건 없이 찾는다 — 검사할 공정은 라우팅 「검사 관리」가 정한다', async () => {
    const { plan, asked } = await run(new Map([[10n, [row(1n)]], [null, [row(2n)]]]));
    expect(plan?.inspectionPlanVersionId).toBe(1n);
    expect(asked).toEqual([{ inspection_type_code: 'PQC', is_active: true, item_id: 10n }]);
  });

  it('제품 기준이 없으면 공통 기준을 쓴다', async () => {
    const { plan } = await run(new Map([[null, [row(2n)]]]));
    expect(plan?.inspectionPlanVersionId).toBe(2n);
  });

  it('제품 기준이 둘이면 고르지 않는다 — 기준 없는 의뢰', async () => {
    const { plan } = await run(new Map([[10n, [row(1n), row(3n)]]]));
    expect(plan?.inspectionPlanVersionId).toBeNull();
  });

  it('둘 다 없으면 종전처럼 기준 없는 의뢰다', async () => {
    const { plan } = await run(new Map());
    expect(plan?.inspectionPlanVersionId).toBeNull();
  });

  it('검사 관리가 꺼진 공정은 의뢰를 만들지 않는다', async () => {
    const prisma = {} as PrismaService;
    const numbering = { next: jest.fn() } as unknown as NumberingService;
    const plan = await preparePqcRequest(prisma, numbering, {
      inspectionManaged: false, itemId: 10n, orderQty: new Prisma.Decimal(100), businessDate: '2026-11-04',
    });
    expect(plan).toBeNull();
  });
});
