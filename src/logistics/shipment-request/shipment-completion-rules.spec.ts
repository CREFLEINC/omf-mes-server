import { blockerSummary, completionBlockers } from './shipment-completion-rules';

const line = (lineNo: number, allocatedQty: number, pickedQty: number, salesOrderLineCancelled = false) =>
  ({ lineNo, allocatedQty, pickedQty, salesOrderLineCancelled });

describe('completionBlockers — 출하 완료 관문(FR-016)', () => {
  it('US1-3 피킹이 목표 이상이고 LOT 이 모두 합격·검사 불필요·생략이면 막는 이유가 없다', () => {
    expect(completionBlockers({
      completed: false,
      lines: [line(1, 100, 110), line(2, 50, 50)],
      lots: [{ lotNo: 'L1', oqcLotStatus: 'ACCEPTED' }, { lotNo: 'L2', oqcLotStatus: 'NOT_REQUIRED' }, { lotNo: 'L3', oqcLotStatus: 'SKIPPED' }],
    })).toEqual([]);
  });

  it('US1-7·US1-4·US2-5 피킹 부족·미검사·불합격·보류를 라인·LOT 마다 낸다', () => {
    expect(completionBlockers({
      completed: false,
      lines: [line(1, 100, 80), line(2, 50, 50)],
      lots: [{ lotNo: 'L1', oqcLotStatus: 'NOT_INSPECTED' }, { lotNo: 'L2', oqcLotStatus: 'REJECTED' }, { lotNo: 'L3', oqcLotStatus: 'HELD' }],
    })).toEqual([
      { code: 'PICKING_SHORT', lineNo: 1 },
      { code: 'NOT_INSPECTED', lotNo: 'L1' }, { code: 'REJECTED', lotNo: 'L2' }, { code: 'HELD', lotNo: 'L3' },
    ]);
  });

  it('Q21 수주 라인이 취소됐으면 막는다(담당자에게 문의)', () => {
    expect(completionBlockers({ completed: false, lines: [line(1, 10, 10, true)], lots: [{ lotNo: 'L1', oqcLotStatus: 'ACCEPTED' }] }))
      .toEqual([{ code: 'SALES_ORDER_LINE_CANCELLED', lineNo: 1 }]);
  });

  it('US1-6 이미 완료면 그 이유 하나뿐이다 · LOT 이 하나도 없으면 피킹 부족이다', () => {
    expect(completionBlockers({ completed: true, lines: [line(1, 100, 0)], lots: [] })).toEqual([{ code: 'ALREADY_COMPLETED' }]);
    expect(completionBlockers({ completed: false, lines: [line(1, 0, 0)], lots: [] })).toEqual([{ code: 'PICKING_SHORT' }]);
  });

  it('목록 요약은 이유 코드별 수다', () => {
    expect(blockerSummary([{ code: 'NOT_INSPECTED', lotNo: 'a' }, { code: 'NOT_INSPECTED', lotNo: 'b' }, { code: 'PICKING_SHORT', lineNo: 1 }]))
      .toEqual({ NOT_INSPECTED: 2, PICKING_SHORT: 1 });
  });
});
