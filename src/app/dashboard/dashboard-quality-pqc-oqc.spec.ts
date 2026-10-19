import { PQC_RECENT_MORE_LIMIT, dailyReturnOut, recentLot, returnReasons } from './dashboard-quality-pqc-oqc';
import { dashboardPeriod } from './dashboard-scope';

describe('dashboard quality PQC·OQC extras', () => {
  it('반품 사유는 수량 큰 순, 같으면 코드 순이고 사유 없는 줄은 끝이다', () => {
    expect(
      returnReasons([
        { reason_code: 'CLAIM', reason_name: '클레임', qty: '5.000000' },
        { reason_code: null, reason_name: null, qty: '5' },
        { reason_code: 'SUPPLIER_RETURN_OUT', reason_name: '공급사반품', qty: '10' },
        { reason_code: 'CUSTOMER_RETURN', reason_name: '고객반품', qty: '5' },
      ]),
    ).toEqual([
      { reasonCode: 'SUPPLIER_RETURN_OUT', reasonName: '공급사반품', qty: 10 },
      { reasonCode: 'CLAIM', reasonName: '클레임', qty: 5 },
      { reasonCode: 'CUSTOMER_RETURN', reasonName: '고객반품', qty: 5 },
      { reasonCode: null, reasonName: null, qty: 5 },
    ]);
  });

  it('일별 공급사 반품 출고는 일별 합격률과 같은 날짜 목록이고, 기록 없는 날은 null 이다', () => {
    const period = dashboardPeriod({ from: '2026-09-20', to: '2026-09-20' });
    const daily = dailyReturnOut([{ local_date: '2026-09-12', qty: '3' }, { local_date: '2026-09-13', qty: '0' }], period);
    expect(daily.map((row) => row.date)).toEqual(period.chartDays);
    expect(daily.slice(0, 3)).toEqual([
      { date: '2026-09-12', qty: 3 },
      { date: '2026-09-13', qty: 0 },
      { date: '2026-09-14', qty: null },
    ]);
  });

  it('PQC 최근 판정 더 보기는 15건까지이고, 기존 recentLots 와 같은 형태(상대 없음)로 옮긴다', () => {
    expect(PQC_RECENT_MORE_LIMIT).toBe(15);
    expect(
      recentLot({
        inspection_result_id: 7n,
        inspected_at: new Date('2026-09-06T03:00:00Z'),
        equipment_code: 'P-1',
        item_code: 'A',
        item_name: 'B',
        lot_no: null,
        qty: '10.000000',
        judgment: 'REJECTED',
      }),
    ).toEqual({
      inspectionResultId: 7,
      inspectedAt: '2026-09-06T03:00:00.000Z',
      counterpartName: null,
      equipmentCode: 'P-1',
      itemCode: 'A',
      itemName: 'B',
      lotNo: null,
      qty: 10,
      judgmentCode: 'REJECTED',
    });
  });
});
