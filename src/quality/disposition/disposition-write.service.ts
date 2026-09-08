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
const QTY_EXCEEDED = 'DISPOSITION_QTY_EXCEEDED';
/** 처분 유형 → 전이 액션. 도착 상태와 이력 코드(C17·C18·C19)는 **전이표가 정본**이다. */
const MOVE_ACTION: Readonly<Record<string, string>> = { REWORK: 'disposition-rework', SCRAP: 'disposition-scrap', NORMAL: 'disposition-normal' };
/** `lot_status_event.source_document_type_code` — 후속 폐기 출고가 되짚는 값이다(`disposition-query.ts:41`). */
const SOURCE_TYPE = 'DISPOSITION_DECISION';
const STATUS_COLUMN = 'quality.nonconformance.status_code';
const DECIDED = 'DECIDED';
/** `numeric(20,6)` 이라 단위가 그보다 큰 자릿수를 적어도 담기지 않는다. */
const COLUMN_SCALE = 6;

/** 잠금 «안»에서 한 번에 읽는 판정의 원천. */
interface Target {
  lotIds: bigint[];
  affectedQtyTotal: Prisma.Decimal;
  decidedQtyTotal: Prisma.Decimal;
  decisionCount: number;
  uomId: number;
  uomScale: number;
}

/**
 * ⭐⭐ `POST …/{nonconformanceId}/disposition-decisions` — **심장 B**. 계약이 「판정 저장과 Lot
 * Status 전이는 **한 트랜잭션**이다(B-8) — 처분만 남고 LOT 이 안 바뀌면 **다음 화면이 잘못된
 * 대상을 집는다**」라 이유까지 적었다.
 * ⭐ **잠금 순서가 판정이다** — 잔량 재계수가 부적합 잠금 «안»이라야 한다. 밖이면 둘이 같은
 *    `remaining` 을 읽어 합계가 대상을 넘고 **If-Match 가 그것을 못 막는다**(같은 토큰이다).
 * ⭐ **잔량 산식을 여기 다시 적지 않는다** — 계약이 「잔량의 정의는 판정 저장의 내부 주석과
 *    **한 글자도 다르지 않아야 한다**」라 못 박아 `disposition-rollup.ts` 를 부른다. 응답도
 *    조회와 «같은 SQL · 같은 매퍼»를 탄다. ⛔ `business_date` 는 이 표에 0칸이다(C-8 무관).
 */
