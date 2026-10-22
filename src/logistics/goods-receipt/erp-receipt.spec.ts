import { PrismaService } from '../../prisma/prisma.service';
import { erpInboundLines } from './erp-receipt';

/**
 * 입하 줄 10 은 ERP 발주에, 20 은 MES 발주에 이어졌다. LOT 1 은 입하 줄 10 에서, LOT 2 는 그것을 선별로 떼어 낸 자식,
 * LOT 3 은 특채가 적용된 LOT 이다.
 */
function fake(): PrismaService {
  const lots: Record<string, { source_type_code: string; source_id: bigint; parent_lot_id: bigint | null }> = {
    '1': { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 10n, parent_lot_id: null },
    '2': { source_type_code: 'LOT_SPLIT', source_id: 0n, parent_lot_id: 1n },
    '3': { source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 10n, parent_lot_id: null },
    '4': { source_type_code: 'WORK_ORDER', source_id: 9n, parent_lot_id: null },
  };
  return {
    concession: { findMany: async () => [{ lot_id: 3n }] },
    lot: { findUnique: async (args: { where: { lot_id: bigint } }) => lots[String(args.where.lot_id)] ?? null },
    inbound_receipt_line: {
      count: async (args: { where: { inbound_receipt_line_id: bigint } }) => (args.where.inbound_receipt_line_id === 10n ? 1 : 0),
    },
  } as unknown as PrismaService;
}

describe('erpInboundLines', () => {
  it('ERP 발주에 이어진 입하 줄만 — 줄의 입하 연결이 없으면 LOT 의 조상을 따른다', async () => {
    const found = await erpInboundLines(fake(), [
      { lotId: 1n, inboundReceiptLineId: 10n },
      { lotId: 2n, inboundReceiptLineId: null },
      { lotId: 1n, inboundReceiptLineId: 20n },
      { lotId: 4n, inboundReceiptLineId: null },
    ]);

    expect(found).toEqual([10n, 10n, null, null]);
  });

  it('특채가 적용된 LOT 은 ERP 로 가지 않는다 — 합격품 한정', async () => {
    expect(await erpInboundLines(fake(), [{ lotId: 3n, inboundReceiptLineId: 10n }])).toEqual([null]);
  });
});
