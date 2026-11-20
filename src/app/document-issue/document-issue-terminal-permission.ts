import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE } from "../../common/errors";
import {
  DocumentIssueDocumentType,
  DocumentIssueTargetFacts,
} from "./document-issue-create-rules";

interface WorkOrderGateRow {
  work_order_id: bigint;
  can_print_label: boolean;
}

/**
 * 생산 LOT 단말 요청만 실제 W/O 공정의 라벨 출력 권한을 검사한다.
 * ⭐ 제품 분리 가족 LOT(원래·자식 · 피처 013 D-7)은 P-04-08 을 열 수 있는 단말(공정 하나라도 `can_print_label`)도 낸다 —
 *    제품 창고 POP 은 W/O 공정에 매핑돼 있지 않고, 자식 LOT 은 원천이 W/O 가 아니다.
 */
export async function assertDocumentIssueTerminalPermission(
  tx: Prisma.TransactionClient,
  documentTypeCode: DocumentIssueDocumentType,
  terminalId: bigint | null,
  facts: Iterable<DocumentIssueTargetFacts>,
): Promise<void> {
  if (terminalId === null || documentTypeCode !== "PRODUCTION_LOT_LABEL")
    return;
  const lots = [...facts].filter(
    (
      fact,
    ): fact is Extract<DocumentIssueTargetFacts, { targetTypeCode: "LOT" }> =>
      fact.targetTypeCode === "LOT",
  );
  if (lots.length === 0) return;
  const workOrderLots = lots.filter(
    (lot) => lot.sourceTypeCode === "WORK_ORDER" && lot.sourceId !== undefined,
  );
  const allowed = await workOrderGate(tx, terminalId, workOrderLots);
  const rest = lots.filter((lot) => !allowed.has(lot.targetId));
  if (rest.length === 0) return;
  if (!(await splitFamilyGate(tx, terminalId, rest.map((lot) => lot.targetId))))
    throw denied();
}

/** W/O 공정 단말 규칙 — 통과한 LOT id. */
async function workOrderGate(
  tx: Prisma.TransactionClient,
  terminalId: bigint,
  lots: Extract<DocumentIssueTargetFacts, { targetTypeCode: "LOT" }>[],
): Promise<Set<bigint>> {
  if (lots.length === 0) return new Set();
  const workOrderIds = [
    ...new Set(lots.map((lot) => lot.sourceId as bigint)),
  ].sort(bigintOrder);
  const rows = await tx.$queryRaw<WorkOrderGateRow[]>(Prisma.sql`
    SELECT work_order.work_order_id,
           COALESCE(terminal_process.can_print_label,false) AS can_print_label
    FROM production.work_order
    JOIN planning.routing_operation
      ON routing_operation.routing_operation_id=work_order.routing_operation_id
    LEFT JOIN mdm.terminal_process
      ON terminal_process.terminal_id=${terminalId}
     AND terminal_process.process_id=routing_operation.process_id
    WHERE work_order.work_order_id IN (${joinedIds(workOrderIds)})
    ORDER BY work_order.work_order_id`);
  const open = new Set(
    rows.filter((row) => row.can_print_label === true).map((row) => String(row.work_order_id)),
  );
  return new Set(
    lots.filter((lot) => open.has(String(lot.sourceId))).map((lot) => lot.targetId),
  );
}

/** 모든 LOT 이 제품 분리 가족이고 단말이 라벨 공정을 하나라도 가졌나(P-04-08). */
async function splitFamilyGate(
  tx: Prisma.TransactionClient,
  terminalId: bigint,
  lotIds: bigint[],
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ family: number; label: boolean }[]>(Prisma.sql`
    SELECT (SELECT count(*)::int FROM unnest(ARRAY[${joinedIds(lotIds)}]) AS t(lot_id)
             WHERE EXISTS (SELECT 1 FROM trace.product_lot_split s
                            WHERE s.parent_lot_id = t.lot_id OR s.child_lot_id = t.lot_id)) AS family,
           EXISTS (SELECT 1 FROM mdm.terminal_process p
                    WHERE p.terminal_id = ${terminalId} AND p.can_print_label) AS label`);
  return row?.label === true && row.family === lotIds.length;
}

function denied(): ContractException {
  return new ContractException(HttpStatus.FORBIDDEN, [
    {
      scope: "screen",
      code: ERROR_CODE.PERMISSION_DENIED,
      message: "이 단말은 해당 생산 공정의 라벨을 출력할 수 없습니다.",
    },
  ]);
}

function joinedIds(ids: bigint[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::bigint`));
}

function bigintOrder(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
