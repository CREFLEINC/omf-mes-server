import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductionResultCorrect, ProductionResultCorrectService } from './production-result-correct.service';

const ORIGINAL_ID = 7000;
const WORK_ORDER = 900;
const OCCURRED_AT = new Date('2026-09-06T01:30:00.000Z');
const CORRECT_NO = 'PR-260906-0009';

type Row = Record<string, unknown>;

/** 뷰 매퍼가 읽는 칸을 다 채운 원본 행. `create` 가 받은 `data` 를 그 위에 얹는다. */
function originalRow(overrides: Row = {}): Row {
  return {
    production_result_id: BigInt(ORIGINAL_ID),
    production_result_no: 'PR-260906-0001',
    work_order_id: BigInt(WORK_ORDER),
    work_session_id: null,
    result_sequence: 1,
    corrects_production_result_id: null,
    good_qty: new Prisma.Decimal(10),
    defect_qty: new Prisma.Decimal(2),
    hold_qty: new Prisma.Decimal(0),
    scrap_qty: new Prisma.Decimal(0),
    rework_qty: new Prisma.Decimal(0),
    uom_id: 3n,
    result_source_code: 'MANUAL',
    occurred_at: OCCURRED_AT,
    recorded_at: new Date('2026-09-06T02:00:00.000Z'),
    // ⭐ 사건 칸 열이 «아니다» — 원본의 지연 사유가 정정본의 사유가 되지 않는다.
    late_entry_reason_code: 'SHIFT_HANDOVER',
    worker_id: 55n,
    equipment_id: null,
    mold_id: null,
    shift_id: null,
    terminal_id: null,
    status_code: 'CONFIRMED',
    remarks: null,
    correct_reason_code: null,
    idempotency_key: 'idem-0',
    created_by: 9n,
    ...overrides,
  };
}

interface StubOptions {
  original?: Row;
  /** `approval_request` 다형 조회가 돌려줄 상태들. 없으면 0건이다. */
  requests?: { status_code: string }[];
  maxSequence?: number | null;
  missing?: boolean;
  /** 원본을 가리키는 정정본 수. 없으면 0 이다. */
  correctedCount?: number;
}

