import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InspectionSheetTemplateView,
  TEMPLATE_DETAIL_INCLUDE,
  TEMPLATE_SUMMARY_INCLUDE,
  templateDetailView,
  templateSummaryView,
} from './inspection-sheet-template-view';
import { contentChanges, contentOf, recordSheetTemplateAudit, statusAudit } from './inspection-sheet-template-audit';

export interface InspectionSheetTemplateStepWrite {
  stepCode: string;
  nameKo: string;
  nameVi?: string | null;
  signRequired: boolean;
  items: { checkItemCode: string; nameKo: string; nameVi?: string | null; methodCode: string }[];
}

/** 계약 `InspectionSheetTemplateUpdate` — 순서는 배열 순서다. */
export interface InspectionSheetTemplateUpdate {
  materialText?: string | null;
  structureText?: string | null;
  rohsFlag: boolean;
  productNameText?: string | null;
  powerText?: string | null;
  motorText?: string | null;
  remarks?: string | null;
  lotSources: { slotCode: string; itemId: number }[];
  steps: InspectionSheetTemplateStepWrite[];
}

/** 계약 `InspectionSheetTemplateCreate`. */
export interface InspectionSheetTemplateCreate extends InspectionSheetTemplateUpdate {
  itemId: number;
  businessUnitId: number;
  formLayoutCode: string;
}

export interface InspectionSheetTemplateQuery {
  itemId?: number;
  statusCode?: string;
  page?: number;
  size?: number;
}

/** 쓰는 사람 — 세션 계정. OA 공장 범위는 컨트롤러가 먼저 본다(`InspectionSheetAccess`). */
export interface TemplateActor {
  userId: number;
}

/** 출력 배치가 칸을 가진 단계만 받는다 — 양식에 없는 단계는 인쇄할 자리가 없다. */
const LAYOUT_STEPS: Readonly<Record<string, readonly string[]>> = {
  OP: ['PROCESS_1', 'PROCESS_2', 'PROCESS_3', 'PROCESS_4', 'PROCESS_5', 'SHIPMENT', 'CROSS_CHECK'],
  PP: ['PROCESS_1', 'PROCESS_2', 'PROCESS_3', 'SHIPMENT', 'CROSS_CHECK', 'SAMPLING'],
};

/**
 * OA 제품 검사표 기준(W-06-24 · omf-all-around#89 · 장부 P-102). 모델마다 확정본은 하나이고, 확정본은
 * 고치지 않는다 — 검사표가 기준의 항목 줄을 FK 로 가리켜 출력물이 그 줄의 이름을 읽기 때문이다.
 * 기준은 OA 공장 범위의 계정만 쓴다(담당자 결정 ④ · 2026-10-21 수정 — 사업부가 부품·OA 를 함께 가져 공장으로 판단).
 * ⚠ `business_unit_id` 칸은 남기되 판단에 쓰지 않는다.
 */
