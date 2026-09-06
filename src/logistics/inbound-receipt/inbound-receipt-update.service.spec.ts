import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundReceiptLineWriteInput } from './inbound-receipt-rules';
import { InboundReceiptUpdateService } from './inbound-receipt-update.service';

/**
 * e2e 로 도달하지 못하는 것을 여기서 확정한다 — 「작성중에서만」 가드(1차에 `REGISTERED`
 * 밖으로 가는 오퍼레이션이 없다 · 문의 026), 차분 맵의 «셈», 잠금의 순서와 범위.
 */

type Args = Record<string, unknown>;

/** 옛 라인 둘 — 901 은 P/O 101(부모 900), 902 는 P/O 102(부모 800)에 붙어 있다. */
const EXISTING = [
  { inbound_receipt_line_id: 901n, purchase_order_line_id: 101n, received_qty: 10, lot_id: null },
  { inbound_receipt_line_id: 902n, purchase_order_line_id: 102n, received_qty: 5, lot_id: null },
];
const PO_LINES: Record<string, { parent: bigint; ordered: number; tolerance: number; received: number }> =
  {
    '101': { parent: 900n, ordered: 100, tolerance: 0, received: 10 },
    '102': { parent: 800n, ordered: 100, tolerance: 0, received: 5 },
  };

const item = (overrides: Partial<InboundReceiptLineWriteInput> = {}): InboundReceiptLineWriteInput => ({
  inboundReceiptLineId: 901,
  purchaseOrderLineId: 101,
  itemId: 40,
  receivedQty: 10,
  uomId: 50,
  supplierLotMissing: false,
  ...overrides,
});

const header = {
  supplierId: 10,
  receiptDatetime: '2026-08-06T09:12:00+09:00',
};

interface Options {
  statusCode?: string;
  existing?: typeof EXISTING;
  poLines?: typeof PO_LINES;
  successors?: number;
}

function fake(options: Options = {}) {
  const existing = options.existing ?? EXISTING;
  const poLines = options.poLines ?? PO_LINES;
  const recorded = {
    calls: [] as string[],
    lockIds: [] as bigint[],
    lockSql: '',
    increments: [] as { purchaseOrderLineId: bigint; increment: unknown }[],
    headerData: {} as Args,
    written: [] as Args[],
    deleted: [] as bigint[],
    transactionOptions: undefined as unknown,
  };

  const poRows = (where: Args) =>
    ((where.purchase_order_line_id as Args).in as bigint[])
      .map(String)
      .filter((id) => poLines[id] !== undefined)
      .map((id) => ({
        purchase_order_line_id: BigInt(id),
        purchase_order_id: poLines[id].parent,
        ordered_qty: new Prisma.Decimal(poLines[id].ordered),
        tolerance_over_qty: new Prisma.Decimal(poLines[id].tolerance),
        received_qty: new Prisma.Decimal(poLines[id].received),
      }));

  const receipt = {
    findUnique: async () => ({ status_code: options.statusCode ?? 'REGISTERED' }),
    updateMany: async ({ data }: { data: Args }) => {
      recorded.calls.push('bump');
      recorded.headerData = data;
      return { count: 1 };
    },
    findUniqueOrThrow: async () => ({
      inbound_receipt_id: 500n,
      inbound_receipt_no: 'IR-20260806-0001',
      supplier_id: 10n,
      plant_id: 30n,
      receipt_datetime: new Date('2026-08-06T00:12:00.000Z'),
      delivery_note_no: null,
      vehicle_no: null,
      dock_location_id: null,
      exception_type_code: null,
      exception_reason: null,
      approval_request_id: null,
      status_code: 'REGISTERED',
      received_by: 99n,
      remarks: null,
      version_no: 2,
    }),
  };

  const tx = {
    inbound_receipt: receipt,
    inbound_receipt_line: {
      findMany: async ({ select }: { select?: Args }) =>
        select === undefined
          ? recorded.written.map((data, index) => ({
              ...data,
              inbound_receipt_line_id: BigInt(901 + index),
              inbound_receipt_id: 500n,
              item_id: 40n,
              uom_id: 50n,
              received_qty: new Prisma.Decimal(data.received_qty as number),
              manufactured_date: null,
              expiry_date: null,
              status_code: 'REGISTERED',
              lot_id: null,
            }))
          : existing.map((row) => ({ ...row, received_qty: new Prisma.Decimal(row.received_qty) })),
      deleteMany: async ({ where }: { where: Args }) => {
        recorded.calls.push('delete');
        recorded.deleted = (where.inbound_receipt_line_id as Args).in as bigint[];
      },
      create: async ({ data }: { data: Args }) => {
        recorded.calls.push('line');
        recorded.written.push(data);
      },
      update: async ({ data }: { data: Args }) => {
        recorded.calls.push('line');
        recorded.written.push(data);
      },
    },
    purchase_order_line: {
      findMany: async ({ where }: { where: Args }) => poRows(where),
      update: async ({ where, data }: { where: Args; data: Args }) => {
        recorded.increments.push({
          purchaseOrderLineId: where.purchase_order_line_id as bigint,
          increment: (data.received_qty as Args).increment,
        });
      },
    },
    goods_receipt_line: { count: async () => options.successors ?? 0 },
    inbound_variance: { count: async () => 0 },
    purchase_order: { count: async () => 0 },
    item: { findMany: async () => [{ item_id: 40n, inspection_required: true }] },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockIds = (values[0] as Prisma.Sql).values as bigint[];
      return [];
    },
    $executeRaw: async () => {
      recorded.calls.push('shift');
      return 0;
    },
  };

  const prisma = {
    ...tx,
    partner: { count: async () => 1 },
    location: { count: async () => 1 },
    code_value: { findMany: async () => [] },
    $transaction: async (work: (client: unknown) => Promise<unknown>, txOptions: unknown) => {
      recorded.transactionOptions = txOptions;
      return work(tx);
    },
  };

  return { service: new InboundReceiptUpdateService(prisma as unknown as PrismaService), recorded };
}

