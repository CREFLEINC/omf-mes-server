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

/** PQC 대상은 품목이다 — 품목 전용 PQC 기준이 있는 품목만, 「전 품목 공통」은 쓰지 않는다(사용자 결정 2026-11-05). */
describe('preparePqcRequest — 품목 PQC 대상', () => {
  const row = (id: bigint) => ({
    inspection_plan_version_id: id,
    inspection_plan_id: id,
    plan_version: 1,
    sampling_method_code: 'FULL_INSPECTION',
    sampling_ratio: null,
    sampling_qty: null,
    inspection_plan: { default_skip: false },
  });
  const run = async (targeted: number, versions: ReturnType<typeof row>[]) => {
    const asked: unknown[] = [];
    const counted: unknown[] = [];
    const prisma = {
      inspection_plan: {
        count: async ({ where }: { where: unknown }) => {
          counted.push(where);
          return targeted;
        },
      },
      inspection_plan_version: {
        findMany: async ({ where }: { where: { inspection_plan: unknown } }) => {
          asked.push(where.inspection_plan);
          return versions;
        },
      },
    } as unknown as PrismaService;
    const numbering = { next: jest.fn().mockResolvedValue('IR-1') } as unknown as NumberingService;
    const plan = await preparePqcRequest(prisma, numbering, {
      itemId: 10n, orderQty: new Prisma.Decimal(100), businessDate: '2026-11-04',
    });
    return { plan, asked, counted, numbering };
  };

  it('⭐ 품목 전용 기준이 있으면 그 기준으로 의뢰를 만든다 — 공정 · 라우팅 · 공통 기준 조건 없이', async () => {
    const { plan, asked, counted } = await run(1, [row(1n)]);
    expect(plan?.inspectionPlanVersionId).toBe(1n);
    expect(counted).toEqual([{ inspection_type_code: 'PQC', is_active: true, item_id: 10n }]);
    expect(asked).toEqual([{ inspection_type_code: 'PQC', is_active: true, item_id: 10n }]);
  });

  it('품목 전용 기준이 없으면 의뢰를 만들지 않는다 — 「전 품목 공통」 기준이 있어도', async () => {
    const { plan, asked, numbering } = await run(0, [row(2n)]);
    expect(plan).toBeNull();
    expect(asked).toEqual([]);
    expect(numbering.next).not.toHaveBeenCalled();
  });

  it('제품 기준 버전이 둘이면 고르지 않는다 — 기준 없는 의뢰', async () => {
    const { plan } = await run(1, [row(1n), row(3n)]);
    expect(plan?.inspectionPlanVersionId).toBeNull();
  });

  it('기준에 유효한 확정 버전이 없으면 종전처럼 기준 없는 의뢰다', async () => {
    const { plan } = await run(1, []);
    expect(plan?.inspectionPlanVersionId).toBeNull();
  });
});
