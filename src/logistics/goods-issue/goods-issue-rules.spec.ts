import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { ApprovalService } from '../../core/approval';
import { DocumentStateService } from '../../core/document-state';
import { InventoryPostingService } from '../../core/inventory-posting';
import { NumberingService } from '../../core/numbering';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { PrismaService } from '../../prisma/prisma.service';
import { GoodsIssueCreate, GoodsIssueLineCreate, assertCreatable } from './goods-issue-rules';
import { GoodsIssueService } from './goods-issue.service';

const WAREHOUSE = 1001;
const PLANT = 7n;
const ITEM = 2001;
const LOT = 3001;
const UOM = 5;
const LOCATION = 4001;
const DESTINATION_LOCATION = 4002;
const PARTNER = 6001;
const PICKING_LINE = 8001;
const GOODS_RECEIPT = 9001;
const DAY = '2026-05-04';
const AT = '2026-05-04T02:00:00.000Z';

type Row = Record<string, unknown>;

const line = (over: Partial<GoodsIssueLineCreate> = {}): GoodsIssueLineCreate => ({
  itemId: ITEM,
  lotId: LOT,
  issueQty: 10,
  uomId: UOM,
  sourceLocationId: LOCATION,
  ...over,
});

const input = (over: Partial<GoodsIssueCreate> = {}): GoodsIssueCreate => ({
  issueTypeCode: 'OTHER',
  sourceDocumentTypeCode: 'GOODS_RECEIPT',
  sourceDocumentId: GOODS_RECEIPT,
  sourceWarehouseId: WAREHOUSE,
  issuedAt: AT,
  businessDate: DAY,
  occurredAt: AT,
  lines: [line()],
  ...over,
});

interface Seed {
  warehouse?: boolean;
  /** 원천 문서 3표 중 물어본 표에 행이 있나. */
  sourceDocument?: boolean;
  destination?: boolean;
  items?: number[];
  lots?: { lot_id: number; item_id: number }[];
  uoms?: number[];
  locations?: { location_id: number; warehouse_id: number }[];
  pickingLines?: number[];
  /** `${그룹} ${코드}` 로 아는 값. */
  codes?: string[];
}

/** `assertCreatable` 이 부르는 만큼만 답하는 최소 prisma 스텁 — 어느 표를 물었는지 잡는다. */
function stub(seed: Seed = {}) {
  const asked: string[] = [];
  const models: Row = {
    warehouse: {
      findUnique: async () => ((seed.warehouse ?? true) ? { plant_id: PLANT } : null),
    },
    picking_order: { count: async () => (asked.push('picking_order'), pick(seed.sourceDocument)) },
    goods_receipt: { count: async () => (asked.push('goods_receipt'), pick(seed.sourceDocument)) },
    disposition_decision: {
      count: async () => (asked.push('disposition_decision'), pick(seed.sourceDocument)),
    },
    partner: { count: async () => (asked.push('partner'), pick(seed.destination)) },
    location: {
      count: async () => (asked.push('location'), pick(seed.destination)),
      findMany: async () => seed.locations ?? [{ location_id: LOCATION, warehouse_id: WAREHOUSE }],
    },
    item: {
      findMany: async () => (seed.items ?? [ITEM]).map((item_id) => ({ item_id })),
    },
    lot: {
      findMany: async () => seed.lots ?? [{ lot_id: LOT, item_id: ITEM }],
    },
    uom: {
      findMany: async () => (seed.uoms ?? [UOM]).map((uom_id) => ({ uom_id })),
    },
    picking_line: {
      findMany: async () =>
        (seed.pickingLines ?? [PICKING_LINE]).map((picking_line_id) => ({ picking_line_id })),
    },
    code_value: {
      findMany: async () =>
        (seed.codes ?? ['ISSUE_TYPE OTHER', 'GOODS_ISSUE_REASON IQC_FAIL']).map((entry) => {
          const [group_code, code] = entry.split(' ');
          return { code, code_group: { group_code } };
        }),
    },
  };
  return { prisma: models as unknown as PrismaService, asked };
}

