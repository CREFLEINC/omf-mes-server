import { Prisma } from '@prisma/client';

import { iqcRecordFlags } from './inbound-receipt.service';
import type { InboundReceiptLineWriteInput } from './inbound-receipt-rules';

/** omf-all-around#215 — 품목 「수입검사 대상」이 꺼져 있어도 품목 전용 IQC 기준이 기본 생략이면 생략 기록 대상이다. */
const line = (itemId: number) => ({ itemId }) as unknown as InboundReceiptLineWriteInput;

function tx(required: Record<number, boolean>, skipPlanItems: number[]) {
  const findMany = jest.fn(async ({ where }: { where: { inspection_plan: { item_id: number } } }) =>
    skipPlanItems.includes(where.inspection_plan.item_id) ? [{ inspection_plan: { default_skip: true } }] : [],
  );
  return {
    client: {
      item: {
        findMany: async () =>
          Object.entries(required).map(([id, on]) => ({ item_id: BigInt(id), inspection_required: on })),
      },
      inspection_plan_version: { findMany },
    } as unknown as Prisma.TransactionClient,
    findMany,
  };
}

describe('입하 IQC 기록 대상 (omf-all-around#215)', () => {
  it('수입검사 대상 품목은 그대로 대상이고 기준을 묻지 않는다', async () => {
    const { client, findMany } = tx({ 40: true }, []);
    expect((await iqcRecordFlags(client, [line(40)], '2026-10-29')).get(40n)).toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('수입검사 대상이 아니어도 품목 전용 IQC 기준이 기본 생략이면 대상(생략 기록)이다', async () => {
    const { client } = tx({ 41: false }, [41]);
    expect((await iqcRecordFlags(client, [line(41)], '2026-10-29')).get(41n)).toBe(true);
  });

  it('수입검사 대상이 아니고 기본 생략 전용 기준도 없으면 종전처럼 대상이 아니다', async () => {
    const { client } = tx({ 42: false }, []);
    expect((await iqcRecordFlags(client, [line(42)], '2026-10-29')).get(42n)).toBe(false);
  });

  it('업무일자가 없으면 품목 값만 본다', async () => {
    const { client, findMany } = tx({ 41: false }, [41]);
    expect((await iqcRecordFlags(client, [line(41)], undefined)).get(41n)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
