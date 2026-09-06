import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MaterialConsumptionContext,
  MaterialConsumptionCreate,
  MaterialConsumptionService,
} from './material-consumption.service';

const WORK_ORDER = 900;
const ITEM = 41;
const LOT = 77;
const UOM = 3;
const WORKER_NO = '100027';
const WORKER_ID = 55n;
const PROCESS_ID = 12n;
const PLANT_ID = 8n;
const OCCURRED_AT = '2026-09-07T01:30:00.000Z';
const CONSUMPTION_NO = 'MC-20260907-0001';

type Row = Record<string, unknown>;

/** 뷰 매퍼가 읽는 칸을 다 채운 기본 행 — `create` 가 받은 `data` 를 그 위에 얹는다. */
const BASE_ROW = {
  material_consumption_id: 7001n,
  work_session_id: null,
  shopfloor_receipt_line_id: null,
  bom_component_id: null,
  corrects_consumption_id: null,
  replaced_consumption_id: null,
  change_reason_code: null,
  actual_use_process_id: null,
  actual_consumed_qty: new Prisma.Decimal(0),
  entered_qty: null,
  entered_uom_id: null,
  recorded_at: new Date('2026-09-07T01:31:00.000Z'),
  late_entry_reason_code: null,
  terminal_id: null,
  remarks: null,
};

