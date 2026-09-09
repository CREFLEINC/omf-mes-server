import { Injectable } from '@nestjs/common';

import { ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues, assertWorkerNoExists } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { PrecheckDecisionView, precheckDecisionView } from './precheck-decision-view';

const OVERRIDDEN = 'OVERRIDDEN';
/** 우회를 허용하는 유일한 W/O 유형 — 서버가 이 값으로만 판정한다(계약 x-internal-note). */
const EMERGENCY_TYPE = 'EMERGENCY';
const CONTROL_OVERRIDE_REASON_GROUP = 'CONTROL_OVERRIDE_REASON';

/** required 5 · 선택 2(§1-3). */
export interface PrecheckDecisionCreate {
  workOrderId: number;
  equipmentId: number;
  decidedAt: string;
  controlLevelCode: string;
  decisionCode: string;
  basisInspectionId?: number | null;
  overrideReasonCode?: string | null;
}

/** 본문 밖에서 오는 것 — 사번은 헤더, 주체는 세션(§4-3 과 같은 가름). */
export interface PrecheckDecisionContext {
  workerNo: string | undefined;
  appUserId: number | undefined;
}

/**
 * 통제 판정 기록(I-11 PR ⑤). 단일 INSERT — `$transaction` 을 안 연다(코어 0 · §7-1 6).
 * ⛔ `app.operation_policy` 를 읽지 않는다 — 화면이 읽은 `controlLevelCode` 를 판정 시점
 * 스냅샷 그대로 저장한다(R-8 · §7-3). 정책을 다시 읽어 대조하면 화면·서버가 서로 다른
 * 시점의 정책을 볼 수 있어 정상 요청이 400 이 된다.
 * ⛔ 유일성 검사 없음 — 같은 판정을 두 번 기록해도 업무적으로 정상이다(§7-2). 409 의
 * 유일한 출처는 컨트롤러가 두르는 `runIdempotent`(지문 불일치·처리 중 재전송)뿐이다.
 */
@Injectable()
export class PrecheckDecisionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: PrecheckDecisionCreate, context: PrecheckDecisionContext): Promise<PrecheckDecisionView> {
    // `precheck_decision.worker_no` 는 FK 가 아니라 **헤더 문자열을 그대로 옮겨 적는 칸**이다
    // — 실재만 보고 그대로 쓴다(`resolveWorkerId` 는 `worker_id` 를 쓰는 자리 것이다).
    await assertWorkerNoExists(this.prisma, context.workerNo);
    const workerNo = context.workerNo as string;
    const workOrder = await this.assertWorkOrder(body.workOrderId);
    await this.assertEquipment(body.equipmentId);
    await this.assertBasisInspection(body.basisInspectionId);
    await this.assertOverrideReason(body, workOrder.work_order_type_code);

    const row = await this.prisma.precheck_decision.create({
      data: {
        work_order_id: BigInt(body.workOrderId),
        equipment_id: BigInt(body.equipmentId),
        decided_at: new Date(body.decidedAt),
        control_level_code: body.controlLevelCode,
        decision_code: body.decisionCode,
        basis_inspection_id: body.basisInspectionId == null ? null : BigInt(body.basisInspectionId),
        override_reason_code: body.overrideReasonCode ?? null,
        worker_no: workerNo,
        created_by: context.appUserId,
      },
    });
    return precheckDecisionView(row);
  }


  /** FK 존재 검증 + 우회 판정에 쓸 유형을 함께 돌려준다 — 조회를 두 번 하지 않는다. */
  private async assertWorkOrder(workOrderId: number): Promise<{ work_order_type_code: string }> {
    const workOrder = await this.prisma.work_order.findUnique({
      where: { work_order_id: BigInt(workOrderId) },
      select: { work_order_type_code: true },
    });
    if (workOrder === null) throw one(field('workOrderId', ERROR_CODE.INVALID, '없는 작업지시입니다.'));
    return workOrder;
  }

  private async assertEquipment(equipmentId: number): Promise<void> {
    const count = await this.prisma.equipment.count({ where: { equipment_id: BigInt(equipmentId) } });
    if (count === 0) throw one(field('equipmentId', ERROR_CODE.INVALID, '없는 설비입니다.'));
  }

  /**
   * FK 존재만 본다 — 점검 유형·주기·종합 판정을 서버가 다시 보지 않는다(판정은 화면 몫 ·
   * §7-1 3 · R-8). ⚠ 이 판정만으로는 「점검 NG 인데 OVERRIDDEN」을 못 막는다 — 알려둘 것 ⓟ.
   */
  private async assertBasisInspection(basisInspectionId: number | null | undefined): Promise<void> {
    if (basisInspectionId == null) return;
    const count = await this.prisma.equipment_inspection.count({
      where: { equipment_inspection_id: BigInt(basisInspectionId) },
    });
    if (count === 0) throw one(field('basisInspectionId', ERROR_CODE.INVALID, '없는 점검 이력입니다.'));
  }

  /** `decisionCode` × `overrideReasonCode` 짝 검증(§7-1 4). `controlLevelCode` 는 대조하지 않는다(§7-3). */
  private async assertOverrideReason(body: PrecheckDecisionCreate, workOrderTypeCode: string): Promise<void> {
    const { decisionCode, overrideReasonCode } = body;
    if (decisionCode !== OVERRIDDEN) {
      if (overrideReasonCode != null) {
        throw one(field('overrideReasonCode', ERROR_CODE.INVALID, 'OVERRIDDEN 일 때만 값이 있습니다.'));
      }
      return;
    }
    if (overrideReasonCode == null) {
      throw one(field('overrideReasonCode', ERROR_CODE.REQUIRED, 'OVERRIDDEN 판정은 사유가 필요합니다.'));
    }
    // 우회는 긴급 W/O 일 때만 허용한다 — 서버가 `work_order_type_code` 로 판정한다(계약 x-internal-note).
    if (workOrderTypeCode !== EMERGENCY_TYPE) {
      throw one(field('overrideReasonCode', ERROR_CODE.INVALID, '긴급 작업지시에서만 우회할 수 있습니다.'));
    }
    await assertCodeValues(this.prisma, [
      { field: 'overrideReasonCode', value: overrideReasonCode, groupCode: CONTROL_OVERRIDE_REASON_GROUP },
    ]);
  }
}
