import { Prisma } from '@prisma/client';

import type { InspectionSheetFourMView } from './inspection-sheet-four-m';
import { type OqcRecord, SHIPMENT_STEP, shipmentSigned } from './inspection-sheet-oqc';

const WORKER = { select: { worker_no: true, worker_name: true } } as const;
const USER = { select: { user_name: true } } as const;

export const SHEET_DETAIL_INCLUDE = {
  serial_number: { select: { serial_no: true } },
  item: { select: { item_code: true, item_name: true } },
  lot: { select: { lot_no: true } },
  work_order: { select: { work_order_no: true } },
  written_worker: WORKER,
  app_user_inspection_sheet_approved_byToapp_user: USER,
  app_user_inspection_sheet_checked_byToapp_user: USER,
  template: {
    select: {
      template_version: true,
      form_layout_code: true,
      lot_sources: { select: { slot_code: true, item_id: true } },
      steps: { orderBy: { sequence_no: 'asc' }, include: { items: { orderBy: { sequence_no: 'asc' } } } },
    },
  },
  step_results: {
    include: { inspected_worker: WORKER, app_user_inspection_sheet_step_result_signed_byToapp_user: USER },
  },
  item_results: { select: { inspection_sheet_template_item_id: true, judgment_code: true } },
  ngs: { orderBy: { sequence_no: 'asc' }, include: { repair_worker: WORKER, recheck_worker: WORKER } },
  events: { orderBy: { acted_at: 'asc' }, include: { app_user: USER, acted_worker: WORKER } },
} satisfies Prisma.inspection_sheetInclude;

export type SheetDetailRow = Prisma.inspection_sheetGetPayload<{ include: typeof SHEET_DETAIL_INCLUDE }>;

const iso = (value: Date | null) => value?.toISOString() ?? null;
const id = (value: bigint | null) => (value === null ? null : Number(value));

type StepResultRow = SheetDetailRow['step_results'][number];

/** 단계 결과 — 출하검사는 시리얼 OQC 기록이 있으면 그 판정(원천 OQC)과, 그 기록에 대한 서명만 싣는다. */
function stepResultView(stepCode: string, result: StepResultRow | undefined, oqc: OqcRecord | null) {
  const signer = (row: StepResultRow) => ({
    signedBy: id(row.signed_by),
    signedByName: row.app_user_inspection_sheet_step_result_signed_byToapp_user?.user_name ?? null,
    signedAt: iso(row.signed_at),
  });
  if (stepCode === SHIPMENT_STEP && oqc !== null) {
    return {
      firstJudgmentCode: oqc.first_judgment_code,
      finalJudgmentCode: oqc.final_judgment_code,
      sourceCode: 'OQC',
      inspectedWorkerNo: oqc.inspected_worker?.worker_no ?? null,
      inspectedWorkerName: oqc.inspected_worker?.worker_name ?? null,
      inspectedAt: oqc.inspected_at.toISOString(),
      ...(result !== undefined && shipmentSigned(result, oqc)
        ? signer(result)
        : { signedBy: null, signedByName: null, signedAt: null }),
    };
  }
  if (result === undefined) return null;
  return {
    firstJudgmentCode: result.first_judgment_code,
    finalJudgmentCode: result.final_judgment_code,
    sourceCode: result.source_code,
    inspectedWorkerNo: result.inspected_worker?.worker_no ?? null,
    inspectedWorkerName: result.inspected_worker?.worker_name ?? null,
    inspectedAt: result.inspected_at.toISOString(),
    ...signer(result),
  };
}

/**
 * 계약 `InspectionSheet` 과 동형. 단계는 기준의 단계 전부 — 아직 안 쓴 단계는 `result` 가 null 이다.
 * `oqc` — 그 시리얼의 OQC 기록(있으면 출하검사 줄의 정본).
 */
