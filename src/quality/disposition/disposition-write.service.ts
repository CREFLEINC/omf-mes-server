import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { DocumentStateService } from '../../core/document-state';
import { LotQualityStatusService, Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { assertQtyPrecision } from '../nonconformance/nonconformance-rules';
import { dispositionByIdQuery } from './disposition-query';
import { dispositionProgressCode, remainingSummary } from './disposition-rollup';
import { DispositionDecisionRow, DispositionDecisionView, dispositionDecisionView } from './disposition-view';

/** 계약 `DispositionDecisionCreate` — required 4 · 프로퍼티 4(**전건 필수**). */
export interface DispositionDecisionCreate {
  dispositionTypeCode: string;
  decisionQty: number;
  uomId: number;
  reason: string;
}

/** 계약 `QualityConflictResponse.code` enum 6값 중 이 오퍼레이션이 쓰는 셋. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const INVALID_STATE = 'INVALID_STATE';
const DISPOSITION_QTY_EXCEEDED = 'DISPOSITION_QTY_EXCEEDED';
/**
 * 처분 유형 → LOT 품질 축 전이 액션. 도착 상태·이력 코드는 **전이표가 정본**이다
 * (`transitions.ts` — 재작업 `C17` → `INSPECTION_PENDING` · 폐기 `C18` → `SCRAPPED` ·
 * 정상 `C19` → `NORMAL`). ⛔ `from`·`to`·`transitionCode` 를 여기 베끼지 않는다.
 */
const MOVE_ACTION: Readonly<Record<string, string>> = {
  REWORK: 'disposition-rework',
  SCRAP: 'disposition-scrap',
  NORMAL: 'disposition-normal',
};
/** `lot_status_event.source_document_type_code` — 후속 폐기 출고가 되짚는 값과 같다(`disposition-query.ts:41`). */
const SOURCE_DOCUMENT_TYPE = 'DISPOSITION_DECISION';
const STATUS_COLUMN = 'quality.nonconformance.status_code';
const DECIDED = 'DECIDED';
/** `app.qty_t` 는 `numeric(20,6)` 이라 단위가 그보다 큰 자릿수를 적어도 담기지 않는다. */
const COLUMN_SCALE = 6;

/** 잠금 «안»에서 읽는 부적합 한 행 — 이 셋이 갈래 판정의 전부다. */
interface LockedNonconformance {
  status_code: string;
  version_no: number;
}

/**
 * ⭐⭐ `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` — **심장 B**.
 * 계약이 「⭐ 판정 저장과 Lot Status 전이는 **한 트랜잭션**이다(공유계약 B-8) — 처분만 남고
 * LOT 이 안 바뀌면 **다음 화면이 잘못된 대상을 집는다**」라 이유까지 적었다.
 *
 * ⭐ **잠금 순서가 판정이다** — 잔량 재계수(5)가 부적합 잠금(3) **안**에 있어야 한다. 밖이면
 *    두 사람이 동시에 `remaining=120` 을 읽고 각각 120 을 저장해 합계가 대상을 넘는다.
 *    **If-Match 만으로는 못 막는다** — 둘 다 같은 토큰을 들고 오기 때문이다.
 * ⭐ **잔량 산식을 여기 다시 적지 않는다** — 계약 `DispositionRemainingSummary.x-internal-note`
 *    가 「잔량의 정의는 판정 저장의 내부 주석과 **한 글자도 다르지 않아야 한다**」라 못 박아
 *    `disposition-rollup.ts` 하나를 부른다(조회 셋과 «같은 함수»다).
 * ⛔ `business_date` 를 다루지 않는다 — 이 표에 그 칸이 0개다(C-8 무관).
 */
@Injectable()
export class DispositionWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotQualityStatusService,
  ) {}

  /**
   * 판정 저장 — 201 + ETag(부적합의 **새** `version_no`).
   * ⭐ **갈래 순서가 판정이다**(§3-4): 존재(404) → 본문 형식(400) → 종결(409 `INVALID_STATE`)
   * → 잔량 초과(409 `DISPOSITION_QTY_EXCEEDED`) → 전이 0건(400 `STATE_LOCKED`) → 판 번호
   * (409 `VERSION_CONFLICT` · **트랜잭션 끝**).
   * ⚠ 404·400 도 트랜잭션 «안»이다 — 존재 확인이 곧 잠금이고 잠금이 곧 잔량의 원천 행이라
   *   한 번만 읽으려고 안으로 넣었다(선례 — 같은 슬라이스 `:request-disposition`).
   */
  async create(
    nonconformanceId: number,
    version: number,
    body: DispositionDecisionCreate,
    appUserId: number,
  ): Promise<{ view: DispositionDecisionView; versionNo: number }> {
    const id = BigInt(nonconformanceId);
    const decidedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      // (1)(3) 존재 + 잠금이 한 문장이다 — 0행이 곧 404 다.
      const locked = await lockNonconformance(tx, id);
      const target = await readTarget(tx, id);
      // (2) 본문 형식. ⛔ `decisionQty > 0` 과 `dispositionTypeCode` enum 은 **계약 가드가 이미**
      //     400 을 낸다(R-15) — 여기서 다시 세면 되돌려도 안 깨지는 절이 된다.
      assertShape(body, target);
      // (4) 종결 판정 — 계약 `x-internal-note` 「409 는 둘이다 … 그리고 이미 닫힌 부적합일 때」.
      if (locked.status_code === DECIDED) {
        throw new ConflictException('user', '이미 종결된 부적합이라 판정을 저장할 수 없습니다.', { code: INVALID_STATE });
      }
      // (5) 잔량 판정 — 잠금 «안»이다. 화면이 보는 수와 서버가 거절하는 기준이 «같은 함수»다.
      assertWithinRemaining(body, target);

      // (6) 결정 한 행. ⛔ `decidedBy`·`decidedAt` 은 본문에서 안 받는다 — 서버가 인증 주체와
      //     수신 시각으로 채운다(B-6). `approval_request_id` 는 비운 채 둔다(처분에 결재를 안 건다).
      const decision = await tx.disposition_decision.create({
        data: {
          nonconformance_id: id,
          disposition_type_code: body.dispositionTypeCode,
          decision_qty: new Prisma.Decimal(body.decisionQty),
          uom_id: BigInt(body.uomId),
          reason: body.reason,
          decided_by: BigInt(appUserId),
          decided_at: decidedAt,
        },
        select: { disposition_decision_id: true },
      });

      // (7) LOT 전이 — **이 부적합의 `nonconformance_lot` 전건**을 옮긴다(§0 판정 #2 ⓑ). 부분
      //     처분이면 매 판정마다 돌아 **마지막 판정의 도착 상태가 남는다**(§0 판정 #2 ⓒ).
      await this.moveLots(tx, target.lotIds, body, decision.disposition_decision_id, appUserId, decidedAt);

      // (8) 남은 수량 0 이면 부적합을 종결시킨다 — ⭐ (7) «뒤»다: LOT 이 못 움직이면(전부
      //     `SCRAPPED`) 400 이고 부적합을 종결시키지 않는다.
      const closing = dispositionProgressCode(
        target.decisionCount + 1,
        target.affectedQtyTotal,
        target.decidedQtyTotal.plus(body.decisionQty),
      );
      const decided = closing === 'COMPLETED' ? this.assertDecidable(locked.status_code) : undefined;

      // (9) ⭐ 조건부 UPDATE — **토큰 비교가 여기다**(§3-4 9). 계약이 「판정 저장은
      //     `nonconformance.version_no` 를 올려야 한다 — 올리지 않으면 이 토큰이 경합을 못
      //     잡는다」라 직접 적었다.
      const updated = await tx.nonconformance.updateMany({
        where: { nonconformance_id: id, version_no: version },
        data: {
          version_no: { increment: 1 },
          updated_by: BigInt(appUserId),
          updated_at: decidedAt,
          ...(decided === undefined ? {} : { status_code: decided.to, closed_at: decidedAt }),
        },
      });
      assertUpdated(updated.count, 'user', { code: VERSION_CONFLICT, currentVersion: String(locked.version_no) });

      // (10) 응답은 조회와 «같은 SQL · 같은 매퍼»를 탄다 — 저장 직후 화면이 목록에서 볼 값과
      //      갈리지 않는다(`lotId`·`lotNo` 접기와 후속 롤업이 그 안에 있다).
      const built = dispositionByIdQuery(Number(decision.disposition_decision_id));
      const rows = await tx.$queryRawUnsafe<DispositionDecisionRow[]>(built.sql, ...built.params);
      return { view: dispositionDecisionView(rows[0]).view, versionNo: locked.version_no + 1 };
    });
  }

  /**
   * ⛔ `ctx.transitionCode` 를 **넘기지 않는다** — 전이표가 코드를 가진 자리라 죽은 인자다
   * (넘기면 전이표와 갈릴 수 있는 두 번째 원천이 생긴다).
   * ⭐ 0건이면 400 `STATE_LOCKED` — 코어는 `from` 밖 LOT 을 조용히 건너뛴다(집합 전이 때문).
   * 단건이 아니라 집합이지만 「하나도 못 옮겼다」를 200 으로 내면 처분과 LOT 상태가 갈린다
   * (선례 `inspection-confirm.service.ts` 의 같은 갈래 · 문의 088). 재로드해도 안 풀린다.
   */
  private async moveLots(
    tx: Tx,
    lotIds: bigint[],
    body: DispositionDecisionCreate,
    dispositionDecisionId: bigint,
    appUserId: number,
    decidedAt: Date,
  ): Promise<void> {
    const { movedLotIds } = await this.lots.moveWithin(tx, lotIds, MOVE_ACTION[body.dispositionTypeCode], {
      changedBy: BigInt(appUserId),
      changedAt: decidedAt,
      sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
      sourceDocumentId: dispositionDecisionId,
      reason: body.reason,
    });
    if (movedLotIds.length === 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '지금 LOT 상태에서는 이 처분으로 옮길 수 없습니다.' },
      ]);
    }
  }

  /**
   * ⛔ 코어 `assertTransition` 은 계열 봉투를 모른다 — `code` 없이 409 를 낸다. 품질 계열이 그
   * 칸을 **required** 로 두므로 여기서 씌운다(같은 슬라이스 `:request-disposition` 과 같은 모양).
   * ⚠ `from` 이 `PENDING_DECISION` 하나라 **의뢰를 안 거친 부적합의 «전량» 판정은 409** 다 —
   *    부분 판정은 종결시킬 것이 없어 그대로 통과한다. 전이표가 정본이다(§6-1).
   */
  private assertDecidable(currentStatus: string): { to: string } {
    try {
      return this.documentState.assertTransition(STATUS_COLUMN, 'nonconformance-decide', currentStatus);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      throw new ConflictException('user', error.conflict.message, { code: INVALID_STATE });
    }
  }
}

