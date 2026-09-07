import { Prisma } from '@prisma/client';

import { InspectionRow, inspectionView } from './inspection-view';

function inspectionRow(id = 1n): InspectionRow {
  return {
    equipment_inspection_id: id,
    inspection_no: `inspection-${id}`,
    equipment_id: 3n,
    inspection_type_code: 'CUSTOM',
    inspected_at: new Date('2026-09-01T00:30:00+07:00'),
    inspected_by: 4n,
    judgment_code: 'FAIL',
    scheduled_at: null,
    status_code: 'LEGACY',
    remarks: null,
    created_at: new Date(),
    created_by: null,
    updated_at: new Date(),
    updated_by: null,
    version_no: 7,
    equipment: { equipment_code: 'EQ-CURRENT' },
    worker: { worker_no: 'WORKER-ONLY' },
    equipment_inspection_result: [],
  };
}

describe('inspectionView', () => {
  it('저장된 FAIL을 라인으로 재계산하지 않고 nullable 키와 사번을 유지한다', () => {
    expect(inspectionView(inspectionRow())).toEqual({
      inspectionId: 1,
      inspectionNo: 'inspection-1',
      equipmentId: 3,
      equipmentCode: 'EQ-CURRENT',
      inspectionTypeCode: 'CUSTOM',
      overallResultCode: 'FAIL',
      inspectedAt: '2026-08-31T17:30:00.000Z',
      inspectorWorkerNo: 'WORKER-ONLY',
      remarks: null,
      lines: [],
    });
  });

  it.each([
    'equipment_inspection_id',
    'equipment_id',
    'inspection_type_code',
    'judgment_code',
    'inspected_at',
    'worker',
  ])('requiredRowFields를 omitEmpty가 숨기지 않는다: %s', (name) => {
    // 설계 미정 — 문의 091. 실제 nullable 세 칸 외의 required도 뷰 경계에서 방어한다.
    const row = { ...inspectionRow(), [name]: null } as InspectionRow;
    expect(() => inspectionView(row)).toThrow();
  });

  it.each(['OK', 'NG', ''])('과거 헤더 enum %s를 PASS로 꾸미지 않는다', (code) => {
    expect(() => inspectionView({ ...inspectionRow(), judgment_code: code })).toThrow();
  });

  it('현재 항목 표시값과 nullable 측정값을 반환한다', () => {
    const row = inspectionRow();
    row.equipment_inspection_result = [lineRow('PASS')];
    expect(inspectionView(row).lines).toEqual([
      {
        inspectionItemId: 5,
        itemName: '현재 항목명',
        judgeMethodCode: 'MEASUREMENT',
        resultCode: 'PASS',
        measuredValue: 12.345678,
        remarks: null,
      },
    ]);
    row.equipment_inspection_result[0].numeric_value = null;
    expect(inspectionView(row).lines[0].measuredValue).toBeNull();
  });

  it.each(['OK', 'NG', ''])('과거 라인 enum %s는 불변식 실패다', (code) => {
    expect(() =>
      inspectionView({ ...inspectionRow(), equipment_inspection_result: [lineRow(code)] }),
    ).toThrow();
  });
});

function lineRow(code: string): InspectionRow['equipment_inspection_result'][number] {
  return {
    equipment_inspection_result_id: 6n,
    equipment_inspection_id: 1n,
    equipment_inspection_item_id: 5n,
    judgment_code: code,
    numeric_value: new Prisma.Decimal('12.345678'),
    text_value: null,
    boolean_value: null,
    remarks: null,
    created_at: new Date(),
    created_by: null,
    equipment_inspection_item: {
      equipment_inspection_item_id: 5n,
      inspection_item_code: 'ITEM',
      inspection_item_name: '현재 항목명',
      data_type_code: 'NUMBER',
      uom_id: null,
      lower_limit: null,
      upper_limit: null,
      is_required: true,
      is_active: true,
      created_at: new Date(),
      created_by: null,
      updated_at: new Date(),
      updated_by: null,
      version_no: 1,
      plant_id: 7n,
      inspection_type_code: 'DAILY',
      judgment_method_code: 'MEASUREMENT',
      inspection_point: null,
      sequence_no: 1,
    },
  };
}
