import { ContractException } from '../../common/errors';
import { BACKWARD_STAGES, FORWARD_STAGES, periodUnlessPinned, stageCaseSql, stageCounts } from './flow-stage';

const FIELDS = { from: 'receiptDateFrom', to: 'receiptDateTo', label: '입고일' };
const PINS = '자재 LOT 번호(lotNo), 입하 번호(inboundReceiptNo)';

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

  it('기간만 있어도 된다 — 번호로 집지 않아도 그 기간 전체다', () => {
    expect(periodUnlessPinned('2026-10-01', '2026-10-26', FIELDS, false, PINS, '2026-10-26')).toEqual({ from: '2026-10-01', to: '2026-10-26' });
  });

  it('번호로 집었으면 기간은 선택이다', () => {
    expect(periodUnlessPinned(undefined, undefined, FIELDS, true, PINS, '2026-10-26')).toBeUndefined();
    expect(periodUnlessPinned('2026-10-01', undefined, FIELDS, true, PINS, '2026-10-26')).toEqual({ from: '2026-10-01' });
  });

  it('기간도 번호도 없으면 기간 시작 칸을 짚는 400 REQUIRED — 넣을 칸과 기간 상한을 알린다', () => {
    try {
      periodUnlessPinned(undefined, '2026-10-26', FIELDS, false, PINS, '2026-10-26');
      throw new Error('던지지 않았다');
    } catch (error) {
      expect((error as ContractException).errors).toEqual([{
        scope: 'field', field: 'receiptDateFrom', code: 'REQUIRED',
        message: '조회 기간이 없습니다. 입고일 시작(receiptDateFrom)을 넣거나 자재 LOT 번호(lotNo), 입하 번호(inboundReceiptNo) 중 하나를 넣어 다시 조회하세요. 기간은 최대 366일입니다.',
      }]);
    }
  });

  it('기간 검사(종료가 시작보다 앞섬·상한)는 그대로다', () => {
    expect(() => periodUnlessPinned('2026-10-26', '2026-10-01', FIELDS, false, PINS, '2026-10-26')).toThrow(ContractException);
    expect(() => periodUnlessPinned('2025-01-01', '2026-10-26', FIELDS, true, PINS, '2026-10-26')).toThrow(ContractException);
  });
});