const pick = (present: boolean | undefined): number => ((present ?? true) ? 1 : 0);

/** 던진 `ContractException` 을 집어 온다 — 코드와 필드를 함께 봐야 하기 때문이다. */
const thrown = (run: () => Promise<unknown>): Promise<ContractException> =>
  run().then(
    () => {
      throw new Error('예외가 나지 않았다');
    },
    (error: ContractException) => error,
  );

const codes = (error: ContractException): string[] =>
  (error.getResponse() as { errors: { code: string }[] }).errors.map((item) => item.code);

const fields = (error: ContractException): (string | undefined)[] =>
  (error.getResponse() as { errors: { field?: string }[] }).errors.map((item) => item.field);

describe('출고 등록 검증', () => {
  it('등록 — lines 가 0건이면 400 LINE_REQUIRED 다(계약이 minItems 를 안 걸었다)', async () => {
    const { prisma } = stub();

    const error = await thrown(() => assertCreatable(prisma, input({ lines: [] })));

    expect(error.getStatus()).toBe(400);
    expect(codes(error)).toContain('LINE_REQUIRED');
  });

  it('등록 — destinationTypeCode 만 채우면 400 PAIR 다(ck_goods_issue_destination 이 500 으로 새지 않는다)', async () => {
    const { prisma } = stub();

    const error = await thrown(() =>
      assertCreatable(prisma, input({ destinationTypeCode: 'PARTNER' })),
    );

    expect(codes(error)).toEqual(['PAIR']);
  });

  it('등록 — destinationId 만 채워도 400 PAIR 다', async () => {
    const { prisma } = stub();

    const error = await thrown(() => assertCreatable(prisma, input({ destinationId: PARTNER })));

    expect(codes(error)).toEqual(['PAIR']);
  });

  it('등록 — 둘 다 비우면 통과한다(자체 폐기)', async () => {
    const { prisma, asked } = stub();

    await expect(
      assertCreatable(prisma, input({ destinationTypeCode: null, destinationId: null })),
    ).resolves.toBe(PLANT);
    // 「나가서 없어지는 물건에는 도착지가 없다」(계약) — 물어볼 표가 없다.
    expect(asked).not.toContain('partner');
  });

  it('등록 — destinationTypeCode 가 LOCATION 이면 destinationId 는 mdm.location 이어야 한다', async () => {
    const found = stub();
    await assertCreatable(
      found.prisma,
      input({ destinationTypeCode: 'LOCATION', destinationId: DESTINATION_LOCATION }),
    );
    expect(found.asked).toContain('location');

    const missing = stub({ destination: false });
    const error = await thrown(() =>
      assertCreatable(
        missing.prisma,
        input({ destinationTypeCode: 'LOCATION', destinationId: DESTINATION_LOCATION }),
      ),
    );
    expect(codes(error)).toEqual(['INVALID']);
    expect(fields(error)).toEqual(['destinationId']);
  });

  it('등록 — destinationTypeCode 가 PARTNER·DISPOSAL_SITE 면 mdm.partner 여야 한다', async () => {
    for (const destinationTypeCode of ['PARTNER', 'DISPOSAL_SITE']) {
      const found = stub();
      await assertCreatable(
        found.prisma,
        input({ destinationTypeCode, destinationId: PARTNER }),
      );
      // 값을 나눴어도 가리키는 표는 하나다(계약 `x-internal-note`).
      expect(found.asked).toContain('partner');

      const missing = stub({ destination: false });
      const error = await thrown(() =>
        assertCreatable(missing.prisma, input({ destinationTypeCode, destinationId: PARTNER })),
      );
      expect(fields(error)).toEqual(['destinationId']);
    }
  });

  it('등록 — issueTypeCode 가 ISSUE_TYPE 코드값에 없으면 400', async () => {
    const { prisma } = stub({ codes: ['GOODS_ISSUE_REASON IQC_FAIL'] });

    const error = await thrown(() => assertCreatable(prisma, input({ issueTypeCode: 'NOPE' })));

    expect(codes(error)).toEqual(['INVALID']);
    expect(fields(error)).toEqual(['issueTypeCode']);
  });

  it('등록 — reasonCode 가 GOODS_ISSUE_REASON 코드값에 없으면 400', async () => {
    const { prisma } = stub({ codes: ['ISSUE_TYPE OTHER'] });

    const error = await thrown(() => assertCreatable(prisma, input({ reasonCode: 'NOPE' })));

    expect(fields(error)).toEqual(['reasonCode']);
  });

  it('등록 — sourceDocumentTypeCode 3값이 가리키는 표에 그 id 가 없으면 400 INVALID(FK 에 맡기지 않는다)', async () => {
    const tables: Record<string, string> = {
      PICKING_ORDER: 'picking_order',
      GOODS_RECEIPT: 'goods_receipt',
      DISPOSITION_DECISION: 'disposition_decision',
    };
    for (const [sourceDocumentTypeCode, table] of Object.entries(tables)) {
      const found = stub();
      await assertCreatable(found.prisma, input({ sourceDocumentTypeCode }));
      // 값이 «대상 테이블 이름»이다(계약) — 그 표에만 묻는다.
      expect(found.asked).toEqual([table]);

      const missing = stub({ sourceDocument: false });
      const error = await thrown(() =>
        assertCreatable(missing.prisma, input({ sourceDocumentTypeCode })),
      );
      expect(codes(error)).toEqual(['INVALID']);
      expect(fields(error)).toEqual(['sourceDocumentId']);
    }
  });

  it('등록 — 라인의 LOT 품목이 itemId 와 다르면 400', async () => {
    const { prisma } = stub({ lots: [{ lot_id: LOT, item_id: 9999 }] });

    const error = await thrown(() => assertCreatable(prisma, input()));

    expect(codes(error)).toEqual(['INVALID']);
    expect(fields(error)).toEqual(['lines[0].itemId']);
  });

  it('등록 — sourceLocationId 가 sourceWarehouseId 의 위치가 아니면 400', async () => {
    const { prisma } = stub({ locations: [{ location_id: LOCATION, warehouse_id: 7777 }] });

    const error = await thrown(() => assertCreatable(prisma, input()));

    expect(fields(error)).toEqual(['lines[0].sourceLocationId']);
  });

  it('등록 — businessDate 형식이 아니면 400 INVALID', async () => {
    const { prisma } = stub();

    // 정규식만 보면 `2026-13-39` 가 통과해 `GI-20261339-0001` 이 전표에 영구히 남는다.
    for (const businessDate of ['2026/05/04', '2026-13-39']) {
      const error = await thrown(() => assertCreatable(prisma, input({ businessDate })));
      expect(codes(error)).toEqual(['INVALID']);
      expect(fields(error)).toEqual(['businessDate']);
    }
  });
});

