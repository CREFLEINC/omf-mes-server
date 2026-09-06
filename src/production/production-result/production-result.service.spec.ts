import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { LotLifecycleService, LotMoveInput } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultCreate } from './production-result-rules';
import { ProductionResultContext, ProductionResultService } from './production-result.service';

const WORK_ORDER = 900;
const WORKER_NO = '100027';
const WORKER_ID = 55n;
const OCCURRED_AT = '2026-09-06T01:30:00.000Z';
const RESULT_NO = 'PR-260906-0001';

type Row = Record<string, unknown>;

/** 뷰 매퍼가 읽는 칸을 다 채운 기본 행 — `create` 가 받은 `data` 를 그 위에 얹는다. */
const BASE_ROW = {
  production_result_id: 7001n,
  work_session_id: null,
  corrects_production_result_id: null,
  late_entry_reason_code: null,
  equipment_id: null,
  mold_id: null,
  shift_id: null,
  terminal_id: null,
  remarks: null,
  recorded_at: new Date('2026-09-06T02:00:00.000Z'),
};

function body(overrides: Partial<ProductionResultCreate> = {}): ProductionResultCreate {
  return {
    workOrderId: WORK_ORDER,
    uomId: 3,
    resultSourceCode: 'MANUAL',
    occurredAt: OCCURRED_AT,
    goodQty: 10,
    ...overrides,
  };
}

function context(overrides: Partial<ProductionResultContext> = {}): ProductionResultContext {
  return { workerNo: WORKER_NO, idempotencyKey: 'idem-1', version: undefined, appUserId: 9, ...overrides };
}

interface StubOptions {
  status?: string;
  maxSequence?: number | null;
  slots?: { lot_id: bigint; lifecycle_status_code: string | null }[];
  worker?: boolean;
}

