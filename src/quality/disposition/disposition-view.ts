import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { DispositionFollowUp, POSTED, dispositionFollowUp } from './disposition-rollup';

/** `disposition-query.ts` 의 `SELECT_COLUMNS` 가 내는 원시 행(선례 `lot-status-view.ts`). */
export interface DispositionDecisionRow {
  disposition_decision_id: bigint | number;
  nonconformance_id: bigint | number;
  disposition_type_code: string;
  decision_qty: unknown;
  uom_id: bigint | number;
  reason: string;
  decided_by: bigint | number;
  decided_at: Date;
  approval_request_id: bigint | number | null;
  nonconformance_no: string;
  item_id: bigint | number;
  item_code: string;
  item_name: string;
  decided_by_name: string;
  lot_id: bigint | number | null;
  lot_no: string | null;
  posted_qty: unknown;
}

/** 계약 `DispositionDecision` 과 동형(required 10 / 프로퍼티 18). */
export interface DispositionDecisionView {
  dispositionDecisionId: number;
  nonconformanceId: number;
  nonconformanceNo?: string;
  dispositionTypeCode: string;
  decisionQty: number;
  uomId: number;
  reason: string;
  decidedBy: number;
  decidedAt: string;
  approvalRequestId?: number;
  lotId?: number;
  lotNo?: string;
  itemId?: number;
  itemCode?: string;
  itemName?: string;
  decidedByName?: string;
  followUpStatusCode: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED';
  followUpQty: number;
}

export interface DispositionDecisionRendered {
  view: DispositionDecisionView;
  followUp: DispositionFollowUp;
}

/**
 * ⭐⭐ R-13 널 정책(§1-4-0) — 조인 칸(`itemId`·`itemCode`·`itemName`·`nonconformanceNo`·
 * `decidedByName`)은 널 금지(키 생략) — 물리는 전부 NOT NULL FK 라 오늘은 늘 채워지지만 계약
 * 모양대로 싣는다. `lotId`·`lotNo` 는 `nonconformance_lot` 이 «하나»일 때만(SQL `lotinfo`
 * LATERAL 이 이미 접었다). `approvalRequestId` 는 오늘 언제나 NULL — 키 생략으로 통일한다
 * (§1-3). ⛔ `numeric(20,6)` 은 `Prisma.Decimal` 로 산술하고 값만 마지막에 `.toNumber()`(①a
 * Major-2 선례).
 */
export function dispositionDecisionView(row: DispositionDecisionRow): DispositionDecisionRendered {
  const decisionQty = new Prisma.Decimal(String(row.decision_qty));
  const postedQty = new Prisma.Decimal(String(row.posted_qty ?? 0));
  // SQL 의 `fu` LATERAL 이 이미 POSTED 만 더했다(CANCELLED 는 빠졌다) — 합성 행 «하나」로 넘겨도
  // `dispositionFollowUp()` 안의 `postedQty()` 합과 같은 값이 된다.
  const followUp = dispositionFollowUp(row.disposition_type_code, decisionQty, postedQty.isZero() ? [] : [{ statusCode: POSTED, issueQty: postedQty }]);

  const view: DispositionDecisionView = omitEmpty({
    dispositionDecisionId: Number(row.disposition_decision_id),
    nonconformanceId: Number(row.nonconformance_id),
    nonconformanceNo: row.nonconformance_no ?? undefined,
    dispositionTypeCode: row.disposition_type_code,
    decisionQty: decisionQty.toNumber(),
    uomId: Number(row.uom_id),
    reason: row.reason,
    decidedBy: Number(row.decided_by),
    decidedAt: row.decided_at.toISOString(),
    approvalRequestId: row.approval_request_id === null ? undefined : Number(row.approval_request_id),
    lotId: row.lot_id === null ? undefined : Number(row.lot_id),
    lotNo: row.lot_no ?? undefined,
    itemId: row.item_id === null ? undefined : Number(row.item_id),
    itemCode: row.item_code ?? undefined,
    itemName: row.item_name ?? undefined,
    decidedByName: row.decided_by_name ?? undefined,
    followUpStatusCode: followUp.followUpStatusCode,
    followUpQty: followUp.followUpQty,
  });
  return { view, followUp };
}

/**
 * ⭐⭐ §2 — SQL WHERE(`followUpPending`·`reinstatable`)와 `dispositionFollowUp()` 이 같은 판정을
 * «두 곳»에 낸다(질의 필터가 페이지네이션 «전»이라 함수를 못 부른다). I-20 R-2 가 진 이중화
 * 빚을 여기선 값을 하나로 줄이지 못해 «런타임 대조»로 갚는다 — 같은 페이지 안 모든 행에서
 * 두 판정이 어긋나면 던진다. 증상은 「목록에 떴는데 그 행이 `COMPLETED`」다.
 */
export function assertFollowUpInvariant(filters: { followUpPending?: boolean; reinstatable?: boolean }, rows: readonly DispositionDecisionRendered[]): void {
  for (const { view, followUp } of rows) {
    if (filters.followUpPending !== undefined && followUp.followUpPending !== filters.followUpPending) {
      throw new Error(`disposition-decisions #${view.dispositionDecisionId}: followUpPending 불변식 위반 — SQL=${filters.followUpPending} fn=${followUp.followUpPending}`);
    }
    if (filters.reinstatable !== undefined && followUp.reinstatable !== filters.reinstatable) {
      throw new Error(`disposition-decisions #${view.dispositionDecisionId}: reinstatable 불변식 위반 — SQL=${filters.reinstatable} fn=${followUp.reinstatable}`);
    }
  }
}
