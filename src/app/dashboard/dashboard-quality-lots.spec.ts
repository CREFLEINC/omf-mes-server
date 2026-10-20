import { parseQuery } from './dashboard-quality-lots.service';

describe('dashboard quality lots query', () => {
  it('inspectionType 은 INSPECTION_HELD 에만 걸고, 다른 status 에서는 버린다', () => {
    expect(parseQuery({ status: 'INSPECTION_HELD', inspectionType: 'IQC' }).inspectionType).toBe('IQC');
    expect(parseQuery({ status: 'INSPECTION_HELD' }).inspectionType).toBeUndefined();
    expect(parseQuery({ status: 'RECEIPT_HOLD', inspectionType: 'PQC' }).inspectionType).toBeUndefined();
  });

  it('가드가 정수로 바꾼 plantId 를 BigInt 로 옮긴다', () => {
    expect(parseQuery({ status: 'NC_OPEN', plantId: 1001 }).scopeQuery.plantId).toBe(1001n);
    expect(parseQuery({ status: 'NC_OPEN' }).scopeQuery.plantId).toBeUndefined();
  });
});
