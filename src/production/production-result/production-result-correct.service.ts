import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertNotBlank, optional } from '../../common/master';
import { Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { lockWorkOrder } from '../work-order/work-order-write.service';
import {
  AffectedLot, CORRECTION_CLOSED_STATUSES, affectedLots, assertLotsNotMovedOn, changedLotIds, correctionAllocations, liveLotQuantities,
  originalShare, recheckCompletion,
} from './correction-lots';
import { lockResult } from './production-result-approval.service';
import { ResultLotAllocation, assertAllocations, resultQuantities } from './production-result-rules';
import { NUMBERING_DOCUMENT, RESULT_STATUS } from './production-result.service';
import { ProductionResultRow, ProductionResultView, productionResultView } from './production-result-view';
import { ResultDefectInput, assertDefectCodes, copyDefects, loadDefects, resolveDefectQty, writeDefects } from './result-defect';
import { allocateLikeOriginal, loadAllocations } from './worker-allocation';

/** required 1. 다섯 수량은 «정정 후 값»이고, 안 준 칸은 원본을 승계한다(§5-3). */
export interface ProductionResultCorrect {
  reasonCode: string;
  note?: string;
  goodQty?: number;
  defectQty?: number;
  holdQty?: number;
  scrapQty?: number;
  reworkQty?: number;
  defects?: ResultDefectInput[];
  /** 정정 후 LOT 배분 — 원본이 배분한 LOT 안에서만. 생략하면 서버가 원본에서 정한다(`correctionAllocations`). */
  lotAllocations?: ResultLotAllocation[];
}

export type ProductionResultCorrection = ProductionResultView & { affectedLots: AffectedLot[] };

/** 본문 밖에서 오는 것. ⛔ If-Match·X-Worker-No 는 계약이 이 오퍼레이션에서 걷었다(§1-1). */
export interface CorrectContext {
  idempotencyKey: string;
  appUserId: number | undefined;
}

/**
 * 실적 정정(I-7 PR ③ · §5 · 장부 P-120). 원본을 고치지 않고 «새 행»을 덧붙인다(G-18).
 *
 * ⛔ 원본을 UPDATE 하지 않는다 — 잠글 것이 없어 If-Match 도 ETag 도 없다.
 * ⭐ 정정본이 LOT 배분을 갖는다 — LOT 수량은 잎(정정 안 된 실적)의 배분만 세므로(`LIVE_ALLOCATION`) 원본 배분과
 *    두 번 세지 않고, LOT 수량·완료 판정·라벨이 정정을 따른다. 원본이 배분한 LOT 안에서만 고친다.
 * ⛔ W/O 마감 뒤에는 막는다 — 마감 때 ERP 로 생산입고가 나간다. 마감 전 수량 정정은 승인 없이, 사유가 필수다.
 * ⛔ L1(`moveWithin`)을 부르지 않는다 — 원본 LOT 안에서만 고쳐 새로 옮길 슬롯이 없다.
 */
@Injectable()
export class ProductionResultCorrectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
  ) {}

  async correct(
    productionResultId: number,
    body: ProductionResultCorrect,
    context: CorrectContext,
  ): Promise<ProductionResultCorrection> {
    // 정정 사유는 그룹 값이 **0건**이라 대조를 걸지 않는다 — 걸면 모든 값이 400 이 된다
    // (I-6 §9-1 #2). ⚠ `plan-uiux.md` §9-4 Q 와 어긋나는 것을 알고 고른 쪽이다(R-20).
    assertNotBlank([['reasonCode', body.reasonCode]]);
    const original = await this.prisma.production_result.findUnique({
      where: { production_result_id: BigInt(productionResultId) },
      select: { work_order_id: true, occurred_at: true },
    });
    if (original === null) throw new NotFoundException('없는 생산 실적입니다.');
    // ⛔ 채번은 `$transaction` 밖이다(I-2 R-2). 기간은 «원본» 사건 시각의 UTC 날짜 — 오늘로 다시
    //    잡으면 같은 사건의 정정이 며칠 뒤 번호를 받는다.
    const productionResultNo = await this.numbering.next(
      NUMBERING_DOCUMENT,
      null,
      original.occurred_at.toISOString().slice(0, 10),
    );
    const workOrderId = Number(original.work_order_id);
    const defectQty = resolveDefectQty(body);
    const defectProcessId = await assertDefectCodes(this.prisma, workOrderId, body.defects ?? []);
    return this.prisma.$transaction((tx) =>
      this.commit(tx, { productionResultId, workOrderId, body, context, productionResultNo, defectQty, defectProcessId }),
    );
  }

  private async commit(tx: Tx, prepared: PreparedCorrection): Promise<ProductionResultCorrection> {
    const { productionResultId, workOrderId, body, context } = prepared;
    // ⭐ 자물쇠 «순서»가 W/O → 실적이다 — 두 자물쇠를 반대로 쥐면 등록(PR ②)과 교착한다
    //    (I-4 R-1 「잠금 오름차순」의 이 도메인판).
    const workOrder = await lockWorkOrder(tx, workOrderId);
    await assertWorkOrderOpen(tx, workOrderId, workOrder.status_code);
    await lockResult(tx, productionResultId);
    const original = await tx.production_result.findUniqueOrThrow({
      where: { production_result_id: BigInt(productionResultId) },
    });
    // ⛔ 이미 정정된 행은 다시 정정하지 못한다 — 형제 정정본이 서면 잎 규칙(§5-3)이 «둘 다» 세어
    //    누계가 두 배가 된다. 체인(잎을 정정)은 그대로 허용한다(§5-4). 물리에 유일 제약이 없어
    //    자물쇠를 쥔 여기서 막는다(R-21 · 리뷰 #241).
    const corrected = await tx.production_result.count({
      where: { corrects_production_result_id: original.production_result_id },
    });
    if (corrected > 0) {
      throw badRequest(ERROR_CODE.STATE_LOCKED, '이미 정정된 실적입니다. 최신 정정본을 정정하십시오.');
    }

    const quantities = resultQuantities({
      // 정정은 다섯 칸이 모두 0 이어도 된다 — 잘못 넣은 실적을 지우거나 다른 LOT 으로 옮기는 길이다.
      allowZero: true,
      goodQty: body.goodQty ?? original.good_qty.toNumber(),
      defectQty: prepared.defectQty ?? original.defect_qty.toNumber(),
      holdQty: body.holdQty ?? original.hold_qty.toNumber(),
      scrapQty: body.scrapQty ?? original.scrap_qty.toNumber(),
      reworkQty: body.reworkQty ?? original.rework_qty.toNumber(),
    });
    const share = await originalShare(tx, original.production_result_id);
    const allocations = correctionAllocations(share, body.lotAllocations, new Prisma.Decimal(quantities.good_qty));
    assertAllocations(allocations, quantities.good_qty);
    const changed = changedLotIds(share.allocations, allocations);
    await assertLotsNotMovedOn(tx, changed, body.lotAllocations === undefined ? 'goodQty' : 'lotAllocations');
    const lotQtyBefore = await liveLotQuantities(tx, changed);

    const max = await tx.production_result.aggregate({
      where: { work_order_id: original.work_order_id },
      _max: { result_sequence: true },
    });
    const row = await tx.production_result.create({
      data: {
        production_result_no: prepared.productionResultNo,
        corrects_production_result_id: original.production_result_id,
        ...quantities,
        // 사건 칸 열 — 정정은 «같은 사건»의 보정이라 바뀔 이유가 없다(§5-2). ⛔ `late_entry_reason_code`
        // 는 그 열이 아니다(원본의 지연 사유가 정정본의 사유가 되지 않는다).
        work_order_id: original.work_order_id,
        uom_id: original.uom_id,
        result_source_code: original.result_source_code,
        occurred_at: original.occurred_at,
        worker_id: original.worker_id,
        ...inherited('work_session_id', original.work_session_id),
        ...inherited('equipment_id', original.equipment_id),
        ...inherited('mold_id', original.mold_id),
        ...inherited('shift_id', original.shift_id),
        ...inherited('terminal_id', original.terminal_id),
        result_sequence: (max._max.result_sequence ?? 0) + 1,
        status_code: RESULT_STATUS,
        correct_reason_code: body.reasonCode,
        // ⚠ 계약이 이름을 달리 적었다 — 본문 `note` 가 물리 `remarks` 다(§5-2 ⓖ).
        ...optional('remarks', body.note),
        idempotency_key: context.idempotencyKey,
        created_by: context.appUserId,
      },
    });
    if (allocations.length > 0) {
      await tx.production_result_lot_allocation.createMany({
        data: allocations.map((allocation) => ({
          production_result_id: row.production_result_id,
          lot_id: BigInt(allocation.lotId),
          allocated_qty: allocation.allocatedQty,
          uom_id: original.uom_id,
          created_by: context.appUserId,
        })),
      });
    }
    await allocateLikeOriginal(tx, row, original.production_result_id, context.appUserId);
    const completionReset = await recheckCompletion(tx, original.work_order_id, changed);
    await tx.audit_event.create({ data: {
      occurred_at: new Date(),
      target_type_code: 'PRODUCTION_RESULT',
      target_id: original.production_result_id,
      event_type_code: 'RESULT_CORRECTED',
      before_value: { productionResultId: Number(original.production_result_id), ...quantitiesOf(original), lotAllocations: share.allocations.map((row) => ({ ...row })) },
      after_value: { productionResultId: Number(row.production_result_id), ...quantitiesOf(row), lotAllocations: allocations.map((allocation) => ({ ...allocation })) },
      reason: [body.reasonCode, body.note].filter((part) => part !== undefined && part !== '').join(' · '),
      performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
    } });
    // 유형을 실으면 그것이 정정본의 내역이다. 안 실으면 불량수량이 같을 때만 원본 내역을 옮긴다 — 수량이 바뀌면
    // 옛 내역과 합이 어긋나 내역 없이 수량만 남긴다(관리웹 정정 화면이 유형을 받지 않는다 · 장부 P-95).
    const inputs = body.defects ?? [];
    if (inputs.length > 0) await writeDefects(tx, row, inputs, prepared.defectProcessId, context.appUserId);
    else if (row.defect_qty.equals(original.defect_qty)) await copyDefects(tx, row, original.production_result_id, context.appUserId);
    const ids = [row.production_result_id];
    const workers = await loadAllocations(tx, ids);
    const defects = await loadDefects(tx, ids);
    return {
      ...productionResultView(row, workers.get(row.production_result_id) ?? [], defects.get(row.production_result_id) ?? []),
      affectedLots: await affectedLots(tx, changed, lotQtyBefore, completionReset),
    };
  }
}

