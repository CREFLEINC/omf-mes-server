import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LotHoldService, LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InboundReceiptLineWriteInput } from './inbound-receipt-rules';
import { InboundReceiptService } from './inbound-receipt.service';

/**
 * e2e 로 도달하지 못하는 것을 여기서 확정한다 — 잠금 문장의 «모양», 트랜잭션 옵션,
 * `Decimal` 비교, LOT 코어에 넘기는 값. LOT 코어는 «진짜»를 쓴다(가짜 `tx` 가 그 코어의
 * 쓰기를 그대로 받아 적는다) — 그래야 `lot_hold` 까지 한 번에 본다.
 */

type Args = Record<string, unknown>;
const ATTACHED_LOT_NO = '040101-00022S|10|260806|100019|0001';

const PO_LINES: Record<string, { parent: bigint; ordered: number; tolerance: number; received: number }> = {
  '101': { parent: 900n, ordered: 100, tolerance: 0, received: 0 },
  '102': { parent: 800n, ordered: 100, tolerance: 0, received: 0 },
};

const line = (overrides: Partial<InboundReceiptLineWriteInput> = {}): InboundReceiptLineWriteInput => ({
  purchaseOrderLineId: 101,
  itemId: 40,
  receivedQty: 10,
  uomId: 50,
  supplierLotMissing: false,
  supplierLotNo: ATTACHED_LOT_NO,
  ...overrides,
});

const input = (overrides: Args = {}) => ({
  supplierId: 10,
  plantId: 30,
  receiptDatetime: '2026-08-06T09:12:00+09:00',
  businessDate: '2026-08-06',
  occurredAt: '2026-08-06T09:12:00+09:00',
  lines: [line()],
  ...overrides,
});

interface Options {
  poLines?: typeof PO_LINES;
  codes?: string[];
  inspectionRequired?: boolean;
  auditFails?: boolean;
}

