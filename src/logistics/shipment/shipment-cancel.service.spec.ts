import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { ReverseInput } from '../../core/inventory-posting/posting.types';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ShipmentCancelService } from './shipment-cancel.service';
import { ShipmentQueryService } from './shipment-query.service';

/** ⭐ 값을 벌린다 — 출하·출고·입고·지시 라인·예약 id 가 같으면 칸을 뒤바꿔도 초록이다. */
const SHIPMENT_ID = 8101;
const ISSUE_ID = 8202n;
const RECEIPT_ID = 8303n;
const REQUEST_LINE_ID = 8404n;
const SALES_LINE_ID = 8505n;
const ITEM_ID = 8606n;
const LOT_ID = 8707n;
const USER_ID = 9;
const VERSION = 3;
const ISSUE_TX = 111n;
const RECEIPT_TX = 222n;
/** ⭐ 원 영업일과 본문 영업일을 «다른 날»로 둔다 — 역전기가 어느 쪽을 쓰는지가 드러난다. */
const ORIGINAL_DAY = '2026-09-01';
const BODY_DAY = '2026-09-02';

type Row = Record<string, unknown>;

interface Seed {
  status?: string;
  version?: number;
  openCancel?: boolean;
  approvals?: string[];
  expedited?: boolean;
  /** 한 (지시 라인, LOT) 에 매달린 예약 행들의 소진량 — 「예약 둘」 축(R-13). */
  reservations?: number[];
  allocated?: number;
  salesLine?: boolean;
}

function build(seed: Seed = {}) {
  const order: string[] = [];
  const reversed: ReverseInput[] = [];
  const released: { id: bigint; qty: string }[] = [];
  const updates: Record<string, Row[]> = {};
  const requested: Row[] = [];
  const record = (table: string) => (args: Row) => {
    order.push(`${table}.update`);
    (updates[table] ??= []).push(args);
    return Promise.resolve(table === 'shipment_request_line' ? { sales_order_line_id: seed.salesLine === false ? null : SALES_LINE_ID } : {});
  };
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) {
        order.push('lock');
        return Promise.resolve([{
          shipment_id: BigInt(SHIPMENT_ID), shipment_no: 'SH-20260901-0009', shipment_request_id: 1n,
          warehouse_id: 2n, shipped_at: null, status_code: seed.status ?? 'UNCONFIRMED',
          version_no: seed.version ?? VERSION,
        }]);
      }
      // releaseReservation 의 UPDATE — 값 순서: consumed −qty · released +qty · id · item
      order.push('releaseReservation');
      const decimals = values.filter((value) => value instanceof Prisma.Decimal) as Prisma.Decimal[];
      const id = values.find((value) => typeof value === 'bigint') as bigint;
      released.push({ id, qty: decimals[0].toString() });
      return Promise.resolve([{ inventory_reservation_id: id }]);
    },
    approval_request: {
      findFirst: () => Promise.resolve(seed.openCancel === true ? { approval_request_id: 1n } : null),
      findMany: () => Promise.resolve((seed.approvals ?? ['APPROVED']).map((status_code) => ({ status_code }))),
    },
    goods_issue: {
      findFirst: () => Promise.resolve({ goods_issue_id: ISSUE_ID }),
      update: record('goods_issue'),
    },
    goods_receipt: {
      findFirst: () => Promise.resolve(seed.expedited === true ? { goods_receipt_id: RECEIPT_ID } : null),
      update: record('goods_receipt'),
    },
    inventory_transaction: {
      findMany: ({ where }: { where: { source_document_type_code: string } }) =>
        Promise.resolve([{
          inventory_transaction_id: where.source_document_type_code === 'GOODS_ISSUE' ? ISSUE_TX : RECEIPT_TX,
          business_date: new Date(`${ORIGINAL_DAY}T00:00:00.000Z`),
        }]),
    },
    shipment_lot_allocation: {
      findMany: () => Promise.resolve([{
        lot_id: LOT_ID,
        allocated_qty: new Prisma.Decimal(seed.allocated ?? 10),
        shipment_line: { shipment_request_line_id: REQUEST_LINE_ID, item_id: ITEM_ID },
      }]),
    },
    inventory_reservation: {
      findMany: () => Promise.resolve((seed.reservations ?? [10]).map((consumed, index) => ({
        inventory_reservation_id: 9000n + BigInt(index), consumed_qty: new Prisma.Decimal(consumed),
      }))),
    },
    shipment_line: {
      findMany: () => Promise.resolve([{ shipment_request_line_id: REQUEST_LINE_ID, shipped_qty: new Prisma.Decimal(10) }]),
    },
    shipment_request_line: { update: record('shipment_request_line') },
    sales_order_line: { update: record('sales_order_line') },
    shipment: { update: record('shipment') },
  };
  const prisma = { $transaction: (run: (t: unknown) => Promise<unknown>) => run(tx) } as unknown as PrismaService;
  const approvals = {
    request: (_tx: unknown, input: Row) => {
      order.push('approvals.request');
      requested.push(input);
      return Promise.resolve({ approvalRequestId: 1n });
    },
  } as unknown as ApprovalService;
  const numbering = { next: () => Promise.resolve('AP-20260910-0001') } as unknown as NumberingService;
  const posting = {
    reverse: (_tx: unknown, input: ReverseInput) => {
      order.push(`reverse:${input.inventoryTransactionId}`);
      reversed.push(input);
      return Promise.resolve({ inventoryTransactionId: 1n, transactionNo: 'X-R', businessDate: input.businessDate, alreadyReversed: false });
    },
  } as unknown as InventoryPostingService;
  const queries = { get: () => Promise.resolve({ view: {}, versionNo: VERSION + 1 }) } as unknown as ShipmentQueryService;
  const service = new ShipmentCancelService(prisma, approvals, numbering, new DocumentStateService(), posting, queries);
  return { service, order, reversed, released, updates, requested };
}

