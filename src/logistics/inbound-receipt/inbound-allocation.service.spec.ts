import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { OutboxService } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { erpReceiptLinesOf } from '../goods-receipt/erp-receipt';
import { InboundAllocationService } from './inbound-allocation.service';

jest.mock('../goods-receipt/erp-receipt', () => ({
  ...jest.requireActual<object>('../goods-receipt/erp-receipt'),
  erpReceiptLinesOf: jest.fn(),
}));

/**
 * e2e 로 보기 어려운 것을 여기서 확정한다 — 잠금의 순서(부모 P/O 를 잡은 «뒤» 라인을 다시 읽는다), 한도 셈,
 * ERP 적재 조건(입고 뒤 + ERP 발주일 때만).
 */

type Args = Record<string, unknown>;
const d = (value: number) => new Prisma.Decimal(value);

interface Options {
  /** 입하 줄 — 받은 수량과 이미 배정된 몫. */
  received?: number;
  allocated?: number[];
  /** 대상 P/O 라인 — 없으면 `null`(없는 라인). */
  target?: null | {
    ordered?: number;
    tolerance?: number;
    received?: number;
    cancelledAt?: Date | null;
    erpNo?: string | null;
    itemId?: bigint;
  };
  /** 그 입하 줄이 ERP 로 가는 입고에 들어갔나. */
  receipted?: boolean;
  /** 빼려는 배정 — 없으면 `null`. */
  allocation?: null | { purchaseOrderLineId: bigint; qty: number };
}

