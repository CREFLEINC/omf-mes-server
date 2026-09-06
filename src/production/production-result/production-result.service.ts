import { Injectable } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertNotBlank, optional } from '../../common/master';
import { LotLifecycleService, Tx, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVersion, lockWorkOrder } from '../work-order/work-order-write.service';
import {
  ProductionResultCreate,
  ResultLotAllocation,
  SlotRow,
  assertAllocations,
  assertResultAccepted,
  assertSlots,
  resultQuantities,
} from './production-result-rules';
import { ProductionResultView, productionResultView } from './production-result-view';

/** 채번 문서 유형 — `app.numbering_rule` 에 `PR-{YYMMDD}-{SEQ4}` 가 등재돼 있다. */
const NUMBERING_DOCUMENT = 'PRODUCTION_RESULT';
/**
 * 계약 `LotLifecycleHistoryEvent.sourceDocumentTypeCode` enum 의 L1 값. 채번 유형과 문자열은
 * 같아도 **축이 다르다** — 묶으면 R-2(공용 상수를 써서 L2 에 틀린 값이 실린 자리)를 되풀이한다.
 */
const LOT_SOURCE_DOCUMENT = 'PRODUCTION_RESULT';
/** L1 대기→활성 — `transitions.ts:112` 에 이미 등록돼 있다. 부르기만 한다. */
const RECORD_ACTION = 'production-result-recorded';
/**
 * 태어나는 상태값. `PRODUCTION_RESULT_STATUS` 는 폐기 그룹(`x-no-code-key`)이라 값 목록이 없어
 * **이미 데이터에 있는 값**을 든다. ⛔ 이 값으로 «아무것도 거르지 않는다»(§2-3).
 */
const RESULT_STATUS = 'CONFIRMED';
const WORKER_NO = 'X-Worker-No';

/** 본문 밖에서 오는 것. `version`(If-Match)은 **선택** — 없으면 대조를 건너뛴다(§4-6 · C-9). */
export interface ProductionResultContext {
  workerNo: string | undefined;
  idempotencyKey: string;
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
 * 생산 실적 등록 + LOT 배분 + L1(I-7 PR ②). 순서는 §4-1 그대로다. ⛔ 원장을 지나지 않고
 * (`plan.md` §5 #8) ⛔ `work_order` 를 UPDATE 하지 않으며(진행률은 실적을 «세어» 낸다)
 * ⛔ ETag 를 안 낸다(계약 미선언).
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
    assertAllocations(allocations, quantities.good_qty);
    // 지연 사유는 그룹 값이 **0건**이라 대조를 걸지 않는다 — 걸면 모든 값이 400 이 된다(I-6 §9-1 #2).
    const late = body.lateEntryReasonCode;
    if (late !== undefined) assertNotBlank([['lateEntryReasonCode', late]]);
    await this.assertReferences(body);
    const occurredAt = new Date(body.occurredAt);
    // ⛔ 채번은 `$transaction` 을 «열기 전»이다 — 안에서 부르면 커넥션을 둘 쥐고 풀이 마르면
    //    `P2024` 로 죽는다. 결번은 허용한다(I-2 R-2).
    // ⭐ `plantId`=`null`(실적에도 W/O 에도 공장 축이 없다 · `purchase-order.service.ts:288`) ·
    //    기간은 `occurredAt` 의 UTC 날짜(서버가 「오늘」로 다시 잡으면 재전송이 하루 뒤 번호를 받는다).
    const period = occurredAt.toISOString().slice(0, 10);
    const productionResultNo = await this.numbering.next(NUMBERING_DOCUMENT, null, period);
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
    // ⑥ 이 W/O 를 `FOR UPDATE` 로 잠근 뒤라 경합이 없다 — `uq_production_result_seq` 를 손으로 채운다.
    const max = await tx.production_result.aggregate({
      where: { work_order_id: BigInt(body.workOrderId) },
      _max: { result_sequence: true },
    });
    const row = await this.insertHeader(tx, prepared, (max._max.result_sequence ?? 0) + 1);
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
    // L1 — 배분한 슬롯«만». 이미 `ACTIVE` 인 슬롯은 코어가 건너뛰어 이력이 두 번 안 찍히고,
    // 0건이면 빈 집합으로 그냥 부른다(§3-1).
    await this.lots.moveWithin(tx, {
      lotIds: allocations.map((allocation) => BigInt(allocation.lotId)),
      action: RECORD_ACTION,
      sourceDocumentTypeCode: LOT_SOURCE_DOCUMENT,
      sourceDocumentId: row.production_result_id,
      // 전이 시각은 단말이 보낸 «사건» 시각 — 수신 시각을 쓰면 재전송이 하루 뒤 이력을 찍는다.
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
        // 귀속(`worker_id`)은 헤더가, 주체(`created_by`)는 세션이 준다 — 두 칸이 다르다(§4-3).
        worker_id: prepared.workerId,
        ...ref('equipment_id', body.equipmentId),
        ...ref('mold_id', body.moldId),
        ...ref('work_session_id', body.workSessionId),
        // `shift_id`·`terminal_id` 는 비운다 — 요청에 칸이 없고(D1) 단말 토큰이 아직 없다.
        status_code: RESULT_STATUS,
        // 헤더 값 «그대로» — 멱등 기록이 만료된 뒤의 재전송을 이 UNIQUE 가 둘째 그물로 막는다(§4-4).
        idempotency_key: context.idempotencyKey,
        ...optional('remarks', body.remarks),
        created_by: context.appUserId,
      },
    });
  }

  /** 배분 대상만 읽는다 — 슬롯 축은 코어 상수(`WORK_ORDER_LOT_SOURCE`)를 그대로 쓴다. */
  private slotsOf(tx: Tx, workOrderId: number, allocations: readonly ResultLotAllocation[]): Promise<SlotRow[]> {
    if (allocations.length === 0) return Promise.resolve([]);
    const lot_id = { in: allocations.map((allocation) => BigInt(allocation.lotId)) };
    return tx.lot.findMany({
      where: { lot_id, source_type_code: WORK_ORDER_LOT_SOURCE, source_id: BigInt(workOrderId) },
      select: { lot_id: true, lifecycle_status_code: true },
    });
  }

  /**
   * 귀속 사번 → `worker_id`. ⛔ `app_user_id` 로 세션 사용자에서 **도출하지 않는다**(계약이 헤더를
   * required 로 못박았다 · §4-3) · ⛔ 재직 여부를 안 본다(계약이 안 적은 마스터 운영 축이다).
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
    const checks: [string, number | undefined, (id: bigint) => Promise<number>][] = [
      ['uomId', body.uomId, (id) => this.prisma.uom.count({ where: { uom_id: id } })],
      ['equipmentId', body.equipmentId, (id) => this.prisma.equipment.count({ where: { equipment_id: id } })],
      ['moldId', body.moldId, (id) => this.prisma.mold.count({ where: { mold_id: id } })],
      ['workSessionId', body.workSessionId, (id) => this.prisma.work_session.count({ where: { work_session_id: id } })],
    ];
    for (const [name, value, count] of checks) {
      if (value === undefined) continue;
      if ((await count(BigInt(value))) === 0) throw one(field(name, ERROR_CODE.INVALID, '없는 참조입니다.'));
    }
  }
}

/** 선택 FK — 본문의 `int64` 를 옮기되 없으면 칸 자체를 안 넣는다. */
function ref(column: string, value: number | undefined): Record<string, unknown> {
  return optional(column, value === undefined ? undefined : BigInt(value));
}
