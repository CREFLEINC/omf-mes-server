import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LotHoldService, LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundReceiptSplitInput, InboundReceiptSplitService } from './inbound-receipt-split.service';
import { InboundReceiptService } from './inbound-receipt.service';

/**
 * e2e 로 도달하지 못하는 것을 여기서 확정한다 — `mode` 정합, 채번의 «순서»와 공장 인자,
 * 초과분 라인에 서버가 손대지 않는다는 것.
 */

type Args = Record<string, unknown>;
const ATTACHED_LOT_NO = '040101-00023S|10|260806|100020|0001';

/** 102 의 부모가 101 의 부모보다 «작다» — part 마다 잠그면 900 → 800 순이 되는 배치다. */
const PO_LINES: Record<string, { parent: bigint; ordered: number; received: number }> = {
  '101': { parent: 900n, ordered: 100, received: 0 },
  '102': { parent: 800n, ordered: 100, received: 0 },
};

const part = (overrides: Args = {}) => ({
  supplierId: 10,
  plantId: 30,
  receiptDatetime: '2026-08-06T09:12:00+09:00',
  lines: [
    {
      purchaseOrderLineId: 101,
      itemId: 40,
      receivedQty: 10,
      uomId: 50,
      supplierLotMissing: true,
      substituteLotReasonCode: 'NO_LABEL',
    },
  ],
  ...overrides,
});

/** 초과분은 정의상 무발주다 — `purchaseOrderLineId` 를 안 싣는다(`W-01-03` §4-B). */
const excessPart = (overrides: Args = {}) =>
  part({
    plantId: 31,
    lines: [
      {
        itemId: 40,
        receivedQty: 3,
        uomId: 50,
        supplierLotMissing: true,
        substituteLotReasonCode: 'NO_LABEL',
      },
    ],
    ...overrides,
  });

const poLine = (purchaseOrderLineId: number | null) => ({
  purchaseOrderLineId,
  itemId: 40,
  receivedQty: 3,
  uomId: 50,
  supplierLotMissing: true,
  substituteLotReasonCode: 'NO_LABEL',
});

/** 사전부착 라인 한 벌 — 두 part 에 같은 번호를 실어 `uq_lot` 축을 본다. */
const LOT_LINES = {
  lines: [
    {
      itemId: 40,
      receivedQty: 3,
      uomId: 50,
      supplierLotMissing: false,
      supplierLotNo: ATTACHED_LOT_NO,
    },
  ],
};

const input = (overrides: Args = {}): InboundReceiptSplitInput =>
  ({
    mode: 'BOTH',
    normal: part(),
    excess: excessPart(),
    businessDate: '2026-08-06',
    occurredAt: '2026-08-06T09:12:00+09:00',
    ...overrides,
  }) as InboundReceiptSplitInput;

