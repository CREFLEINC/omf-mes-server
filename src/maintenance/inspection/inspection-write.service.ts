import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { recordTerminalWorkerAudit } from "../../audit/terminal-worker-audit";

import {
  ContractException,
  ERROR_CODE,
  ErrorItem,
  field,
} from "../../common/errors";
import { parseMaintenanceInstant } from "../maintenance-instant";
import { NumberedMaintenanceWrite } from "../numbered-maintenance-write";
import {
  CheckedInspectionLine,
  InspectionCreate,
  checkInspectionInput,
} from "./inspection-input";
import { InspectionWriteContext } from "./inspection-write-context";
import {
  INSPECTION_INCLUDE,
  InspectionView,
  inspectionView,
} from "./inspection-view";

const INSPECTION_TYPE_GROUP = "EQUIPMENT_INSPECTION_TYPE";

@Injectable()
export class InspectionWriteService {
  constructor(private readonly numbered: NumberedMaintenanceWrite) {}

  async create(
    input: InspectionCreate,
    context: InspectionWriteContext,
  ): Promise<InspectionView> {
    let instant: ReturnType<typeof parseMaintenanceInstant> | undefined;
    const parsedInstant = () =>
      (instant ??= parseMaintenanceInstant(input.inspectedAt, "inspectedAt"));
    return this.numbered.run({
      context,
      documentTypeCode: "EQUIPMENT_INSPECTION",
      target: {
        type: "EQUIPMENT",
        id: input.equipmentId,
        field: "equipmentId",
      },
      periodDate: () => parsedInstant().utcIso.slice(0, 10),
      numberField: "inspectionNo",
      numberColumn: "inspection_no",
      work: (tx, inspectionNo) => {
        const checked = checkInspectionInput(input);
        return this.createWithin(
          tx,
          input,
          checked.lines,
          checked.overallResultCode,
          parsedInstant().utcIso,
          inspectionNo,
          context,
        );
      },
    });
  }

  private async createWithin(
    tx: Prisma.TransactionClient,
    input: InspectionCreate,
    lines: CheckedInspectionLine[],
    overallResultCode: "PASS" | "FAIL",
    inspectedAt: string,
    inspectionNo: string,
    context: InspectionWriteContext,
  ): Promise<InspectionView> {
    const itemIds = lines.map((line) => BigInt(line.inspectionItemId));
    const [worker, inspectionType, items] = await Promise.all([
      tx.worker.findUnique({
        where: { worker_no: context.workerNo },
        select: { worker_id: true },
      }),
      tx.code_value.findFirst({
        where: {
          code: input.inspectionTypeCode,
          is_active: true,
          code_group: { group_code: INSPECTION_TYPE_GROUP },
        },
        select: { code_value_id: true },
      }),
      tx.equipment_inspection_item.findMany({
        where: { equipment_inspection_item_id: { in: itemIds } },
        select: { equipment_inspection_item_id: true },
      }),
    ]);
    const errors: ErrorItem[] = [];
    if (worker === null)
      errors.push(
        field("X-Worker-No", ERROR_CODE.INVALID, "없는 작업자 사번입니다."),
      );
    if (inspectionType === null) {
      errors.push(
        field(
          "inspectionTypeCode",
          ERROR_CODE.INVALID,
          "등록되지 않은 설비 점검 유형입니다.",
        ),
      );
    }
    const existing = new Set(
      items.map((item) => item.equipment_inspection_item_id),
    );
    lines.forEach((line, index) => {
      if (!existing.has(BigInt(line.inspectionItemId))) {
        errors.push(
          field(
            `lines[${index}].inspectionItemId`,
            ERROR_CODE.INVALID,
            "없는 설비 점검 항목입니다.",
          ),
        );
      }
    });
    if (errors.length > 0)
      throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    if (worker === null)
      throw new Error("Worker validation did not stop the write");

    const actorId = context.appUserId === undefined ? null : BigInt(context.appUserId);
    const row = await tx.equipment_inspection.create({
      data: {
        inspection_no: inspectionNo,
        equipment_id: BigInt(input.equipmentId),
        inspection_type_code: input.inspectionTypeCode,
        scheduled_at: null,
        inspected_at: new Date(inspectedAt),
        inspected_by: worker.worker_id,
        judgment_code: overallResultCode,
        status_code: null,
        remarks: input.remarks ?? null,
        created_by: actorId,
        updated_by: actorId,
      },
    });
    await tx.equipment_inspection_result.createMany({
      data: lines.map((line) => ({
        equipment_inspection_id: row.equipment_inspection_id,
        equipment_inspection_item_id: BigInt(line.inspectionItemId),
        numeric_value: line.numericValue,
        text_value: null,
        boolean_value: null,
        judgment_code: line.resultCode,
        remarks: line.remarks ?? null,
        created_by: actorId,
      })),
    });
    if (context.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
      actor: context.terminalAudit, targetTypeCode: 'EQUIPMENT_INSPECTION',
      targetId: row.equipment_inspection_id, eventTypeCode: 'CREATED',
    });
    const created = await tx.equipment_inspection.findUnique({
      where: { equipment_inspection_id: row.equipment_inspection_id },
      include: INSPECTION_INCLUDE,
    });
    if (created === null) throw new Error("Created inspection is missing");
    return inspectionView(created);
  }
}
