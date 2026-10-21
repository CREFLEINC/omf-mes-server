import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { ResultDefectView } from './result-defect';
import { WorkerAllocationView } from './worker-allocation';

/**
 * 계약 `ProductionResult`(23칸 · required 14)로 옮기는 자리. 목록·단건이 **같은 매퍼**를
 * 쓴다 — 물리 칸 이름 그대로 camelCase 이고 대조표는 I-7.md §2-1 이다.
 *
 * ⛔ 값이 없는 칸은 **키를 생략**한다 — 널을 내리면 계약의 「선택 필드」와 뜻이 갈린다
 * (`plan.md` §5 규칙 7 · 형제 `work-order-view.ts` 관행).
 * ⭐ required 14 는 **값이 0 이어도 언제나 실린다** — 다섯 수량이 그 자리다.
 * ⛔ `correct_reason_code`(D2)는 계약 `ProductionResult` 에 칸이 «없어» 내지 않는다 —
 *    `:correct` 요청 본문에만 있는 값이다.
 * ⛔ `version_no` 도 계약에 칸이 없다(ETag 0건 · §1-1).
 */
export type ProductionResultRow = Prisma.production_resultGetPayload<object>;
export type ProductionResultView = ReturnType<typeof productionResultView>;

/**
 * `workerAllocations` 는 배분이 없어도 늘 싣는다(빈 배열) — 화면이 그때 실적의 `workerId` 로 센다.
 * `defects` 도 늘 싣는다 — 유형 없이 불량수량만 남은 실적이 있어 합이 `defectQty` 보다 작을 수 있다.
 */
export function productionResultView(
  row: ProductionResultRow,
  workerAllocations: WorkerAllocationView[],
  defects: ResultDefectView[],
) {
  return omitEmpty({
    productionResultId: Number(row.production_result_id),
    productionResultNo: row.production_result_no,
    workOrderId: Number(row.work_order_id),
    workSessionId: id(row.work_session_id),
    resultSequence: row.result_sequence,
    correctsProductionResultId: id(row.corrects_production_result_id),
    goodQty: row.good_qty.toNumber(),
    defectQty: row.defect_qty.toNumber(),
    holdQty: row.hold_qty.toNumber(),
    scrapQty: row.scrap_qty.toNumber(),
    reworkQty: row.rework_qty.toNumber(),
    uomId: Number(row.uom_id),
    resultSourceCode: row.result_source_code,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    lateEntryReasonCode: row.late_entry_reason_code ?? undefined,
    workerId: Number(row.worker_id),
    equipmentId: id(row.equipment_id),
    moldId: id(row.mold_id),
    // D1 뒤 이 칸은 대개 NULL 이다 — 계약이 선택이라 그때는 키가 없다(§9-3 ⓒ).
    shiftId: id(row.shift_id),
    terminalId: id(row.terminal_id),
    // `x-no-code-key` — 값 목록이 없다. 이 칸으로 «아무것도 거르지 않는다»(§2-3).
    statusCode: row.status_code,
    remarks: row.remarks ?? undefined,
    workerAllocations,
    defects,
  });
}

const id = (value: bigint | null): number | undefined => (value === null ? undefined : Number(value));