@Injectable()
export class InspectionSheetTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InspectionSheetTemplateQuery): Promise<PagedResponse<InspectionSheetTemplateView>> {
    const page = pageRequest(query);
    const where: Prisma.inspection_sheet_templateWhereInput = {
      ...(query.itemId === undefined ? {} : { item_id: query.itemId }),
      ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inspection_sheet_template.findMany({
        where,
        include: TEMPLATE_SUMMARY_INCLUDE,
        orderBy: [{ item_id: 'asc' }, { template_version: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.inspection_sheet_template.count({ where }),
    ]);
    return pagedResponse(rows.map(templateSummaryView), total, page);
  }

  async get(id: number): Promise<{ inspectionSheetTemplate: InspectionSheetTemplateView; versionNo: number }> {
    const row = await this.prisma.inspection_sheet_template.findUnique({
      where: { inspection_sheet_template_id: id },
      include: TEMPLATE_DETAIL_INCLUDE,
    });
    if (row === null) throw new NotFoundException('없는 검사표 기준입니다.');
    return { inspectionSheetTemplate: templateDetailView(row), versionNo: row.version_no };
  }

  /** 같은 모델의 판 번호는 최댓값 + 1 이다 — 확정본이 있어도 새 작성중 판을 세운다. */
  async create(input: InspectionSheetTemplateCreate, actor: TemplateActor): Promise<InspectionSheetTemplateView> {
    await this.assertContent(input.formLayoutCode, input);
    const id = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.inspection_sheet_template.aggregate({
        where: { item_id: input.itemId },
        _max: { template_version: true },
      });
      const created = await tx.inspection_sheet_template.create({
        data: {
          item_id: input.itemId,
          business_unit_id: input.businessUnitId,
          form_layout_code: input.formLayoutCode,
          template_version: (latest._max.template_version ?? 0) + 1,
          ...headerData(input),
          created_by: actor.userId,
          updated_by: actor.userId,
        },
        select: { inspection_sheet_template_id: true },
      });
      await writeChildren(tx, created.inspection_sheet_template_id, input);
      await recordSheetTemplateAudit(tx, {
        templateId: created.inspection_sheet_template_id,
        eventTypeCode: 'CREATE',
        actorId: actor.userId,
        after: { templateVersion: (latest._max.template_version ?? 0) + 1, formLayoutCode: input.formLayoutCode, statusCode: 'DRAFT' },
      });
      return created.inspection_sheet_template_id;
    });
    return (await this.get(Number(id))).inspectionSheetTemplate;
  }