describe('InboundReceiptUpdateService.update', () => {
  it('수정 — status_code 가 REGISTERED 가 아니면 400 STATE_LOCKED 다(1차에 도달 불가라 e2e 로 못 세운다)', async () => {
    const { service } = fake({ statusCode: 'POSTED' });

    const error = await thrown(() => service.update(500, 1, header, 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'statusCode',
      code: ERROR_CODE.STATE_LOCKED,
    });
  });

  it('수정 — 본문이 plantId·statusCode·exceptionTypeCode 를 받지 않는다(스키마에 칸이 없다)', async () => {
    const { service, recorded } = fake();
    // 계약 `InboundReceiptUpdate` 에 없는 칸이라 타입이 막는다 — 실제 본문처럼 넓혀 넘긴다.
    const body = { ...header, plantId: 77, statusCode: 'POSTED', exceptionTypeCode: 'OVER_DELIVERY' };

    await service.update(500, 1, body, 99);

    expect(recorded.headerData).not.toHaveProperty('plant_id');
    expect(recorded.headerData).not.toHaveProperty('status_code');
    expect(recorded.headerData).not.toHaveProperty('exception_type_code');
    expect(recorded.headerData.version_no).toEqual({ increment: 1 });
  });
});

describe('InboundReceiptUpdateService.replaceLines', () => {
  it('치환 — status_code 가 REGISTERED 가 아니면 400 STATE_LOCKED 다(같은 이유)', async () => {
    const { service } = fake({ statusCode: 'POSTED' });

    const error = await thrown(() => service.replaceLines(500, 1, [item()], 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'statusCode',
      code: ERROR_CODE.STATE_LOCKED,
    });
  });

  it('치환 — 남의 입하의 라인 id 를 실으면 400 이다', async () => {
    const { service } = fake();

    const error = await thrown(() =>
      service.replaceLines(500, 1, [item({ inboundReceiptLineId: 777 })], 99),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'items.0.inboundReceiptLineId',
      code: ERROR_CODE.INVALID,
    });
  });

  it('치환 — 같은 라인 id 를 두 번 실으면 400 이다(요청 N 건이 응답 N-1 건으로 줄지 않는다)', async () => {
    const { service } = fake();

    const error = await thrown(() => service.replaceLines(500, 1, [item(), item()], 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'items.1.inboundReceiptLineId',
      code: ERROR_CODE.INVALID,
    });
  });

  it('치환 — 차분은 (po_line_id → Σqty) 맵으로 계산한다(삭제·수량 변경·귀속 변경 셋을 한 번에)', async () => {
    const { service, recorded } = fake();

    // 901 은 10 → 25 로 오르고, 902(P/O 102 · 5)는 요청에서 빠져 지워진다.
    await service.replaceLines(500, 1, [item({ receivedQty: 25 })], 99);

    expect(recorded.increments.map((row) => [row.purchaseOrderLineId, String(row.increment)])).toEqual([
      [101n, '15'],
      [102n, '-5'],
    ]);
    expect(recorded.deleted).toEqual([902n]);
  });

  it('치환 — 귀속 대상이 바뀌면 옛 P/O 라인은 내리고 새 라인은 올린다', async () => {
    const { service, recorded } = fake({ existing: [EXISTING[0]] });

    await service.replaceLines(500, 1, [item({ purchaseOrderLineId: 102 })], 99);

    expect(recorded.increments.map((row) => [row.purchaseOrderLineId, String(row.increment)])).toEqual([
      [101n, '-10'],
      [102n, '10'],
    ]);
  });

  it('치환 — 잠글 부모는 옛 집합과 새 집합의 합집합이다(내리는 쪽도 잠근다)', async () => {
    const { service, recorded } = fake({ existing: [EXISTING[0]] });

    await service.replaceLines(500, 1, [item({ purchaseOrderLineId: 102 })], 99);

    expect(recorded.lockIds).toEqual([800n, 900n]);
    expect(recorded.lockSql).toContain('ORDER BY purchase_order_id');
    expect(recorded.lockSql).toContain('FOR UPDATE');
  });

  it('치환 — 부모 P/O 를 먼저 잠근 뒤 입하 라인을 만진다', async () => {
    const { service, recorded } = fake();

    await service.replaceLines(500, 1, [item({ receivedQty: 25 })], 99);

    expect(recorded.calls.indexOf('bump')).toBeLessThan(recorded.calls.indexOf('lock'));
    expect(recorded.calls.indexOf('lock')).toBeLessThan(recorded.calls.indexOf('delete'));
    expect(recorded.calls.indexOf('lock')).toBeLessThan(recorded.calls.indexOf('line'));
    expect(recorded.transactionOptions).toEqual({ timeout: 15_000, maxWait: 5_000 });
  });

  it('귀속 — 차분이 0 미만이면 400 RANGE 다(qty_t 하한이 500 으로 새지 않는다)', async () => {
    // I-3 이전에 심긴 입하 라인은 `received_qty` 를 올린 적이 없다 — 그 라인을 줄이면 음수가 된다.
    const { service } = fake({
      existing: [EXISTING[0]],
      poLines: { '101': { parent: 900n, ordered: 100, tolerance: 0, received: 3 } },
    });

    const error = await thrown(() => service.replaceLines(500, 1, [item({ receivedQty: 1 })], 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'items.0.receivedQty',
      code: ERROR_CODE.RANGE,
    });
  });

  it('치환 — 수량을 올려 발주+허용치를 넘기면 400 QTY_EXCEEDS_ORDERED', async () => {
    const { service } = fake({ existing: [EXISTING[0]] });

    const error = await thrown(() => service.replaceLines(500, 1, [item({ receivedQty: 150 })], 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'items.0.receivedQty',
      code: ERROR_CODE.QTY_EXCEEDS_ORDERED,
    });
  });
});

const thrown = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: unknown) => error,
  );
