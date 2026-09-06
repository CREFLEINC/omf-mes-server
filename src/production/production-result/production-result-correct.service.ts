import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertNotBlank, optional } from '../../common/master';
import { Tx } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { lockWorkOrder } from '../work-order/work-order-write.service';
import { CORRECT_APPROVAL_TARGET_TYPE, CORRECT_APPROVAL_TYPE, lockResult } from './production-result-approval.service';
import { QTY_COLUMNS, resultQuantities } from './production-result-rules';
import { NUMBERING_DOCUMENT, RESULT_STATUS } from './production-result.service';
import { ProductionResultRow, ProductionResultView, productionResultView } from './production-result-view';

/** required 1. 다섯 수량은 «정정 후 값»이고, 안 준 칸은 원본을 승계한다(§5-3). */
export interface ProductionResultCorrect {
  reasonCode: string;
  note?: string;
  goodQty?: number;
  defectQty?: number;
  holdQty?: number;
  scrapQty?: number;
  reworkQty?: number;
}

/** 본문 밖에서 오는 것. ⛔ If-Match·X-Worker-No 는 계약이 이 오퍼레이션에서 걷었다(§1-1). */
export interface CorrectContext {
  idempotencyKey: string;
  appUserId: number | undefined;
}

/**
 * 실적 정정(I-7 PR ③ · §5). 원본을 고치지 않고 «새 행»을 덧붙인다(G-18).
 *
 * ⛔ 원본을 UPDATE 하지 않는다 — 잠글 것이 없어 If-Match 도 ETag 도 없다.
 * ⛔ 배분을 만들지도 복사하지도 않는다 — 계약 본문에 칸이 없고, 복사하면 `:complete` 의
 *    누적 양품이 두 배가 된다(§5-6 · 문의 044).
 * ⛔ L1(`moveWithin`)을 부르지 않는다 — 배분이 없어 옮길 슬롯이 없다. 빈 배열로도 안 부른다.
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
  ): Promise<ProductionResultView> {
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
    return this.prisma.$transaction((tx) =>
      this.commit(tx, { productionResultId, workOrderId, body, context, productionResultNo }),
    );
  }

  private async commit(tx: Tx, prepared: PreparedCorrection): Promise<ProductionResultView> {
    const { productionResultId, workOrderId, body, context } = prepared;
    // ⭐ 자물쇠 «순서»가 W/O → 실적이다 — 두 자물쇠를 반대로 쥐면 등록(PR ②)과 교착한다
    //    (I-4 R-1 「잠금 오름차순」의 이 도메인판).
    await lockWorkOrder(tx, workOrderId);
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
      goodQty: body.goodQty ?? original.good_qty.toNumber(),
      defectQty: body.defectQty ?? original.defect_qty.toNumber(),
      holdQty: body.holdQty ?? original.hold_qty.toNumber(),
      scrapQty: body.scrapQty ?? original.scrap_qty.toNumber(),
      reworkQty: body.reworkQty ?? original.rework_qty.toNumber(),
    });
    if (isGradeA(original, quantities)) await assertCorrectionApproved(tx, productionResultId);

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
        // 정정한 사람은 인증 주체로 남는다 — 이 오퍼레이션은 사번을 받지 않는다.
        created_by: context.appUserId,
      },
    });
    return productionResultView(row);
  }
}

interface PreparedCorrection {
  productionResultId: number;
  workOrderId: number;
  body: ProductionResultCorrect;
  context: CorrectContext;
  productionResultNo: string;
}

/**
 * A급 = ⌜수불에 영향을 준다⌝의 가장 좁은 해석 — 본문이 담는 것이 사유·비고·다섯 수량뿐이라
 * 서버가 볼 수 있는 경계는 「수량이 바뀌는가」 하나다. ⭐ 판정은 **승계 «뒤»** 다섯 칸 전체를
 * 견준다 — 「준 칸만 비교」로 하면 원본과 같은 값을 명시로 보낸 요청이 A급이 된다(R-9).
 */
function isGradeA(original: ProductionResultRow, quantities: Record<string, number>): boolean {
  return Object.values(QTY_COLUMNS).some((column) => !original[column].equals(quantities[column]));
}

/**
 * A급 승인 게이트(§5-5). ⛔ 코어 `ApprovalService.assertApproved` 를 쓰지 않는다 — 그쪽은
 * ⌜요청이 0건이면 통과⌝ 라(`approval.service.ts:155`) 상신을 한 번도 안 한 A급 정정을 열어 준다.
 * 이쪽은 「승인이 **필수**」라 뜻이 반대다. 합치는 것은 문의 030 이 답한 뒤다.
 * ⚠ 승인 한 건이 정정 몇 건을 여는지는 세지 않는다 — 소진 축이 데이터에 없다(문의 041 ⓑ).
 */
async function assertCorrectionApproved(tx: Tx, productionResultId: number): Promise<void> {
  // 다형 축 — 조회 인덱스는 I-1 A6 이 깐 `ix_approval_request_target` 이다.
  const requests = await tx.approval_request.findMany({
    where: {
      target_type_code: CORRECT_APPROVAL_TARGET_TYPE,
      target_id: BigInt(productionResultId),
      approval_type_code: CORRECT_APPROVAL_TYPE,
    },
    select: { status_code: true },
  });
  if (requests.some((row) => row.status_code === 'APPROVED')) return;
  // 섞여 있으면 `PENDING` 이 이긴다 — 「기다려라」가 「다시 올려라」보다 정확하다. 0건·반려는 아래로 떨어진다.
  if (requests.some((row) => row.status_code === 'PENDING')) {
    throw badRequest(ERROR_CODE.APPROVAL_IN_PROGRESS, '진행 중인 승인 요청이 이미 있습니다.');
  }
  throw badRequest(ERROR_CODE.APPROVAL_REQUIRED, '수량을 바꾸는 정정은 승인이 필요합니다. 먼저 상신하십시오.');
}

function badRequest(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code, message }]);
}

/** 사건 칸 승계 — 원본이 비운 칸은 정정본도 비운다(널을 명시로 넣지 않는다). */
function inherited(column: string, value: bigint | null): Record<string, unknown> {
  return optional(column, value ?? undefined);
}