/** 트랜잭션 하나를 흉내 내는 스텁 — INSERT 로 들어간 «데이터»를 그대로 잡는다. */
function serviceStub(seed: Seed = {}) {
  const { prisma: reads } = stub(seed);
  const headers: Row[] = [];
  const lines: Row[] = [];
  const posted: PostingInput[] = [];
  const updated: Row[] = [];
  let approvals = 0;

  const tx: Row = {
    goods_issue: {
      create: async ({ data }: { data: Row }) => {
        headers.push(data);
        return { ...data, goods_issue_id: 700n, goods_issue_no: data.goods_issue_no };
      },
      update: async (args: Row) => void updated.push(args),
      findUniqueOrThrow: async () => ({
        goods_issue_id: 700n,
        goods_issue_no: 'GI-20260504-0001',
        issue_type_code: 'OTHER',
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: BigInt(GOODS_RECEIPT),
        source_warehouse_id: BigInt(WAREHOUSE),
        destination_type_code: null,
        destination_id: null,
        issued_at: new Date(AT),
        status_code: updated.length > 0 ? 'POSTED' : 'REGISTERED',
        reason_code: null,
        replacement_expected: null,
        approval_request_id: null,
        remarks: null,
        version_no: 1,
      }),
    },
    goods_issue_line: {
      create: async ({ data }: { data: Row }) => {
        lines.push(data);
        return {
          goods_issue_line_id: BigInt(900 + lines.length),
          item_id: BigInt(data.item_id as number),
          lot_id: BigInt(data.lot_id as number),
          issue_qty: new Prisma.Decimal(data.issue_qty as number),
          uom_id: BigInt(data.uom_id as number),
          source_location_id: BigInt(data.source_location_id as number),
        };
      },
      findMany: async () => [],
      update: async () => ({}),
    },
    lot: { findMany: async () => [{ status_code: 'NORMAL' }] },
    judgment_type_control: { findFirst: async () => null },
    warehouse: {
      findUniqueOrThrow: async () => ({
        business_unit_id: 2n,
        plant_id: PLANT,
        plant: { legal_entity_id: 1n },
      }),
    },
    location: { findUniqueOrThrow: async () => ({ warehouse_id: BigInt(WAREHOUSE) }) },
    inventory_transaction_line: {
      findMany: async () => posted[0].lines.map((_, i) => ({ inventory_transaction_line_id: BigInt(i) })),
    },
    $queryRaw: async () => [
      {
        legalEntityId: 1n,
        businessUnitId: 2n,
        plantId: PLANT,
        warehouseId: BigInt(WAREHOUSE),
        locationId: BigInt(LOCATION),
        itemId: BigInt(ITEM),
        lotKey: BigInt(LOT),
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        owner_partner_id: null,
        available_qty: new Prisma.Decimal(1000),
      },
    ],
  };

  const prisma = new Proxy(reads as unknown as Row, {
    get: (target: Row, prop: string) =>
      prop === '$transaction'
        ? (work: (client: unknown) => Promise<unknown>) => work(tx)
        : target[prop],
  }) as unknown as PrismaService;

  const service = new GoodsIssueService(
    prisma,
    {
      post: async (_tx: unknown, argument: PostingInput) => {
        posted.push(argument);
        return { inventoryTransactionId: 77n, businessDate: argument.businessDate, alreadyPosted: false };
      },
    } as unknown as InventoryPostingService,
    { assertApproved: async () => void (approvals += 1) } as unknown as ApprovalService,
    {} as DocumentStateService,
    { next: async () => 'GI-20260504-0001' } as unknown as NumberingService,
  );
  return { service, headers, lines, posted, updated, gate: (): number => approvals };
}

