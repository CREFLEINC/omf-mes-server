import { Prisma } from '@prisma/client';

import { iqcRecordFlags } from './inbound-receipt.service';
import type { InboundReceiptLineWriteInput } from './inbound-receipt-rules';

/** omf-all-around#366 — 모든 입하가 IQC 기록(검사 요청 또는 생략) 대상이다(사용자 결정 2026-11-27). */
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
  it.each<[string, boolean]>([
    ['수입검사 대상 품목', true],
    ['수입검사 대상이 아닌 품목(기준 유무와 무관 · 생략 기록)', false],
  ])('%s 은 대상이고 기준을 묻지 않는다', async (_label, required) => {
    const { client, findMany } = tx({ 40: required }, []);
    expect((await iqcRecordFlags(client, [line(40)], '2026-10-29')).get(40n)).toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('업무일자가 없으면 품목 값만 본다', async () => {
    const { client, findMany } = tx({ 41: false }, [41]);
    expect((await iqcRecordFlags(client, [line(41)], undefined)).get(41n)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });
});