/** 잔량·전이·단위의 원천 — 잠금 «안»에서 한 번에 읽는다. */
interface DecisionTarget {
  lotIds: bigint[];
  affectedQtyTotal: Prisma.Decimal;
  decidedQtyTotal: Prisma.Decimal;
  decisionCount: number;
  uomId: number;
  uomScale: number;
}

/**
 * ⛔ `SELECT … FOR UPDATE` — 읽고 판정하고 쓰는 사이에 다른 판정이 확정되면 옛 잔량으로
 * 판정한다(선례 `inspection-confirm.service.ts:lockResult`). 0행이 곧 404 다 — 계약이 «이»
 * 오퍼레이션에 404 를 선언했다.
 */
async function lockNonconformance(tx: Tx, id: bigint): Promise<LockedNonconformance> {
  const rows = await tx.$queryRaw<LockedNonconformance[]>`
    SELECT status_code, version_no
      FROM quality.nonconformance
     WHERE nonconformance_id = ${id}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 부적합입니다.');
  return rows[0];
}

/**
 * ⛔ `numeric(20,6)` 을 JS `number` 로 접어 더하지 않는다 — `Prisma.Decimal` 로 더하고 응답에
 * 실을 값만 마지막에 접는다(①a 리뷰 Major-2 · `0.1 + 0.2 !== 0.3`).
 * 단위는 «첫» LOT 것이고 lot 이 0행이면 품목 기준 단위로 접는다 — 조회 둘과 **같은 규칙**이다
 * (`nonconformance-view.ts` · `disposition-by-nonconformance.ts:targetOf`).
 */
async function readTarget(tx: Tx, id: bigint): Promise<DecisionTarget> {
  const nc = await tx.nonconformance.findUniqueOrThrow({
    where: { nonconformance_id: id },
    select: {
      item: { select: { base_uom_id: true } },
      nonconformance_lot: { orderBy: { nonconformance_lot_id: 'asc' }, select: { lot_id: true, affected_qty: true, uom_id: true } },
      disposition_decision: { select: { decision_qty: true } },
    },
  });
  const lots = nc.nonconformance_lot;
  const uomId = lots.length > 0 ? Number(lots[0].uom_id) : Number(nc.item.base_uom_id);
  const uom = await tx.uom.findUniqueOrThrow({ where: { uom_id: BigInt(uomId) }, select: { decimal_scale: true } });
  return {
    lotIds: lots.map((lot) => lot.lot_id),
    affectedQtyTotal: lots.reduce((sum, lot) => sum.add(lot.affected_qty), new Prisma.Decimal(0)),
    decidedQtyTotal: nc.disposition_decision.reduce((sum, row) => sum.add(row.decision_qty), new Prisma.Decimal(0)),
    decisionCount: nc.disposition_decision.length,
    uomId,
    // ⛔ 컬럼 한계로 접는다 — 단위가 7자리를 적어도 `numeric(20,6)` 이 안 담는다(조용한 반올림 금지).
    uomScale: Math.min(uom.decimal_scale, COLUMN_SCALE),
  };
}

/**
 * 본문 형식 — **살아 있는 절 셋**이다.
 * ⓐ 단위는 부적합의 것으로 고정된다(계약 `DispositionRemainingSummary.uomId` 「판정 입력의
 *   단위도 이 값으로 고정한다」) → 400 `INVALID`.
 * ⓑ 스케일 — `mdm.uom.decimal_scale` 을 넘는 자릿수는 400 `RANGE` 다. ⛔ **조용한 반올림
 *   금지**(「120 을 넣었는데 119.999999 가 저장됐다」를 사용자가 못 본다 · §9-1 #16).
 * ⓒ `reason` 이 **공백만**(`" "`)이면 400 `REQUIRED` — `minLength:1` 이 그것을 통과시킨다
 *   (빈 문자열 `""` 은 가드가 `RANGE` 로 막아 **두 갈래의 코드가 다르다** · A-12).
 */
function assertShape(body: DispositionDecisionCreate, target: DecisionTarget): void {
  if (body.uomId !== target.uomId) {
    throw one(field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.'));
  }
  assertQtyPrecision('decisionQty', body.decisionQty, target.uomScale);
  if (body.reason.trim() === '') {
    throw one(field('reason', ERROR_CODE.REQUIRED, '판정 사유를 공백만으로 채울 수 없습니다.'));
  }
}

/**
 * ⭐⭐ 409 `DISPOSITION_QTY_EXCEEDED` + **`remainingQty`·`remainingQtyUomId`**. 계약이 「⛔
 * `message` 자유 텍스트에서 파싱하지 않는다」라 못 박아 구조화 칸으로 내린다(`W-03-10` §6).
 * ⭐ 기준값은 `remainingSummary()` 가 낸 «그 값»이다 — 화면이 「남은 수량 120」으로 보는 수와
 * 서버가 거절하는 기준이 **한 자리에서 나온다**(계약 `x-internal-note` 가 요구한 것).
 */
function assertWithinRemaining(body: DispositionDecisionCreate, target: DecisionTarget): void {
  const summary = remainingSummary(target.affectedQtyTotal, target.decidedQtyTotal, target.uomId);
  if (new Prisma.Decimal(body.decisionQty).lessThanOrEqualTo(summary.remainingQty)) return;
  throw new ConflictException('user', `남은 수량을 넘습니다. (남은 수량 ${summary.remainingQty})`, {
    code: DISPOSITION_QTY_EXCEEDED,
    remainingQty: summary.remainingQty,
    remainingQtyUomId: summary.uomId,
  });
}