export function sheetDetailView(
  row: SheetDetailRow,
  lotCandidates: Map<string, string[]>,
  fourMChanges: InspectionSheetFourMView[],
  oqc: OqcRecord | null,
) {
  const judgments = new Map(row.item_results.map((r) => [r.inspection_sheet_template_item_id, r.judgment_code]));
  return {
    inspectionSheetId: Number(row.inspection_sheet_id),
    serialNumberId: Number(row.serial_number_id),
    serialNo: row.serial_number.serial_no,
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no,
    workOrderId: id(row.work_order_id),
    workOrderNo: row.work_order?.work_order_no ?? null,
    inspectionSheetTemplateId: Number(row.inspection_sheet_template_id),
    templateVersion: row.template.template_version,
    formLayoutCode: row.template.form_layout_code,
    statusCode: row.status_code,
    modelText: row.model_text,
    specText: row.spec_text,
    destinationText: row.destination_text,
    pcbLotNo: row.pcb_lot_no,
    sdLotNo: row.sd_lot_no,
    stapleLotNo: row.staple_lot_no,
    fwProductionVersion: row.fw_production_version,
    fwQualityVersion: row.fw_quality_version,
    materialText: row.material_text,
    structureText: row.structure_text,
    rohsFlag: row.rohs_flag,
    productNameText: row.product_name_text,
    powerText: row.power_text,
    motorText: row.motor_text,
    tempPackNote: row.temp_pack_note,
    overallResultCode: row.overall_result_code,
    lotCandidates: {
      pcb: lotCandidates.get('PCB') ?? [],
      sd: lotCandidates.get('SD') ?? [],
      staple: lotCandidates.get('STAPLE') ?? [],
    },
    /** 변경품 투입(W/O 단위 · S4). */
    fourMChanges,
    writtenWorkerNo: row.written_worker?.worker_no ?? null,
    writtenWorkerName: row.written_worker?.worker_name ?? null,
    createdAt: row.created_at.toISOString(),
    approvedBy: id(row.approved_by),
    approvedByName: row.app_user_inspection_sheet_approved_byToapp_user?.user_name ?? null,
    approvedAt: iso(row.approved_at),
    checkedBy: id(row.checked_by),
    checkedByName: row.app_user_inspection_sheet_checked_byToapp_user?.user_name ?? null,
    checkedAt: iso(row.checked_at),
    steps: row.template.steps.map((step) => {
      const result = row.step_results.find((r) => r.step_code === step.step_code);
      return {
        stepCode: step.step_code,
        sequenceNo: step.sequence_no,
        nameKo: step.name_ko,
        nameVi: step.name_vi,
        signRequired: step.sign_required,
        result: stepResultView(step.step_code, result, oqc),
        items: step.items.map((item) => ({
          inspectionSheetTemplateItemId: Number(item.inspection_sheet_template_item_id),
          sequenceNo: item.sequence_no,
          checkItemCode: item.check_item_code,
          nameKo: item.name_ko,
          nameVi: item.name_vi,
          methodCode: item.method_code,
          judgmentCode: judgments.get(item.inspection_sheet_template_item_id) ?? null,
        })),
      };
    }),
    ngs: row.ngs.map((ng) => ({
      sequenceNo: ng.sequence_no,
      foundDepartmentCode: ng.found_department_code,
      foundStepCode: ng.found_step_code,
      occurrenceProcessText: ng.occurrence_process_text,
      standardNo: ng.standard_no,
      checkItemCode: ng.check_item_code,
      ngContent: ng.ng_content,
      investigationText: ng.investigation_text,
      ngTypeCode: ng.ng_type_code,
      repairDepartmentCode: ng.repair_department_code,
      repairWorkerNo: ng.repair_worker?.worker_no ?? null,
      repairWorkerName: ng.repair_worker?.worker_name ?? null,
      repairedAt: iso(ng.repaired_at),
      recheckResultCode: ng.recheck_result_code,
      recheckWorkerNo: ng.recheck_worker?.worker_no ?? null,
      recheckWorkerName: ng.recheck_worker?.worker_name ?? null,
      recheckedAt: iso(ng.rechecked_at),
    })),
    events: row.events.map((event) => ({
      eventCode: event.event_code,
      stepCode: event.step_code,
      reason: event.reason,
      actedBy: id(event.acted_by),
      actedByName: event.app_user?.user_name ?? event.acted_worker?.worker_name ?? null,
      actedAt: event.acted_at.toISOString(),
    })),
  };
}

export type InspectionSheetView = ReturnType<typeof sheetDetailView>;