const body = { businessDate: BODY_DAY, occurredAt: '2026-09-02T05:00:00.000Z', remarks: '버린다' };

async function caught<T>(run: () => Promise<unknown>): Promise<T> {
  try {
    await run();
  } catch (error) {
    return error as T;
  }
  throw new Error('던지지 않았다');
}

describe('출하 취소 상신 — :request-cancel', () => {
  it('⭐ SHIPMENT_CANCEL 결재를 이 출하에 세우고 사유 원문을 싣는다 — 출하 상태는 «안» 옮긴다', async () => {
    const { service, requested, updates } = build();

    await service.requestCancel(SHIPMENT_ID, VERSION, { reason: '고객 요청' }, USER_ID);

    expect(requested[0]).toMatchObject({
      approvalTypeCode: 'SHIPMENT_CANCEL',
      targetTypeCode: 'SHIPMENT',
      targetId: BigInt(SHIPMENT_ID),
      requestedBy: BigInt(USER_ID),
      reason: '고객 요청',
    });
    // 시드 3값에 CANCEL_REQUESTED 가 없다 — 옮길 상태가 없다.
    expect(updates.shipment).toBeUndefined();
  });

  it('⭐ 재상신은 코어보다 «먼저» 409 CANCEL_IN_PROGRESS 다 — 코어는 400 APPROVAL_IN_PROGRESS 를 낸다', async () => {
    const { service, order } = build({ openCancel: true, version: VERSION + 9 });

    const failure = await caught<ConflictException>(() =>
      service.requestCancel(SHIPMENT_ID, VERSION, { reason: '다시' }, USER_ID),
    );

    expect(failure.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(failure.conflict.code).toBe('CANCEL_IN_PROGRESS');
    expect(order).not.toContain('approvals.request');
  });

  it('⛔ 확정된 출하는 409 ALREADY_CONFIRMED — 「미확정 구간에서만 된다」', async () => {
    const { service } = build({ status: 'CONFIRMED' });

    const failure = await caught<ConflictException>(() =>
      service.requestCancel(SHIPMENT_ID, VERSION, { reason: 'x' }, USER_ID),
    );

    expect(failure.conflict.code).toBe('ALREADY_CONFIRMED');
  });
});

describe('출하 취소 실행 — :cancel', () => {
  it('⭐⭐ 승인 요청이 «0건»이면 400 APPROVAL_REQUIRED — 코어 assertApproved 는 이때 통과시킨다', async () => {
    const { service, order } = build({ approvals: [] });

    const failure = await caught<ContractException>(() => service.cancel(SHIPMENT_ID, VERSION, body, USER_ID));

    expect(failure.getStatus()).toBe(400);
    expect(failure.errors[0]).toMatchObject({ code: 'APPROVAL_REQUIRED', scope: 'screen' });
    expect(order.some((step) => step.startsWith('reverse'))).toBe(false);
  });

  it('승인 대기뿐이면 400 APPROVAL_IN_PROGRESS · 반려뿐이면 APPROVAL_REQUIRED', async () => {
    const pending = await caught<ContractException>(() =>
      build({ approvals: ['PENDING'] }).service.cancel(SHIPMENT_ID, VERSION, body, USER_ID),
    );
    const rejected = await caught<ContractException>(() =>
      build({ approvals: ['REJECTED'] }).service.cancel(SHIPMENT_ID, VERSION, body, USER_ID),
    );

    expect(pending.errors[0].code).toBe('APPROVAL_IN_PROGRESS');
    expect(rejected.errors[0].code).toBe('APPROVAL_REQUIRED');
  });

  it('⭐ J-8 — 그 사이 확정됐으면 409 ALREADY_CONFIRMED 이고 원장을 안 건드린다', async () => {
    const { service, order } = build({ status: 'CONFIRMED', version: VERSION + 5 });

    const failure = await caught<ConflictException>(() => service.cancel(SHIPMENT_ID, VERSION, body, USER_ID));

    expect(failure.conflict.code).toBe('ALREADY_CONFIRMED');
    expect(order.some((step) => step.startsWith('reverse'))).toBe(false);
  });

  it('⭐⭐ 역전기는 «원» 영업일을 쓴다 — 본문 영업일이 달라도 거절하지 않는다(문의 032 · R-8)', async () => {
    const { service, reversed } = build();

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    expect(reversed[0]).toMatchObject({ inventoryTransactionId: ISSUE_TX, businessDate: ORIGINAL_DAY, createdBy: USER_ID });
    expect(reversed[0].businessDate).not.toBe(BODY_DAY);
    expect(reversed[0].occurredAt).toEqual(new Date(body.occurredAt));
  });

  it('⭐⭐ 긴급 직행은 역전기가 «둘»이고 출고 역이 입고 역보다 먼저다', async () => {
    const { service, order, updates } = build({ expedited: true });

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    expect(order.filter((step) => step.startsWith('reverse'))).toEqual([`reverse:${ISSUE_TX}`, `reverse:${RECEIPT_TX}`]);
    expect(updates.goods_receipt?.[0]).toMatchObject({ data: { status_code: 'CANCELLED' } });
  });

  it('평시는 역전기가 하나이고 입고 전표를 안 건드린다', async () => {
    const { service, order, updates } = build();

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    expect(order.filter((step) => step.startsWith('reverse'))).toEqual([`reverse:${ISSUE_TX}`]);
    expect(updates.goods_receipt).toBeUndefined();
    expect(updates.goods_issue?.[0]).toMatchObject({ data: { status_code: 'CANCELLED' } });
  });

  it('⭐⭐ 예약이 «둘»이면 소진분이 남은 행부터 배분 수량을 나눠 푼다(R-13)', async () => {
    const { service, released } = build({ reservations: [6, 7], allocated: 10 });

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    // 첫 행에서 6 · 둘째 행에서 남은 4. ⛔ 둘째에서 7 을 다 풀면 소진하지 않은 양까지 풀린다.
    expect(released).toEqual([
      { id: 9000n, qty: '6' },
      { id: 9001n, qty: '4' },
    ]);
  });

  it('예약이 없는 배분(긴급 직행 등)은 되돌릴 것이 없다', async () => {
    const { service, released } = build({ reservations: [] });

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    expect(released).toEqual([]);
  });

  it('⭐ 롤업 둘을 같은 양 «내린다» — 수주 라인이 없으면 그 쪽만 건너뛴다', async () => {
    const withSales = build();
    await withSales.service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);
    expect(withSales.updates.shipment_request_line?.[0]).toMatchObject({
      data: { shipped_qty: { decrement: new Prisma.Decimal(10) } },
    });
    expect(withSales.updates.sales_order_line).toHaveLength(1);

    const withoutSales = build({ salesLine: false });
    await withoutSales.service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);
    expect(withoutSales.updates.sales_order_line).toBeUndefined();
  });

  it('⭐ 출하가 CANCELLED 로 가고 취소 시각은 «본문» occurredAt · 판 번호가 오른다', async () => {
    const { service, updates, order } = build();

    await service.cancel(SHIPMENT_ID, VERSION, body, USER_ID);

    expect(updates.shipment?.[0]).toMatchObject({
      data: {
        status_code: 'CANCELLED',
        cancelled_at: new Date(body.occurredAt),
        cancelled_by: BigInt(USER_ID),
        version_no: { increment: 1 },
      },
    });
    // 상태는 맨 끝이다 — 역전기가 400 이면 상태도 안 옮긴다.
    expect(order[order.length - 1]).toBe('shipment.update');
  });
});