interface PreparedCorrection {
  productionResultId: number;
  workOrderId: number;
  body: ProductionResultCorrect;
  context: CorrectContext;
  productionResultNo: string;
  /** 본문 `defectQty`, 없으면 `defects` 합 — 둘 다 없으면 원본을 승계한다. */
  defectQty: number | undefined;
  defectProcessId: bigint | null;
}

function badRequest(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code, message }]);
}

/** 사건 칸 승계 — 원본이 비운 칸은 정정본도 비운다(널을 명시로 넣지 않는다). */
function inherited(column: string, value: bigint | null): Record<string, unknown> {
  return optional(column, value ?? undefined);
}

/** W/O 마감·취소 뒤에는 정정하지 않는다 — 마감 때 ERP 로 생산입고가 나가 실적과 어긋난다. */
async function assertWorkOrderOpen(tx: Tx, workOrderId: number, statusCode: string): Promise<void> {
  if (!CORRECTION_CLOSED_STATUSES.includes(statusCode)) return;
  const workOrder = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) }, select: { work_order_no: true },
  });
  const when = statusCode === 'CLOSED' ? '마감돼 ERP 로 생산입고가 이미 나갔습니다' : '취소됐습니다';
  throw badRequest(ERROR_CODE.STATE_LOCKED,
    `W/O ${workOrder.work_order_no} 는 ${when}(W/O 진행 상세에서 확인). 실적을 고칠 수 없습니다 — 수량 차이는 재고 조정으로 맞추세요.`);
}


function quantitiesOf(row: ProductionResultRow): Record<string, number> {
  return {
    goodQty: row.good_qty.toNumber(), defectQty: row.defect_qty.toNumber(), holdQty: row.hold_qty.toNumber(),
    scrapQty: row.scrap_qty.toNumber(), reworkQty: row.rework_qty.toNumber(),
  };
}
