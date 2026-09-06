import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

export type PrecheckDecisionRow = Prisma.precheck_decisionGetPayload<object>;
export type PrecheckDecisionView = ReturnType<typeof precheckDecisionView>;

/**
 * 계약 `PrecheckDecision`(9칸 · required 6 · 전 칸 `x-source-column` 1:1)으로 옮기는 자리.
 * ⛔ 값 없는 칸(`basisInspectionId`·`overrideReasonCode`·`workerNo`)은 키를 생략한다.
 */
export function precheckDecisionView(row: PrecheckDecisionRow) {
  return omitEmpty({
    precheckDecisionId: Number(row.precheck_decision_id),
    workOrderId: Number(row.work_order_id),
    equipmentId: Number(row.equipment_id),
    decidedAt: row.decided_at.toISOString(),
    controlLevelCode: row.control_level_code,
    decisionCode: row.decision_code,
    basisInspectionId: id(row.basis_inspection_id),
    overrideReasonCode: row.override_reason_code ?? undefined,
    workerNo: row.worker_no ?? undefined,
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