function fake(codeValues?: string[]) {
  const codes = new Set(
    codeValues ?? ['INBOUND_RECEIPT_EXCEPTION_TYPE OVER_DELIVERY', 'SUBSTITUTE_LOT_REASON NO_LABEL'],
  );
  const recorded = {
    calls: [] as string[],
    numbering: [] as unknown[][],
    headers: [] as Args[],
    lines: [] as Args[],
  };

  const tx = {
    purchase_order_line: {
      findMany: async ({ where }: { where: Args }) =>
        ((where.purchase_order_line_id as Args).in as bigint[])
          .map(String)
          .filter((id) => PO_LINES[id] !== undefined)
          .map((id) => ({
            purchase_order_line_id: BigInt(id),
            purchase_order_id: PO_LINES[id].parent,
            ordered_qty: new Prisma.Decimal(PO_LINES[id].ordered),
            tolerance_over_qty: new Prisma.Decimal(0),
            received_qty: new Prisma.Decimal(PO_LINES[id].received),
          })),
      update: async () => undefined,
    },
    // 코어 보류가 LOT 을 «먼저» 잠근다(R-5). P/O 부모 잠금은 이 스위트가 따로 본다.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('?').includes('trace.lot')
        ? ((values[0] as Prisma.Sql).values as bigint[]).map((lot_id) => ({
            lot_id,
            status_code: 'INSPECTION_PENDING',
            version_no: 1,
          }))
        : [],
    item: {
      findMany: async () => [{ item_id: 40n, inspection_required: false }],
    },
    inbound_receipt: {
      create: async ({ data }: { data: Args }) => {
        recorded.headers.push(data);
        return { inbound_receipt_id: BigInt(500 + recorded.headers.length) };
      },
    },
    inbound_receipt_line: {
      create: async ({ data }: { data: Args }) => {
        recorded.lines.push(data);
        return { inbound_receipt_line_id: BigInt(900 + recorded.lines.length) };
      },
      updateMany: async () => ({ count: 1 }),
    },
    lot: {
      create: async () => ({ lot_id: 7000n }),
      findUniqueOrThrow: async () => ({ lot_id: 7000n, lot_hold: [] }),
    },
    lot_hold: { create: async () => undefined },
  };

  const prisma = {
    item: {
      findMany: async () => [{ item_id: 40n, inspection_required: false }],
    },
    code_value: {
      findMany: async ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
        where.OR.filter((check) => codes.has(`${check.code_group.group_code} ${check.code}`)).map((check) => ({
          code: check.code,
          code_group: { group_code: check.code_group.group_code },
        })),
    },
    $transaction: async (work: (client: unknown) => Promise<unknown>) => {
      recorded.calls.push('transaction');
      return work(tx);
    },
    inbound_receipt: {
      findMany: async ({ where }: { where: { inbound_receipt_id: { in: bigint[] } } }) =>
        where.inbound_receipt_id.in.map((inbound_receipt_id) => ({
          ...recorded.headers[Number(inbound_receipt_id) - 501],
          inbound_receipt_id,
          receipt_datetime: new Date('2026-08-06T00:12:00.000Z'),
          approval_request_id: null,
          version_no: 1,
        })),
    },
  };

  const numbering = {
    next: async (...args: unknown[]) => {
      recorded.calls.push('numbering');
      recorded.numbering.push(args);
      return `IR-20260806-000${recorded.numbering.length}`;
    },
  } as unknown as NumberingService;

  const receipts = new InboundReceiptService(
    prisma as unknown as PrismaService,
    numbering,
    new LotRegistryService(new LotHoldService()),
  );
  const service = new InboundReceiptSplitService(prisma as unknown as PrismaService, numbering, receipts);
  return { service, receipts, recorded };
}

/** `lockParentsOf` 와 `createWithin` 의 «호출 순서»를 본다 — 원본은 그대로 부른다. */
function trace(receipts: InboundReceiptService) {
  const order: string[] = [];
  const lockArgs: bigint[][] = [];
  const lock = receipts.lockParentsOf.bind(receipts);
  const create = receipts.createWithin.bind(receipts);
  jest.spyOn(receipts, 'lockParentsOf').mockImplementation((tx, ids) => {
    order.push('lock');
    lockArgs.push(ids);
    return lock(tx, ids);
  });
  jest.spyOn(receipts, 'createWithin').mockImplementation((...args) => {
    order.push('create');
    return create(...args);
  });
  return { order, lockArgs };
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('던지지 않았다');
}

