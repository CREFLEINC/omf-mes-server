import { ContractException } from '../../common/errors';
import { BACKWARD_STAGES, FORWARD_STAGES, periodUnlessPinned, requireEntry, stageCaseSql, stageCounts } from './flow-stage';

const FIELDS = { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' };

describe('LOT 추적 단계', () => {
  it('현재 단계는 가장 멀리 간 단계부터 본다 — 아무것도 없으면 첫 단계', () => {
    expect(stageCaseSql(BACKWARD_STAGES, { PRODUCTION_RECEIVED: 'r', PACKED: 'p', SHIPPED: 's' }))
      .toBe("CASE WHEN s > 0 THEN 'SHIPPED' WHEN p > 0 THEN 'PACKED' WHEN r > 0 THEN 'PRODUCTION_RECEIVED' ELSE 'PRODUCED' END");
    expect(stageCaseSql(FORWARD_STAGES, { CONSUMED: 'c', PRODUCED: 'd', PRODUCTION_RECEIVED: 'r', PACKED: 'p', SHIPPED: 's' }))
      .toMatch(/^CASE WHEN s > 0 THEN 'SHIPPED' .* WHEN c > 0 THEN 'CONSUMED' ELSE 'RECEIVED' END$/);
  });

  it('단계별 건수는 없는 단계도 0 으로 싣는다', () => {
    expect(stageCounts(BACKWARD_STAGES, [{ stage: 'SHIPPED', count: 2n }])).toEqual({ PRODUCED: 0, PRODUCTION_RECEIVED: 0, PACKED: 0, SHIPPED: 2 });
  });

  it('진입점이 하나도 없으면 첫 칸을 짚는 400 REQUIRED — 빈 문자열은 없는 것으로 본다', () => {
    try {
      requireEntry({ q: ' ' }, ['itemId', 'lotNo', 'q'], '품목(itemId) · LOT 번호(lotNo) · LOT 번호 일부(q)');
      throw new Error('던지지 않았다');
    } catch (error) {
      expect((error as ContractException).errors).toEqual([{
        scope: 'field', field: 'itemId', code: 'REQUIRED',
        message: '찾을 대상이 없습니다. 품목(itemId) · LOT 번호(lotNo) · LOT 번호 일부(q) 중 하나를 넣어 다시 조회하세요.',
      }]);
    }
    expect(() => requireEntry({ lotNo: 'L-1' }, ['itemId', 'lotNo'], '')).not.toThrow();
  });

  it('번호로 집었으면 기간은 선택이고, 아니면 시작이 필수다', () => {
    expect(periodUnlessPinned(undefined, undefined, FIELDS, true)).toBeUndefined();
    expect(periodUnlessPinned('2026-10-01', undefined, FIELDS, true, new Date('2026-10-26T00:00:00Z'))).toEqual({ from: '2026-10-01' });
    expect(() => periodUnlessPinned(undefined, undefined, FIELDS, false)).toThrow(ContractException);
  });
});
