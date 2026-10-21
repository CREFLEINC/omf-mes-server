import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';

/** 검사표에 쓰는 사람 — POP 은 단말 사번의 작업자, 관리웹은 계정이다. */
export interface SheetActor {
  workerId?: bigint;
  appUserId?: bigint;
}

export type SheetJudgment = 'OK' | 'NG';

export interface RecordStepInput {
  stepCode: string;
  firstJudgmentCode: SheetJudgment;
  /** NG → 수리 → 재검 OK 면 OK. 1차가 OK 면 OK 여야 한다. */
  finalJudgmentCode: SheetJudgment;
  items?: { templateItemId: bigint; judgmentCode: SheetJudgment }[];
  source: 'SHEET' | 'OQC';
  inspectionResultId?: bigint;
  inspectedAt: Date;
}

const PRODUCTION_LOT_SOURCE = 'WORK_ORDER';

/**
 * OA 제품 검사표 — 시리얼 1대에 1장(omf-all-around#89 · 장부 P-102). 품질(검사표 입력)과 출하(시리얼 OQC · #68 의
 * 「출하검사」 줄)가 함께 쓴다 — 그래서 코어다. Prisma 는 받지 않는다: 호출자가 연 `tx` 안에서 자기 기록과 한 번에 쓴다.
 */
@Injectable()
export class InspectionSheetService {
  /**
   * 그 시리얼의 검사표를 찾고, 없으면 만든다. 기준 판은 W/O 단위로 고정한다 — 같은 W/O 에 이미 만든 검사표가 있으면 그
   * 판(폐기됐어도)을 쓰고, 첫 검사표만 그때의 확정판을 쓴다(담당자 검토 2026-10-21 · 한 W/O 안에서 시리얼마다 판이 갈리지
   * 않게). 쓸 판이 없으면(첫 검사표인데 확정 기준이 없으면) 400 `serialNo`·`STATE_LOCKED` 다.
   * 머리 값은 만들 때 한 번 채운다 — Model 은 품목 코드, 사양은 ERP SPEC, LOT 칸은 W/O 투입 기록이 한 LOT 일 때만, 고정 문구는 기준에서.
   */
  async getOrCreateBySerial(
    tx: Prisma.TransactionClient,
    serialNumberId: bigint,
    actor: SheetActor,
  ): Promise<{ inspectionSheetId: bigint; created: boolean }> {
    const existing = await tx.inspection_sheet.findUnique({
      where: { serial_number_id: serialNumberId },
      select: { inspection_sheet_id: true },
    });
    if (existing) return { inspectionSheetId: existing.inspection_sheet_id, created: false };

    const serial = await tx.serial_number.findUniqueOrThrow({
      where: { serial_number_id: serialNumberId },
      select: {
        item_id: true,
        lot_id: true,
        item: { select: { item_code: true, erp_spec: true } },
        lot: { select: { source_type_code: true, source_id: true } },
      },
    });
    const workOrderId = serial.lot.source_type_code === PRODUCTION_LOT_SOURCE ? serial.lot.source_id : null;
    const sameWorkOrder =
      workOrderId === null
        ? null
        : await tx.inspection_sheet.findFirst({
            where: { work_order_id: workOrderId },
            orderBy: { inspection_sheet_id: 'asc' },
            select: { inspection_sheet_template_id: true },
          });
    const template = await tx.inspection_sheet_template.findFirst({
      where:
        sameWorkOrder === null
          ? { item_id: serial.item_id, status_code: 'CONFIRMED' }
          : { inspection_sheet_template_id: sameWorkOrder.inspection_sheet_template_id },
      include: { lot_sources: { select: { slot_code: true, item_id: true } } },
    });
    if (template === null) {
      throw stateLocked('serialNo', '이 모델의 확정된 검사표 기준이 없습니다. 검사표 기준을 먼저 확정하세요.');
    }
    const lots = workOrderId === null ? new Map<string, string[]>() : await lotCandidates(tx, workOrderId, template.lot_sources);
    const single = (slot: string) => {
      const found = lots.get(slot) ?? [];
      return found.length === 1 ? found[0] : null;
    };

    // ⚠ 두 단말이 같은 시리얼을 동시에 열 수 있다 — 유일 색인에 걸린 쪽은 먼저 선 줄을 읽는다.
    const inserted = await tx.inspection_sheet.createMany({
      skipDuplicates: true,
      data: [
        {
          serial_number_id: serialNumberId,
          inspection_sheet_template_id: template.inspection_sheet_template_id,
          item_id: serial.item_id,
          lot_id: serial.lot_id,
          work_order_id: workOrderId,
          model_text: serial.item.item_code,
          spec_text: serial.item.erp_spec,
          pcb_lot_no: single('PCB'),
          sd_lot_no: single('SD'),
          staple_lot_no: single('STAPLE'),
          material_text: template.material_text,
          structure_text: template.structure_text,
          rohs_flag: template.rohs_flag,
          product_name_text: template.product_name_text,
          power_text: template.power_text,
          motor_text: template.motor_text,
          written_worker_id: actor.workerId ?? null,
          created_by: actor.appUserId ?? null,
          updated_by: actor.appUserId ?? null,
        },
      ],
    });
    const sheet = await tx.inspection_sheet.findUniqueOrThrow({
      where: { serial_number_id: serialNumberId },
      select: { inspection_sheet_id: true },
    });
    return { inspectionSheetId: sheet.inspection_sheet_id, created: inserted.count === 1 };
  }