function stub(options: StubOptions = {}) {
  const original = options.original ?? originalRow();
  const created: Row[] = [];
  const updated: Row[] = [];
  const allocated: Row[] = [];
  const approvalWheres: Row[] = [];
  const sequenceWheres: Row[] = [];
  const numbered: unknown[][] = [];
  /** 부른 «차례» — 자물쇠 순서와 채번 위치가 판정 대상이다. */
  const order: string[] = [];

  const tx = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const workOrderLock = strings.join('').includes('production.work_order');
      order.push(workOrderLock ? 'lock-work-order' : 'lock-result');
      return Promise.resolve(
        workOrderLock
          ? [
              {
                status_code: 'IN_PROGRESS',
                released_at: new Date('2026-09-06T00:00:00.000Z'),
                version_no: 1,
                order_qty: new Prisma.Decimal(100),
                planned_start_at: null,
                planned_end_at: null,
              },
            ]
          : [{ production_result_id: BigInt(ORIGINAL_ID) }],
      );
    },
    approval_request: {
      findMany: ({ where }: { where: Row }) => {
        approvalWheres.push(where);
        return Promise.resolve(options.requests ?? []);
      },
    },
    production_result: {
      findUniqueOrThrow: () => Promise.resolve(original),
      count: () => Promise.resolve(options.correctedCount ?? 0),
      aggregate: ({ where }: { where: Row }) => {
        sequenceWheres.push(where);
        return Promise.resolve({ _max: { result_sequence: options.maxSequence ?? null } });
      },
      update: ({ data }: { data: Row }) => {
        updated.push(data);
        return Promise.resolve({});
      },
      create: ({ data }: { data: Row }) => {
        created.push(data);
        return Promise.resolve({
          ...original,
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
    production_result: {
      findUnique: () =>
        Promise.resolve(
          options.missing === true ? null : { work_order_id: original.work_order_id, occurred_at: original.occurred_at },
        ),
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      order.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const next = jest.fn((...args: unknown[]) => {
    order.push('numbering');
    numbered.push(args);
    return Promise.resolve(CORRECT_NO);
  });

  return {
    service: new ProductionResultCorrectService(prisma, { next } as unknown as NumberingService),
    created,
    updated,
    allocated,
    approvalWheres,
    sequenceWheres,
    numbered,
    order,
    next,
  };
}

const body = (overrides: Partial<ProductionResultCorrect> = {}): ProductionResultCorrect => ({
  reasonCode: 'MISCOUNT',
  ...overrides,
});

const context = () => ({ idempotencyKey: 'idem-correct', appUserId: 9 });

function errorsOf(caught: unknown) {
  expect(caught).toBeInstanceOf(ContractException);
  return (caught as ContractException).errors;
}

const approved = [{ status_code: 'APPROVED' }];

describe('생산 실적 정정 (I-7 PR ③)', () => {
  it('정정 — 승계 뒤 다섯 칸 중 하나라도 원본과 다르면 A급이다(R-9)', async () => {
    const harness = stub({ requests: approved });

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 12 }), context());

    // 양품 하나만 바꿔도 A급이라 승인 게이트를 «본다» — 다형 축 세 칸으로 찾는다.
    expect(harness.approvalWheres).toEqual([
      {
        target_type_code: 'PRODUCTION_RESULT',
        target_id: BigInt(ORIGINAL_ID),
        approval_type_code: 'PRODUCTION_RESULT_CORRECT',
      },
    ]);
    expect(harness.created[0]).toMatchObject({ good_qty: 12, defect_qty: 2 });
  });

  it('정정 — 다섯이 다 같으면 B급이라 승인을 안 본다', async () => {
    const harness = stub();

    // 사유·비고만 고치는 정정이다 — 승인 흔적이 0건이어도 통과한다.
    await harness.service.correct(ORIGINAL_ID, body({ note: '집계 오기' }), context());

    expect(harness.approvalWheres).toEqual([]);
    expect(harness.created[0]).toMatchObject({ correct_reason_code: 'MISCOUNT', remarks: '집계 오기' });
  });

  it('정정 — 생략한 칸은 원본 값을 승계한 뒤 비교한다(그래서 B급이다)', async () => {
    const harness = stub();

    // 원본과 «같은» 값을 명시로 보냈다 — 「준 칸만 비교」로 가르면 여기서 A급이 된다(R-9).
    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 10 }), context());

    expect(harness.approvalWheres).toEqual([]);
    expect(harness.created[0]).toMatchObject({ good_qty: 10, defect_qty: 2, hold_qty: 0, scrap_qty: 0, rework_qty: 0 });
  });

  it('정정 — A급인데 승인 0건이면 400 `APPROVAL_REQUIRED` 다(코어 `assertApproved` 와 다르다)', async () => {
    const harness = stub({ requests: [] });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 20 }), context()).catch((e: unknown) => e);

    // ⭐ 코어 `assertApproved` 는 ⌜0건이면 통과⌝ 다 — 그것을 그대로 쓰면 상신을 한 번도 안 한
    //    A급 정정이 열린다. 계약은 이 자리를 400 으로 못박았다(§5-5).
    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.APPROVAL_REQUIRED }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — `PENDING` 이면 400 `APPROVAL_IN_PROGRESS` 다', async () => {
    const harness = stub({ requests: [{ status_code: 'REJECTED' }, { status_code: 'PENDING' }] });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ scrapQty: 3 }), context()).catch((e: unknown) => e);

    // 섞여 있으면 `PENDING` 이 이긴다 — 「기다려라」가 「다시 올려라」보다 정확하다.
    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.APPROVAL_IN_PROGRESS }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — 반려만 있으면 `APPROVAL_REQUIRED` 다', async () => {
    const harness = stub({ requests: [{ status_code: 'REJECTED' }] });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 1 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.APPROVAL_REQUIRED }]);
  });

  it('정정 — 사건 칸 열은 원본을 승계한다', async () => {
    const harness = stub({
      original: originalRow({ work_session_id: 41n, equipment_id: 42n, mold_id: 43n, shift_id: 44n, terminal_id: 45n }),
      maxSequence: 4,
    });

    await harness.service.correct(ORIGINAL_ID, body(), context());

    expect(harness.created[0]).toMatchObject({
      corrects_production_result_id: BigInt(ORIGINAL_ID),
      work_order_id: BigInt(WORK_ORDER),
      work_session_id: 41n,
      equipment_id: 42n,
      mold_id: 43n,
      shift_id: 44n,
      terminal_id: 45n,
      uom_id: 3n,
      result_source_code: 'MANUAL',
      occurred_at: OCCURRED_AT,
      worker_id: 55n,
      // 새 전표라 번호·순번·상태·멱등키는 «이 요청»의 것이다.
      production_result_no: CORRECT_NO,
      result_sequence: 5,
      status_code: 'CONFIRMED',
      idempotency_key: 'idem-correct',
      created_by: 9,
    });
    // ⛔ 지연 사유는 사건 칸 열이 아니다 — 승계하지 않는다.
    expect(Object.keys(harness.created[0])).not.toContain('late_entry_reason_code');
    // 채번 기간은 «원본 사건 시각»의 UTC 날짜다 — 오늘로 다시 잡지 않는다.
    expect(harness.numbered[0]).toEqual(['PRODUCTION_RESULT', null, '2026-09-06']);
    // ⭐ 자물쇠는 W/O → 실적 순이다(교착 회피) · 채번은 트랜잭션 «밖»이다.
    expect(harness.order).toEqual(['numbering', 'transaction', 'lock-work-order', 'lock-result']);
    expect(harness.sequenceWheres).toEqual([{ work_order_id: BigInt(WORK_ORDER) }]);
  });

  it('정정 — 배분을 만들지 않는다', async () => {
    const harness = stub();

    await harness.service.correct(ORIGINAL_ID, body({ note: '비고만' }), context());

    // 계약 `ProductionResultCorrect` 에 `lotAllocations` 칸이 없다. 원본 배분도 «복사하지 않는다» —
    // 복사하면 `:complete` 의 누적 양품이 두 배가 된다(§5-6 · 문의 044).
    expect(harness.allocated).toEqual([]);
  });

  it('정정 — 원본의 `version_no` 를 안 올린다', async () => {
    const harness = stub({ requests: approved });

    await harness.service.correct(ORIGINAL_ID, body({ goodQty: 30 }), context());

    // ⌜원본을 고치지 않는다(G-18)⌝ — 고칠 것이 없으므로 If-Match 도 받지 않는다.
    expect(harness.updated).toEqual([]);
  });

  it('정정 — 정정본을 다시 정정할 수 있다', async () => {
    const harness = stub({ original: originalRow({ corrects_production_result_id: 6900n }) });

    await harness.service.correct(ORIGINAL_ID, body({ note: '재정정' }), context());

    // 체인을 막으려면 「정정본인가」 축을 하나 더 봐야 하는데 계약도 물리도 안 막았고,
    // §5-3 의 잎 규칙이 체인을 이미 옳게 센다.
    expect(harness.created[0]).toMatchObject({ corrects_production_result_id: BigInt(ORIGINAL_ID) });
  });

  it('정정 — 이미 정정된 원본은 다시 정정할 수 없다(형제가 서면 누계가 두 배다 · R-21)', async () => {
    const harness = stub({ correctedCount: 1, requests: approved });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 7 }), context()).catch((e: unknown) => e);

    expect(errorsOf(caught)).toMatchObject([{ code: ERROR_CODE.STATE_LOCKED }]);
    expect(harness.created).toEqual([]);
  });

  it('정정 — 정정 뒤 합이 0 이면 400 이다', async () => {
    const harness = stub({ original: originalRow({ defect_qty: new Prisma.Decimal(0) }), requests: approved });

    const caught = await harness.service.correct(ORIGINAL_ID, body({ goodQty: 0 }), context()).catch((e: unknown) => e);

    // 승계한 넷이 0 이라 합이 0 이 된다 — `ck_production_result_nonzero` 를 앞당겨 막는다.
    expect(errorsOf(caught)).toMatchObject([{ field: 'goodQty', code: ERROR_CODE.INVALID }]);
    expect(harness.created).toEqual([]);
  });
});
