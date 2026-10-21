import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { InspectionSheetService, SheetActor, SheetJudgment, lotCandidates } from '../../core/inspection-sheet';
import { PrismaService } from '../../prisma/prisma.service';
import { fourMChangesOf } from './inspection-sheet-four-m';
import { InspectionSheetView, SHEET_DETAIL_INCLUDE, sheetDetailView } from './inspection-sheet-view';

/** 계약 `InspectionSheetHeaderUpdate` — 머리 값은 자동으로 채운 뒤 사람이 고친다(담당자 결정 ①). */
export interface InspectionSheetHeaderUpdate {
  modelText?: string | null;
  specText?: string | null;
  destinationText?: string | null;
  pcbLotNo?: string | null;
  sdLotNo?: string | null;
  stapleLotNo?: string | null;
  fwProductionVersion?: string | null;
  fwQualityVersion?: string | null;
  materialText?: string | null;
  structureText?: string | null;
  rohsFlag: boolean;
  productNameText?: string | null;
  powerText?: string | null;
  motorText?: string | null;
  tempPackNote?: string | null;
  overallResultCode?: SheetJudgment | null;
}

/** 계약 `InspectionSheetStepWrite` — 판정 두 칸을 함께 빼면 항목 판정만 임시 저장한다(담당자 실검증 2026-10-21). */
export interface InspectionSheetStepWrite {
  firstJudgmentCode?: SheetJudgment;
  finalJudgmentCode?: SheetJudgment;
  items: { inspectionSheetTemplateItemId: number; judgmentCode: SheetJudgment }[];
}

/** 계약 `InspectionSheetNgWrite` — 작업자는 사번으로 받는다(POP 은 사번을 친다). */
export interface InspectionSheetNgWrite {
  foundDepartmentCode?: string | null;
  foundStepCode?: string | null;
  occurrenceProcessText?: string | null;
  standardNo?: string | null;
  checkItemCode?: string | null;
  ngContent: string;
  investigationText?: string | null;
  ngTypeCode?: string | null;
  repairDepartmentCode?: string | null;
  repairWorkerNo?: string | null;
  repairedAt?: string | null;
  recheckResultCode?: SheetJudgment | null;
  recheckWorkerNo?: string | null;
  recheckedAt?: string | null;
}

export interface SheetResult {
  inspectionSheet: InspectionSheetView;
  versionNo: number;
}

/**
 * OA 제품 검사표 입력(POP P-02-15 · 관리웹 W-03-13 · omf-all-around#89 · 장부 P-102).
 * 쓰기는 모두 검사표 한 장의 `version_no` 로 잠근다 — 단계·NG 를 고쳐도 검사표 ETag 가 바뀐다.
 */
