import { Prisma } from '@prisma/client';

import { ContractException, ErrorItem } from '../../common/errors';
import { assertInboundLotsClosed, erpLinesOf, inboundGate } from './receipt-gate';
import { GoodsReceiptCreate } from './receipt-posting';

/**
 * 입고 게이트를 서비스 밖 함수로 꺼냈다(피처 009 research R-1) — 웹 입고와 PDA 적치가 같은 판정을 쓴다.
 * 여기서는 «꺼낸 함수»가 지금과 같은 결과를 내는지만 본다. 서비스를 통한 판정은 `goods-receipt-iqc-gate.spec.ts`.
 */
const d = (value: number) => new Prisma.Decimal(value);

const line: GoodsReceiptCreate['lines'][number] = {
  inboundReceiptLineId: 7,
  itemId: 10,
  lotId: 20,
  receiptQty: 5,
  uomId: 1,
  qualityStatusCode: 'NORMAL',
  inventoryStatusCode: 'AVAILABLE',
  destinationLocationId: 1,
};

const input: GoodsReceiptCreate = {
  receiptTypeCode: 'MATERIAL',
  plantId: 1,
  warehouseId: 1,
  receiptDatetime: '2026-11-18T01:00:00.000Z',
  businessDate: '2026-11-18',
  lines: [line],
};

const inboundLot = (status: string) => ({ status_code: status, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 7n });

function db(opts: { isDefect?: boolean; inspectionRequired?: boolean; initialQty?: number; receiving?: string } = {}) {
  return {
    warehouse: { findUnique: async () => ({ is_defect: opts.isDefect ?? false }) },
    inbound_receipt_line: {
      findUnique: async () => ({
        inspection_required: opts.inspectionRequired ?? true,
        received_qty: d(10),
        inbound_lot: { erp_send_mode_code: 'PER_RECEIPT' },
        inbound_receipt_po_allocation: [
          { allocated_qty: d(10), purchase_order_line: { purchase_order: { erp_purchase_order_no: 'ERP-1' } } },
        ],
      }),
    },
    lot: {
      findUnique: async () => inboundLot('NORMAL'),
      findMany: async (args?: { where?: { inbound_lot?: unknown } }) =>
        args?.where?.inbound_lot !== undefined
          ? opts.receiving === undefined
            ? []
            : [{ lot_id: 20n, inbound_lot: { inbound_lot_no: opts.receiving } }]
          : [{ lot_id: 20n, initial_qty: d(opts.initialQty ?? 100) }],
      groupBy: async () => [],
    },
    goods_receipt_line: { groupBy: async () => [] },
    inventory_transaction_line: { groupBy: async () => [] },
    concession: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
}

async function gate(status: string, opts: Parameters<typeof db>[0] = {}, total = 5): Promise<ErrorItem[]> {
  const errors: ErrorItem[] = [];
  await inboundGate(db(opts), 1, 'lines[0]', line, inboundLot(status), d(total), errors);
  return errors;
}

describe('receipt-gate — 입고 게이트 꺼내기(피처 009 R-1, 동작 그대로)', () => {
  it('inboundGate: 합격(NORMAL) 입하 LOT 은 통과한다', async () => {
    expect(await gate('NORMAL')).toEqual([]);
  });

  it('inboundGate: IQC 대상 검사 대기 LOT 은 STATE_LOCKED', async () => {
    expect((await gate('INSPECTION_PENDING')).map((e) => e.code)).toEqual(['STATE_LOCKED']);
  });

  it('inboundGate: 불량 LOT 은 불량창고만 — 일반 창고는 막고 불량창고는 통과', async () => {
    expect((await gate('DEFECTIVE'))[0].message).toContain('불량창고로만');
    expect(await gate('DEFECTIVE', { isDefect: true })).toEqual([]);
  });

  it('inboundGate: 입고 가능 수량을 넘으면 receiptQty 로 막는다(assertReceivable)', async () => {
    const errors = await gate('NORMAL', { initialQty: 3 }, 5);
    expect(errors.map((e) => e.field)).toEqual(['lines[0].receiptQty']);
    expect(errors[0].message).toContain('3 까지');
  });

  it('inboundGate: 입하와 무관한 LOT 은 지나간다', async () => {
    const errors: ErrorItem[] = [];
    await inboundGate(db(), 1, 'lines[0]', line, { status_code: 'INSPECTION_PENDING', source_type_code: 'WORK_ORDER', source_id: 1n }, d(5), errors);
    expect(errors).toEqual([]);
  });

  it('assertInboundLotsClosed: 입하 중 입하 LOT 이면 409 INBOUND_LOT_RECEIVING, 마감됐으면 통과', async () => {
    await expect(assertInboundLotsClosed(db(), input)).resolves.toBeUndefined();
    const error = await assertInboundLotsClosed(db({ receiving: 'IL-1' }), input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getStatus()).toBe(409);
    expect(JSON.stringify((error as ContractException).getResponse())).toContain('INBOUND_LOT_RECEIVING');
  });

  it('erpLinesOf: 이전 흐름 자재 입고는 입하 줄을 돌려준다, 불량창고·자재 아님은 빈 목록', async () => {
    expect(await erpLinesOf(db(), input)).toEqual([7n]);
    expect(await erpLinesOf(db({ isDefect: true }), input)).toEqual([]);
    expect(await erpLinesOf(db(), { ...input, receiptTypeCode: 'PRODUCT' })).toEqual([]);
  });

  it('erpLinesOf: 새 흐름(ON_FINALIZE) 입하 LOT 은 보내지 않는다', async () => {
    const newFlow = db();
    (newFlow.inbound_receipt_line as unknown as { findUnique: () => Promise<unknown> }).findUnique = async () => ({
      received_qty: d(10),
      inbound_lot: { erp_send_mode_code: 'ON_FINALIZE' },
      inbound_receipt_po_allocation: [
        { allocated_qty: d(10), purchase_order_line: { purchase_order: { erp_purchase_order_no: 'ERP-1' } } },
      ],
    });
    expect(await erpLinesOf(newFlow, input)).toEqual([]);
  });
});
