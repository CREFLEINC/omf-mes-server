import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';

export type RepairExecutionRow = Prisma.repair_executionGetPayload<object>;
export type RepairExecutionView = ReturnType<typeof repairExecutionView>;

/**
 * 계약 `RepairExecution`(11칸 · required 5 · 전 칸에 `x-source-column` 실재)로 옮기는 자리
 * (I-25 §1-4). 널 허용 6칸(`repairProcessId`·`returnedAt`·`repairResultCode`·
 * `reintroducedLotId`·`terminalId`·`workerNo`)은 값이 없으면 **키를 생략**한다 —
 * `plan.md` §5 규칙 7 + `omitEmpty` 관행. ⛔ 널을 그대로 내리지 않는다(I-18 R-3 이 이 자리에서
 * 걸렸다 — `toBe(undefined)` 단언은 널과 못 가른다).
 */
export function repairExecutionView(row: RepairExecutionRow) {
  return omitEmpty({
    repairExecutionId: Number(row.repair_execution_id),
    defectRecordId: Number(row.defect_record_id),
    repairProcessId: row.repair_process_id === null ? undefined : Number(row.repair_process_id),
    startedAt: row.started_at.toISOString(),
    // ⭐ 구간의 판정 축 — 비어 있으면 아직 수리 중이다(「투입 대기 목록」의 근거 칸).
    returnedAt: row.returned_at === null ? undefined : row.returned_at.toISOString(),
    repairQty: Number(row.repair_qty),
    uomId: Number(row.uom_id),
    repairResultCode: row.repair_result_code ?? undefined,
    // ⭐ 영구 NULL(I-25 §0 자리 4) — 이 값을 채우는 쓰기가 계약에 없다.
    reintroducedLotId: row.reintroduced_lot_id === null ? undefined : Number(row.reintroduced_lot_id),
    terminalId: row.terminal_id === null ? undefined : Number(row.terminal_id),
    workerNo: row.worker_no ?? undefined,
  });
}