@Injectable()
export class InspectionSheetEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: InspectionSheetService,
  ) {}

  async openBySerial(serialNo: string, actor: SheetActor): Promise<SheetResult> {
    const serial = await this.prisma.serial_number.findUnique({
      where: { serial_no: serialNo },
      select: { serial_number_id: true },
    });
    if (serial === null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'field', field: 'serialNo', code: ERROR_CODE.INVALID, message: '없는 시리얼 번호입니다.' },
      ]);
    }
    const { inspectionSheetId } = await this.prisma.$transaction((tx) =>
      this.sheets.getOrCreateBySerial(tx, serial.serial_number_id, actor),
    );
    return this.get(Number(inspectionSheetId));
  }

  async get(id: number): Promise<SheetResult> {
    const row = await this.prisma.inspection_sheet.findUnique({
      where: { inspection_sheet_id: id },
      include: SHEET_DETAIL_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 검사표입니다.');
    const candidates =
      row.work_order_id === null ? new Map<string, string[]>() : await lotCandidates(this.prisma, row.work_order_id, row.template.lot_sources);
    const fourMChanges = await fourMChangesOf(this.prisma, row.work_order_id);
    return { inspectionSheet: sheetDetailView(row, candidates, fourMChanges), versionNo: row.version_no };
  }

  async updateHeader(id: number, version: number, input: InspectionSheetHeaderUpdate, actor: SheetActor): Promise<SheetResult> {
    await this.prisma.$transaction(async (tx) => {
      await bumpOpenSheet(tx, id, version, actor);
      await tx.inspection_sheet.update({
        where: { inspection_sheet_id: id },
        data: {
          model_text: input.modelText ?? null,
          spec_text: input.specText ?? null,
          destination_text: input.destinationText ?? null,
          pcb_lot_no: input.pcbLotNo ?? null,
          sd_lot_no: input.sdLotNo ?? null,
          staple_lot_no: input.stapleLotNo ?? null,
          fw_production_version: input.fwProductionVersion ?? null,
          fw_quality_version: input.fwQualityVersion ?? null,
          material_text: input.materialText ?? null,
          structure_text: input.structureText ?? null,
          rohs_flag: input.rohsFlag,
          product_name_text: input.productNameText ?? null,
          power_text: input.powerText ?? null,
          motor_text: input.motorText ?? null,
          temp_pack_note: input.tempPackNote ?? null,
          overall_result_code: input.overallResultCode ?? null,
        },
      });
    });
    return this.get(id);
  }

  async writeStep(id: number, stepCode: string, version: number, input: InspectionSheetStepWrite, actor: SheetActor): Promise<SheetResult> {
    const { firstJudgmentCode, finalJudgmentCode } = input;
    if ((firstJudgmentCode === undefined) !== (finalJudgmentCode === undefined)) {
      throw fieldError(firstJudgmentCode === undefined ? 'firstJudgmentCode' : 'finalJudgmentCode', ERROR_CODE.INVALID, '1차 판정과 최종 판정은 함께 보내거나 함께 빼세요.');
    }
    await this.prisma.$transaction(async (tx) => {
      const serialNumberId = await bumpOpenSheet(tx, id, version, actor);
      if (firstJudgmentCode === undefined || finalJudgmentCode === undefined) {
        await saveItemDraft(tx, id, stepCode, input.items);
        return;
      }
      await this.sheets.recordStep(
        tx,
        serialNumberId,
        {
          stepCode,
          firstJudgmentCode,
          finalJudgmentCode,
          items: input.items.map((item) => ({
            templateItemId: BigInt(item.inspectionSheetTemplateItemId),
            judgmentCode: item.judgmentCode,
          })),
          source: 'SHEET',
          inspectedAt: new Date(),
        },
        actor,
      );
    });
    return this.get(id);
  }

  /** NG 블록은 통째로 갈아 끼운다 — 순번은 배열 순서다. */
  async replaceNgs(id: number, version: number, ngs: InspectionSheetNgWrite[], actor: SheetActor): Promise<SheetResult> {
    await this.prisma.$transaction(async (tx) => {
      await bumpOpenSheet(tx, id, version, actor);
      const workers = await workerIds(tx, ngs);
      await tx.inspection_sheet_ng.deleteMany({ where: { inspection_sheet_id: id } });
      if (ngs.length === 0) return;
      await tx.inspection_sheet_ng.createMany({
        data: ngs.map((ng, index) => ({
          inspection_sheet_id: id,
          sequence_no: index + 1,
          found_department_code: ng.foundDepartmentCode ?? null,
          found_step_code: ng.foundStepCode ?? null,
          occurrence_process_text: ng.occurrenceProcessText ?? null,
          standard_no: ng.standardNo ?? null,
          check_item_code: ng.checkItemCode ?? null,
          ng_content: ng.ngContent,
          investigation_text: ng.investigationText ?? null,
          ng_type_code: ng.ngTypeCode ?? null,
          repair_department_code: ng.repairDepartmentCode ?? null,
          repair_worker_id: ng.repairWorkerNo ? (workers.get(ng.repairWorkerNo) ?? null) : null,
          repaired_at: ng.repairedAt ? new Date(ng.repairedAt) : null,
          recheck_result_code: ng.recheckResultCode ?? null,
          recheck_worker_id: ng.recheckWorkerNo ? (workers.get(ng.recheckWorkerNo) ?? null) : null,
          rechecked_at: ng.recheckedAt ? new Date(ng.recheckedAt) : null,
          created_by: actor.appUserId ?? null,
          updated_by: actor.appUserId ?? null,
        })),
      });
    });
    return this.get(id);
  }
}

/**
 * 작성중인 검사표의 잠금 버전을 올린다. 완료된 검사표는 400 `STATE_LOCKED`, 버전이 다르면 409 다.
 * ⭐ 승인·확인 중 하나만 된 검사표를 고치면 그 승인·확인을 푼다 — 고친 내용으로 다시 승인받게(서명 해제와 같은 이유).
 */
async function bumpOpenSheet(tx: Prisma.TransactionClient, id: number, version: number, actor: SheetActor): Promise<bigint> {
  const sheet = await tx.inspection_sheet.findUnique({
    where: { inspection_sheet_id: id },
    select: { serial_number_id: true, status_code: true, approved_by: true, checked_by: true },
  });
  if (sheet === null) throw new NotFoundException('없는 검사표입니다.');
  if (sheet.status_code === 'COMPLETED') {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '완료된 검사표입니다. 승인 취소 뒤에 고치세요.' },
    ]);
  }
  const updated = await tx.inspection_sheet.updateMany({
    where: { inspection_sheet_id: id, version_no: version, status_code: 'IN_PROGRESS' },
    data: {
      approved_by: null,
      approved_at: null,
      checked_by: null,
      checked_at: null,
      updated_by: actor.appUserId ?? null,
      updated_at: new Date(),
      version_no: { increment: 1 },
    },
  });
  assertUpdated(updated.count);
  if (sheet.approved_by !== null || sheet.checked_by !== null) {
    await tx.inspection_sheet_event.create({
      data: {
        inspection_sheet_id: id,
        event_code: 'APPROVAL_CLEARED',
        acted_by: actor.appUserId ?? null,
        acted_worker_id: actor.workerId ?? null,
      },
    });
  }
  return sheet.serial_number_id;
}