@Injectable()
export class DispositionWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentState: DocumentStateService,
    private readonly lots: LotQualityStatusService,
  ) {}

  /**
   * 201 + ETag(부적합의 **새** `version_no`). ⭐ **갈래 순서가 판정이다**(§3-4): 존재(404) → 본문
   * 형식(400) → 종결(409 `INVALID_STATE`) → 잔량(409 `DISPOSITION_QTY_EXCEEDED`) → 전이 0건
   * (400 `STATE_LOCKED`) → 판 번호(409 `VERSION_CONFLICT` · **트랜잭션 끝**).
   * ⚠ 404·400 도 트랜잭션 «안»이다 — 존재 확인이 곧 잠금이고 그것이 곧 잔량의 원천이라 한 번만
   *   읽는다(선례 — 같은 슬라이스 `:request-disposition`).
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
      const locked = await lockNonconformance(tx, id);
      const target = await readTarget(tx, id);
      // ⛔ `decisionQty > 0` 과 `dispositionTypeCode` enum 은 **계약 가드가 이미** 400 을 낸다(R-15).
      assertShape(body, target);
      // 계약 「409 는 둘이다 — 남은 수량을 넘길 때, 그리고 이미 닫힌 부적합일 때」.
      if (locked.status_code === DECIDED) {
        throw new ConflictException('user', '이미 종결된 부적합이라 판정을 저장할 수 없습니다.', { code: INVALID_STATE });
      }
      assertWithinRemaining(body, target);

      // ⛔ `decidedBy`·`decidedAt` 은 서버가 채운다(B-6). `approval_request_id` 는 비운다(결재 0).
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

      // ⭐ **이 부적합의 `nonconformance_lot` 전건**을 옮긴다. 부분 처분이면 매 판정마다 돌아
      //    **마지막 판정의 도착 상태가 남는다**(§0 판정 #2).
      // ⛔ `ctx.transitionCode` 를 안 넘긴다 — 전이표가 코드를 가진 자리라 죽은 인자다(R-1 ⓑ).
      const { movedLotIds } = await this.lots.moveWithin(tx, target.lotIds, MOVE_ACTION[body.dispositionTypeCode], {
        changedBy: BigInt(appUserId),
        changedAt: decidedAt,
        sourceDocumentTypeCode: SOURCE_TYPE,
        sourceDocumentId: decision.disposition_decision_id,
        reason: body.reason,
      });
      // ⭐ 코어는 `from` 밖 LOT 을 조용히 건너뛴다(집합 전이라 그렇다). 「하나도 못 옮겼다」를
      //    201 로 내면 처분과 LOT 이 갈린다 — 재로드해도 안 풀리므로 400 이다(문의 088 선례).
      if (movedLotIds.length === 0) {
        throw new ContractException(HttpStatus.BAD_REQUEST, [
          { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '지금 LOT 상태에서는 이 처분으로 옮길 수 없습니다.' },
        ]);
      }

      // ⭐ 종결 판정이 전이 «뒤»다 — LOT 이 못 움직이면 부적합을 닫지 않는다. 「남은 수량 0」의
      //    정의도 조회와 한 함수다(계약 `dispositionProgressCode.COMPLETED`).
      const closing = dispositionProgressCode(
        target.decisionCount + 1,
        target.affectedQtyTotal,
        target.decidedQtyTotal.plus(body.decisionQty),
      );
      const decided = closing === 'COMPLETED' ? this.assertDecidable(locked.status_code) : undefined;

      // ⭐ 조건부 UPDATE — **토큰 비교가 여기다**. 계약이 「판정 저장은 `version_no` 를 올려야
      //    한다 — 올리지 않으면 이 토큰이 경합을 못 잡는다」라 직접 적었다.
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

      const built = dispositionByIdQuery(Number(decision.disposition_decision_id));
      const rows = await tx.$queryRawUnsafe<DispositionDecisionRow[]>(built.sql, ...built.params);
      return { view: dispositionDecisionView(rows[0]).view, versionNo: locked.version_no + 1 };
    });
  }

  /**
   * ⛔ 코어 `assertTransition` 은 계열 봉투를 몰라 `code` 없이 409 를 낸다 — 여기서 씌운다.
   * ⚠ `from` 이 `PENDING_DECISION` 하나라 **의뢰를 안 거친 부적합의 «전량» 판정은 409** 다 —
   *   부분 판정은 종결시킬 것이 없어 이 전이를 안 타고 통과한다. 전이표가 정본이다.
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

/** ⛔ `FOR UPDATE` — 그 사이 다른 판정이 확정되면 옛 잔량으로 판정한다. 0행이 곧 404 다. */
async function lockNonconformance(tx: Tx, id: bigint): Promise<{ status_code: string; version_no: number }> {
  const rows = await tx.$queryRaw<{ status_code: string; version_no: number }[]>`
    SELECT status_code, version_no
      FROM quality.nonconformance
     WHERE nonconformance_id = ${id}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 부적합입니다.');
  return rows[0];
}

/**
 * ⛔ `numeric(20,6)` 을 `Number()` 로 접어 더하지 않는다 — `Prisma.Decimal` 로 더한다(`0.1+0.2
 * !== 0.3`). 단위는 «첫» LOT 것이고 0행이면 품목 기준 단위다 — 조회 둘과 **같은 규칙**이다.
 */
async function readTarget(tx: Tx, id: bigint): Promise<Target> {
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
    uomScale: Math.min(uom.decimal_scale, COLUMN_SCALE),
  };
}

/**
 * **살아 있는 절 셋**. ⓐ 단위는 부적합의 것으로 고정된다(계약 「판정 입력의 단위도 이 값으로
 * 고정한다」) ⓑ 스케일 축은 `mdm.uom.decimal_scale` 이다 — ⛔ **조용한 반올림 금지**(§9-1 #16)
 * ⓒ `reason` 이 **공백만**이면 `REQUIRED` — `minLength:1` 이 통과시킨다(빈 문자열은 가드가
 * `RANGE` 로 막아 **두 갈래의 코드가 다르다** · A-12).
 */
function assertShape(body: DispositionDecisionCreate, target: Target): void {
  if (body.uomId !== target.uomId) {
    throw one(field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.'));
  }
  assertQtyPrecision('decisionQty', body.decisionQty, target.uomScale);
  if (body.reason.trim() === '') {
    throw one(field('reason', ERROR_CODE.REQUIRED, '판정 사유를 공백만으로 채울 수 없습니다.'));
  }
}

/**
 * ⭐⭐ 409 + **`remainingQty`·`remainingQtyUomId`** — 계약이 「⛔ `message` 자유 텍스트에서
 * 파싱하지 않는다」라 못 박아 구조화 칸으로 내린다(`W-03-10` §6). ⭐ 기준값이
 * `remainingSummary()` 가 낸 «그 값»이라 화면이 보는 수와 거절 기준이 한 자리에서 나온다.
 */
function assertWithinRemaining(body: DispositionDecisionCreate, target: Target): void {
  const summary = remainingSummary(target.affectedQtyTotal, target.decidedQtyTotal, target.uomId);
  if (new Prisma.Decimal(body.decisionQty).lessThanOrEqualTo(summary.remainingQty)) return;
  throw new ConflictException('user', `남은 수량을 넘습니다. (남은 수량 ${summary.remainingQty})`, {
    code: QTY_EXCEEDED,
    remainingQty: summary.remainingQty,
    remainingQtyUomId: summary.uomId,
  });
}
