import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundReceiptSplitInput, InboundReceiptSplitService } from './inbound-receipt-split.service';
import { InboundReceiptService } from './inbound-receipt.service';

/**
 * e2e 로 도달하지 못하는 것을 여기서 확정한다 — `mode` 정합, 채번의 «순서»와 공장 인자,
 * 초과분 라인에 서버가 손대지 않는다는 것.
 */

type Args = Record<string, unknown>;

const PO_LINES: Record<string, { parent: bigint; ordered: number; received: number }> = {
  '101': { parent: 900n, ordered: 100, received: 0 },
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
      { itemId: 40, receivedQty: 3, uomId: 50, supplierLotMissing: true, substituteLotReasonCode: 'NO_LABEL' },
    ],
    ...overrides,
  });

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
    $queryRaw: async () => [],
    item: { findMany: async () => [{ item_id: 40n, inspection_required: false }] },
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
  };

  const prisma = {
    code_value: {
      findMany: async ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
        where.OR.filter((check) => codes.has(`${check.code_group.group_code} ${check.code}`)).map(
          (check) => ({ code: check.code, code_group: { group_code: check.code_group.group_code } }),
        ),
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
    new LotRegistryService(),
  );
  const service = new InboundReceiptSplitService(
    prisma as unknown as PrismaService,
    numbering,
    receipts,
  );
  return { service, recorded };
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

  it('분리 — exceptionTypeCode 가 code_value 에 없으면 400 이다', async () => {
    const error = await thrown(() =>
      fake().service.create(
        input({ excess: excessPart({ exceptionTypeCode: '없는코드', exceptionReason: '초과' }) }),
        99,
      ),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'excess.exceptionTypeCode',
      code: ERROR_CODE.INVALID,
    });
  });
});
