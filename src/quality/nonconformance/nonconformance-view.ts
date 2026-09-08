import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { ERROR_CODE, field, one } from '../../common/errors';
import { toDateString } from '../../common/master';
import { SOURCE_LOT_SELECT, SourceCode, sourceCodeOf } from './nonconformance-source';

/**
 * ⭐ 계약 `Nonconformance` 는 «목록과 상세가 한 스키마를 공유한다»(계약 본문 명시 — `lots`
 * required 필드 설명). ⇒ **목록도 `lots[]`·`dispositionProgressCode`·`affectedQtyTotal`·
 * `uomId` 를 전건 채운다** — PR ①b(상세) 는 이 매퍼를 재사용해 `get()` 하나만 더한다.
 */
export const NONCONFORMANCE_INCLUDE = {
  nonconformance_lot: {
    orderBy: { nonconformance_lot_id: 'asc' },
    include: { lot: { select: { lot_no: true, ...SOURCE_LOT_SELECT } } },
  },
  disposition_decision: { select: { decision_qty: true } },
  // ⭐ PR 리뷰 Minor-3 — `lots` 가 0행이면 `uomId` 를 고를 데가 없다(DB 는 그 상태를 막지 않는다 —
  //   `minItems:1` 는 등록 API 가드뿐이고 PR ⑥ 이전엔 그 가드조차 없다). 대상 품목의 기준 단위로 접는다.
  item: { select: { base_uom_id: true } },
} satisfies Prisma.nonconformanceInclude;

export type NonconformanceRow = Prisma.nonconformanceGetPayload<{ include: typeof NONCONFORMANCE_INCLUDE }>;

export interface NonconformanceLotView {
  nonconformanceLotId: number;
  lotId: number;
  lotNo?: string;
  affectedQty: number;
  uomId: number;
  qualityStatusBeforeCode: string;
  qualityStatusAfterCode: string;
}

/** 계약 `Nonconformance` 와 동형(required 12 / 프로퍼티 21). */
export interface NonconformanceView {
  nonconformanceId: number;
  nonconformanceNo: string;
  itemId: number;
  workOrderId?: number;
  inspectionResultId: number | null;
  sourceCode: SourceCode;
  severityCode: string;
  description: string;
  responsibleDepartmentId?: number;
  actionDescription?: string;
  actionOwnerId?: number;
  actionDueDate?: string;
  actionCompletedAt?: string;
  statusCode: string;
  openedAt: string;
  closedAt: string | null;
  affectedQtyTotal: number;
  uomId: number;
  dispositionProgressCode: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED';
  lots: NonconformanceLotView[];
}

/**
 * ⭐⭐ **R-13 널 정책**(§1-4-0) — 계약이 널을 못 받는 선택 칸 7(`workOrderId`·
 * `responsibleDepartmentId`·`actionDescription`·`actionOwnerId`·`actionDueDate`·
 * `actionCompletedAt`·`versionNo`)은 `omitEmpty` 로 키를 생략한다. 널을 실을 수 있는 2칸
 * (`inspectionResultId`·`closedAt`)은 명시로 `null` 을 싣는다(생략이 아니다). `versionNo` 는
 * 아예 싣지 않는다 — ETag 전용(공유계약 A-4 · `optimistic-lock.ts:11-16`).
 */
