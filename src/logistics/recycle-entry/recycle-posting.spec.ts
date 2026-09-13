import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { PostingInput } from '../../core/inventory-posting/posting.types';
import { LotRegistryService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { RecycleEntryService } from './recycle-entry.service';
import { RecycleEntryCreate, postRecycleEntry } from './recycle-posting';

/** ⭐ 표별로 값을 벌린다 — 다 같으면 칸을 뒤바꿔도 초록이다(R-7 ⓑ). */
const ENTRY_ID = 90001n;
const LOT_ID = 501n;
const ITEM_ID = 77;
const UOM_ID = 13;
const WAREHOUSE_ID = 21;
const LOCATION_ID = 34;
const PLANT_ID = 5;
const USER_ID = 9;
const NO = 'RC-20260811-0007';
const LOT_NO = 'M00000520260811000001ABCDEFGHJKLMN';
const DAY = '2026-08-11';
/** ⭐ 영업일과 **다른 날**의 시각이다 — 두 축을 섞으면 RED. */
const AT = '2026-08-13T02:00:00.000Z';

type Row = Record<string, unknown>;

const input = (over: Partial<RecycleEntryCreate> = {}): RecycleEntryCreate => ({
  itemId: ITEM_ID,
  quantity: 12.5,
  warehouseId: WAREHOUSE_ID,
  locationId: LOCATION_ID,
  businessDate: DAY,
  occurredAt: AT,
  ...over,
});

interface Recorded {
  order: string[];
  created: Row[];
  updated: Row[];
  lotInputs: Row[];
  lotActors: unknown[];
  posted: PostingInput[];
  numbered: unknown[][];
}

function fake(seed: { duplicateNo?: boolean; duplicateTarget?: string; auditFails?: boolean } = {}): {
  tx: Prisma.TransactionClient;
  posting: InventoryPostingService;
  lots: LotRegistryService;
  recorded: Recorded;
} {
  const recorded: Recorded = { order: [], created: [], updated: [], lotInputs: [], lotActors: [], posted: [], numbered: [] };

  const tx = {
    worker: { findFirst: async () => ({ worker_id: 8n }) },
    terminal: { findFirst: async () => ({ terminal_id: 4n }) },
    audit_event: { create: async () => {
      recorded.order.push('audit_event.create');
      if (seed.auditFails) throw new Error('audit unavailable');
      return {};
    } },
    recycle_entry: {
      create: ({ data }: { data: Row }) => {
        recorded.order.push('recycle_entry.create');
        recorded.created.push(data);
        if (seed.duplicateNo === true) {
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError('중복', {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: [seed.duplicateTarget ?? 'recycle_entry_no'] },
            }),
          );
        }
        return Promise.resolve({ recycle_entry_id: ENTRY_ID });
      },
      update: (args: Row) => {
        recorded.order.push('recycle_entry.update');
        recorded.updated.push(args);
        return Promise.resolve({});
      },
    },
  } as unknown as Prisma.TransactionClient;

  const lots = {
    // ⭐ **셋째 인자(행위자)까지** 기록한다 — 둘째만 받으면 `appUserId` 를 상수로 못 박아도
    //    전 층이 초록이다(A 리뷰 M-2). 그 인자가 LOT·보류의 「누가」를 정한다.
    createWithin: (_tx: Prisma.TransactionClient, lotInput: Row, appUserId: unknown) => {
      recorded.order.push('lot.createWithin');
      recorded.lotInputs.push(lotInput);
      recorded.lotActors.push(appUserId);
      return Promise.resolve({ lot_id: LOT_ID, lot_no: LOT_NO });
    },
  } as unknown as LotRegistryService;

  const posting = {
    post: (_tx: Prisma.TransactionClient, posted: PostingInput) => {
      recorded.order.push('posting.post');
      recorded.posted.push(posted);
      return Promise.resolve({
        inventoryTransactionId: 77n,
        businessDate: posted.businessDate,
        alreadyPosted: false,
      });
    },
  } as unknown as InventoryPostingService;

  return { tx, posting, lots, recorded };
}

const write = (over: Partial<RecycleEntryCreate> = {}) => ({
  input: input(over),
  recycleEntryNo: NO,
  lotNo: LOT_NO,
  plantId: PLANT_ID,
  uomId: UOM_ID,
  appUserId: USER_ID,
});

