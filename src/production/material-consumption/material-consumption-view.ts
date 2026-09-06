import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

/**
 * 계약 `MaterialConsumption`(25칸 · required 12)로 옮기는 자리. 목록·단건이 **같은 매퍼**를
 * 쓴다 — 상세 전용 스키마가 계약에 없다(I-10 §5-2).
 *
 * ⛔ 값이 없는 칸은 **키를 생략**한다(`plan.md` §5 규칙 7 · `production-result-view.ts` 관행).
 * ⚠ `terminalId` 는 계약 required 인데 오늘 언제나 빠진다 — 단말 토큰 검증 축이 0건이라 물리
 *    칸이 NULL 이다. 설계 미정 — 문의 054.
 * ⛔ 물리에만 있는 `idempotency_key`·감사칸·`version_no` 는 계약에 칸이 없어 내지 않는다.
 */
export type MaterialConsumptionRow = Prisma.material_consumptionGetPayload<object>;
export type MaterialConsumptionView = ReturnType<typeof materialConsumptionView>;

export function materialConsumptionView(row: MaterialConsumptionRow) {
  return omitEmpty({
    materialConsumptionId: Number(row.material_consumption_id),
    consumptionNo: row.consumption_no,
    workOrderId: Number(row.work_order_id),
    workSessionId: id(row.work_session_id),
    shopfloorReceiptLineId: id(row.shopfloor_receipt_line_id),
    bomComponentId: id(row.bom_component_id),
    itemId: Number(row.item_id),
    lotId: Number(row.lot_id),
    // `x-no-code-key` — 값 목록이 없다. 저장된 문자를 그대로 낸다.
    consumptionTypeCode: row.consumption_type_code,
    correctsConsumptionId: id(row.corrects_consumption_id),
    replacedConsumptionId: id(row.replaced_consumption_id),
    changeReasonCode: row.change_reason_code ?? undefined,
    actualUseProcessId: id(row.actual_use_process_id),
    inputQty: Number(row.input_qty),
    // DEFAULT 0 을 올리는 오퍼레이션이 계약에 0건이라 오늘은 언제나 0 이다(I-10 §3-6).
    actualConsumedQty: Number(row.actual_consumed_qty),
    uomId: Number(row.uom_id),
    enteredQty: row.entered_qty === null ? undefined : Number(row.entered_qty),
    enteredUomId: id(row.entered_uom_id),
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    lateEntryReasonCode: row.late_entry_reason_code ?? undefined,
    workerId: Number(row.worker_id),
    terminalId: id(row.terminal_id),
    statusCode: row.status_code,
    remarks: row.remarks ?? undefined,
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