/**
 * 단계 판정 없이 항목 판정만 쓴다(임시 저장). 단계 판정은 전수 항목을 다 본 뒤 정해지므로, 판정이 이미 기록된 단계는
 * 항목만 바꿔 판정과 어긋나게 두지 않는다 — 400 `stepCode`·`STATE_LOCKED`(판정과 함께 저장).
 */
async function saveItemDraft(
  tx: Prisma.TransactionClient,
  id: number,
  stepCode: string,
  items: InspectionSheetStepWrite['items'],
): Promise<void> {
  if (items.length === 0) throw fieldError('items', ERROR_CODE.REQUIRED, '임시 저장할 항목 판정이 없습니다.');
  const sheet = await tx.inspection_sheet.findUniqueOrThrow({
    where: { inspection_sheet_id: id },
    select: {
      template: { select: { steps: { select: { step_code: true, items: { select: { inspection_sheet_template_item_id: true } } } } } },
      step_results: { where: { step_code: stepCode }, select: { step_code: true } },
    },
  });
  const step = sheet.template.steps.find((row) => row.step_code === stepCode);
  if (step === undefined) throw fieldError('stepCode', ERROR_CODE.INVALID, '이 검사표 기준에 없는 단계입니다.');
  const own = new Set(step.items.map((item) => item.inspection_sheet_template_item_id));
  if (items.some((item) => !own.has(BigInt(item.inspectionSheetTemplateItemId)))) {
    throw fieldError('items', ERROR_CODE.INVALID, '이 단계의 항목이 아닙니다.');
  }
  if (sheet.step_results.length > 0) {
    throw fieldError('stepCode', ERROR_CODE.STATE_LOCKED, '판정이 기록된 단계입니다. 판정과 함께 저장하세요.');
  }
  for (const item of items) {
    const templateItemId = BigInt(item.inspectionSheetTemplateItemId);
    await tx.inspection_sheet_item_result.upsert({
      where: {
        inspection_sheet_id_inspection_sheet_template_item_id: { inspection_sheet_id: id, inspection_sheet_template_item_id: templateItemId },
      },
      create: { inspection_sheet_id: id, inspection_sheet_template_item_id: templateItemId, judgment_code: item.judgmentCode },
      update: { judgment_code: item.judgmentCode, updated_at: new Date() },
    });
  }
}

function fieldError(field: string, code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field, code, message }]);
}

async function workerIds(tx: Prisma.TransactionClient, ngs: InspectionSheetNgWrite[]): Promise<Map<string, bigint>> {
  const wanted = new Map<string, string>();
  ngs.forEach((ng, index) => {
    if (ng.repairWorkerNo) wanted.set(ng.repairWorkerNo, `ngs[${index}].repairWorkerNo`);
    if (ng.recheckWorkerNo) wanted.set(ng.recheckWorkerNo, `ngs[${index}].recheckWorkerNo`);
  });
  if (wanted.size === 0) return new Map();
  const rows = await tx.worker.findMany({
    where: { worker_no: { in: [...wanted.keys()] } },
    select: { worker_no: true, worker_id: true },
  });
  const found = new Map(rows.map((row) => [row.worker_no, row.worker_id]));
  const missing = [...wanted].filter(([workerNo]) => !found.has(workerNo));
  if (missing.length > 0) {
    throw new ContractException(
      HttpStatus.BAD_REQUEST,
      missing.map(([, field]) => ({ scope: 'field' as const, field, code: ERROR_CODE.INVALID, message: '없는 작업자 사번입니다.' })),
    );
  }
  return found;
}
