import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { ReworkWorkOrderService } from './rework-work-order.service';

/**
 * 재작업 W/O 발행 — **판정이 정한 잔량이 상한이다**(omf-all-around#47 · 사용자 결정 2026-09-21).
 *
 * ⚠ 같은 흐름의 일반 생산 실적은 초과를 «막지 않고 되묻는다»(omf-mes-client#1040). 재작업은
 *   대상 수량이 판정으로 정해진 값이라 **막는 쪽**이다 — 두 규칙이 다르다.
 */

const NONCONFORMANCE = 700;
const ROUTING_OPERATION = 33;

type Row = Record<string, unknown>;

function stub(options: {
  /** REWORK 판정들의 수량. 비우면 재작업 판정이 없는 부적합이다. */
  decided?: number[];
  /** 이미 발행한 재작업 W/O 수량 합. */
  issued?: number | null;
  /** 원천 W/O 의 생산계획 — `null` 이면 승계할 계획이 없다. */
  productionPlanId?: bigint | null;
  /** 고른 공정이 실재하는가. */
  operationExists?: boolean;
  /** 부적합 판 번호 대조 결과. */
  updatedCount?: number;
}) {
  const created: Row[] = [];
  const calls: string[] = [];

  const tx = {
    $queryRaw: () => Promise.resolve([{ version_no: 3 }]),
    nonconformance: {
      findUniqueOrThrow: () =>
        Promise.resolve({
          item_id: 11n,
          item: { base_uom_id: 22n },
          work_order_nonconformance_work_order_idTowork_order:
            options.productionPlanId === null ? null : { production_plan_id: options.productionPlanId ?? 55n },
          nonconformance_lot: [{ lot_id: 900n, uom_id: 22n }],
          disposition_decision: (options.decided ?? [60]).map((qty) => ({
            decision_qty: new Prisma.Decimal(qty),
          })),
        }),
      updateMany: () => Promise.resolve({ count: options.updatedCount ?? 1 }),
    },
    work_order: {
      aggregate: () =>
        Promise.resolve({
          _sum: { order_qty: options.issued === undefined ? null : new Prisma.Decimal(options.issued ?? 0) },
        }),
      create: ({ data }: { data: Row }) => {
        calls.push('create');
        created.push(data);
        return Promise.resolve({
          work_order_id: 4100n,
          work_order_no: 'WO-20260921-0007',
          work_order_type_code: data.work_order_type_code,
          status_code: data.status_code,
          order_qty: data.order_qty,
          uom_id: data.uom_id,
          routing_operation_id: data.routing_operation_id,
          item_id: data.item_id,
        });
      },
    },
    routing_operation: {
      findUnique: () =>
        Promise.resolve(
          options.operationExists === false ? null : { routing_operation_id: BigInt(ROUTING_OPERATION) },
        ),
    },
  };

  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      calls.push('transaction');
      return work(tx);
    },
  } as unknown as PrismaService;

  const numbering = {
    next: () => {
      calls.push('numbering');
      return Promise.resolve('WO-20260921-0007');
    },
  } as unknown as NumberingService;

  return { service: new ReworkWorkOrderService(prisma, numbering), created, calls };
}

const issue = (harness: ReturnType<typeof stub>, orderQty = 40) =>
  harness.service.issue(NONCONFORMANCE, 3, { routingOperationId: ROUTING_OPERATION, orderQty }, 7);