export function nonconformanceView(row: NonconformanceRow): NonconformanceView {
  // ⭐ PR 리뷰 Major-2 — `affected_qty`·`decision_qty` 는 `numeric(20,6)` 이다. `Number()` 로
  // 먼저 접어 더하면 이진 부동소수 오차가 새 required enum(`dispositionProgressCode`)의
  // 「한계와 같은 값」 비교를 실제로 틀리게 만든다(0.1+0.2 !== 0.3). `Prisma.Decimal` 로 정확히
  // 더하고, 응답에 실을 «값»만 마지막에 `.toNumber()` 한다(선례 `inspection-summary.service.ts:136`
  // ·`lot-progress.ts:32-34`).
  const lots = row.nonconformance_lot;
  const affectedQtyTotalDecimal = lots.reduce((sum, lot) => sum.add(lot.affected_qty), new Prisma.Decimal(0));
  const decidedQtyTotalDecimal = row.disposition_decision.reduce((sum, d) => sum.add(d.decision_qty), new Prisma.Decimal(0));
  const affectedQtyTotal = affectedQtyTotalDecimal.toNumber();
  // 등록(PR ⑥· 아직 없음)이 서면 `lots: NonconformanceLotCreate[]` 를 minItems:1 로 강제하고
  // uq_nonconformance_lot 이 중복을 막아 항상 ≥1 행이 되고 단위가 «전부 같기를» 강제된다(§1-3
  // 판정). ⛔ 오늘은 그 가드가 없어 DB 가 0행·단위 혼합을 막지 않는다(PR 리뷰 Major-3·Minor-3)
  // — 0행이면 대상 품목의 기준 단위로 접는다(위 `item` 조인).
  const uomId = lots.length > 0 ? Number(lots[0].uom_id) : Number(row.item.base_uom_id);

  return omitEmpty({
    nonconformanceId: Number(row.nonconformance_id),
    nonconformanceNo: row.nonconformance_no,
    itemId: Number(row.item_id),
    workOrderId: row.work_order_id === null ? undefined : Number(row.work_order_id),
    inspectionResultId: row.inspection_result_id === null ? null : Number(row.inspection_result_id),
    sourceCode: sourceCodeOf(lots),
    severityCode: row.severity_code,
    description: row.description,
    responsibleDepartmentId: row.responsible_department_id === null ? undefined : Number(row.responsible_department_id),
    actionDescription: row.action_description ?? undefined,
    actionOwnerId: row.action_owner_id === null ? undefined : Number(row.action_owner_id),
    actionDueDate: row.action_due_date === null ? undefined : (toDateString(row.action_due_date) ?? undefined),
    actionCompletedAt: row.action_completed_at === null ? undefined : row.action_completed_at.toISOString(),
    statusCode: row.status_code,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at === null ? null : row.closed_at.toISOString(),
    affectedQtyTotal,
    uomId,
    dispositionProgressCode: dispositionProgressCodeOf(decidedQtyTotalDecimal, affectedQtyTotalDecimal),
    lots: lots.map(nonconformanceLotView),
  });
}

function nonconformanceLotView(row: NonconformanceRow['nonconformance_lot'][number]): NonconformanceLotView {
  return omitEmpty({
    nonconformanceLotId: Number(row.nonconformance_lot_id),
    lotId: Number(row.lot_id),
    lotNo: row.lot.lot_no ?? undefined,
    affectedQty: Number(row.affected_qty),
    uomId: Number(row.uom_id),
    qualityStatusBeforeCode: row.quality_status_before_code,
    qualityStatusAfterCode: row.quality_status_after_code,
  });
}

/**
 * §1-4-1 판정 — 결정 0건은 `NOT_STARTED`, 남은 수량 > 0 은 `PARTIAL`, 0 은 `COMPLETED`.
 * ⭐ PR 리뷰 Major-2 — `Prisma.Decimal` 로 비교한다(`Number()` 비교는 소수 합에서 「한계와
 * 같은 값」을 놓친다 — 예: 0.1+0.2 결정에 0.3 을 매기면 `<`로 새 영원히 PARTIAL 이 된다).
 */
function dispositionProgressCodeOf(decidedQtyTotal: Prisma.Decimal, affectedQtyTotal: Prisma.Decimal): 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED' {
  if (decidedQtyTotal.lessThanOrEqualTo(0)) return 'NOT_STARTED';
  return decidedQtyTotal.greaterThanOrEqualTo(affectedQtyTotal) ? 'COMPLETED' : 'PARTIAL';
}

/**
 * 목록 — 기간 갈래 A(§1-2). 설명은 「기간 필수 — 공유계약 L-3」인데 계약이 `required` 도
 * 400 도 선언하지 않았다. 거부 → 허용은 호환 완화(README §2 2단계 기준 2 · I-20 §1-2 갈래 C
 * 선례) ⇒ 400 REQUIRED 로 잠근다. // 결정 — 통보 186
 *
 * ⛔ **Nit-2(PR 리뷰)** — `openedFrom > openedTo` 역전 구간은 계약·계획 둘 다 안 적었다.
 * `openedAtWhere` 가 `gte(from) AND lt(to)` 로 조용히 빈 목록을 낸다(PAIR 400 을 걸지 않는다) —
 * 지금 판단은 정당하다(리뷰 판정). 흔적만 남긴다.
 */
export function assertOpenedPeriodRequired(query: { openedFrom?: string; openedTo?: string }): void {
  if (query.openedFrom !== undefined && query.openedTo !== undefined) return;
  const missing = query.openedFrom === undefined ? 'openedFrom' : 'openedTo';
  throw one(field(missing, ERROR_CODE.REQUIRED, '기간(openedFrom·openedTo)이 필요합니다.'));
}

/** ⛔ 끝 경계는 «미만»이다(반열림 · 공유계약 L-3-1) — `opened_at >= from AND opened_at < to`. */
export function openedAtWhere(from: string, to: string): Prisma.nonconformanceWhereInput {
  return { opened_at: { gte: new Date(from), lt: new Date(to) } };
}
