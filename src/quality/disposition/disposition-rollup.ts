import { Prisma } from '@prisma/client';

/**
 * 처분 롤업 — 순수 판정. 조회 «셋»이 같은 함수를 부른다(§7-1 · 사용처 3): ⓐ `GET
 * /quality/nonconformances/{id}` 의 `dispositionProgressCode` · ⓑ `GET …/{id}/disposition-decisions`
 * 의 `summary` · ⓒ `GET /quality/disposition-decisions` 행마다의 `followUp*`·`reinstatable`.
 *
 * 계약이 「⭐ 서버가 롤업해 낸다(L-2) — ⛔ 화면이 세어 판정하지 않는다」라 적었고,
 * `DispositionRemainingSummary.x-internal-note` 는 「잔량의 정의는 판정 저장의 내부 주석과 **한
 * 글자도 다르지 않아야 한다**」라 못 박았다 ⇒ 산식을 이 파일 하나에 둔다.
 * ⛔ 부동소수로 세지 않는다 — 물리가 전부 `numeric(20,6)` 이라 `320.3 − 200.2` 가
 *    `120.10000000000002` 로 새고 그 값이 그대로 화면의 「남은 수량」이 된다.
 */

/** 계약 `CD-DISPOSITION-PROGRESS` — `dispositionProgressCode`·`followUpStatusCode` 가 같이 쓴다. */
export type DispositionProgressCode = 'NOT_STARTED' | 'PARTIAL' | 'COMPLETED';

/** 계약 `dispositionTypeCode` enum 3값 중 후속 «원천»이 오늘 실재하는 하나(통보 089 §4). */
const SCRAP = 'SCRAP';
const NORMAL = 'NORMAL';
/** `logistics.goods_issue.status_code` 4값 중 원장을 지난 하나. */
const POSTED = 'POSTED';
const ZERO = new Prisma.Decimal(0);

/** 계약 `DispositionRemainingSummary` — required 4 · 프로퍼티 4(전건 필수). */
export interface DispositionRemainingSummary {
  affectedQtyTotal: number;
  decidedQtyTotal: number;
  remainingQty: number;
  uomId: number;
}

/**
 * 잔량의 정의 — 계약 판정 저장 `x-internal-note` 「남은 수량 = `nonconformance_lot.affected_qty` 합
 * − 이 부적합의 `decision_qty` 합」. 409 `DISPOSITION_QTY_EXCEEDED` 의 기준이기도 하다.
 */
function remaining(affectedQtyTotal: Prisma.Decimal, decidedQtyTotal: Prisma.Decimal): Prisma.Decimal {
  return affectedQtyTotal.minus(decidedQtyTotal);
}

export function remainingSummary(
  affectedQtyTotal: Prisma.Decimal,
  decidedQtyTotal: Prisma.Decimal,
  uomId: number,
): DispositionRemainingSummary {
  return {
    affectedQtyTotal: affectedQtyTotal.toNumber(),
    decidedQtyTotal: decidedQtyTotal.toNumber(),
    remainingQty: remaining(affectedQtyTotal, decidedQtyTotal).toNumber(),
    uomId,
  };
}

/**
 * 계약 `Nonconformance.dispositionProgressCode` — 「`NOT_STARTED`=처분 결정 0건 ·
 * `PARTIAL`=결정이 있고 남은 수량 > 0 · `COMPLETED`=남은 수량 0」.
 * ⚠ `statusCode` 와 축이 다르다 — 「판정 대기」 한 값이 앞의 둘을 함께 담아 이 열을 대신 못 한다.
 * ⛔ 「결정 0건」을 잔량으로 대신 보지 않는다 — 결정이 0건이면 잔량이 곧 대상 전량이라
 *    「미판정」이 조용히 「일부 판정」으로 접힌다.
 */
export function dispositionProgressCode(
  decisionCount: number,
  affectedQtyTotal: Prisma.Decimal,
  decidedQtyTotal: Prisma.Decimal,
): DispositionProgressCode {
  if (decisionCount === 0) {
    return 'NOT_STARTED';
  }
  return remaining(affectedQtyTotal, decidedQtyTotal).greaterThan(ZERO) ? 'PARTIAL' : 'COMPLETED';
}

/** 처분 결정에 이어 붙은 폐기 출고 한 줄 — `goods_issue` × `goods_issue_line`. */
export interface FollowUpIssueLine {
  statusCode: string;
  issueQty: Prisma.Decimal;
}

export interface DispositionFollowUp {
  followUpStatusCode: DispositionProgressCode;
  followUpQty: number;
  followUpPending: boolean;
  reinstatable: boolean;
}