function fake(options: Options = {}) {
  const poLines = options.poLines ?? PO_LINES;
  const codes = new Set(
    options.codes ?? ['INBOUND_RECEIPT_EXCEPTION_TYPE CUSTOMER_SUPPLY', 'SUBSTITUTE_LOT_REASON NO_LABEL'],
  );
  const recorded = {
    calls: [] as string[],
    numbering: [] as unknown[],
    lockSql: '',
    lockIds: [] as bigint[],
    header: {} as Args,
    lines: [] as Args[],
    lots: [] as Args[],
    holds: [] as Args[],
    inspectionRequests: [] as Args[],
    increments: [] as { purchaseOrderLineId: bigint; increment: unknown }[],
    transactionOptions: undefined as unknown,
    audits: [] as Args[],
    committed: false,
  };

  const rows = (where: Args) => {
    const ids = ((where.purchase_order_line_id as Args).in as bigint[]).map(String);
    return ids
      .filter((id) => poLines[id] !== undefined)
      .map((id) => ({
        purchase_order_line_id: BigInt(id),
        purchase_order_id: poLines[id].parent,
        ordered_qty: new Prisma.Decimal(poLines[id].ordered),
        tolerance_over_qty: new Prisma.Decimal(poLines[id].tolerance),
        received_qty: new Prisma.Decimal(poLines[id].received),
      }));
  };

  const tx = {
    worker: { findFirst: async () => ({ worker_id: 8n }) },
    terminal: { findFirst: async () => ({ terminal_id: 4n }) },
    audit_event: { create: async ({ data }: { data: Args }) => {
      recorded.audits.push(data);
      if (options.auditFails) throw new Error('audit unavailable');
      return {};
    } },
    purchase_order_line: {
      findMany: async ({ where }: { where: Args }) => rows(where),
      update: async ({ where, data }: { where: Args; data: Args }) => {
        recorded.increments.push({
          purchaseOrderLineId: where.purchase_order_line_id as bigint,
          increment: (data.received_qty as Args).increment,
        });
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // 코어 보류가 LOT 을 «먼저» 잠근다(R-5) — 이 스위트가 보는 잠금은 P/O 쪽이라 갈라 준다.
      if (strings.join('?').includes('trace.lot')) {
        return ((values[0] as Prisma.Sql).values as bigint[]).map((lot_id) => ({
          lot_id,
          status_code: 'INSPECTION_PENDING',
          version_no: 1,
        }));
      }
      recorded.calls.push('lock');
      recorded.lockSql = strings.join('?');
      recorded.lockIds = (values[0] as Prisma.Sql).values as bigint[];
      return [];
    },
    item: {
      findMany: async () => [
        {
          item_id: 40n,
          inspection_required: options.inspectionRequired ?? false,
        },
      ],
      findUnique: async () => ({ item_code: '000000040' }),
    },
    partner: { findUnique: async () => ({ partner_code: '000010' }) },
    inbound_receipt: {
      create: async ({ data }: { data: Args }) => {
        recorded.header = data;
        return { inbound_receipt_id: 500n };
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
      count: async () => 0,
      create: async ({ data }: { data: Args }) => {
        recorded.lots.push(data);
        return { lot_id: 7000n };
      },
      findUniqueOrThrow: async () => ({ lot_id: 7000n, lot_hold: [] }),
    },
    lot_hold: {
      create: async ({ data }: { data: Args }) => {
        recorded.holds.push(data);
      },
    },
    lot_external_identifier: { create: async () => ({}) },
    inspection_plan_version: {
      findMany: async () => [{ inspection_plan_version_id: 6000n }],
    },
    inspection_request: {
      create: async ({ data }: { data: Args }) => {
        recorded.inspectionRequests.push(data);
        return {};
      },
    },
  };

  const prisma = {
    code_value: {
      findMany: async ({ where }: { where: { OR: { code: string; code_group: { group_code: string } }[] } }) =>
        where.OR.filter((check) => codes.has(`${check.code_group.group_code} ${check.code}`)).map((check) => ({
          code: check.code,
          code_group: { group_code: check.code_group.group_code },
        })),
    },
    $transaction: async (work: (client: unknown) => Promise<unknown>, txOptions: unknown) => {
      recorded.calls.push('transaction');
      recorded.transactionOptions = txOptions;
      const result = await work(tx);
      recorded.committed = true;
      return result;
    },
    inbound_receipt: {
      findUniqueOrThrow: async () => ({
        ...recorded.header,
        inbound_receipt_id: 500n,
        approval_request_id: null,
        remarks: null,
        version_no: 1,
      }),
    },
    inbound_receipt_line: {
      findMany: async () =>
        recorded.lines.map((data, index) => ({
          ...data,
          inbound_receipt_line_id: BigInt(901 + index),
          lot_id: null,
          version_no: 1,
        })),
    },
    item: {
      findMany: async () => [
        {
          item_id: 40n,
          item_code: '040101-00022S',
          inspection_required: options.inspectionRequired ?? false,
        },
      ],
    },
    partner: {
      findMany: async () => [{ partner_id: 10n, partner_code: '100019' }],
    },
  };

  const numbering = {
    next: async (...args: unknown[]) => {
      recorded.calls.push('numbering');
      recorded.numbering = args;
      return 'IR-20260806-0001';
    },
  } as unknown as NumberingService;

  const service = new InboundReceiptService(
    prisma as unknown as PrismaService,
    numbering,
    new LotRegistryService(new LotHoldService()),
  );
  return { service, recorded };
}

describe('InboundReceiptService.create', () => {
  it('계정 없는 단말 입하는 같은 tx의 LOT/입하 감사 없이는 커밋되지 않는다', async () => {
    const actor = { workerId: 8n, terminalAudit: { workerId: 8n, workerNo: 'W8',
      terminalId: 4n, plantId: 30n, correlationId: 'inbound-1',
      operationKey: 'POST /logistics/inbound-receipts' } };
    const ok = fake();
    await ok.service.create(input(), actor);
    expect(ok.recorded.header).toMatchObject({ created_by: null, received_by: null });
    expect(ok.recorded.holds[0]).toMatchObject({ held_worker_id: 8n, held_by: null });
    expect(ok.recorded.audits.map((row) => row.target_type_code)).toEqual(['LOT', 'INBOUND_RECEIPT']);
    expect(ok.recorded.committed).toBe(true);
    const fail = fake({ auditFails: true });
    await expect(fail.service.create(input(), actor)).rejects.toThrow('audit unavailable');
    expect(fail.recorded.committed).toBe(false);
  });
  it('등록 — inspectionRequired 는 품목 마스터에서 읽는다(요청 스키마에 칸이 없다)', async () => {
    const { service, recorded } = fake({ inspectionRequired: true });

    await service.create(input(), 99);

    expect(recorded.lines[0].inspection_required).toBe(true);
  });

  it("등록 — 라인 status_code 는 'REGISTERED' 고정이다(값 목록이 없다 — 이 값으로 판정하지 않는다)", async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.lines[0].status_code).toBe('REGISTERED');
    expect(recorded.header.status_code).toBe('REGISTERED');
  });

  it('등록 — businessDate 는 형식만 본다(저장 칸이 없다 · 채번 periodDate 로만 쓴다)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);
    expect(recorded.numbering).toEqual(['INBOUND_RECEIPT', 30n, '2026-08-06']);
    expect(recorded.header).not.toHaveProperty('business_date');

    const error = await thrown(() => fake().service.create(input({ businessDate: '2026/08/06' }), 99));
    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'businessDate',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — occurredAt 도 형식만 본다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);
    expect(recorded.header).not.toHaveProperty('occurred_at');

    const error = await thrown(() => fake().service.create(input({ occurredAt: '어제' }), 99));
    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'occurredAt',
      code: ERROR_CODE.INVALID,
    });
  });

  it('등록 — 채번은 $transaction 을 열기 전에 부른다(잠금 전에 번호가 있다)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.calls).toEqual(['numbering', 'transaction', 'lock']);
  });

  it('귀속 — 잠글 purchase_order_id 를 오름차순으로 정렬해 한 문장으로 잠근다(데드락 회피)', async () => {
    const { service, recorded } = fake();

    // 요청 순서는 102(부모 800) → 101(부모 900) 의 «역순»이다.
    await service.create(
      input({
        lines: [
          line({
            purchaseOrderLineId: 102,
            supplierLotNo: '040101-00022S|10|260806|100019|0002',
          }),
          line({
            purchaseOrderLineId: 101,
            supplierLotNo: '040101-00022S|10|260806|100019|0003',
          }),
        ],
      }),
      99,
    );

    expect(recorded.calls.filter((call) => call === 'lock')).toHaveLength(1);
    expect(recorded.lockIds).toEqual([800n, 900n]);
    expect(recorded.lockSql).toContain('ORDER BY purchase_order_id');
    expect(recorded.lockSql).toContain('FOR UPDATE');
  });

  it('귀속 — 비교는 Decimal 로 한다(Number 로 접지 않는다)', async () => {
    // 0.1 + 0.2 는 Number 로 접으면 0.30000000000000004 라 이 요청이 «통과»한다.
    const { service } = fake({
      poLines: {
        '101': { parent: 900n, ordered: 0.1, tolerance: 0.2, received: 0 },
      },
    });

    const error = await thrown(() =>
      service.create(input({ lines: [line({ receivedQty: 0.30000000000000004 })] }), 99),
    );

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.receivedQty',
      code: ERROR_CODE.QTY_EXCEEDS_ORDERED,
    });
  });

  it('귀속 — purchaseOrderLineId 가 빈 라인은 잠금 목록에도 없다(무발주·초과분)', async () => {
    const { service, recorded } = fake();

    await service.create(
      input({
        exceptionTypeCode: 'CUSTOMER_SUPPLY',
        exceptionReason: '고객사급 자재',
        lines: [
          line({ supplierLotNo: '040101-00022S|10|260806|100019|0002' }),
          line({
            purchaseOrderLineId: null,
            supplierLotNo: '040101-00022S|10|260806|100019|0003',
          }),
        ],
      }),
      99,
    );

    expect(recorded.lockIds).toEqual([900n]);
    expect(recorded.increments).toHaveLength(1);
    expect(recorded.increments[0].purchaseOrderLineId).toBe(101n);
  });

  it('LOT — supplierLotMissing=true 인 라인은 LOT 없이 저장된다', async () => {
    const { service, recorded } = fake();

    await service.create(
      input({
        lines: [
          line({
            supplierLotMissing: true,
            supplierLotNo: null,
            substituteLotReasonCode: 'NO_LABEL',
          }),
        ],
      }),
      99,
    );

    expect(recorded.lots).toEqual([]);
    expect(recorded.lines[0].supplier_lot_missing).toBe(true);
  });

  it('LOT — 사전부착 라인의 lot_no 는 supplierLotNo 그대로다', async () => {
    const { service, recorded } = fake();

    await service.create(input({ lines: [line({ supplierLotNo: ATTACHED_LOT_NO })] }), 99);

    expect(recorded.lots[0]).toMatchObject({
      lot_no: ATTACHED_LOT_NO,
      item_id: 40,
      plant_id: 30,
      source_type_code: 'INBOUND_RECEIPT_LINE',
      source_id: 901,
    });
  });

  it('LOT — 외부번호가 있지만 라벨 미부착이면 원문을 보존하고 lotId 없이 저장한다', async () => {
    const { service, recorded } = fake();

    const result = await service.create(
      input({
        lines: [
          line({
            supplierLotNo: '납품서-LOT/A-01',
            supplierLotLabelAttached: false,
          }),
        ],
      }),
      99,
    );

    expect(recorded.lines[0]).toMatchObject({
      supplier_lot_no: '납품서-LOT/A-01',
      supplier_lot_missing: false,
      supplier_lot_label_attached: false,
    });
    expect(recorded.lots).toEqual([]);
    expect(result.detail.lines[0].lotId).toBeNull();
  });

  it('LOT — 부착 여부를 생략한 기존 요청은 supplierLotMissing=false이면 true로 저장한다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.lines[0].supplier_lot_label_attached).toBe(true);
    expect(recorded.lots).toHaveLength(1);
  });

  it('IQC — 사전부착 검사 대상 LOT은 유효 계획으로 의뢰를 같은 트랜잭션에서 한 건 만든다', async () => {
    const { service, recorded } = fake({ inspectionRequired: true });

    await service.create(input(), 99);

    expect(recorded.inspectionRequests).toHaveLength(1);
    expect(recorded.inspectionRequests[0]).toMatchObject({
      inspection_type_code: 'IQC',
      inspection_plan_version_id: 6000n,
      lot_id: 7000n,
      target_qty: 10,
      status_code: 'REQUESTED',
    });
  });

  it('LOT — lot_type_code 는 MATERIAL 이다', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.lots[0].lot_type_code).toBe('MATERIAL');
  });

  it('LOT — manufactured_at 은 채우지 않는다(date→timestamptz 캐스팅 금지)', async () => {
    const { service, recorded } = fake();

    await service.create(
      input({
        lines: [line({ manufacturedDate: '2026-08-01', expiryDate: '2027-08-01' })],
      }),
      99,
    );

    expect(recorded.lots[0].manufactured_at).toBeNull();
    expect(recorded.lines[0].manufactured_date).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  it('LOT — 등록 즉시 lot_hold 가 선다(INCOMING_INSPECTION_WAIT · HELD)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.holds[0]).toMatchObject({
      lot_id: 7000n,
      reason_code: 'INCOMING_INSPECTION_WAIT',
      status_code: 'HELD',
    });
  });

  it('귀속 — 요청의 purchaseOrderLineId 가 재조회에 없으면 400 INVALID 다(FK 에 맡기지 않는다)', async () => {
    const { service, recorded } = fake();

    const error = await thrown(() => service.create(input({ lines: [line({ purchaseOrderLineId: 777 })] }), 99));

    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'lines.0.purchaseOrderLineId',
      code: ERROR_CODE.INVALID,
    });
    expect(recorded.calls).not.toContain('lock');
  });

  it('귀속 — 트랜잭션 시한은 15초다(P2028 이 500 으로 새지 않는다)', async () => {
    const { service, recorded } = fake();

    await service.create(input(), 99);

    expect(recorded.transactionOptions).toEqual({
      timeout: 15_000,
      maxWait: 5_000,
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