  /** 작성중 판만 고친다. 하위 줄(단계·항목·LOT 칸)은 통째로 갈아 끼운다. */
  async update(
    id: number,
    version: number,
    input: InspectionSheetTemplateUpdate,
    actor: TemplateActor,
  ): Promise<{ inspectionSheetTemplate: InspectionSheetTemplateView; versionNo: number }> {
    const row = await this.loadDraft(id);
    await this.assertContent(row.form_layout_code, input);
    const before = contentOf(writeShapeOf((await this.get(id)).inspectionSheetTemplate));
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.inspection_sheet_template.updateMany({
        where: { inspection_sheet_template_id: id, version_no: version, status_code: 'DRAFT' },
        data: { ...headerData(input), updated_by: actor.userId, updated_at: new Date(), version_no: { increment: 1 } },
      });
      assertUpdated(updated.count);
      const steps = await tx.inspection_sheet_template_step.findMany({
        where: { inspection_sheet_template_id: id },
        select: { inspection_sheet_template_step_id: true },
      });
      await tx.inspection_sheet_template_item.deleteMany({
        where: { inspection_sheet_template_step_id: { in: steps.map((s) => s.inspection_sheet_template_step_id) } },
      });
      await tx.inspection_sheet_template_step.deleteMany({ where: { inspection_sheet_template_id: id } });
      await tx.inspection_sheet_template_lot_source.deleteMany({ where: { inspection_sheet_template_id: id } });
      await writeChildren(tx, BigInt(id), input);
      const diff = contentChanges(before, contentOf(input));
      if (diff) await recordSheetTemplateAudit(tx, { templateId: id, eventTypeCode: 'UPDATE', actorId: actor.userId, ...diff });
    });
    return this.get(id);
  }

  /** 확정 — 같은 모델의 앞 확정본은 폐기로 내린다(모델당 확정본 하나 · `uq_inspection_sheet_template_item_confirmed`). */
  async confirm(
    id: number,
    version: number,
    actor: TemplateActor,
  ): Promise<{ inspectionSheetTemplate: InspectionSheetTemplateView; versionNo: number }> {
    const row = await this.loadDraft(id);
    const stepCount = await this.prisma.inspection_sheet_template_step.count({
      where: { inspection_sheet_template_id: id },
    });
    if (stepCount === 0) throw badRequest('steps', ERROR_CODE.REQUIRED, '검사 단계를 하나 이상 등록해야 확정할 수 있습니다.');
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.inspection_sheet_template.findMany({
        where: { item_id: row.item_id, status_code: 'CONFIRMED' },
        select: { inspection_sheet_template_id: true },
      });
      await tx.inspection_sheet_template.updateMany({
        where: { item_id: row.item_id, status_code: 'CONFIRMED' },
        data: { status_code: 'OBSOLETE', updated_by: actor.userId, updated_at: new Date(), version_no: { increment: 1 } },
      });
      const now = new Date();
      const updated = await tx.inspection_sheet_template.updateMany({
        where: { inspection_sheet_template_id: id, version_no: version, status_code: 'DRAFT' },
        data: {
          status_code: 'CONFIRMED',
          confirmed_by: actor.userId,
          confirmed_at: now,
          updated_by: actor.userId,
          updated_at: now,
          version_no: { increment: 1 },
        },
      });
      assertUpdated(updated.count);
      for (const old of previous) {
        await recordSheetTemplateAudit(tx, statusAudit(old.inspection_sheet_template_id, 'CONFIRMED', 'OBSOLETE', actor.userId));
      }
      await recordSheetTemplateAudit(tx, statusAudit(id, 'DRAFT', 'CONFIRMED', actor.userId));
    });
    return this.get(id);
  }

  /** 확정 → 폐기(omf-all-around#214). ⛔ 되돌릴 수 없다 — 그 모델은 새 버전을 확정할 때까지 확정본이 없다. */
  async obsolete(
    id: number,
    version: number,
    actor: TemplateActor,
  ): Promise<{ inspectionSheetTemplate: InspectionSheetTemplateView; versionNo: number }> {
    const row = await this.prisma.inspection_sheet_template.findUnique({
      where: { inspection_sheet_template_id: id },
      select: { status_code: true },
    });
    if (row === null) throw new NotFoundException('없는 검사표 기준입니다.');
    if (row.status_code !== 'CONFIRMED') throw locked('확정된 기준만 폐기할 수 있습니다.');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.inspection_sheet_template.updateMany({
        where: { inspection_sheet_template_id: id, version_no: version, status_code: 'CONFIRMED' },
        data: { status_code: 'OBSOLETE', updated_by: actor.userId, updated_at: new Date(), version_no: { increment: 1 } },
      });
      assertUpdated(updated.count);
      await recordSheetTemplateAudit(tx, statusAudit(id, 'CONFIRMED', 'OBSOLETE', actor.userId));
    });
    return this.get(id);
  }

  /**
   * 작성중 버전을 지운다(작성 취소 · omf-all-around#214) — 단계 · 항목 · LOT 칸과 함께.
   * 검사표는 확정본만 쓰므로 작성중 버전을 가리키는 검사표는 정상 경로로 생기지 않는다.
   * ⛔ 그래도 세어 막는다 — 지운 뒤 FK 위반이 500 으로 새지 않게.
   */
  async discard(id: number, actor: TemplateActor): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // ⛔ `FOR UPDATE` — 판정과 삭제 사이에 확정이 끼면 확정본이 지워진다.
      const rows = await tx.$queryRaw<{ status_code: string; template_version: number }[]>`
        SELECT status_code, template_version
          FROM quality.inspection_sheet_template
         WHERE inspection_sheet_template_id = ${BigInt(id)}
           FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('없는 검사표 기준입니다.');
      if (rows[0].status_code !== 'DRAFT') throw locked('작성중인 기준만 작성을 취소할 수 있습니다.');
      if ((await tx.inspection_sheet.count({ where: { inspection_sheet_template_id: id } })) > 0) {
        throw locked('이 기준으로 만든 검사표가 있어 작성을 취소할 수 없습니다.');
      }

      const own = { inspection_sheet_template_id: id };
      await tx.inspection_sheet_template_item.deleteMany({ where: { step: own } });
      await tx.inspection_sheet_template_step.deleteMany({ where: own });
      await tx.inspection_sheet_template_lot_source.deleteMany({ where: own });
      await tx.inspection_sheet_template.delete({ where: own });
      await recordSheetTemplateAudit(tx, {
        templateId: id,
        eventTypeCode: 'DELETE',
        actorId: actor.userId,
        before: { templateVersion: Number(rows[0].template_version), statusCode: rows[0].status_code },
      });
    });
  }

  private async loadDraft(id: number) {
    const row = await this.prisma.inspection_sheet_template.findUnique({
      where: { inspection_sheet_template_id: id },
      select: { item_id: true, form_layout_code: true, status_code: true },
    });
    if (row === null) throw new NotFoundException('없는 검사표 기준입니다.');
    if (row.status_code !== 'DRAFT') throw locked('작성중인 기준만 고칠 수 있습니다. 새 판을 만드세요.');
    return row;
  }

  private async assertContent(formLayoutCode: string, input: InspectionSheetTemplateUpdate): Promise<void> {
    const allowed = LAYOUT_STEPS[formLayoutCode] ?? [];
    const seen = new Set<string>();
    const errors: ErrorItem[] = [];
    input.steps.forEach((step, index) => {
      if (seen.has(step.stepCode)) {
        errors.push(fieldError(`steps[${index}].stepCode`, ERROR_CODE.UNIQUE_VIOLATION, '같은 단계를 두 번 둘 수 없습니다.'));
      } else if (!allowed.includes(step.stepCode)) {
        errors.push(fieldError(`steps[${index}].stepCode`, ERROR_CODE.INVALID, `${formLayoutCode} 양식에 없는 단계입니다.`));
      }
      seen.add(step.stepCode);
    });
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    await assertCodeValues(
      this.prisma,
      input.steps.map((step, index) => ({
        field: `steps[${index}].stepCode`,
        value: step.stepCode,
        groupCode: 'INSPECTION_SHEET_STEP',
      })),
    );
  }
}

/** 읽은 기준을 쓰기 모양으로 — 고치기 전 내용을 이력에 견줄 때 쓴다. */
function writeShapeOf(view: InspectionSheetTemplateView): InspectionSheetTemplateUpdate {
  return {
    ...view,
    lotSources: view.lotSources ?? [],
    steps: view.steps ?? [],
  };
}

function headerData(input: InspectionSheetTemplateUpdate) {
  return {
    material_text: input.materialText ?? null,
    structure_text: input.structureText ?? null,
    rohs_flag: input.rohsFlag,
    product_name_text: input.productNameText ?? null,
    power_text: input.powerText ?? null,
    motor_text: input.motorText ?? null,
    remarks: input.remarks ?? null,
  };
}

async function writeChildren(
  tx: Prisma.TransactionClient,
  templateId: bigint,
  input: InspectionSheetTemplateUpdate,
): Promise<void> {
  if (input.lotSources.length > 0) {
    await tx.inspection_sheet_template_lot_source.createMany({
      data: input.lotSources.map((source) => ({
        inspection_sheet_template_id: templateId,
        slot_code: source.slotCode,
        item_id: source.itemId,
      })),
    });
  }
  for (const [index, step] of input.steps.entries()) {
    await tx.inspection_sheet_template_step.create({
      data: {
        inspection_sheet_template_id: templateId,
        step_code: step.stepCode,
        sequence_no: index + 1,
        name_ko: step.nameKo,
        name_vi: step.nameVi ?? null,
        sign_required: step.signRequired,
        items: {
          create: step.items.map((item, itemIndex) => ({
            sequence_no: itemIndex + 1,
            check_item_code: item.checkItemCode,
            name_ko: item.nameKo,
            name_vi: item.nameVi ?? null,
            method_code: item.methodCode,
          })),
        },
      },
    });
  }
}


function fieldError(field: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field, code, message };
}

function badRequest(field: string, code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [fieldError(field, code, message)]);
}

function locked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