  /**
   * 한 단계의 판정과 항목 판정을 쓴다. 같은 단계를 다시 쓰면 고친다 — 서명돼 있던 단계면 서명이 풀린다.
   * ⛔ 다른 원천(SHEET ↔ OQC)이 이미 쓴 단계는 400 `STATE_LOCKED` · 완료된 검사표도 400 `STATE_LOCKED` 다.
   */
  async recordStep(
    tx: Prisma.TransactionClient,
    serialNumberId: bigint,
    input: RecordStepInput,
    actor: SheetActor,
  ): Promise<void> {
    const { inspectionSheetId } = await this.getOrCreateBySerial(tx, serialNumberId, actor);
    const sheet = await tx.inspection_sheet.findUniqueOrThrow({
      where: { inspection_sheet_id: inspectionSheetId },
      select: {
        status_code: true,
        template: {
          select: { steps: { select: { step_code: true, items: { select: { inspection_sheet_template_item_id: true } } } } },
        },
        step_results: { where: { step_code: input.stepCode }, select: { source_code: true } },
      },
    });
    if (sheet.status_code === 'COMPLETED') throw stateLocked('stepCode', '완료된 검사표입니다. 승인 취소 뒤에 고치세요.');
    const step = sheet.template.steps.find((s) => s.step_code === input.stepCode);
    if (step === undefined) throw invalid('stepCode', '이 검사표 기준에 없는 단계입니다.');
    const own = new Set(step.items.map((i) => i.inspection_sheet_template_item_id));
    const items = input.items ?? [];
    if (items.some((item) => !own.has(item.templateItemId))) throw invalid('items', '이 단계의 항목이 아닙니다.');
    if (input.firstJudgmentCode === 'OK' && input.finalJudgmentCode !== 'OK') {
      throw invalid('finalJudgmentCode', '1차 판정이 OK 면 최종 판정도 OK 입니다.');
    }
    const previous = sheet.step_results[0];
    if (previous !== undefined && previous.source_code !== input.source) {
      throw stateLocked('stepCode', '다른 화면이 이미 기록한 단계입니다.');
    }

    const values = {
      first_judgment_code: input.firstJudgmentCode,
      final_judgment_code: input.finalJudgmentCode,
      inspected_worker_id: actor.workerId ?? null,
      inspected_at: input.inspectedAt,
      inspection_result_id: input.inspectionResultId ?? null,
      updated_by: actor.appUserId ?? null,
    };
    await tx.inspection_sheet_step_result.upsert({
      where: { inspection_sheet_id_step_code: { inspection_sheet_id: inspectionSheetId, step_code: input.stepCode } },
      create: {
        inspection_sheet_id: inspectionSheetId,
        step_code: input.stepCode,
        source_code: input.source,
        created_by: actor.appUserId ?? null,
        ...values,
      },
      update: { ...values, signed_by: null, signed_at: null, updated_at: new Date(), version_no: { increment: 1 } },
    });
    for (const item of items) {
      await tx.inspection_sheet_item_result.upsert({
        where: {
          inspection_sheet_id_inspection_sheet_template_item_id: {
            inspection_sheet_id: inspectionSheetId,
            inspection_sheet_template_item_id: item.templateItemId,
          },
        },
        create: {
          inspection_sheet_id: inspectionSheetId,
          inspection_sheet_template_item_id: item.templateItemId,
          judgment_code: item.judgmentCode,
        },
        update: { judgment_code: item.judgmentCode, updated_at: new Date() },
      });
    }
  }
}

/** W/O 투입 기록에서 칸별 자재 LOT 번호. 시리얼별 투입 기록은 없어 W/O 단위다(장부 P-102). */
export async function lotCandidates(
  tx: Prisma.TransactionClient,
  workOrderId: bigint,
  sources: readonly { slot_code: string; item_id: bigint }[],
): Promise<Map<string, string[]>> {
  if (sources.length === 0) return new Map();
  const rows = await tx.material_consumption.findMany({
    where: { work_order_id: workOrderId, item_id: { in: sources.map((s) => s.item_id) } },
    select: { item_id: true, lot: { select: { lot_no: true } } },
    orderBy: { material_consumption_id: 'asc' },
  });
  const bySlot = new Map<string, string[]>();
  for (const source of sources) {
    const lotNos = rows.filter((row) => row.item_id === source.item_id).map((row) => row.lot.lot_no);
    bySlot.set(source.slot_code, [...new Set([...(bySlot.get(source.slot_code) ?? []), ...lotNos])]);
  }
  return bySlot;
}

function stateLocked(field: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field, code: ERROR_CODE.STATE_LOCKED, message }]);
}

function invalid(field: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field, code: ERROR_CODE.INVALID, message }]);
}
