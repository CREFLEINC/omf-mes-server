import { Prisma } from '@prisma/client';

export const INSPECTION_INCLUDE = {
  equipment: { select: { equipment_code: true } },
  worker: { select: { worker_no: true } },
  equipment_inspection_result: {
    include: { equipment_inspection_item: true },
    orderBy: [
      { equipment_inspection_item: { sequence_no: 'asc' } },
      { equipment_inspection_item_id: 'asc' },
    ],
  },
} satisfies Prisma.equipment_inspectionInclude;

export type InspectionRow = Prisma.equipment_inspectionGetPayload<{
  include: typeof INSPECTION_INCLUDE;
}>;

export interface InspectionLineView {
  inspectionItemId: number;
  itemName: string;
  judgeMethodCode: string;
  resultCode: 'PASS' | 'FAIL';
  measuredValue: number | null;
  remarks: string | null;
}

export interface InspectionView {
  inspectionId: number;
  inspectionNo: string;
  equipmentId: number;
  equipmentCode: string;
  inspectionTypeCode: string;
  overallResultCode: 'PASS' | 'FAIL';
  inspectedAt: string;
  inspectorWorkerNo: string;
  remarks: string | null;
  lines: InspectionLineView[];
}

/** 과거 결손·OK/NG를 정상 응답으로 보완하지 않는다 — 설계 미정 문의 091. */
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing required inspection field');
  return value;
}

function resultCode(value: string | null): 'PASS' | 'FAIL' {
  if (value !== 'PASS' && value !== 'FAIL') throw new Error('Invalid stored inspection result');
  return value;
}

export function inspectionView(row: InspectionRow): InspectionView {
  return {
    inspectionId: Number(required(row.equipment_inspection_id)),
    inspectionNo: row.inspection_no,
    equipmentId: Number(required(row.equipment_id)),
    equipmentCode: row.equipment.equipment_code,
    inspectionTypeCode: required(row.inspection_type_code),
    overallResultCode: resultCode(row.judgment_code),
    inspectedAt: required(row.inspected_at).toISOString(),
    inspectorWorkerNo: required(row.worker?.worker_no),
    remarks: row.remarks,
    lines: row.equipment_inspection_result.map((line) => ({
      inspectionItemId: Number(required(line.equipment_inspection_item_id)),
      itemName: line.equipment_inspection_item.inspection_item_name,
      judgeMethodCode: line.equipment_inspection_item.judgment_method_code,
      resultCode: resultCode(line.judgment_code),
      measuredValue: line.numeric_value === null ? null : Number(line.numeric_value),
      remarks: line.remarks,
    })),
  };
}