function stub(options: StubOptions = {}) {
  const created: Row[] = [];
  const allocated: Row[] = [];
  const moves: LotMoveInput[] = [];
  const numbered: unknown[][] = [];
  const workerWheres: Row[] = [];
  const resultWheres: Row[] = [];
  const lotWheres: Row[] = [];
  /** 부른 «차례»를 그대로 적는다 — 채번·잠금·순번의 앞뒤가 판정 대상이다. */
  const order: string[] = [];

  const tx = {
    $queryRaw: () => {
      order.push('lock');
      return Promise.resolve([
        {
          status_code: options.status ?? 'IN_PROGRESS',
          released_at: new Date('2026-09-06T00:00:00.000Z'),
          version_no: 1,
          order_qty: new Prisma.Decimal(100),
          planned_start_at: null,
          planned_end_at: null,
        },
      ]);
    },
    lot: {
      findMany: ({ where }: { where: Row }) => {
        lotWheres.push(where);
        return Promise.resolve(options.slots ?? []);
      },
    },
    production_result: {
      aggregate: ({ where }: { where: Row }) => {
        order.push('sequence');
        resultWheres.push(where);
        return Promise.resolve({ _max: { result_sequence: options.maxSequence ?? null } });
      },
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({
          ...BASE_ROW,
          ...data,
          good_qty: new Prisma.Decimal(data.good_qty as number),
          defect_qty: new Prisma.Decimal(data.defect_qty as number),
          hold_qty: new Prisma.Decimal(data.hold_qty as number),
          scrap_qty: new Prisma.Decimal(data.scrap_qty as number),
          rework_qty: new Prisma.Decimal(data.rework_qty as number),
        });
      },
    },
    production_result_lot_allocation: {
      createMany: ({ data }: { data: Row[] }) => {
        allocated.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };

  const prisma = {
    worker: {
      findUnique: ({ where }: { where: Row }) => {
        workerWheres.push(where);
        return Promise.resolve(options.worker === false ? null : { worker_id: WORKER_ID });
      },
    },
    uom: { count: () => Promise.resolve(1) },
    equipment: { count: () => Promise.resolve(1) },
    mold: { count: () => Promise.resolve(1) },
    work_session: { count: () => Promise.resolve(1) },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const next = jest.fn((...args: unknown[]) => {
    order.push('numbering');
    numbered.push(args);
    return Promise.resolve(RESULT_NO);
  });
  const numbering = { next } as unknown as NumberingService;

  const lots = {
    moveWithin: (_tx: unknown, input: LotMoveInput) => {
      moves.push(input);
      return Promise.resolve({ movedLotIds: input.lotIds, skippedLotIds: [] });
    },
  } as unknown as LotLifecycleService;

  return {
    service: new ProductionResultService(prisma, numbering, lots),
    created,
    allocated,
    moves,
    numbered,
    workerWheres,
    resultWheres,
    lotWheres,
    order,
    next,
  };
}

function errorsOf(caught: unknown) {
  expect(caught).toBeInstanceOf(ContractException);
  return (caught as ContractException).errors;
}

const slot = (lot_id: bigint, lifecycle_status_code: string | null = 'WAITING') => ({ lot_id, lifecycle_status_code });

describe('생산 실적 등록 (I-7 PR ②)', () => {
  it('수량 — 다섯이 다 비면 400 이다(합 0)', async () => {
    const harness = stub();

    const caught = await harness.service.create(body({ goodQty: undefined }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'goodQty', code: ERROR_CODE.INVALID }]);
    // ⭐ 손검사가 채번보다 «앞»이다 — 거부한 요청이 번호를 태우지 않는다.
    expect(harness.next).not.toHaveBeenCalled();
    expect(harness.created).toEqual([]);
  });

  it('수량 — 음수는 400 이고 도메인 CHECK 까지 안 간다', async () => {
    const harness = stub();

    const caught = await harness.service.create(body({ defectQty: -1 }), context()).catch((e: unknown) => e);

    // `app.qty_t CHECK (VALUE >= 0)` 위반은 `PrismaClientUnknownRequestError` 라 공용 그물에
    // 안 걸려 500 이 샌다 — 손으로 앞당겨 막고 어느 칸인지 짚는다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'defectQty', code: ERROR_CODE.INVALID }]);
    expect(harness.created).toEqual([]);
  });

  it('수량 — 생략한 넷은 0 으로 저장된다', async () => {
    const harness = stub();

    await harness.service.create(body({ goodQty: 12 }), context());

    // `P-02-04` §4 ⌜네 칸은 이 화면에서 입력받지 않는다 … 기본값 0 으로 저장⌝.
    expect(harness.created[0]).toMatchObject({ good_qty: 12, defect_qty: 0, hold_qty: 0, scrap_qty: 0, rework_qty: 0 });
  });

  it('순번 — `MAX+1` 이고 W/O 를 잠근 뒤에 읽는다', async () => {
    const harness = stub({ maxSequence: 4 });

    await harness.service.create(body(), context());

    expect(harness.created[0]).toMatchObject({ result_sequence: 5 });
    // ⭐ 잠금이 먼저라 두 요청이 같은 번호를 읽지 못한다(`uq_production_result_seq`).
    expect(harness.order.indexOf('lock')).toBeLessThan(harness.order.indexOf('sequence'));
    expect(harness.resultWheres).toEqual([{ work_order_id: BigInt(WORK_ORDER) }]);
  });

  it('순번 — 첫 실적은 1 이다', async () => {
    const harness = stub({ maxSequence: null });

    await harness.service.create(body(), context());

    expect(harness.created[0]).toMatchObject({ result_sequence: 1 });
  });

  it('배분 — 같은 lotId 두 번이면 400 이다', async () => {
    const harness = stub({ slots: [slot(31n)] });

    const caught = await harness.service
      .create(
        body({
          lotAllocations: [
            { lotId: 31, allocatedQty: 5 },
            { lotId: 31, allocatedQty: 5 },
          ],
        }),
        context(),
      )
      .catch((e: unknown) => e);

    // ⛔ `UNIQUE_VIOLATION` 이 아니다 — 요청 안의 중복은 저장 충돌이 아니라 입력 오류다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'lotAllocations', code: ERROR_CODE.INVALID }]);
    expect(harness.next).not.toHaveBeenCalled();
  });

  it('배분 — 이 W/O 의 슬롯이 아니면 400 이다', async () => {
    // 조회 축이 `source_type_code='WORK_ORDER' AND source_id=이 W/O` 라 남의 슬롯은 0행으로 온다.
    const harness = stub({ slots: [] });

    const caught = await harness.service
      .create(body({ lotAllocations: [{ lotId: 77, allocatedQty: 5 }] }), context())
      .catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'lotAllocations', code: ERROR_CODE.INVALID }]);
    expect(harness.lotWheres[0]).toMatchObject({
      source_type_code: 'WORK_ORDER',
      source_id: BigInt(WORK_ORDER),
    });
    expect(harness.created).toEqual([]);
  });

  it('배분 — `VOIDED` 슬롯이면 400 이고 `skipped` 로 흘리지 않는다', async () => {
    const harness = stub({ slots: [slot(31n, 'VOIDED')] });

    const caught = await harness.service
      .create(body({ lotAllocations: [{ lotId: 31, allocatedQty: 5 }] }), context())
      .catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'lotAllocations', code: ERROR_CODE.STATE_LOCKED }]);
    // ⛔ `moveWithin` 에 넘겨 `skipped` 로 흘리면 배분 행만 남아 마감의 슬롯 집계가 되살아난 것처럼 센다.
    expect(harness.moves).toEqual([]);
    expect(harness.allocated).toEqual([]);
  });

  it('배분 — 합이 `goodQty` 와 달라도 통과한다(검사하지 않는다)', async () => {
    const harness = stub({ slots: [slot(31n)] });

    await harness.service.create(
      body({ goodQty: 10, lotAllocations: [{ lotId: 31, allocatedQty: 3 }] }),
      context(),
    );

    // 계약이 «무엇과» 비교할지 침묵한다(`goodQty`? 다섯 합?) — 검사를 지어내지 않는다(§4-5).
    expect(harness.allocated).toMatchObject([{ lot_id: 31n, allocated_qty: 3 }]);
    expect(harness.moves[0]).toMatchObject({
      lotIds: [31n],
      action: 'production-result-recorded',
      sourceDocumentTypeCode: 'PRODUCTION_RESULT',
      changedAt: new Date(OCCURRED_AT),
    });
  });

  it('배분 — 합이 양품수량을 넘으면 400 이고 DB-C18 트리거까지 안 간다', async () => {
    const harness = stub({ slots: [slot(31n)] });

    const caught = await harness.service
      .create(body({ goodQty: 10, lotAllocations: [{ lotId: 31, allocatedQty: 11 }] }), context())
      .catch((e: unknown) => e);

    // `trg_result_lot_allocation_sum` 은 `DEFERRABLE INITIALLY DEFERRED` 라 커밋 시점에 터지고
    // `check_violation` 은 공용 그물에 안 걸려 500 이 샌다 — 손으로 앞당겨 막는다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'lotAllocations', code: ERROR_CODE.INVALID }]);
    expect(harness.next).not.toHaveBeenCalled();
  });

  it('상태 — `PLANNED`·`CONFIRMED`·`CANCELLED` 는 400 이다', async () => {
    for (const status of ['PLANNED', 'CONFIRMED', 'CANCELLED']) {
      const harness = stub({ status });

      const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

      // 배포 전이거나 취소돼 «실적이 붙을 슬롯»이 없다. 409 가 아니다 — 재로드해도 안 풀린다(G-1).
      expect(errorsOf(caught)).toMatchObject([{ field: 'workOrderId', code: ERROR_CODE.STATE_LOCKED }]);
      expect(harness.created).toEqual([]);
    }
  });

  it('상태 — `CLOSED` W/O 에도 들어간다(W-02-05 §5-4 규칙 3)', async () => {
    const harness = stub({ status: 'CLOSED' });

    await harness.service.create(body(), context());

    // ⭐ 마감 뒤 도착한 지연 실적을 덧붙이는 것이 확정된 업무다. `work_order` 를 UPDATE 하지
    //    않으므로 마감 불변 트리거(BEFORE UPDATE)에 걸리지 않는다.
    expect(harness.created).toHaveLength(1);
  });

  it('귀속 — `X-Worker-No` 가 없으면 400 `REQUIRED` 다', async () => {
    const harness = stub();

    const caught = await harness.service
      .create(body(), context({ workerNo: undefined }))
      .catch((e: unknown) => e);

    // 헤더는 계약 검증 가드가 안 본다 — 서비스가 손으로 판정한다(§1-1 · §4-3).
    expect(errorsOf(caught)).toMatchObject([{ field: 'X-Worker-No', code: ERROR_CODE.REQUIRED }]);
    expect(harness.next).not.toHaveBeenCalled();
  });

  it('귀속 — 사번이 마스터에 없으면 400 `INVALID` 다', async () => {
    const harness = stub({ worker: false });

    const caught = await harness.service.create(body(), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ field: 'X-Worker-No', code: ERROR_CODE.INVALID }]);
    expect(harness.created).toEqual([]);
  });

  it('귀속 — `app_user_id` 로 도출하지 않는다', async () => {
    const harness = stub();

    const caught = await harness.service
      .create(body(), context({ workerNo: undefined, appUserId: 9 }))
      .catch((e: unknown) => e);

    // 세션이 있어도 사번을 «도출»하지 않는다 — 계약이 헤더를 required 로 못박았고 도출은
    // 값을 조용히 지어내는 것이다. `mdm.worker` 는 `worker_no` 로만 찾는다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'X-Worker-No', code: ERROR_CODE.REQUIRED }]);
    expect(harness.workerWheres).toEqual([]);

    const found = stub();
    await found.service.create(body(), context());
    expect(found.workerWheres).toEqual([{ worker_no: WORKER_NO }]);
    // 주체(`created_by`)는 여전히 계정 세션이다 — 귀속과 주체는 다른 칸이다.
    expect(found.created[0]).toMatchObject({ worker_id: WORKER_ID, created_by: 9 });
  });

  it('채번 — `plantId` 로 `null` 을 넘기고 `periodDate` 는 `occurredAt` 의 UTC 날짜다', async () => {
    const harness = stub();

    await harness.service.create(body({ occurredAt: '2026-09-06T23:30:00.000Z' }), context());

    // ⭐ 공장을 도출하지 않는다 — 실적에도 W/O 에도 공장 축이 없다(`purchase-order.service.ts:288-297`).
    // ⭐ 서버가 「오늘」로 다시 잡지 않는다 — 오프라인 재전송이 같은 날 번호를 받아야 한다.
    expect(harness.numbered[0]).toEqual(['PRODUCTION_RESULT', null, '2026-09-06']);
    expect(harness.created[0]).toMatchObject({ production_result_no: RESULT_NO });
  });

  it('채번 — `$transaction` 을 열기 전에 부른다', async () => {
    const harness = stub();

    await harness.service.create(body(), context());

    // 열린 트랜잭션 «안»에서 부르면 한 요청이 커넥션을 둘 쥐고 풀이 마르면 `P2024` 로 죽는다.
    expect(harness.order.indexOf('numbering')).toBeLessThan(harness.order.indexOf('transaction'));
  });

  it('상태값 — `status_code` 는 `CONFIRMED` 상수이고 이 값으로 아무것도 거르지 않는다', async () => {
    const harness = stub();

    const view = await harness.service.create(body(), context());

    // `PRODUCTION_RESULT_STATUS` 는 폐기 그룹이라 값 목록이 없다 — 이미 데이터에 있는 값을
    // 그대로 쓰고, 조회·집계 어느 `where` 에도 이 칸을 넣지 않는다(§2-3).
    expect(harness.created[0]).toMatchObject({ status_code: 'CONFIRMED' });
    expect(view.statusCode).toBe('CONFIRMED');
    expect(harness.resultWheres).toEqual([{ work_order_id: BigInt(WORK_ORDER) }]);
    expect(JSON.stringify(harness.lotWheres)).not.toContain('CONFIRMED');
  });
});
