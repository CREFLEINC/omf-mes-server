import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { DocumentStateService } from '../../core/document-state';
import { LotLifecycleService, LotMoveInput } from '../../core/lot';
import { OutboxEnqueueInput, OutboxService } from '../../core/outbox';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkOrderCancelService } from './work-order-cancel.service';
import { WorkOrderCloseService } from './work-order-close.service';

const WORK_ORDER = 900;
const ORDER_QTY = 100;

type Row = Record<string, unknown>;

function stub(options: { status?: string; goodSum?: number; openSession?: boolean; slots?: bigint[] } = {}) {
  const updates: Row[] = [];
  const creates: Row[] = [];
  const resultWheres: Row[] = [];
  const lotWheres: Row[] = [];
  const moves: LotMoveInput[] = [];
  const enqueued: OutboxEnqueueInput[] = [];

  const tx = {
    $queryRaw: () =>
      Promise.resolve([
        {
          status_code: options.status ?? 'IN_PROGRESS',
          released_at: new Date('2026-09-06T00:00:00.000Z'),
          version_no: 1,
          order_qty: new Prisma.Decimal(ORDER_QTY),
          planned_start_at: null,
          planned_end_at: null,
        },
      ]),
    work_session: {
      findFirst: () => Promise.resolve(options.openSession === true ? { work_session_id: 1n } : null),
    },
    production_result: {
      aggregate: ({ where }: { where: Row }) => {
        resultWheres.push(where);
        const sum = options.goodSum === undefined ? null : new Prisma.Decimal(options.goodSum);
        return Promise.resolve({ _sum: { good_qty: sum } });
      },
    },
    work_order: {
      update: ({ data }: { data: Row }) => {
        updates.push(data);
        return Promise.resolve({ work_order_no: 'WO-20260906-0001', item_id: 11n });
      },
      create: ({ data }: { data: Row }) => {
        creates.push(data);
        return Promise.resolve({});
      },
    },
    lot: {
      findMany: ({ where }: { where: Row }) => {
        lotWheres.push(where);
        return Promise.resolve((options.slots ?? []).map((lot_id) => ({ lot_id })));
      },
    },
  };

  const prisma = {
    // `assertCodeValues` 가 보는 마스터 — 두 사유 그룹의 값을 다 등록해 둔다.
    code_value: {
      findMany: () =>
        Promise.resolve([
          { code: 'MATERIAL_SHORTAGE', code_group: { group_code: 'WORK_ORDER_COMPLETION_VARIANCE_REASON' } },
          { code: 'PLAN_CHANGE', code_group: { group_code: 'WORK_ORDER_CANCEL_REASON' } },
        ]),
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaService;

  const lots = {
    moveWithin: (_tx: unknown, input: LotMoveInput) => {
      moves.push(input);
      return Promise.resolve({ movedLotIds: input.lotIds, skippedLotIds: [] });
    },
  } as unknown as LotLifecycleService;

  const outbox = {
    enqueue: (_tx: unknown, input: OutboxEnqueueInput) => {
      enqueued.push(input);
      return Promise.resolve({ integrationMessageId: 1n, alreadyQueued: false });
    },
  } as unknown as OutboxService;

  const documentState = new DocumentStateService();
  return {
    close: new WorkOrderCloseService(prisma, documentState, lots, outbox),
    cancel: new WorkOrderCancelService(prisma, documentState, lots),
    updates,
    creates,
    resultWheres,
    lotWheres,
    moves,
    enqueued,
  };
}

describe('W/O 마감·취소 (I-6 PR ⑥b)', () => {
  it('마감 — 누적 양품은 실적 상태로 거르지 않는다', async () => {
    const harness = stub({ goodSum: ORDER_QTY });

    await harness.close.close(WORK_ORDER, 1, {}, 7);

    // ⛔ `PRODUCTION_RESULT_STATUS` 그룹이 폐기돼 거를 값이 없다 — `status_code` 를 조건에
    //    넣으면 조회(`progressOf`)와 마감이 다른 양품 합을 낸다(§5-2 · F-6).
    expect(harness.resultWheres).toEqual([{ work_order_id: BigInt(WORK_ORDER) }]);
    expect(harness.enqueued[0].payload).toMatchObject({
      header: { goodQty: ORDER_QTY, completionJudgmentCode: 'NORMAL' },
      sendItems: [],
    });
  });

  it('마감 — 실적이 0건이면 양품 합은 0 이고 미달 판정이다', async () => {
    const harness = stub({ goodSum: undefined });

    // 합이 널이라 0 으로 읽는다 — 미달이므로 처분·사유가 둘 다 필요하다.
    await harness.close.close(
      WORK_ORDER,
      1,
      { remainderDispositionCode: 'WRITE_OFF', reasonCode: 'MATERIAL_SHORTAGE' },
      7,
    );

    expect(harness.enqueued[0].payload).toMatchObject({
      header: { goodQty: 0, completionJudgmentCode: 'UNDER' },
    });
    expect(harness.updates[0]).toMatchObject({
      close_disposition_code: 'WRITE_OFF',
      completion_variance_reason_code: 'MATERIAL_SHORTAGE',
    });
  });

  it('마감 — `closed_at` 을 찍는 UPDATE 는 한 번뿐이다(트리거가 두 번째를 막는다)', async () => {
    const harness = stub({ goodSum: ORDER_QTY, slots: [10n] });

    await harness.close.close(WORK_ORDER, 1, {}, 7);

    // `trg_work_order_closed_immutable` 이 `OLD.closed_at IS NOT NULL` 인 UPDATE 를 막는다 —
    // 슬롯 폐번·아웃박스 적재가 뒤에 오지만 그 둘은 «다른 표»라 괜찮다.
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]).toMatchObject({ status_code: 'CLOSED', version_no: { increment: 1 } });
    expect(harness.updates[0].closed_at).toEqual(expect.any(Date));
    // ⛔ `completed_at` 은 건드리지 않는다 — 실적 축이 찍는 칸이다.
    expect(Object.keys(harness.updates[0])).not.toContain('completed_at');
    expect(harness.moves).toHaveLength(1);
    expect(harness.enqueued).toHaveLength(1);
  });

  it('마감 — 이월 W/O 를 만들지 않는다', async () => {
    const harness = stub({ goodSum: 90 });

    await harness.close.close(
      WORK_ORDER,
      1,
      { remainderDispositionCode: 'CARRY_OVER', reasonCode: 'MATERIAL_SHORTAGE' },
      7,
    );

    // 계약 자인 — ⌜이월이 잔량 W/O 를 «자동으로» 만드는지는 아직 정해지지 않았다⌝.
    expect(harness.creates).toEqual([]);
    expect(harness.updates[0]).toMatchObject({ close_disposition_code: 'CARRY_OVER' });
  });

  it('마감 — 열린 세션 검사가 전이 검사보다 앞이다', async () => {
    // 상태가 전이표의 `from` 밖(`PLANNED`)이면서 세션도 열려 있다 — 둘 다 걸리는 자리다.
    const harness = stub({ status: 'PLANNED', openSession: true });

    const rejected = await harness.close.close(WORK_ORDER, 1, {}, 7).catch((error: unknown) => error);

    // 400 `STATE_LOCKED` 가 아니라 409 다 — 계약이 이 자리에만 봉투를 지정했다(§5-1).
    expect(rejected).toBeInstanceOf(ConflictException);
    expect((rejected as ConflictException).conflict).toMatchObject({ code: 'OPEN_SESSION_EXISTS' });
    expect(harness.updates).toEqual([]);
  });

  it('마감 — 슬롯 대상이 실적 없는 `WAITING` 뿐이고 빈 목록이면 코어를 부르지 않는다', async () => {
    const harness = stub({ goodSum: ORDER_QTY });

    await harness.close.close(WORK_ORDER, 1, {}, 7);

    expect(harness.lotWheres).toEqual([
      {
        source_type_code: 'WORK_ORDER',
        source_id: BigInt(WORK_ORDER),
        lifecycle_status_code: 'WAITING',
        production_result_lot_allocation: { none: {} },
      },
    ]);
    expect(harness.moves).toEqual([]);
    // 슬롯이 0건이어도 아웃박스는 적재한다 — 둘은 다른 축이다.
    expect(harness.enqueued[0]).toMatchObject({
      interfaceCode: 'IF-WO-CLOSE-SEND',
      messageKey: 'IF-WO-CLOSE-SEND:WO-20260906-0001',
      targetTypeCode: 'WORK_ORDER',
      targetId: BigInt(WORK_ORDER),
    });
  });

  it('마감 — L2 이력의 `sourceDocumentTypeCode` 는 `WORK_ORDER_CLOSING` 이고 아웃박스 `targetTypeCode` 는 `WORK_ORDER` 그대로다', async () => {
    const harness = stub({ goodSum: ORDER_QTY, slots: [10n] });

    await harness.close.close(WORK_ORDER, 1, {}, 7);

    // 계약 `LotLifecycleHistoryEvent.sourceDocumentTypeCode` enum 이 전이별 값을 못박았다 —
    // L2 대기→폐번은 `WORK_ORDER_CLOSING` 이고 `WORK_ORDER` 는 L3 취소의 값이다(I-7 R-2).
    expect(harness.moves[0]).toMatchObject({ sourceDocumentTypeCode: 'WORK_ORDER_CLOSING' });
    // ⛔ 아웃박스는 «승인 다형 축»이라 그대로 `WORK_ORDER` 다 — 두 축이 한 상수를 쓰고 있었다.
    expect(harness.enqueued[0]).toMatchObject({ targetTypeCode: 'WORK_ORDER' });
  });

  it('취소 — 대상 집합이 `WAITING`·`ACTIVE` 전건이고 마감의 집합보다 넓다', async () => {
    const harness = stub({ status: 'RELEASED', slots: [10n, 11n] });

    await harness.cancel.cancel(WORK_ORDER, 1, { reasonCode: 'PLAN_CHANGE', note: '버려진다' }, 7);

    // ⌜취소는 선발행 슬롯 전건이다⌝ — 마감의 「실적 없는 것만」 조건이 여기엔 없다.
    expect(harness.lotWheres).toEqual([
      {
        source_type_code: 'WORK_ORDER',
        source_id: BigInt(WORK_ORDER),
        lifecycle_status_code: { in: ['WAITING', 'ACTIVE'] },
      },
    ]);
    expect(harness.moves[0]).toMatchObject({ lotIds: [10n, 11n], action: 'work-order-cancel' });
    // `note` 는 버린다 — `remarks` 에 덧붙이지 않는다(「알려둘 것」).
    expect(harness.updates[0]).toEqual({
      status_code: 'CANCELLED',
      cancellation_reason_code: 'PLAN_CHANGE',
      updated_by: 7,
      version_no: { increment: 1 },
    });
    // ⛔ 취소는 ERP 로 나가지 않는다.
    expect(harness.enqueued).toEqual([]);
  });
});