describe('재작업 W/O 발행 (omf-all-around#47)', () => {
  it('판정 잔량 안이면 REWORK 유형으로 발행하고 근거 부적합을 채운다', async () => {
    const harness = stub({ decided: [60] });

    const result = await issue(harness, 40);

    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]).toMatchObject({
      work_order_type_code: 'REWORK',
      status_code: 'PLANNED',
      rework_source_nonconformance_id: BigInt(NONCONFORMANCE),
      /* ⭐ 원천 LOT 도 함께 — 라벨·추적이 되짚는 자리다. */
      rework_source_lot_id: 900n,
      production_plan_id: 55n,
    });
    expect(result.view).toMatchObject({
      workOrderTypeCode: 'REWORK',
      reworkSourceNonconformanceId: NONCONFORMANCE,
      orderQty: 40,
      /* 60 − 40 = 20 이 남는다 — 화면이 중복 발행을 막는 값이다. */
      remainingQty: 20,
    });
    expect(result.versionNo).toBe(4);
  });

  /* ⛔ 채번이 트랜잭션 안으로 들어가면 한 요청이 커넥션을 둘 쥔다(저장소 관례). */
  it('번호를 트랜잭션 밖에서 뽑는다', async () => {
    const harness = stub({});

    await issue(harness);

    expect(harness.calls.indexOf('numbering')).toBeLessThan(harness.calls.indexOf('transaction'));
  });

  /* ⛔ 판정 수량을 넘는 발행은 막는다 — 일반 생산 실적의 「되묻는다」와 다른 규칙이다. */
  it('판정 잔량을 넘으면 409 로 막고 아무것도 만들지 않는다', async () => {
    const harness = stub({ decided: [60], issued: 50 });

    await expect(issue(harness, 20)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DISPOSITION_QTY_EXCEEDED' }),
    });
    expect(harness.created).toEqual([]);
  });

  it('이미 발행한 몫을 빼고 남은 만큼은 발행된다', async () => {
    const harness = stub({ decided: [60], issued: 50 });

    const result = await issue(harness, 10);

    expect(result.view.remainingQty).toBe(0);
  });

  /* ⛔ 재작업 판정이 없는 부적합은 발행 근거가 없다 — 폐기·정상 판정만 있는 경우다. */
  it('재작업 판정이 없으면 409 다', async () => {
    const harness = stub({ decided: [] });

    /*
     * ⛔ `code` 까지 본다 — 판정이 없으면 잔량도 0 이라 **뒤의 잔량 갈래가 대신 던진다.** 그냥
     *    「거절됐다」만 보면 이 갈래를 통째로 지워도 초록이다(리뷰 2026-09-21 실측).
     */
    await expect(issue(harness)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_STATE' }),
    });
    expect(harness.created).toEqual([]);
  });

  /* 원천 W/O 가 없는 부적합(입고 검사 등)은 승계할 계획이 없다 — 지어내지 않는다. */
  it('원천 작업지시가 없으면 400 이다', async () => {
    const harness = stub({ productionPlanId: null });

    await expect(issue(harness)).rejects.toBeInstanceOf(ContractException);
    expect(harness.created).toEqual([]);
  });

  it('없는 공정으로는 발행하지 못한다', async () => {
    const harness = stub({ operationExists: false });

    await expect(issue(harness)).rejects.toBeInstanceOf(ContractException);
    expect(harness.created).toEqual([]);
  });

  /* ⛔ 낡은 토큰으로 온 발행은 막는다 — 그사이 다른 사람이 잔량을 썼을 수 있다. */
  it('부적합 판 번호가 다르면 409 다', async () => {
    const harness = stub({ updatedCount: 0 });

    await expect(issue(harness)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VERSION_CONFLICT' }),
    });
  });

  /*
   * ⛔ 상한은 «부적합의 단위» 기준이다 — 다른 단위를 실어 보내면 환산 없이 수만 비교해
   *    「60 EA 판정」에 「40 BOX 재작업」이 선다. 판정 저장과 같은 규칙으로 막는다.
   */
  it('부적합과 다른 단위로는 발행하지 못한다', async () => {
    const harness = stub({ decided: [60] });

    await expect(
      harness.service.issue(NONCONFORMANCE, 3, { routingOperationId: ROUTING_OPERATION, orderQty: 40, uomId: 999 }, 7),
    ).rejects.toBeInstanceOf(ContractException);
    expect(harness.created).toEqual([]);
  });

  it('같은 단위를 명시하는 것은 통한다', async () => {
    const harness = stub({ decided: [60] });

    const result = await harness.service.issue(
      NONCONFORMANCE,
      3,
      { routingOperationId: ROUTING_OPERATION, orderQty: 40, uomId: 22 },
      7,
    );

    expect(result.view.uomId).toBe(22);
  });
});