function body(overrides: Partial<MaterialConsumptionCreate> = {}): MaterialConsumptionCreate {
  return {
    workOrderId: WORK_ORDER,
    itemId: ITEM,
    lotId: LOT,
    inputQty: 12,
    uomId: UOM,
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

function context(overrides: Partial<MaterialConsumptionContext> = {}): MaterialConsumptionContext {
  return { workerNo: WORKER_NO, idempotencyKey: 'idem-1', appUserId: 9, ...overrides };
}

interface StubOptions {
  planId?: bigint | null;
  components?: Row[];
  lot?: { item_id: bigint; status_code: string } | null;
  receiptLines?: Row[];
  session?: Row | null;
  replaced?: Row | null;
  worker?: boolean;
}

function stub(options: StubOptions = {}) {
  const created: Row[] = [];
  const componentArgs: Row[] = [];
  const receiptArgs: Row[] = [];
  const numbered: unknown[][] = [];
  /** 부른 «차례»를 그대로 적는다 — 채번과 트랜잭션의 앞뒤가 판정 대상이다. */
  const order: string[] = [];
  const components = options.components ?? [
    { bom_component_id: 31n, component_item_id: BigInt(ITEM), uom_id: BigInt(UOM), required_qty: new Prisma.Decimal(10) },
  ];
  const receiptLines = options.receiptLines ?? [];

  const tx = {
    material_consumption: {
      create: ({ data }: { data: Row }) => {
        order.push('insert');
        created.push(data);
        return Promise.resolve({ material_consumption_id: BASE_ROW.material_consumption_id });
      },
      findUniqueOrThrow: () =>
        Promise.resolve({
          ...BASE_ROW,
          ...created[created.length - 1],
          consumption_no: CONSUMPTION_NO,
          input_qty: new Prisma.Decimal(created[created.length - 1].input_qty as number),
          occurred_at: new Date(OCCURRED_AT),
        }),
    },
  };

  const bomId = options.planId === undefined ? 21n : options.planId;
  const prisma = {
    worker: {
      findUnique: () => Promise.resolve(options.worker === false ? null : { worker_id: WORKER_ID }),
    },
    work_order: {
      findUnique: () =>
        Promise.resolve({
          production_plan: bomId === null ? null : { bom_id: bomId, production_order: { plant_id: PLANT_ID } },
          routing_operation: { process_id: PROCESS_ID },
        }),
    },
    lot: {
      findUnique: () =>
        Promise.resolve(
          options.lot === undefined ? { item_id: BigInt(ITEM), status_code: 'NORMAL' } : options.lot,
        ),
    },
    item: { count: () => Promise.resolve(1) },
    uom: { count: () => Promise.resolve(1) },
    work_session: { findUnique: () => Promise.resolve(options.session ?? null) },
    material_consumption: { findUnique: () => Promise.resolve(options.replaced ?? null) },
    bom_component: {
      findFirst: (args: Row) => {
        componentArgs.push(args);
        return Promise.resolve(components[0] ?? null);
      },
    },
    shopfloor_receipt_line: {
      findFirst: (args: Row) => {
        receiptArgs.push(args);
        return Promise.resolve(receiptLines[0] ?? null);
      },
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const next = jest.fn((...args: unknown[]) => {
    order.push('numbering');
    numbered.push(args);
    return Promise.resolve(CONSUMPTION_NO);
  });
  const numbering = { next } as unknown as NumberingService;

  return {
    service: new MaterialConsumptionService(prisma, numbering),
    created,
    componentArgs,
    receiptArgs,
    numbered,
    order,
    next,
  };
}

function errorsOf(caught: unknown) {
  expect(caught).toBeInstanceOf(ContractException);
  return (caught as ContractException).errors;
}

describe('자재 투입 등록 (I-10 PR ②)', () => {
  it('BOM 에 없는 품목이면 400 INVALID', async () => {
    const harness = stub({ components: [] });

    const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

    // ⭐ 오투입 3축에서 막는 것은 이것 하나다 — 계약 ⌜찾지 못하면 명세에 없는 품목이므로 거절한다⌝.
    expect(errorsOf(caught)).toMatchObject([{ field: 'itemId', code: ERROR_CODE.INVALID }]);
    expect(harness.next).not.toHaveBeenCalled();
    expect(harness.created).toEqual([]);
  });

  it('work_order.production_plan_id 가 없으면 400 INVALID', async () => {
    // 문의 040 인용 — 긴급 W/O 는 계획이 없어 BOM 3홉에 닿을 수 없다.
    const harness = stub({ planId: null });

    const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'itemId', code: ERROR_CODE.INVALID }]);
    expect(harness.created).toEqual([]);
  });

  it('같은 품목이 bom_component 두 줄이면 sequence_no 가 작은 쪽을 쓴다', async () => {
    const harness = stub();

    await harness.service.create(body(), context());

    // 품목 유일 제약이 없다(`uq_bom_component` 는 순번 축) — 정렬로 한 줄을 고정한다.
    expect(harness.componentArgs[0]).toMatchObject({ orderBy: { sequence_no: 'asc' } });
    expect(harness.created[0]).toMatchObject({ bom_component_id: 31n });
  });

  it('lot.item_id 가 itemId 와 다르면 400 INVALID', async () => {
    const harness = stub({ lot: { item_id: 999n, status_code: 'NORMAL' } });

    const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'lotId', code: ERROR_CODE.INVALID }]);
  });

  it('lot.status_code 가 NORMAL 이 아니면 400 INVALID', async () => {
    const harness = stub({ lot: { item_id: BigInt(ITEM), status_code: 'DEFECTIVE' } });

    const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

    // `P-02-03` §5-2 ⌜`DEFECTIVE`·`INSPECTION_PENDING`·`SCRAPPED` → ⛔ 차단⌝.
    expect(errorsOf(caught)).toMatchObject([{ field: 'lotId', code: ERROR_CODE.INVALID }]);
  });

  it('entered_qty 만 오면 400 PAIR(물리 CHECK 앞당김)', async () => {
    const harness = stub();

    const caught = await harness.service.create(body({ enteredQty: 5 }), context()).catch((e: unknown) => e);

    // `ck_material_consumption_entered` 위반은 공용 그물에 안 걸려 500 으로 샌다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'enteredQty', code: ERROR_CODE.PAIR }]);
    expect(harness.created).toEqual([]);
  });

  it('빈 문자열 코드 셋은 400 REQUIRED', async () => {
    const harness = stub();

    // `app.code_t` 도메인 CHECK 위반은 공용 그물에 안 걸려 500 으로 샌다 — 400 으로 앞당긴다.
    const caught = await harness.service
      .create(body({ consumptionTypeCode: '', changeReasonCode: ' ', lateEntryReasonCode: '' }), context())
      .catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([
      { field: 'consumptionTypeCode', code: ERROR_CODE.REQUIRED },
      { field: 'changeReasonCode', code: ERROR_CODE.REQUIRED },
      { field: 'lateEntryReasonCode', code: ERROR_CODE.REQUIRED },
    ]);
    expect(harness.created).toEqual([]);
  });

  it('enteredQty 가 음수면 400 RANGE', async () => {
    const harness = stub();

    // `app.qty_t` 의 `CHECK (VALUE >= 0)` 앞당김 — `inputQty <= 0` 도 같은 자리에서 모인다.
    const caught = await harness.service
      .create(body({ inputQty: 0, enteredQty: -1, enteredUomId: 4 }), context())
      .catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([
      { field: 'inputQty', code: ERROR_CODE.RANGE },
      { field: 'enteredQty', code: ERROR_CODE.RANGE },
    ]);
    expect(harness.created).toEqual([]);
  });

  it('enteredQty 와 inputQty 의 환산 정합을 검사하지 않는다', async () => {
    // 계약이 inputQty 를 required 로 받는다 — 화면이 이미 환산한 값을 보낸다(§3-8).
    const harness = stub();

    await harness.service.create(body({ inputQty: 12, enteredQty: 999, enteredUomId: 4 }), context());

    expect(harness.created[0]).toMatchObject({ input_qty: 12, entered_qty: 999, entered_uom_id: 4n });
  });

  it('수령 라인이 여럿이면 PK 내림차순 첫 행을 잇는다', async () => {
    const harness = stub({ receiptLines: [{ shopfloor_receipt_line_id: 502n }] });

    await harness.service.create(body(), context());

    expect(harness.receiptArgs[0]).toMatchObject({ orderBy: { shopfloor_receipt_line_id: 'desc' } });
    expect(harness.created[0]).toMatchObject({ shopfloor_receipt_line_id: 502n });
  });

  it('수령 라인이 없으면 shopfloor_receipt_line_id 를 NULL 로 둔다', async () => {
    const harness = stub();

    await harness.service.create(body(), context());

    // 계약 ⌜비어 있어도 투입은 선다(출고 귀속 무관)⌝ — 값 없는 칸은 아예 안 넣는다.
    expect(harness.created[0]).not.toHaveProperty('shopfloor_receipt_line_id');
  });

  it('수령량을 넘는 투입도 201 이다', async () => {
    // 설계 미정 — 문의 052. 수령 라인에 소진량 칸이 없어 서버가 누계를 못 센다(I-9 §9).
    const harness = stub({ receiptLines: [{ shopfloor_receipt_line_id: 502n }] });

    const view = await harness.service.create(body({ inputQty: 100000 }), context());

    expect(view.consumptionNo).toBe(CONSUMPTION_NO);
    expect(harness.created[0]).toMatchObject({ input_qty: 100000, shopfloor_receipt_line_id: 502n });
  });

  it('actual_use_process_id 를 routing_operation.process_id 로 채운다', async () => {
    const harness = stub();

    // ⭐ 본문 값이 와도 서버 값이 이긴다 — 계약이 ⌜화면은 이 값을 보내지 않는다⌝ 로 적었다.
    await harness.service.create(body({ actualUseProcessId: 999, bomComponentId: 999 }), context());

    expect(harness.created[0]).toMatchObject({ actual_use_process_id: PROCESS_ID, bom_component_id: 31n });
  });

  it('terminal_id 를 넣지 않는다', async () => {
    // 설계 미정 — 문의 054. 단말 토큰 «검증» 축이 0건이라 풀 값이 없다.
    const harness = stub();

    await harness.service.create(body(), context());

    expect(harness.created[0]).not.toHaveProperty('terminal_id');
  });

  it('work_session_id 가 다른 W/O 의 세션이면 400 INVALID', async () => {
    const harness = stub({ session: { work_order_id: 901n } });

    const caught = await harness.service.create(body({ workSessionId: 7 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'workSessionId', code: ERROR_CODE.INVALID }]);
  });

  it('idempotency_key 컬럼에 헤더 값을 그대로 넣는다', async () => {
    const harness = stub();

    await harness.service.create(body(), context({ idempotencyKey: 'header-key-1' }));

    // 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다(§3-12).
    expect(harness.created[0]).toMatchObject({ idempotency_key: 'header-key-1', status_code: 'RECORDED' });
  });

  it('번호를 $transaction 밖에서 뽑는다', async () => {
    const harness = stub();

    await harness.service.create(body(), context());

    // 안에서 부르면 한 요청이 커넥션을 둘 쥐어 풀 고갈 시 `P2024` 로 죽는다(I-2 R-2).
    expect(harness.order).toEqual(['numbering', 'transaction', 'insert']);
    // 기간 키는 `occurredAt` 의 UTC 날짜다 — 공장은 W/O → 계획 → 지시로 푼다.
    expect(harness.numbered[0]).toEqual(['MATERIAL_CONSUMPTION', PLANT_ID, '2026-09-07']);
  });
});