describe('출고 등록', () => {
  it('등록 — line_no 는 서버가 1..N 으로 매긴다(본문의 goodsIssueLineId 는 무시된다)', async () => {
    const { service, lines } = serviceStub();

    await service.create(
      input({
        lines: [
          line({ goodsIssueLineId: 555, pickingLineId: PICKING_LINE }),
          line({ goodsIssueLineId: 111 }),
        ],
      }),
      1,
    );

    expect(lines.map((row) => row.line_no)).toEqual([1, 2]);
    expect(lines.some((row) => 'goods_issue_line_id' in row)).toBe(false);
    // 받아서 «저장만» 한다 — 수량 대조는 I-8 몫이다(§7-2).
    expect(lines[0].picking_line_id).toBe(PICKING_LINE);
  });

  it('등록 — postImmediately 가 거짓이면 businessDate·occurredAt 을 저장하지 않는다', async () => {
    const { service, headers, posted, updated } = serviceStub();

    const created = await service.create(input(), 1);

    // 담을 칸이 아예 없다 — 원장을 안 지나면 저장할 표가 없다(§2-5).
    expect(Object.keys(headers[0])).not.toContain('business_date');
    expect(Object.keys(headers[0])).not.toContain('occurred_at');
    expect(posted).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(headers[0].status_code).toBe('REGISTERED');
    expect(created.detail.goodsIssue.statusCode).toBe('REGISTERED');
  });

  it('등록 — postImmediately 가 참이면 같은 트랜잭션에서 전기하고 POSTED 로 만든다', async () => {
    const { service, posted, updated, gate } = serviceStub();

    const created = await service.create(input({ postImmediately: true }), 1);

    // 방금 만든 전표라 승인 요청이 있을 수 없다 — 게이트는 «부르되» 언제나 통과한다(문의 030 ③).
    expect(gate()).toBe(1);
    // 본문 값 그대로다 — 서버가 「오늘」로 다시 잡지 않는다(C-8).
    expect(posted[0].businessDate).toBe(DAY);
    expect(posted[0].occurredAt).toEqual(new Date(AT));
    // ⛔ `document-post` 전이를 안 부른다 — from 이 없는 전이라 표에 담을 수 없다(§3-9).
    expect(updated[0]).toEqual({ where: { goods_issue_id: 700n }, data: { status_code: 'POSTED' } });
    expect(created.detail.goodsIssue.statusCode).toBe('POSTED');
    // 상태를 «옮기는» 것이 아니라 처음부터 POSTED 다 — 버전은 1 그대로 ETag 에 실린다.
    expect(created.versionNo).toBe(1);
  });

  it('등록 — If-Match 가 실려도 400 을 내지 않는다(새 자원이라 대조할 버전이 없다)', async () => {
    const { service, headers } = serviceStub();

    // 가드는 「선택」인 채로 두고 서비스가 값을 «안 받는다» — 넘길 자리가 없으니 400 도 없다.
    await expect(service.create(input(), 1)).resolves.toMatchObject({ versionNo: 1 });
    expect(Object.keys(headers[0])).not.toContain('version_no');
  });

  it('등록 — 결과가 ③ 픽스처(insertRegisteredIssue)와 같은 모양이다', async () => {
    const { service, headers, lines } = serviceStub();

    await service.create(input({ reasonCode: 'IQC_FAIL' }), 1);

    // `test/logistics-goods-issue.e2e-spec.ts` 의 `insertRegisteredIssue()` 가 넣는 칸 —
    // 갈리면 PR ③⑤ 의 e2e 가 «실제 등록 결과»를 대표하지 못한다(I-4.md R-3).
    const fixtureHeader = [
      'goods_issue_no',
      'issue_type_code',
      'source_document_type_code',
      'source_document_id',
      'source_warehouse_id',
      'destination_type_code',
      'destination_id',
      'issued_at',
      'status_code',
      'reason_code',
    ];
    for (const column of fixtureHeader) expect(Object.keys(headers[0])).toContain(column);
    // 픽스처가 안 채우는 나머지는 이 셋뿐이다(`approval_request_id` 는 상신이 채운다 — PR ⑤).
    expect(Object.keys(headers[0]).filter((key) => !fixtureHeader.includes(key)).sort()).toEqual([
      'created_by',
      'remarks',
      'replacement_expected',
    ]);

    const fixtureLine = [
      'goods_issue_id',
      'line_no',
      'item_id',
      'lot_id',
      'issue_qty',
      'uom_id',
      'source_location_id',
    ];
    for (const column of fixtureLine) expect(Object.keys(lines[0])).toContain(column);
    expect(Object.keys(lines[0]).filter((key) => !fixtureLine.includes(key)).sort()).toEqual([
      'created_by',
      'picking_line_id',
    ]);
  });
});