describe('InboundReceiptSplitService.create', () => {
  it('분리 — mode=NORMAL_ONLY 인데 normal 이 없으면 400 이다(가드가 못 막는다 — 계약이 스스로 적었다)', async () => {
    const error = await thrown(() =>
      fake().service.create(input({ mode: 'NORMAL_ONLY', normal: undefined, excess: undefined }), 99),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'normal',
      code: ERROR_CODE.REQUIRED,
    });
  });

  it('분리 — mode=EXCESS_ONLY 인데 excess 가 없으면 400 이다', async () => {
    const error = await thrown(() =>
      fake().service.create(input({ mode: 'EXCESS_ONLY', normal: undefined, excess: undefined }), 99),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'excess',
      code: ERROR_CODE.REQUIRED,
    });
  });

  it('분리 — mode=BOTH 인데 한쪽이 없으면 400 이다', async () => {
    const error = await thrown(() => fake().service.create(input({ excess: undefined }), 99));

    expect((error as ContractException).errors).toEqual([
      expect.objectContaining({ field: 'excess', code: ERROR_CODE.REQUIRED }),
    ]);
  });

  it('분리 — mode 와 어긋나게 실린 쪽은 무시하지 않고 400 이다(조용히 버리지 않는다)', async () => {
    const error = await thrown(() => fake().service.create(input({ mode: 'NORMAL_ONLY' }), 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'excess',
      code: ERROR_CODE.INVALID,
    });
  });

  it('분리 — 채번은 part 마다 그 plantId 로 부른다(둘의 공장이 다를 수 있다)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.numbering).toEqual([
      ['INBOUND_RECEIPT', 30n, '2026-08-06'],
      ['INBOUND_RECEIPT', 31n, '2026-08-06'],
    ]);
  });

  it('분리 — 채번 둘을 $transaction 열기 전에 부른다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.calls).toEqual(['numbering', 'numbering', 'transaction']);
  });

  it('분리 — 초과분 라인의 purchaseOrderLineId 는 요청이 비운 그대로다(서버가 지우지 않는다)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.lines[0].purchase_order_line_id).toBe(101n);
    expect(recorded.lines[1].purchase_order_line_id).toBeNull();
  });

  it('분리 — 초과분 exceptionTypeCode 를 서버가 OVER_DELIVERY 로 강제하지 않는다', async () => {
    const { service, recorded } = fake();

    const created = await service.create(input(), 99);

    expect(recorded.headers[1].exception_type_code).toBeNull();
    expect(created.created.map((row) => row.exceptionTypeCode)).toEqual([null, null]);
  });

  it('분리 — 두 part 에 같은 공장의 같은 supplierLotNo 가 실리면 excess.lines.{i}.supplierLotNo 를 짚는 400 INVALID 다', async () => {
    const error = await thrown(() =>
      fake().service.create(
        input({
          normal: part(LOT_LINES),
          excess: excessPart({ plantId: 30, ...LOT_LINES }),
        }),
        99,
      ),
    );

    expect((error as ContractException).errors).toEqual([
      expect.objectContaining({
        field: 'excess.lines.0.supplierLotNo',
        code: ERROR_CODE.INVALID,
      }),
    ]);
  });

  it('분리 — 두 part 의 plantId 가 다르면 같은 supplierLotNo 를 허용한다', async () => {
    const { service, recorded } = fake();

    const created = await service.create(input({ normal: part(LOT_LINES), excess: excessPart(LOT_LINES) }), 99);

    expect(created.created).toHaveLength(2);
    expect(recorded.lines.map((row) => row.supplier_lot_no)).toEqual([ATTACHED_LOT_NO, ATTACHED_LOT_NO]);
  });

  it('분리 — createWithin 전에 두 part 의 P/O 부모 합집합을 한 번 잠근다', async () => {
    const { service, receipts } = fake();
    const { order, lockArgs } = trace(receipts);

    await service.create(input({ excess: excessPart({ lines: [poLine(102)] }) }), 99);

    // 선잠금이 «한 번»만 서고 그 다음이 첫 `createWithin` 이다 — 합집합이라 800 → 900 순이 된다.
    expect(order.indexOf('create')).toBe(1);
    expect(lockArgs[0]).toEqual([101n, 102n]);
  });

  it('분리 — 두 part 모두 P/O 라인이 없으면 선잠금을 부르지 않는다', async () => {
    const { service, receipts } = fake();
    const { order, lockArgs } = trace(receipts);

    await service.create(input({ normal: part({ lines: [poLine(null)] }) }), 99);

    expect(lockArgs).toEqual([]);
    expect(order).toEqual(['create', 'create']);
  });

  it('분리 — exceptionTypeCode 가 code_value 에 없으면 400 이다', async () => {
    const error = await thrown(() =>
      fake().service.create(
        input({
          excess: excessPart({
            exceptionTypeCode: '없는코드',
            exceptionReason: '초과',
          }),
        }),
        99,
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'excess.exceptionTypeCode',
      code: ERROR_CODE.INVALID,
    });
  });
});
