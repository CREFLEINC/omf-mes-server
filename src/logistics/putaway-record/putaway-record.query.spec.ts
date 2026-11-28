import { Prisma } from '@prisma/client';

import { RecordRow, mergeRecords, recordView } from './putaway-record.query';

function row(overrides: Partial<RecordRow>): RecordRow {
  return {
    record_type: 'DIRECT', record_id: 1n, recorded_at: new Date('2026-11-18T05:00:00Z'), mode_code: 'DESIGNATED',
    receipt_type_code: 'MATERIAL', replenishment: false, document_no: 'GR-1', lot_id: 2n, lot_no: 'L-1',
    item_id: 3n, item_code: 'X', item_name: '자재 X', qty: new Prisma.Decimal('10.500000'), uom_code: 'EA',
    quality_status_code: 'NORMAL', warehouse_id: 4n, warehouse_code: 'WH', warehouse_name: '창고', location_id: 5n,
    location_code: 'R1', worker_no: '90901', worker_name: '작업자', terminal_code: 'MOB1', receipt_status_code: 'POSTED',
    ...overrides,
  };
}

describe('putaway-record.query', () => {
  it('US1-1 두 출처를 합쳐 시각 내림차순, 같은 시각은 TASK 먼저·id 내림차순', () => {
    const same = new Date('2026-11-18T05:00:00Z');
    const merged = mergeRecords(
      [row({ record_id: 1n, recorded_at: same }), row({ record_id: 2n, recorded_at: same }), row({ record_id: 9n, recorded_at: new Date('2026-11-18T01:00:00Z') })],
      [row({ record_type: 'TASK', record_id: 1n, recorded_at: same, mode_code: 'COMPLETED' }), row({ record_type: 'TASK', record_id: 3n, recorded_at: new Date('2026-11-18T06:00:00Z'), mode_code: 'COMPLETED' })],
    );
    expect(merged.map((r) => `${r.record_type}:${String(r.record_id)}`)).toEqual(['TASK:3', 'TASK:1', 'DIRECT:2', 'DIRECT:1', 'DIRECT:9']);
  });

  it('US3-1 방식 코드 — 지시 없는 적치는 라인 값, 지시 완료는 TASK·임시 완료는 TASK_TEMPORARY', () => {
    expect(recordView(row({ mode_code: 'UNDESIGNATED' }), 'P').putawayModeCode).toBe('UNDESIGNATED');
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED' }), 'P').putawayModeCode).toBe('TASK');
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED_TEMPORARY' }), 'P').putawayModeCode).toBe('TASK_TEMPORARY');
  });

  it('US3-1 출처 — 보충 수령은 REPLENISHMENT, 제품 입고는 PRODUCT, 그 밖의 입고는 PURCHASE', () => {
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED', replenishment: true, receipt_type_code: null }), 'P').sourceCode).toBe('REPLENISHMENT');
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED', receipt_type_code: 'PRODUCT' }), 'P').sourceCode).toBe('PRODUCT');
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED', receipt_type_code: 'MATERIAL' }), 'P').sourceCode).toBe('PURCHASE');
    expect(recordView(row({}), 'P').sourceCode).toBe('PURCHASE');
  });

  it('US2-4·Q8 반납 입고 줄에서 생긴 지시(피처 019)는 MATERIAL_RETURN', () => {
    expect(recordView(row({ record_type: 'TASK', mode_code: 'COMPLETED', material_return: true, receipt_type_code: null }), 'P').sourceCode).toBe('MATERIAL_RETURN');
  });

  it('US1-1 줄 칸 — 수량은 소수 꼬리 없는 문자열, 경로·작업자·단말·입고 상태', () => {
    expect(recordView(row({ receipt_status_code: null }), 'WH › R1')).toEqual({
      recordType: 'DIRECT', recordId: 1, putawayModeCode: 'DESIGNATED', sourceCode: 'PURCHASE', recordedAt: '2026-11-18T05:00:00.000Z',
      documentNo: 'GR-1', lot: { lotId: 2, lotNo: 'L-1' }, item: { itemId: 3, itemCode: 'X', itemName: '자재 X' }, qty: '10.5', uomCode: 'EA',
      qualityStatusCode: 'NORMAL', warehouse: { warehouseId: 4, warehouseCode: 'WH', warehouseName: '창고' },
      location: { locationId: 5, locationCode: 'R1', path: 'WH › R1' }, worker: { workerNo: '90901', workerName: '작업자' },
      terminalCode: 'MOB1', receiptStatusCode: null,
    });
  });
});
