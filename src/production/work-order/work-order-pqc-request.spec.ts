import { Prisma } from '@prisma/client';

import { inspectionQty } from './work-order-pqc-request';

/** PQC 의뢰 검사 수량(omf-all-around#201 · 장부 P-141) — 개수 또는 비율(%) 중 하나로 정한다. */
describe('inspectionQty', () => {
  const version = (samplingRatio: number | null, samplingQty: number | null, samplingMethodCode = 'SAMPLE_BY_UNIT') => ({
    inspectionPlanVersionId: 1n,
    samplingMethodCode,
    samplingRatio: samplingRatio === null ? null : new Prisma.Decimal(samplingRatio),
    samplingQty: samplingQty === null ? null : new Prisma.Decimal(samplingQty),
    pqcSkipAllowed: false,
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
