import { Injectable } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { optional } from '../../common/master';
import { LotLifecycleService, Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVersion, lockWorkOrder } from '../work-order/work-order-write.service';
import {
  ProductionResultCreate,
  ResultLotAllocation,
  SlotRow,
  assertAllocationCap,
  assertAllocations,
  assertLateEntryReason,
  assertResultAccepted,
  assertSlots,
  resultQuantities,
} from './production-result-rules';
import { ProductionResultView, productionResultView } from './production-result-view';

/** 채번 문서 유형 — `app.numbering_rule` 에 `PR-{YYMMDD}-{SEQ4}` 가 등재돼 있다(DEFAULT_PREFIX 무관). */
const NUMBERING_DOCUMENT = 'PRODUCTION_RESULT';
/**
 * 계약 `LotLifecycleHistoryEvent.sourceDocumentTypeCode` enum 의 L1 값. 채번 유형과 문자열이
 * 같지만 **축이 다르다** — 둘을 한 상수로 묶으면 R-2(L2 가 `WORK_ORDER_CLOSING` 인데 아웃박스
 * 축과 공용 상수를 써서 틀린 값이 실린 자리)를 되풀이한다. 이 한 자리만 쓰므로 코어로 올리지
 * 않는다(CLAUDE.md 「사용처 하나뿐인 추상화 금지」).
 */
const LOT_SOURCE_DOCUMENT = 'PRODUCTION_RESULT';
/** L1 대기→활성 — `transitions.ts:112` 에 이미 등록돼 있다. 여기서는 부르기만 한다. */
const RECORD_ACTION = 'production-result-recorded';
/**
 * 태어나는 상태값. `PRODUCTION_RESULT_STATUS` 는 폐기 그룹(`x-no-code-key` · A-21)이라 값 목록이
 * 없어 **이미 데이터에 있는 값**을 그대로 든다. ⛔ 이 값으로 «아무것도 거르지 않는다» —
 * 원본인지 정정본인지는 `corrects_production_result_id` 가 판정한다(`plan.md` §0 #10 · I-3 R-9).
 */
const RESULT_STATUS = 'CONFIRMED';
const WORKER_NO = 'X-Worker-No';

/** 본문 밖에서 오는 것 — 헤더 셋과 세션. */
export interface ProductionResultContext {
  workerNo: string | undefined;
  idempotencyKey: string;
  /** If-Match 는 **선택**이다 — 없으면 대조를 건너뛴다(§4-6 · C-9). */
  version: number | undefined;
  appUserId: number | undefined;
}

interface PreparedResult {
  body: ProductionResultCreate;
  context: ProductionResultContext;
  workerId: bigint;
  quantities: Record<string, number>;
  allocations: readonly ResultLotAllocation[];
  occurredAt: Date;
  productionResultNo: string;
}

/**
 * 생산 실적 등록 + LOT 배분 + L1 호출(I-7 PR ②). 순서는 §4-1 그대로다.
 *
 * ⛔ **원장을 지나지 않는다** — `posting.post()` 를 안 부르고 `inventory_*` 어느 표도 안 만진다
 *    (`plan.md` §5 #8 · 제품 입고는 이미 구현된 입고가 만든다).
 * ⛔ **`work_order` 를 UPDATE 하지 않는다** — 진행률은 언제나 실적을 «세어» 낸다
 *    (`work-order-progress.ts`). 그래서 마감된 W/O 에 실적을 넣어도 트리거에 안 걸린다.
 * ⛔ ETag 를 안 낸다 — 계약이 I-7 7건 중 어디에도 선언하지 않았다.
 */
