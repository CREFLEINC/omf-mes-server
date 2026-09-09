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

/** 생산 LOT 단말 요청만 실제 W/O 공정의 라벨 출력 권한을 검사한다. */
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
  if (
    lots.some(
      (lot) =>
        lot.sourceTypeCode !== "WORK_ORDER" || lot.sourceId === undefined,
    )
  )
    throw denied();

  const workOrderIds = [
    ...new Set(lots.map((lot) => lot.sourceId as bigint)),
  ].sort(bigintOrder);
  const rows = await tx.$queryRaw<WorkOrderGateRow[]>(Prisma.sql`
    SELECT work_order.work_order_id,
           COALESCE(terminal_process.can_print_label,false) AS can_print_label
    FROM production.work_order
    JOIN mdm.routing_operation
      ON routing_operation.routing_operation_id=work_order.routing_operation_id
    LEFT JOIN mdm.terminal_process
      ON terminal_process.terminal_id=${terminalId}
     AND terminal_process.process_id=routing_operation.process_id
    WHERE work_order.work_order_id IN (${joinedIds(workOrderIds)})
    ORDER BY work_order.work_order_id`);
  if (
    rows.length !== workOrderIds.length ||
    rows.some((row) => row.can_print_label !== true)
  )
    throw denied();
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
