import { Prisma } from '@prisma/client';

/** 계약 `InspectionSheetTemplateItem` 과 동형. */
export interface InspectionSheetTemplateItemView {
  inspectionSheetTemplateItemId: number;
  sequenceNo: number;
  checkItemCode: string;
  nameKo: string;
  nameVi: string | null;
  methodCode: string;
}

/** 계약 `InspectionSheetTemplateStep` 과 동형. */
export interface InspectionSheetTemplateStepView {
  stepCode: string;
  sequenceNo: number;
  nameKo: string;
  nameVi: string | null;
  signRequired: boolean;
  items: InspectionSheetTemplateItemView[];
}

/** 계약 `InspectionSheetTemplate` 과 동형. 목록은 `steps`·`lotSources` 를 싣지 않는다. */
export interface InspectionSheetTemplateView {
  inspectionSheetTemplateId: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  templateVersion: number;
  businessUnitId: number;
  formLayoutCode: string;
  statusCode: string;
  materialText: string | null;
  structureText: string | null;
  rohsFlag: boolean;
  productNameText: string | null;
  powerText: string | null;
  motorText: string | null;
  remarks: string | null;
  confirmedBy: number | null;
  confirmedAt: string | null;
  lotSources?: { slotCode: string; itemId: number; itemCode: string; itemName: string }[];
  steps?: InspectionSheetTemplateStepView[];
}

export const TEMPLATE_SUMMARY_INCLUDE = {
  item: { select: { item_code: true, item_name: true } },
} satisfies Prisma.inspection_sheet_templateInclude;

export const TEMPLATE_DETAIL_INCLUDE = {
  ...TEMPLATE_SUMMARY_INCLUDE,
  lot_sources: {
    orderBy: [{ slot_code: 'asc' }, { inspection_sheet_template_lot_source_id: 'asc' }],
    include: { item: { select: { item_code: true, item_name: true } } },
  },
  steps: { orderBy: { sequence_no: 'asc' }, include: { items: { orderBy: { sequence_no: 'asc' } } } },
} satisfies Prisma.inspection_sheet_templateInclude;

type SummaryRow = Prisma.inspection_sheet_templateGetPayload<{ include: typeof TEMPLATE_SUMMARY_INCLUDE }>;
type DetailRow = Prisma.inspection_sheet_templateGetPayload<{ include: typeof TEMPLATE_DETAIL_INCLUDE }>;

export function templateSummaryView(row: SummaryRow): InspectionSheetTemplateView {
  return {
    inspectionSheetTemplateId: Number(row.inspection_sheet_template_id),
    itemId: Number(row.item_id),
    itemCode: row.item.item_code,
    itemName: row.item.item_name,
    templateVersion: row.template_version,
    businessUnitId: Number(row.business_unit_id),
    formLayoutCode: row.form_layout_code,
    statusCode: row.status_code,
    materialText: row.material_text,
    structureText: row.structure_text,
    rohsFlag: row.rohs_flag,
    productNameText: row.product_name_text,
    powerText: row.power_text,
    motorText: row.motor_text,
    remarks: row.remarks,
    confirmedBy: row.confirmed_by === null ? null : Number(row.confirmed_by),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
  };
}

export function templateDetailView(row: DetailRow): InspectionSheetTemplateView {
  return {
    ...templateSummaryView(row),
    lotSources: row.lot_sources.map((source) => ({
      slotCode: source.slot_code,
      itemId: Number(source.item_id),
      itemCode: source.item.item_code,
      itemName: source.item.item_name,
    })),
    steps: row.steps.map((step) => ({
      stepCode: step.step_code,
      sequenceNo: step.sequence_no,
      nameKo: step.name_ko,
      nameVi: step.name_vi,
      signRequired: step.sign_required,
      items: step.items.map((item) => ({
        inspectionSheetTemplateItemId: Number(item.inspection_sheet_template_item_id),
        sequenceNo: item.sequence_no,
        checkItemCode: item.check_item_code,
        nameKo: item.name_ko,
        nameVi: item.name_vi,
        methodCode: item.method_code,
      })),
    })),
  };
}