describe('postRecycleEntry — 원장 한 줄과 LOT 이 한 트랜잭션이다', () => {
  it('계정 없는 단말 작업자는 LOT actor와 등록 감사에 남고 감사 실패가 전기 전체를 거절한다', async () => {
    const actor = { workerId: 8n, terminalAudit: {
      workerId: 8n, workerNo: 'W8', terminalId: 4n, plantId: 5n,
      correlationId: 'recycle-1', operationKey: 'POST /logistics/recycle-entries',
    } };
    const ok = fake();
    await postRecycleEntry(ok.tx, ok.posting, ok.lots, { ...write(), appUserId: undefined, actor });
    expect(ok.recorded.created[0]).toMatchObject({ created_by: null });
    expect(ok.recorded.lotActors[0]).toEqual(actor);
    expect(ok.recorded.order.indexOf('audit_event.create')).toBeGreaterThan(ok.recorded.order.indexOf('posting.post'));
    const fail = fake({ auditFails: true });
    await expect(postRecycleEntry(fail.tx, fail.posting, fail.lots, { ...write(), appUserId: undefined, actor }))
      .rejects.toThrow('audit unavailable');
  });
  it('6. `PostingInput` 열한 칸을 객체 통째로 — 칸 하나를 바꾸면 RED 다', async () => {
    const { tx, posting, lots, recorded } = fake();

    await postRecycleEntry(tx, posting, lots, write());

    expect(recorded.posted[0]).toEqual({
      businessDate: DAY,
      occurredAt: new Date(AT),
      transactionTypeCode: 'RECYCLE_ENTRY',
      transactionNo: NO,
      statusCode: 'POSTED',
      plantId: PLANT_ID,
      // ⭐⭐ 판별자 — 질의 213 → ⓐ. ⛔ `INVENTORY_ADJUSTMENT`·`GOODS_RECEIPT` 를 빌리지 않는다.
      sourceDocumentTypeCode: 'RECYCLE_ENTRY',
      sourceDocumentId: Number(ENTRY_ID),
      idempotencyKey: `RECYCLE_ENTRY:${NO}`,
      createdBy: USER_ID,
      lines: [
        {
          itemId: ITEM_ID,
          lotId: Number(LOT_ID),
          qty: 12.5,
          uomId: UOM_ID,
          to: {
            warehouseId: WAREHOUSE_ID,
            locationId: LOCATION_ID,
            qualityStatusCode: 'INSPECTION_PENDING',
            inventoryStatusCode: 'AVAILABLE',
          },
          ownershipTypeCode: 'OWNED',
        },
      ],
    });
  });

  it('7. 라인에 `from` 키가 **없다** — 그것이 「들어왔다」의 표현이다', async () => {
    const { tx, posting, lots, recorded } = fake();

    await postRecycleEntry(tx, posting, lots, write());

    expect(recorded.posted[0].lines[0]).not.toHaveProperty('from');
    expect(recorded.posted[0].lines[0].to).toBeDefined();
  });

  it('8. 멱등키가 «전표 번호»에서 나온 결정적 키다 — 헤더 키가 아니다', async () => {
    const { tx, posting, lots, recorded } = fake();

    await postRecycleEntry(tx, posting, lots, {
      ...write(),
      recycleEntryNo: 'RC-20260811-0099',
    });

    // 헤더 키를 쓰면 같은 등록을 다른 키로 두 번 보낼 때 원장이 둘 선다.
    expect(recorded.posted[0].idempotencyKey).toBe('RECYCLE_ENTRY:RC-20260811-0099');
    expect(recorded.posted[0].transactionNo).toBe('RC-20260811-0099');
  });

  it('⭐ 저장 칸과 LOT 입력 — 원천 문서 짝은 둘 다 비우고 역방향 칸은 호출자가 쓴다', async () => {
    const { tx, posting, lots, recorded } = fake();

    await postRecycleEntry(tx, posting, lots, write());

    expect(recorded.created[0]).toMatchObject({
      recycle_entry_no: NO,
      plant_id: PLANT_ID,
      item_id: ITEM_ID,
      recycle_type_code: 'RECYCLED',
      recycle_qty: 12.5,
      uom_id: UOM_ID,
      warehouse_id: WAREHOUSE_ID,
      destination_location_id: LOCATION_ID,
      status_code: 'POSTED',
      processed_at: new Date(AT),
      remarks: null,
    });
    expect(recorded.created[0]).not.toHaveProperty('source_document_type_code');
    expect(recorded.created[0]).not.toHaveProperty('source_document_id');
    expect(recorded.created[0]).not.toHaveProperty('lot_id');
    // LOT 은 «등록 건»을 원천으로 가리킨다 — id 축을 벌려 두었으므로 뒤바꾸면 RED 다.
    expect(recorded.lotInputs[0]).toMatchObject({
      lotNo: LOT_NO,
      itemId: ITEM_ID,
      lotTypeCode: 'MATERIAL',
      plantId: PLANT_ID,
      initialQty: 12.5,
      uomId: UOM_ID,
      sourceTypeCode: 'RECYCLE_ENTRY',
      sourceId: Number(ENTRY_ID),
    });
    expect(recorded.updated[0]).toEqual({
      where: { recycle_entry_id: ENTRY_ID },
      data: { lot_id: LOT_ID },
    });
    // ⭐ 행위자는 **코어에도 그대로** 넘어간다 — 그 인자가 `lot.created_by` 와
    //    `lot_hold.held_by` 를 정한다. 상수로 못 박으면 LOT·보류의 「누가」가 거짓이 된다
    //    (A 리뷰 M-2 · 등록 건의 `created_by` 는 직전 라운드에서 이미 잠갔다).
    expect(recorded.lotActors).toEqual([USER_ID]);
  });
});

