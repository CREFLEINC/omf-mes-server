import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { LotComplete, LotCompleteService } from './lot-complete.service';

const LOT_ID = 7;
const WORK_ORDER_ID = 900n;
const OCCURRED_AT = '2026-09-06T05:00:00.000Z';
const VARIANCE_REASON_GROUP = 'WORK_ORDER_COMPLETION_VARIANCE_REASON';

type Row = Record<string, unknown>;

interface StubOptions {
  initialQty?: number;
  allocated?: number | null;
  sourceTypeCode?: string;
  completedAt?: Date | null;
  missing?: boolean;
  workOrder?: { closed_at: Date | null } | null;
}

function stub(options: StubOptions = {}) {
  const lotUpdates: Row[] = [];
  const workOrderUpdates: Row[] = [];
  const workOrderReads: Row[] = [];
  const allocationWheres: Row[] = [];
  /** ⛔ 이 둘이 «비어 있어야» 한다 — 완료는 실적 합을 세지도, 이력을 찍지도 않는다. */
  const resultAggregates: Row[] = [];
  const historyCreates: Row[] = [];
  const codeChecks: Row[] = [];

  const locked = {
    initial_qty: new Prisma.Decimal(options.initialQty ?? 50),
    source_type_code: options.sourceTypeCode ?? 'WORK_ORDER',
    source_id: WORK_ORDER_ID,
    completed_at: options.completedAt ?? null,
    version_no: 2,
  };
  const stored = {
    lot_id: BigInt(LOT_ID),
    lot_no: 'LOT-1',
    item_id: 11n,
    lot_type_code: 'PRODUCTION',
    plant_id: 1n,
    uom_id: 2n,
    manufactured_at: null,
    expiry_date: null,
    status_code: 'NORMAL',
    lifecycle_status_code: 'ACTIVE',
    parent_lot_id: null,
    remarks: null,
    lot_hold: [],
    ...locked,
  };

  const tx = {
    $queryRaw: () => Promise.resolve(options.missing === true ? [] : [locked]),
    production_result_lot_allocation: {
      aggregate: ({ where }: { where: Row }) => {
        allocationWheres.push(where);
        const value = options.allocated === undefined ? 50 : options.allocated;
        return Promise.resolve({
          _sum: { allocated_qty: value === null ? null : new Prisma.Decimal(value) },
        });
      },
    },
    production_result: {
      aggregate: ({ where }: { where: Row }) => {
        resultAggregates.push(where);
        return Promise.resolve({ _sum: { good_qty: new Prisma.Decimal(0) } });
      },
    },
    work_order: {
      findUnique: ({ where }: { where: Row }) => {
        workOrderReads.push(where);
        return Promise.resolve(options.workOrder === undefined ? { closed_at: null } : options.workOrder);
      },
      update: ({ data }: { data: Row }) => {
        workOrderUpdates.push(data);
        return Promise.resolve({});
      },
    },
    lot: {
      update: ({ data }: { data: Row }) => {
        lotUpdates.push(data);
        return Promise.resolve({ ...stored, completed_at: data.completed_at as Date, version_no: 3 });
      },
    },
    lot_lifecycle_history: {
      create: ({ data }: { data: Row }) => {
        historyCreates.push(data);
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    code_value: {
      findMany: ({ where }: { where: Row }) => {
        codeChecks.push(where);
        return Promise.resolve([
          { code: 'MATERIAL_SHORTAGE', code_group: { group_code: VARIANCE_REASON_GROUP } },
        ]);
      },
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  return {
    service: new LotCompleteService(prisma),
    lotUpdates,
    workOrderUpdates,
    workOrderReads,
    allocationWheres,
    resultAggregates,
    historyCreates,
    codeChecks,
  };
}

const body = (overrides: Partial<LotComplete> = {}): LotComplete => ({
  businessDate: '2026-09-06',
  occurredAt: OCCURRED_AT,
  ...overrides,
});

const context = () => ({ workerNo: 'WK-1', version: undefined, appUserId: 9 });

function errorsOf(caught: unknown) {
  expect(caught).toBeInstanceOf(ContractException);
  return (caught as ContractException).errors;
}

describe('생산 LOT 완료 (I-7 PR ④)', () => {
  it('완료 — 목표는 `lot.initial_qty` 이고 누적은 `Σ allocated_qty` 다(`good_qty` 합이 아니다)', async () => {
    const harness = stub({ initialQty: 50, allocated: 50 });

    await harness.service.complete(LOT_ID, body(), context());

    // 누적은 «이 LOT 에 배분된 것»만 센다 — W/O 축(실적 양품 합)과 섞으면 슬롯이 둘일 때 두 배가 된다.
    expect(harness.allocationWheres).toEqual([{ lot_id: BigInt(LOT_ID) }]);
    expect(harness.resultAggregates).toEqual([]);
  });

  it('완료 — 미달인데 사유가 없으면 400 `REQUIRED` 다', async () => {
    const harness = stub({ initialQty: 50, allocated: 30 });

    const caught = await harness.service.complete(LOT_ID, body(), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([
      { field: 'completionVarianceReasonCode', code: ERROR_CODE.REQUIRED },
    ]);
    expect(harness.lotUpdates).toEqual([]);
  });

  it('완료 — 정상·초과인데 사유가 오면 400 `INVALID` 다(:close 규칙 5 와 대칭)', async () => {
    const reason = { completionVarianceReasonCode: 'MATERIAL_SHORTAGE' };
    const normal = stub({ initialQty: 50, allocated: 50 });
    const over = stub({ initialQty: 50, allocated: 70 });

    const onNormal = await normal.service.complete(LOT_ID, body(reason), context()).catch((e: unknown) => e);
    const onOver = await over.service.complete(LOT_ID, body(reason), context()).catch((e: unknown) => e);

    // 조용히 버리면 화면이 사유를 적었다고 믿는다.
    expect(errorsOf(onNormal)).toMatchObject([
      { field: 'completionVarianceReasonCode', code: ERROR_CODE.INVALID },
    ]);
    expect(errorsOf(onOver)).toMatchObject([{ code: ERROR_CODE.INVALID }]);
    expect(normal.lotUpdates).toEqual([]);
  });

  it('완료 — 사유는 `WORK_ORDER_COMPLETION_VARIANCE_REASON` 6값과 대조한다', async () => {
    const good = stub({ initialQty: 50, allocated: 30 });
    const bad = stub({ initialQty: 50, allocated: 30 });

    await good.service
      .complete(LOT_ID, body({ completionVarianceReasonCode: 'MATERIAL_SHORTAGE' }), context())
      .catch((e: unknown) => e);
    const caught = await bad.service
      .complete(LOT_ID, body({ completionVarianceReasonCode: '지어낸값' }), context())
      .catch((e: unknown) => e);

    // 대조는 트랜잭션 «밖»이다 — 잠글 필요가 없는 마스터 조회다.
    expect(good.codeChecks[0]).toMatchObject({
      OR: [{ code: 'MATERIAL_SHORTAGE', code_group: { group_code: VARIANCE_REASON_GROUP } }],
    });
    expect(errorsOf(caught)).toMatchObject([
      { field: 'completionVarianceReasonCode', code: ERROR_CODE.INVALID },
    ]);
    expect(bad.lotUpdates).toEqual([]);
  });

  it('완료 — 어느 상태 칸도 안 옮기고 `completed_at` 만 찍는다', async () => {
    const harness = stub({ initialQty: 50, allocated: 50 });

    const result = await harness.service.complete(LOT_ID, body({ remarks: '마감' }), context());

    // `LOT_LIFECYCLE_STATUS` 3값에 「완료」가 없다 — 완료는 «시각 필드»가 담는다(`P-02-06` §5-5).
    expect(Object.keys(harness.lotUpdates[0]).sort()).toEqual(
      ['completed_at', 'remarks', 'updated_by', 'version_no'].sort(),
    );
    expect(harness.lotUpdates[0]).toMatchObject({
      completed_at: new Date(OCCURRED_AT),
      version_no: { increment: 1 },
    });
    expect(result.view.lifecycleStatusCode).toBe('ACTIVE');
    expect(result.versionNo).toBe(3);
  });

  it('완료 — `lot_lifecycle_history` 를 쓰지 않는다', async () => {
    const harness = stub({ initialQty: 50, allocated: 50 });

    await harness.service.complete(LOT_ID, body(), context());

    // `LOT_LIFECYCLE_TRANSITION` 3값(L1·L2·L3)에 「완료」가 없고 `transition_code` 는 NOT NULL 이다.
    expect(harness.historyCreates).toEqual([]);
  });

  it('완료 — 생산 LOT(`source_type_code=\'WORK_ORDER\'`)이 아니면 400 이다', async () => {
    const harness = stub({ sourceTypeCode: 'INBOUND_RECEIPT_LINE' });

    const caught = await harness.service.complete(LOT_ID, body(), context()).catch((e: unknown) => e);

    // 계약이 ⌜**생산** LOT 을 완료로 옮긴다⌝ 라 적었다.
    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.INVALID }]);
    expect(harness.allocationWheres).toEqual([]);
  });

  it('완료 — 이미 완료됐으면 400 `STATE_LOCKED` 다', async () => {
    const harness = stub({ completedAt: new Date('2026-09-05T00:00:00.000Z') });

    const caught = await harness.service.complete(LOT_ID, body(), context()).catch((e: unknown) => e);

    // 멱등 키가 다르면 재전송이 아니다 — 두 번 완료하지 않는다.
    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(harness.lotUpdates).toEqual([]);
  });

  it('완료 — 배분이 0건(누적 0)이면 400 `STATE_LOCKED` 다(R-7)', async () => {
    const none = stub({ allocated: null });
    const zero = stub({ allocated: 0 });

    const onNone = await none.service.complete(LOT_ID, body(), context()).catch((e: unknown) => e);
    const onZero = await zero.service.complete(LOT_ID, body(), context()).catch((e: unknown) => e);

    // 안 막으면 `WAITING` 슬롯이 `completed_at` 을 얻고 마감 L2 가 그 행을 폐번한다.
    expect(errorsOf(onNone)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(errorsOf(onZero)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(none.lotUpdates).toEqual([]);
  });

  it('완료 — 마감된 W/O 의 LOT 을 «미달»로 완료하면 400 이고 500 이 아니다(트리거를 앞당겨 막는다)', async () => {
    const harness = stub({
      initialQty: 50,
      allocated: 30,
      workOrder: { closed_at: new Date('2026-09-06T02:00:00.000Z') },
    });

    const caught = await harness.service
      .complete(LOT_ID, body({ completionVarianceReasonCode: 'MATERIAL_SHORTAGE' }), context())
      .catch((e: unknown) => e);

    // `trg_work_order_closed_immutable`(BEFORE UPDATE)이 던지면 500 이 샌다.
    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(harness.workOrderUpdates).toEqual([]);
    expect(harness.lotUpdates).toEqual([]);
  });

  it('완료 — 정상이면 `work_order` 를 UPDATE 하지 않아 마감된 W/O 에서도 통과한다', async () => {
    const harness = stub({
      initialQty: 50,
      allocated: 50,
      workOrder: { closed_at: new Date('2026-09-06T02:00:00.000Z') },
    });

    await harness.service.complete(LOT_ID, body(), context());

    // 정상·초과는 W/O 를 아예 «읽지도» 않는다 — 트리거에 닿을 일이 없다.
    expect(harness.workOrderReads).toEqual([]);
    expect(harness.workOrderUpdates).toEqual([]);
    expect(harness.lotUpdates).toHaveLength(1);
  });

  it('완료 — `businessDate` 를 받아도 저장하지 않는다', async () => {
    const harness = stub({ initialQty: 50, allocated: 50 });

    await harness.service.complete(LOT_ID, body({ businessDate: '2026-01-01' }), context());

    // 원장을 안 지나는 오퍼레이션은 받아서 형식만 보고 저장하지 않는다(대기 15).
    expect(Object.keys(harness.lotUpdates[0])).not.toContain('business_date');
    // 찍히는 시각은 «사건» 시각이지 업무일자가 아니다.
    expect(harness.lotUpdates[0].completed_at).toEqual(new Date(OCCURRED_AT));
  });
});