@Injectable()
export class ProductionResultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly lots: LotLifecycleService,
  ) {}

  async create(body: ProductionResultCreate, context: ProductionResultContext): Promise<ProductionResultView> {
    const workerId = await this.resolveWorker(context.workerNo);
    const quantities = resultQuantities(body);
    const allocations = body.lotAllocations ?? [];
    assertAllocations(allocations);
    assertAllocationCap(allocations, quantities.good_qty);
    assertLateEntryReason(body.lateEntryReasonCode);
    await this.assertReferences(body);
    const occurredAt = new Date(body.occurredAt);
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 한 요청이 커넥션을 둘 쥐고
    //    풀이 마르면 `P2024` 로 죽는다(`numbering.service.ts` 주석). 대가인 결번은 허용한다(I-2 R-2).
    // ⭐ `plantId` 는 `null` — `production_result` 에도 `work_order` 에도 공장 축이 없어
    //    도출하려면 계획·오더를 두 번 조인해야 한다(`purchase-order.service.ts:288-297` 선례).
    // ⭐ `periodDate` 는 `occurredAt` 의 UTC 날짜다 — 서버가 「오늘」로 다시 잡으면 오프라인
    //    재전송이 하루 뒤 번호를 받는다(공유계약 C-8 과 같은 이유).
    const productionResultNo = await this.numbering.next(
      NUMBERING_DOCUMENT,
      null,
      occurredAt.toISOString().slice(0, 10),
    );
    const prepared: PreparedResult = { body, context, workerId, quantities, allocations, occurredAt, productionResultNo };
    return this.prisma.$transaction((tx) => this.commit(tx, prepared));
  }

  private async commit(tx: Tx, prepared: PreparedResult): Promise<ProductionResultView> {
    const { body, context, allocations, occurredAt } = prepared;
    const locked = await lockWorkOrder(tx, body.workOrderId);
    // ⭐ 버전 대조가 상태 게이트보다 «먼저»다(형제 `:release`·`:close` 선례).
    assertVersion(locked, context.version);
    assertResultAccepted(locked.status_code);
    assertSlots(allocations, await this.slotsOf(tx, body.workOrderId, allocations));

    const row = await this.insertHeader(tx, prepared, await nextSequence(tx, body.workOrderId));
    if (allocations.length > 0) {
      await tx.production_result_lot_allocation.createMany({
        data: allocations.map((allocation) => ({
          production_result_id: row.production_result_id,
          lot_id: BigInt(allocation.lotId),
          allocated_qty: allocation.allocatedQty,
          uom_id: BigInt(body.uomId),
          created_by: context.appUserId,
        })),
      });
    }
    // L1 — 배분한 슬롯«만». 이미 `ACTIVE` 인 슬롯(두 번째 실적)은 코어가 건너뛰어 이력이
    // 두 번 찍히지 않는다. 배분이 0건이면 빈 집합으로 그냥 부른다(§3-1).
    await this.lots.moveWithin(tx, {
      lotIds: allocations.map((allocation) => BigInt(allocation.lotId)),
      action: RECORD_ACTION,
      sourceDocumentTypeCode: LOT_SOURCE_DOCUMENT,
      sourceDocumentId: row.production_result_id,
      // 전이 시각은 단말이 보낸 «사건» 시각이다 — 서버 수신 시각을 쓰면 오프라인 재전송이
      // 하루 뒤 이력을 찍는다.
      changedAt: occurredAt,
    });
    return productionResultView(row);
  }

  private insertHeader(tx: Tx, prepared: PreparedResult, resultSequence: number) {
    const { body, context } = prepared;
    return tx.production_result.create({
      data: {
        production_result_no: prepared.productionResultNo,
        work_order_id: BigInt(body.workOrderId),
        result_sequence: resultSequence,
        ...prepared.quantities,
        uom_id: BigInt(body.uomId),
        result_source_code: body.resultSourceCode,
        occurred_at: prepared.occurredAt,
        // `recorded_at` 은 DB 기본값(`clock_timestamp()`)에 맡긴다 — 서버 수신 시각이다.
        ...optional('late_entry_reason_code', body.lateEntryReasonCode),
        // 귀속은 헤더가, 주체는 세션이 준다 — 두 칸이 다르다(§4-3).
        worker_id: prepared.workerId,
        ...ref('equipment_id', body.equipmentId),
        ...ref('mold_id', body.moldId),
        ...ref('work_session_id', body.workSessionId),
        // `shift_id`·`terminal_id` 는 비운다 — 요청에 칸이 없고(D1) 단말 토큰이 아직 없다.
        status_code: RESULT_STATUS,
        // 클라이언트가 만들어 outbox 에 담은 값을 «그대로» 넣는다 — `idempotency_record` 가
        // 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다(§4-4).
        idempotency_key: context.idempotencyKey,
        ...optional('remarks', body.remarks),
        created_by: context.appUserId,
      },
    });
  }

  /** 배분 대상만 읽는다 — 슬롯 축은 코어 상수(`WORK_ORDER_LOT_SOURCE`)를 그대로 쓴다. */
  private slotsOf(tx: Tx, workOrderId: number, allocations: readonly ResultLotAllocation[]): Promise<SlotRow[]> {
    if (allocations.length === 0) return Promise.resolve([]);
    return tx.lot.findMany({
      where: {
        lot_id: { in: allocations.map((allocation) => BigInt(allocation.lotId)) },
        source_type_code: WORK_ORDER_LOT_SOURCE,
        source_id: BigInt(workOrderId),
      },
      select: { lot_id: true, lifecycle_status_code: true },
    });
  }

  /**
   * 귀속 사번 → `worker_id`.
   * ⛔ `mdm.worker.app_user_id` 로 세션 사용자에서 **도출하지 않는다** — 계약이 헤더를
   *    required 로 못박았고, 도출은 값을 조용히 지어내는 것이다(§4-3).
   * ⛔ `status_code`(재직 여부)를 안 본다 — 계약이 안 적었고 마스터 운영 축이다.
   */
  private async resolveWorker(workerNo: string | undefined): Promise<bigint> {
    if (workerNo === undefined || workerNo.trim() === '') {
      throw one(field(WORKER_NO, ERROR_CODE.REQUIRED, '작업자 사번 헤더가 필요합니다.'));
    }
    const worker = await this.prisma.worker.findUnique({
      where: { worker_no: workerNo },
      select: { worker_id: true },
    });
    if (worker === null) throw one(field(WORKER_NO, ERROR_CODE.INVALID, '없는 작업자 사번입니다.'));
    return worker.worker_id;
  }

  /** FK 존재 검증 — 없으면 400 `INVALID` 다. `P2003` 으로 흘리면 어느 칸인지 못 짚는다. */
  private async assertReferences(body: ProductionResultCreate): Promise<void> {
    await this.assertExists('uomId', body.uomId, (id) => this.prisma.uom.count({ where: { uom_id: id } }));
    await this.assertExists('equipmentId', body.equipmentId, (id) =>
      this.prisma.equipment.count({ where: { equipment_id: id } }),
    );
    await this.assertExists('moldId', body.moldId, (id) => this.prisma.mold.count({ where: { mold_id: id } }));
    await this.assertExists('workSessionId', body.workSessionId, (id) =>
      this.prisma.work_session.count({ where: { work_session_id: id } }),
    );
  }

  private async assertExists(
    name: string,
    value: number | undefined,
    count: (id: bigint) => Promise<number>,
  ): Promise<void> {
    if (value === undefined) return;
    if ((await count(BigInt(value))) === 0) {
      throw one(field(name, ERROR_CODE.INVALID, '없는 참조입니다.'));
    }
  }
}

/** ⑥ 이 W/O 를 `FOR UPDATE` 로 잠근 뒤라 경합이 없다 — `uq_production_result_seq` 를 손으로 채운다. */
async function nextSequence(tx: Tx, workOrderId: number): Promise<number> {
  const max = await tx.production_result.aggregate({
    where: { work_order_id: BigInt(workOrderId) },
    _max: { result_sequence: true },
  });
  return (max._max.result_sequence ?? 0) + 1;
}

/** 선택 FK — 본문의 `int64` 를 옮기되 없으면 칸 자체를 안 넣는다. */
function ref(column: string, value: number | undefined): Record<string, unknown> {
  return optional(column, value === undefined ? undefined : BigInt(value));
}