describe('RecycleEntryService — 번호는 트랜잭션 밖에서 뽑는다', () => {
  function stub(seed: { duplicateNo?: boolean; duplicateTarget?: string } = {}) {
    const { tx, posting, lots, recorded } = fake(seed);
    const prisma = {
      item: { findUnique: () => Promise.resolve({ base_uom_id: BigInt(UOM_ID) }) },
      warehouse: { findUnique: () => Promise.resolve({ plant_id: BigInt(PLANT_ID) }) },
      location: { findFirst: () => Promise.resolve({ location_id: BigInt(LOCATION_ID) }) },
      // ⭐ 공용 판정 `assertWorkerNoExists` 는 `findUnique` 를 쓴다(`worker-no.ts:62`) — `count` 가 아니다.
      worker: { findUnique: () => Promise.resolve({ worker_id: 1n }) },
      lot: {
        count: () => {
          recorded.order.push('lot.count');
          return Promise.resolve(0);
        },
      },
      recycle_entry: {
        findUniqueOrThrow: () =>
          Promise.resolve({
            recycle_entry_id: ENTRY_ID,
            item_id: BigInt(ITEM_ID),
            recycle_qty: new Prisma.Decimal('12.5'),
            uom_id: BigInt(UOM_ID),
            warehouse_id: BigInt(WAREHOUSE_ID),
            destination_location_id: BigInt(LOCATION_ID),
            processed_at: new Date(AT),
            lot: { lot_id: LOT_ID, lot_no: LOT_NO },
          }),
      },
      $transaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
        recorded.order.push('$transaction');
        return work(tx);
      },
    } as unknown as PrismaService;
    const numbering = {
      next: (...args: unknown[]) => {
        recorded.order.push('numbering.next');
        recorded.numbered.push(args);
        return Promise.resolve(NO);
      },
    } as unknown as NumberingService;

    return { service: new RecycleEntryService(prisma, posting, numbering, lots), recorded };
  }

  it('9. 호출 **순서**가 「건 → LOT → 건 UPDATE → 전기」다 — `lot.source_id` 가 건 id 다', async () => {
    const harness = stub();

    await harness.service.create(input(), { workerNo: 'W-1', appUserId: USER_ID });

    expect(harness.recorded.order).toEqual([
      'numbering.next',
      'lot.count',
      '$transaction',
      'recycle_entry.create',
      'lot.createWithin',
      'recycle_entry.update',
      'posting.post',
    ]);
  });

  it('10. 채번이 `$transaction` 을 **열기 전**이다 · 기간 축은 본문 `businessDate` 다', async () => {
    const harness = stub();

    await harness.service.create(input({ businessDate: '2026-08-12' }), {
      workerNo: 'W-1',
      appUserId: USER_ID,
    });

    // 안에서 부르면 한 요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2 R-2).
    const { order } = harness.recorded;
    expect(order.indexOf('numbering.next')).toBeLessThan(order.indexOf('$transaction'));
    expect(order.indexOf('lot.count')).toBeLessThan(order.indexOf('$transaction'));
    // ⛔ 서버 UTC 「오늘」이 아니다 — 번호의 날짜와 원장의 영업일이 같아야 두 표를 맞댄다.
    expect(harness.recorded.numbered[0]).toEqual(['RECYCLE_ENTRY', BigInt(PLANT_ID), '2026-08-12']);
  });

  // ⭐ 축이 **셋**이다 — 이 등록은 번호를 둘 매기고(전표·LOT) 원장 번호까지 셋을 쓴다(R-11 ⓓ).
  //    ⛔ `recycle_entry_no` 하나만 밀면 `isDuplicateNo` 의 배열을 한 칸으로 줄여도 전층 초록이었다
  //       (PR ② 리뷰 MIN-2). 세 축을 각각 민다.
  it.each(['recycle_entry_no', 'lot_no', 'transaction_no'])(
    '11. %s 가 부딪히면 3회 재시도하고 그 뒤 409 다 — 사용자가 고칠 값이 아니다',
    async (duplicateTarget) => {
      const harness = stub({ duplicateNo: true, duplicateTarget });

      const caught = await harness.service
        .create(input(), { workerNo: 'W-1', appUserId: USER_ID })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConflictException);
      expect(harness.recorded.order.filter((step) => step === 'numbering.next')).toHaveLength(4);
    },
  );
});
