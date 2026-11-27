import { Prisma } from '@prisma/client';

import { ATTRIBUTION } from './material-return.constants';
import { IssueCandidate, attributionOf, latestWorkOrderIssues, returnableQty } from './return-attribution';

const D = (value: number) => new Prisma.Decimal(value);

function candidate(over: Partial<IssueCandidate> & Pick<IssueCandidate, 'goodsIssueLineId'>): IssueCandidate {
  return {
    lotId: 1n, issuedAt: new Date('2026-11-27T01:00:00Z'), issueQty: D(120), uomId: 9n,
    issueStatusCode: 'POSTED', cancelled: false, requestTypeCode: 'WORK_ORDER',
    workOrderId: 10n, workOrderNo: 'WO-10', sourceWarehouseId: 5n, destinationLocationId: null,
    ...over,
  };
}

describe('반납 귀속 규칙(피처 019 R-2)', () => {
  describe('FR-010 가장 최근 W/O 출고 라인', () => {
    it('FR-010 LOT 마다 출고 시각이 가장 늦은 W/O 출고 라인을 고른다', () => {
      const latest = latestWorkOrderIssues([
        candidate({ goodsIssueLineId: 1n, issuedAt: new Date('2026-11-27T01:00:00Z'), workOrderId: 10n }),
        candidate({ goodsIssueLineId: 2n, issuedAt: new Date('2026-11-27T05:00:00Z'), workOrderId: 12n }),
        candidate({ goodsIssueLineId: 3n, lotId: 2n, workOrderId: 11n }),
      ]);
      expect(latest.get(1n)?.goodsIssueLineId).toBe(2n);
      expect(latest.get(1n)?.workOrderId).toBe(12n);
      expect(latest.get(2n)?.workOrderId).toBe(11n);
    });

    it('FR-010 출고 시각이 같으면 라인 id 가 늦은 것이다', () => {
      const latest = latestWorkOrderIssues([
        candidate({ goodsIssueLineId: 7n, workOrderId: 12n }),
        candidate({ goodsIssueLineId: 4n, workOrderId: 10n }),
      ]);
      expect(latest.get(1n)?.goodsIssueLineId).toBe(7n);
    });

    it('FR-010 취소된 출고·전기 전 출고는 빼고 그 앞의 W/O 출고가 남는다', () => {
      const latest = latestWorkOrderIssues([
        candidate({ goodsIssueLineId: 1n, workOrderId: 10n }),
        candidate({ goodsIssueLineId: 2n, issuedAt: new Date('2026-11-28T00:00:00Z'), workOrderId: 12n, cancelled: true }),
        candidate({ goodsIssueLineId: 3n, issuedAt: new Date('2026-11-28T01:00:00Z'), workOrderId: 13n, issueStatusCode: 'REGISTERED' }),
      ]);
      expect(latest.get(1n)?.workOrderId).toBe(10n);
    });

    it('FR-010 W/O 경로가 아닌 출고(보충 이동·피킹 없는 출고)는 무시한다', () => {
      const latest = latestWorkOrderIssues([
        candidate({ goodsIssueLineId: 1n, workOrderId: 10n }),
        candidate({ goodsIssueLineId: 2n, issuedAt: new Date('2026-11-28T00:00:00Z'), requestTypeCode: 'REPLENISHMENT', workOrderId: null }),
        candidate({ goodsIssueLineId: 3n, issuedAt: new Date('2026-11-28T01:00:00Z'), requestTypeCode: null, workOrderId: null }),
      ]);
      expect(latest.get(1n)?.goodsIssueLineId).toBe(1n);
    });

    it('FR-003 W/O 출고 이력이 없는 LOT 은 결과에 없다', () => {
      const latest = latestWorkOrderIssues([candidate({ goodsIssueLineId: 1n, requestTypeCode: 'REPLENISHMENT', workOrderId: null })]);
      expect(latest.has(1n)).toBe(false);
    });
  });

  describe('FR-003 반납 가능 양', () => {
    it('FR-003 출고 라인 수량 − 그 라인에 귀속된 반납 합', () => {
      expect(returnableQty(D(120), D(20)).toNumber()).toBe(100);
      expect(returnableQty(D(120), undefined).toNumber()).toBe(120);
    });

    it('FR-003 0 아래로 내려가지 않는다', () => {
      expect(returnableQty(D(120), D(130)).toNumber()).toBe(0);
    });
  });

  describe('FR-011 귀속', () => {
    it('FR-010 최종 마감이 아니면 그 W/O 에 자동 귀속(AUTO_LATEST_ISSUE)', () => {
      expect(attributionOf(10n, false, false)).toEqual({ workOrderId: 10n, attributionCode: ATTRIBUTION.AUTO_LATEST_ISSUE });
    });

    it('FR-016 W/O 로 찾기로 고른 줄은 WORK_ORDER_PICKED', () => {
      expect(attributionOf(10n, false, true)).toEqual({ workOrderId: 10n, attributionCode: ATTRIBUTION.WORK_ORDER_PICKED });
    });

    it('FR-011 그 W/O 가 최종 마감이면 귀속 없음(NONE_FINALIZED · W/O null) — 고른 줄도 같다', () => {
      expect(attributionOf(10n, true, false)).toEqual({ workOrderId: null, attributionCode: ATTRIBUTION.NONE_FINALIZED });
      expect(attributionOf(10n, true, true)).toEqual({ workOrderId: null, attributionCode: ATTRIBUTION.NONE_FINALIZED });
    });
  });
});