function fake(options: Options = {}) {
  const calls: string[] = [];
  const updates: Args[] = [];
  const created: Args[] = [];
  const deleted: bigint[] = [];
  const target = options.target === undefined ? {} : options.target;
  const line = {
    received_qty: d(options.received ?? 5000),
    item_id: 40n,
    uom_id: 50n,
    inbound_receipt: { plant_id: 30n, supplier_id: 10n },
    inbound_receipt_po_allocation: (options.allocated ?? []).map((qty) => ({ allocated_qty: d(qty) })),
  };
  const orderLine =
    target === null
      ? null
      : {
          purchase_order_line_id: 101n,
          purchase_order_id: 900n,
          item_id: target.itemId ?? 40n,
          uom_id: 50n,
          cancelled_at: target.cancelledAt ?? null,
          ordered_qty: d(target.ordered ?? 5000),
          tolerance_over_qty: d(target.tolerance ?? 0),
          received_qty: d(target.received ?? 0),
          purchase_order: {
            purchase_order_id: 900n,
            plant_id: 30n,
            supplier_id: 10n,
            status_code: 'CONFIRMED',
            erp_purchase_order_no: target.erpNo === undefined ? 'PO-ERP-1' : target.erpNo,
          },
        };
  const tx = {
    inbound_receipt_line: { findUnique: async () => (options.received === -1 ? null : line) },
    purchase_order_line: {
      findUnique: async () => (orderLine === null ? null : { purchase_order_id: orderLine.purchase_order_id }),
      findUniqueOrThrow: async () => {
        calls.push('reread');
        return orderLine;
      },
      update: async (args: Args) => {
        calls.push('update');
        updates.push(args);
        return {};
      },
    },
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(`lock:${sql.join('?').includes('FOR UPDATE') ? values[0] : 'no-lock'}`);
      return [];
    },
    inbound_receipt_po_allocation: {
      create: async (args: Args) => {
        calls.push('create');
        created.push(args);
        return { inbound_receipt_po_allocation_id: 7001n, ...(args.data as Args) };
      },
      findUnique: async () =>
        options.allocation === null || options.allocation === undefined
          ? null
          : {
              inbound_receipt_line_id: 901n,
              purchase_order_line_id: options.allocation.purchaseOrderLineId,
              allocated_qty: d(options.allocation.qty),
            },
      delete: async (args: Args) => {
        calls.push('delete');
        deleted.push((args.where as Args).inbound_receipt_po_allocation_id as bigint);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  const outbox = { enqueue: jest.fn(async () => ({ integrationMessageId: 1n, alreadyQueued: false })) };
  (erpReceiptLinesOf as jest.Mock).mockResolvedValue(
    options.receipted ? [{ goodsReceiptNo: 'GR-1', receiptQty: d(1) }] : [],
  );
  // 트랜잭션 안의 두 동작만 본다 — 경로 메서드(목록·후보·잠금)는 e2e 가 본다.
  const service = new InboundAllocationService({} as unknown as PrismaService, outbox as unknown as OutboxService);
  return { service, tx, outbox, calls, updates, created, deleted };
}

const add = (f: ReturnType<typeof fake>, qty: number, fields?: { target: string; qty: string }) =>
  f.service.add(f.tx, { inboundReceiptLineId: 901n, purchaseOrderLineId: 101n, qty: d(qty), appUserId: 7, fields });

async function failure(promise: Promise<unknown>): Promise<ContractException> {
  try {
    await promise;
  } catch (error) {
    return error as ContractException;
  }
  throw new Error('던지지 않았다');
}

describe('InboundAllocationService.add — 몫을 더한다', () => {
  it('부모 P/O 를 잠근 뒤 라인을 다시 읽고, received_qty 를 올리고, 행을 만든다', async () => {
    const f = fake({ received: 5000, allocated: [4500] });
    const row = await add(f, 500);
    expect(f.calls).toEqual(['lock:900', 'reread', 'update', 'create']);
    expect(f.updates[0]).toMatchObject({
      where: { purchase_order_line_id: 101n },
      data: { received_qty: { increment: d(500) }, updated_by: 7n },
    });
    expect(f.created[0]).toMatchObject({
      data: { inbound_receipt_line_id: 901n, purchase_order_line_id: 101n, allocated_qty: d(500), created_by: 7n },
    });
    expect(row.inbound_receipt_po_allocation_id).toBe(7001n);
  });

  it('받은 수량 중 미배정 몫을 넘으면 RANGE 다 — 5,000 중 4,500 이 배정돼 있으면 501 은 안 된다', async () => {
    const error = await failure(add(fake({ received: 5000, allocated: [4500] }), 501));
    expect(error.errors[0]).toMatchObject({ field: 'qty', code: ERROR_CODE.RANGE });
  });

  it('미배정 몫과 같은 수량은 된다 — 전부 초과였던 줄도 통째로 배정된다', async () => {
    const f = fake({ received: 1000, allocated: [] });
    await expect(add(f, 1000)).resolves.toBeDefined();
  });

  it('발주 + 허용치를 넘으면 QTY_EXCEEDS_ORDERED 다 — 한도는 Decimal 로 본다', async () => {
    const f = fake({ received: 5000, target: { ordered: 100, tolerance: 5, received: 95.5 } });
    const error = await failure(add(f, 9.500001));
    expect(error.errors[0]).toMatchObject({ field: 'qty', code: ERROR_CODE.QTY_EXCEEDS_ORDERED });
    await expect(add(fake({ received: 5000, target: { ordered: 100, tolerance: 5, received: 95.5 } }), 9.5)).resolves.toBeDefined();
  });

  it('0 이하는 INVALID 다 — 표의 CHECK 가 500 으로 새기 전에 막는다', async () => {
    const error = await failure(add(fake(), 0));
    expect(error.errors[0]).toMatchObject({ field: 'qty', code: ERROR_CODE.INVALID });
  });

  it('없는 P/O 라인은 INVALID 다', async () => {
    const error = await failure(add(fake({ target: null }), 1));
    expect(error.errors[0]).toMatchObject({ field: 'purchaseOrderLineId', code: ERROR_CODE.INVALID, message: '없는 P/O 라인입니다.' });
  });

  it('조건이 다른 P/O 라인은 INVALID 다', async () => {
    const error = await failure(add(fake({ target: { itemId: 41n } }), 1));
    expect(error.errors[0]).toMatchObject({ field: 'purchaseOrderLineId', code: ERROR_CODE.INVALID });
  });

  it('없는 입하 줄은 404 다', async () => {
    await expect(add(fake({ received: -1 }), 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 이 짚는 칸은 부르는 쪽이 정한다 — 입하 등록은 lines.{i}.… 로 짚는다', async () => {
    const fields = { target: 'lines.2.purchaseOrderLineId', qty: 'lines.2.receivedQty' };
    const error = await failure(add(fake({ received: 10 }), 11, fields));
    expect(error.errors[0]).toMatchObject({ field: 'lines.2.receivedQty', code: ERROR_CODE.RANGE });
  });

  it('입고 전이면 ERP 로 적재하지 않는다 — 입고가 적재한다', async () => {
    const f = fake({ receipted: false });
    await add(f, 1);
    expect(f.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('입고 뒤에 더한 몫은 그 몫의 구매입고를 바로 적재한다(ALLOC 키)', async () => {
    const f = fake({ receipted: true });
    await add(f, 1);
    expect(f.outbox.enqueue).toHaveBeenCalledWith(f.tx, {
      interfaceCode: 'IF-GR-SEND',
      messageKey: 'IF-GR-SEND:ALLOC:7001',
      targetTypeCode: 'INBOUND_RECEIPT_PO_ALLOCATION',
      targetId: 7001n,
      payload: { inboundReceiptPoAllocationId: 7001 },
    });
  });

  it('MES 에서만 만든 P/O(ERP 번호 없음)는 입고 뒤여도 적재하지 않는다', async () => {
    const f = fake({ receipted: true, target: { erpNo: null } });
    await add(f, 1);
    expect(f.outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('InboundAllocationService.remove — 몫을 뺀다', () => {
  it('부모 P/O 를 잠그고 received_qty 를 되돌린 뒤 행을 지운다', async () => {
    const f = fake({ allocation: { purchaseOrderLineId: 101n, qty: 500 } });
    await f.service.remove(f.tx, 7001n, 7);
    expect(f.calls).toEqual(['lock:900', 'reread', 'update', 'delete']);
    expect(f.updates[0]).toMatchObject({ data: { received_qty: { decrement: d(500) }, updated_by: 7n } });
    expect(f.deleted).toEqual([7001n]);
  });

  it('줄이 ERP 로 가는 입고에 들어갔고 대상이 ERP 발주면 STATE_LOCKED 다 — 그 몫은 구매입고로 갔다', async () => {
    const f = fake({ allocation: { purchaseOrderLineId: 101n, qty: 500 }, receipted: true });
    const error = await failure(f.service.remove(f.tx, 7001n, 7));
    expect(error.errors[0]).toMatchObject({ field: 'inboundReceiptPoAllocationId', code: ERROR_CODE.STATE_LOCKED });
    // 잠근 뒤 판단한다 — 되돌리기·삭제는 없다.
    expect(f.calls).toEqual(['lock:900', 'reread']);
  });

  it('입고 뒤여도 MES 에서만 만든 P/O(ERP 번호 없음)의 몫은 뺄 수 있다 — ERP 로 간 것이 없다', async () => {
    const f = fake({ allocation: { purchaseOrderLineId: 101n, qty: 500 }, receipted: true, target: { erpNo: null } });
    await f.service.remove(f.tx, 7001n, 7);
    expect(f.deleted).toEqual([7001n]);
  });

  it('없는 배정은 404 다', async () => {
    await expect(fake({ allocation: null }).service.remove(fake().tx, 7001n, 7)).rejects.toBeInstanceOf(NotFoundException);
  });
});
