import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { erpInboundLines, receiptShares } from './erp-receipt';

const d = (value: number) => new Prisma.Decimal(value);
const alloc = (qty: number, erpNo: string | null) => ({
  allocated_qty: d(qty),
  purchase_order_line: { purchase_order: { erp_purchase_order_no: erpNo } },
});

/**
 * 입하 줄 10 은 ERP 발주에, 20 은 MES 발주에 다 배정됐고, 30 은 MES 발주에 일부만 배정돼 미배정이 남았다.
 * LOT 1 은 입하 줄 10 에서, LOT 2 는 그것을 선별로 떼어 낸 자식, LOT 3 은 특채가 적용된 LOT 이다.
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
      findUnique: async (args: { where: { inbound_receipt_line_id: bigint } }) =>
        ({
          '10': { received_qty: d(10), inbound_receipt_po_allocation: [alloc(10, 'ERP-1')] },
          '20': { received_qty: d(10), inbound_receipt_po_allocation: [alloc(10, null)] },
          '30': { received_qty: d(10), inbound_receipt_po_allocation: [alloc(6, null)] },
        })[String(args.where.inbound_receipt_line_id)] ?? null,
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

  it('미배정 몫이 남은 줄은 MES 발주에만 배정됐어도 간다 — 나중에 ERP 발주에 배정되면 이 입고 번호로 간다', async () => {
    expect(await erpInboundLines(fake(), [{ lotId: 1n, inboundReceiptLineId: 30n }])).toEqual([30n]);
  });
});

describe('receiptShares — 입고 수량을 배정 순서대로 채운다', () => {
  const rows = [
    { inbound_receipt_po_allocation_id: 8n, allocated_qty: d(20) },
    { inbound_receipt_po_allocation_id: 5n, allocated_qty: d(80) },
  ];

  it('다 받으면 몫 그대로다', () => {
    expect([...receiptShares(d(100), rows)].map(([id, qty]) => [id, qty.toString()])).toEqual([[5n, '80'], [8n, '20']]);
  });

  it('입고가 적으면 먼저 만든 몫부터 채우고 뒤 몫이 덜 받는다 — id 순이지 넘긴 순서가 아니다', () => {
    expect([...receiptShares(d(90), rows)].map(([id, qty]) => [id, qty.toString()])).toEqual([[5n, '80'], [8n, '10']]);
  });

  it('미배정 몫이 있으면 그것이 마지막이라 배정 몫은 다 채운다', () => {
    expect(receiptShares(d(150), rows).get(8n)?.toString()).toBe('20');
  });
});