/**
 * ⭐⭐ **`status_code = 'POSTED'` 만 센다**(통보 089 §4). `goods_issue.status_code` 는 4값
 * (`REGISTERED`·`POSTED`·`CANCEL_REQUESTED`·`CANCELLED`)이고 취소되거나 아직 전기되지 않은 폐기
 * 출고는 「후속 «처리된» 수량」이 아니다 — 원장을 지난 것만 실제로 나갔다.
 */
function postedQty(lines: FollowUpIssueLine[]): Prisma.Decimal {
  return lines.reduce((sum, line) => (line.statusCode === POSTED ? sum.plus(line.issueQty) : sum), ZERO);
}

/**
 * 후속 진행은 「처리 수량 0」이 축이라 `dispositionProgressCode`(「결정 0건」이 축)와 갈라 둔다.
 * ⭐ `COMPLETED` 는 `>=` — 계약은 「= decisionQty」나 초과 출고가 서면 영영 `PARTIAL` 이다.
 */
function followUpProgress(doneQty: Prisma.Decimal, targetQty: Prisma.Decimal): DispositionProgressCode {
  if (doneQty.isZero()) {
    return 'NOT_STARTED';
  }
  return doneQty.greaterThanOrEqualTo(targetQty) ? 'COMPLETED' : 'PARTIAL';
}

/**
 * 처분 결정 한 건의 후속 4칸. 계약 `x-internal-note` 가 후속 전표를 **폐기=`goods_issue` ·
 * 정상=`stock_transfer` · 재작업=`production_result`** 로 적고 **셋 다 「LOT 축까지만」**이라
 * 스스로 「건별 귀속이 갈리지 않는다」를 남겼다 ⇒ 오늘 결정 축으로 셀 수 있는 것은 폐기뿐이고
 * (`goods_issue.source_document_type_code='DISPOSITION_DECISION'` + `source_document_id`) **정상·
 * 재작업은 `0`/`NOT_STARTED` 고정**이다(통보 089 §4). ⛔ required 라 키를 생략하지 않는다.
 *
 * ⚠ **이것이 공유계약 L-8 과 부딪히는 것을 «알고» 골랐다** — `P-04-03` §3 ④ 가 `followUpQty` 를
 *    상세의 「미처리 수량」으로 그려, 재작업을 다 끝내도 화면에 「미처리 160」이 남는다.
 *    설계팀에 통보 089 §4 로 실었다(ⓐ 0 으로 둔다 / ⓑ 결정 축 칸을 늘린다).
 * ⚠ I-23(레인 C)이 `logistics.stock_reinstatement` 를 세우면 NORMAL 갈래가 «켜진다» — 계약
 *    `StockReinstatementCreate.dispositionDecisionId` 가 required 이고 「서버가 이 값으로
 *    `followUpPending` 을 내린다」라 적었다. 조회 질의 필터도 같은 판정을 SQL 로 다시 적는다.
 */
export function dispositionFollowUp(
  dispositionTypeCode: string,
  decisionQty: Prisma.Decimal,
  issueLines: FollowUpIssueLine[],
): DispositionFollowUp {
  const followUpQty = dispositionTypeCode === SCRAP ? postedQty(issueLines) : ZERO;
  const followUpStatusCode = followUpProgress(followUpQty, decisionQty);
  return {
    followUpStatusCode,
    followUpQty: followUpQty.toNumber(),
    // ⭐ 「후속 «원천»이 있는 유형만」 = SCRAP 축에서만 참이다(통보 089 §4). 계약이 이 필터를
    // 「처리한 건이 계속 남으면 **같은 건을 두 번 처리한다**」로 정의했다 ⇒ 원천이 0인
    // REWORK·NORMAL 을 참으로 두면 `W-04-11` 이 재등록 끝난 LOT 을 계속 집는다. ⛔ 그 대가로
    // `W-04-11` 의 진입은 이 필터로 비고, 그 화면의 축은 `reinstatable` 이다.
    followUpPending: dispositionTypeCode === SCRAP && followUpStatusCode !== 'COMPLETED',
    // ⭐ 계약은 「정상이거나, 재작업이고 그 재작업이 «끝난» 것」이라 적었으나 **뒤 갈래는 오늘
    // 언제나 거짓**이다 — 재작업 후속(`production_result`)에 결정 축이 없어 REWORK 는 위에서 늘
    // `NOT_STARTED` 로 굳는다. 닿을 수 없는 절은 되돌려도 안 깨져(R-15) `NORMAL` 하나로 접었다
    // (089 §4 #4).
    reinstatable: dispositionTypeCode === NORMAL,
  };
}
