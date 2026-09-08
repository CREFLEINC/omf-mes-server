import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertCodeValues, optional } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { LockedLot, LotHoldInput, LotHoldService, LotQualityStatusService, Tx } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import {
  HOLD_REASON_GROUP,
  HOLD_RELEASE_REASON_GROUP,
  HOLD_SOURCE_DOCUMENT_TYPE,
  LOT_STATUS_GROUP,
  LotHoldCreate,
  LotHoldRelease,
  assertHoldCreateShape,
  assertHoldReleaseShape,
} from './lot-hold-rules';
import { LotHoldView, lotHoldView } from './lot-hold-view';

/** 계약 `QualityConflictResponse.code` enum 6값 중 이 오퍼레이션이 쓰는 셋. */
const VERSION_CONFLICT = 'VERSION_CONFLICT';
const DUPLICATE_HOLD = 'DUPLICATE_HOLD';
const HOLD_QTY_EXCEEDED = 'HOLD_QTY_EXCEEDED';

/**
 * ⭐⭐ `POST /quality/lot-holds` — 의심자재 등록(C10)과 클레임·리콜 재Hold(C9)를 한 경로로 받는다.
 *
 * **심장이다.** 원장은 지나지 않지만 `lot_hold` INSERT · `lot.status_code` 이동 ·
 * `lot_status_event` 가 **한 트랜잭션**이다(공유계약 B-8 · 계약 `:1845` — 「하나만 되면 재고가
 * 안 막히거나 **막힌 이유가 없다**」).
 *
 * ⭐ **순서 판정 셋**(§3-1 — 뒤집으면 안 된다)은 아래 (b)·(e)·(f) 자리에 각각 적었다.
 *
 * ⛔ 헤더 `If-Match` 를 쓰지 않는 유일한 쓰기다 — 「여러 LOT 을 한 트랜잭션으로 걸어 토큰이
 *    여럿이다. `lots[].versionNo` 로 싣고 하나라도 어긋나면 전체를 거부한다」(계약 `:4091`).
 *    잠그는 대상은 **`trace.lot.version_no`** 다(R-24).
 * ⛔ `trace.lot_hold` 를 직접 쓰지 않는다 — 쓰기와 잠금은 코어(`LotHoldService`)가 진다
 *    (`server-architecture.md:67`). `LockedLot` 표식이 잠금 누락을 컴파일에서 막는다.
 * ⛔ `inventory_balance.blocked_qty` 를 안 건드린다 — 잔액은 서버가 파생한다(계약 `:1845`).
 */
@Injectable()
export class LotHoldWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: LotHoldService,
    private readonly lots: LotQualityStatusService,
  ) {}

  async create(body: LotHoldCreate, appUserId: number): Promise<LotHoldView[]> {
    // (0) 값 목록 대조는 트랜잭션 «밖»이다 — 코드 표를 읽는 커넥션을 업무 tx 가 쥐지 않는다.
    await assertCodeValues(this.prisma, [
      { field: 'reasonCode', value: body.reasonCode, groupCode: HOLD_REASON_GROUP },
      { field: 'targetLotStatusCode', value: body.targetLotStatusCode, groupCode: LOT_STATUS_GROUP },
    ]);
    // (1) 본문 형식 — 여기서 400 갈래 여섯이 갈린다(중복 `lotId` 포함 · §12-1 ⓑ).
    const action = assertHoldCreateShape(body);

    const lotIds = body.lots.map((ref) => BigInt(ref.lotId));
    // `held_at`·`lot_status_event.changed_at` 이 한 시각을 나눠 쓴다.
    const actor = { by: BigInt(appUserId), at: new Date() };

    return this.prisma.$transaction(async (tx) => {
      // (a) ⭐⭐ 잠금이 먼저다 — 읽고 판정하고 쓰는 사이에 다른 등록·해제가 끼어들면 옛
      //     상태로 판정한다(R-5). 한 문장에 `lot_id` 오름차순이라 교착이 없다.
      const locked = await this.holds.lockLotsWithin(tx, lotIds);
      // ⚠ 「행수」로 404 를 판정할 수 있는 것은 §12-1 ⓑ(중복 `lotId`)를 «위에서» 400 으로
      //   막았기 때문이다 — `WHERE lot_id IN (1,1)` 은 한 행이라 그것 없이는 없는 LOT 이
      //   아닌데 404 가 난다. 계약이 이 오퍼레이션에 404 를 «선언했다»(400 이 아니다).
      if (locked.length !== lotIds.length) throw new NotFoundException('없는 LOT 이 섞여 있습니다.');
      // (b) 버전 → (c) 열린 전량 보류 → (d) 수량 합계. 이 순서가 판정 1 이다.
      assertVersions(body, new Map(locked.map((lot) => [lot.lot_id, lot])));
      await assertNoOpenFullHold(tx, lotIds);
      await assertHoldQtyWithinOnHand(tx, body, lotIds[0]);

      // (e) 보류 INSERT — 반환 순서가 입력 순서다(코어 규약).
      const rows = await this.holds.holdWithin(tx, locked, holdInputsOf(body), actor);
      // (f) 전이. ⭐ **R-12** — LOT 마다 «자기» `lot_hold_id` 를 가리킨다. 배치 한 칸
      //     (`sourceDocumentId`)으로는 첫 것밖에 못 담아 나머지 LOT 의 이력이 남의 문서를 가리킨다.
      const { skippedLotIds } = await this.lots.moveWithin(tx, lotIds, action, {
        changedBy: actor.by,
        changedAt: actor.at,
        sourceDocumentTypeCode: HOLD_SOURCE_DOCUMENT_TYPE,
        sourceDocumentIdByLot: new Map(rows.map((row) => [row.lot_id, row.lot_hold_id])),
        reasonCode: body.reasonCode,
      });
      if (skippedLotIds.length > 0) throw stateLocked(skippedLotIds);

      // (g) 재조회 — 응답은 조회와 «같은 매퍼»를 탄다.
      return rereadViews(tx, rows.map((row) => row.lot_hold_id));
    });
  }

  /**
   * ⭐⭐ `POST /quality/lot-holds/{lotHoldId}:release` — 보류 해제·재판정(C7·C8). **심장 B**.
   *
   * ⭐⭐ **If-Match 토큰은 `trace.lot.version_no` 다**(R-24 · 계약 `:1950`·`:2058` — 「If-Match 는
   *    `lot_hold` 가 아니라 `trace.lot` 의 `version_no` 다 — `lot_hold` 에는 `version_no` 가 없다
   *    (기록 전용). B-8 로 한 트랜잭션이라 lot 의 토큰이 이 오퍼레이션의 토큰이다」).
   *    ⛔ `lot_hold.version_no` 를 읽지도 쓰지도 않는다 — 읽는 코드 0줄인 죽은 칸이고 다음
   *    릴리스의 삭제 후보다(`CLAUDE.md` 두 릴리스 규칙).
   * ⭐ 그 필연으로 **LOT 이 «안 움직인» 해제는 ETag 가 안 오른다** — 같은 토큰으로 다음 해제를
   *    바로 보낼 수 있다. (g)가 LOT 을 «다시 읽어» 그 값을 내므로 두 갈래가 갈리지 않는다.
   */
  async release(
    lotHoldId: number,
    version: number,
    body: LotHoldRelease,
    appUserId: number,
  ): Promise<{ view: LotHoldView; versionNo: number }> {
    // (0) 값 목록 대조는 트랜잭션 «밖»이다 — 코드 표를 읽는 커넥션을 업무 tx 가 쥐지 않는다.
    await assertCodeValues(this.prisma, [
      { field: 'releaseReasonCode', value: body.releaseReasonCode, groupCode: HOLD_RELEASE_REASON_GROUP },
      { field: 'targetLotStatusCode', value: body.targetLotStatusCode, groupCode: LOT_STATUS_GROUP },
    ]);
    // (1) 본문 형식 — 도착 상태 두 값(INVALID) · releaseQty > 0(RANGE).
    const action = assertHoldReleaseShape(body);

    const holdId = BigInt(lotHoldId);
    // `released_at`·`lot_status_event.changed_at`·잔량 행의 `held_at` 이 한 시각을 나눠 쓴다.
    const actor = { by: BigInt(appUserId), at: new Date() };

    return this.prisma.$transaction(async (tx) => {
      // (a) ⭐⭐ 잠금 대상은 **보류가 아니라 LOT** 이다(R-5). `lot_id` 를 알려면 먼저 읽어야 하는데,
      //     그 칸은 안 바뀌므로 잠금 «전» 읽기로 충분하다. ⛔ `lot_hold` 를 먼저 `FOR UPDATE` 로
      //     잡으면 코어(잠금 → `lot_hold` UPDATE)와 «반대» 순서라 교착한다.
      const found = await tx.lot_hold.findUnique({ where: { lot_hold_id: holdId }, select: { lot_id: true } });
      if (found === null) throw new NotFoundException('없는 보류입니다.');
      const locked = await this.holds.lockLotsWithin(tx, [found.lot_id]);
      const lot = locked[0];
      // (b) ⭐ 버전 대조가 (c) 「이미 해제됨」보다 «먼저»다 — 낡은 토큰으로 이미 해제된 보류를
      //     건드리면 「다시 불러오라」가 먼저 나와야 한다(0단계 선례 `:confirm`).
      if (lot.version_no !== version) {
        assertUpdated(0, 'user', {
          code: VERSION_CONFLICT,
          currentVersion: String(lot.version_no),
          currentLotStatusCode: lot.status_code,
        });
      }
      // 잠근 «뒤에» 다시 읽는다 — (a)의 읽기는 잠금 밖이라 그 사이 다른 해제가 닫았을 수 있다.
      const hold = await tx.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: holdId } });
      // (c) ⭐ **400 `STATE_LOCKED` 다 — 409 가 «아니다»**(§3-3 ⑦ · 공유계약 G-1: 재로드해도
      //     안 풀린다). `:confirm` 이 먼저 닫았을 수 있다(§0 #2 ⓐ).
      if (hold.released_at !== null) throw releaseStateLocked('이미 해제된 보류입니다.');
      // (d) 부분 해제와 저장된 수량의 관계 — 여기서만 볼 수 있다(행을 읽어야 안다).
      const releaseQty = assertReleasableQty(body.releaseQty, hold.hold_qty);

      // ⭐ **R-2** — `release_target_lot_status_code` 는 «실제로 보낸» 도착만 담는다. 코어가 그 칸을
      //   선택으로 열어 두었으므로 **쓰기 전에** LOT 이 움직일지 정해야 한다: ⓐ 이 보류 말고 열린
      //   보류가 없고 ⓑ 이 해제가 잔량 행을 안 남긴다(R-6 — `releaseQty == hold_qty` 는 잔량이 없다).
      //   요청값을 그냥 넣으면 부분 해제 때 `W-03-01` 이력의 「전이」 열에 「보류 → 정상」이 «거짓»으로 그려진다.
      const others = await tx.lot_hold.count({
        where: { lot_id: hold.lot_id, released_at: null, lot_hold_id: { not: holdId } },
      });
      const willMove = others === 0 && (releaseQty === undefined || hold.hold_qty === null || !releaseQty.lessThan(hold.hold_qty));

      // (e) ⭐ 코어가 닫고·잔량을 세우고·열린 보류를 «다시 센다»(재계수가 잠금 안이어야 한다 — R-5).
      //     ⛔ `lotHoldIds` 로 좁힌다 — 안 좁히면 그 LOT 의 «열린 보류 전건»이 닫히고
      //        `openAfter` 가 0 이 되어 불량 자재가 `NORMAL` 로 풀린다.
      const { openAfter } = await this.holds.releaseWithin(
        tx,
        locked,
        { lotId: hold.lot_id, lotHoldIds: [holdId] },
        {
          releaseReasonCode: body.releaseReasonCode,
          ...(willMove ? { releaseTargetLotStatusCode: body.targetLotStatusCode } : {}),
          ...optional('remarks', body.remarks),
          ...(releaseQty === undefined ? {} : { releaseQty }),
        },
        actor,
      );
      // 잠금 안이라 둘은 어긋날 수 없다 — 어긋나면 위 예측이 코어의 잔량 규칙과 갈린 것이다.
      if (willMove !== (openAfter === 0)) {
        throw new Error(`R-2 예측이 코어 재계수와 어긋났다: willMove=${willMove} openAfter=${openAfter}`);
      }
      // (f) ⭐⭐ **열린 보류가 0 일 때만** LOT 을 옮긴다. 부분 해제는 잔량 행이 서서 언제나 ≥1 이라
      //     **LOT 을 절대 안 옮긴다 — 그래도 200 이다**(400 이 아니다 · 0단계 선례 `:confirm` R-11).
      if (openAfter === 0) {
        const { movedLotIds } = await this.lots.moveWithin(tx, [hold.lot_id], action, {
          changedBy: actor.by,
          changedAt: actor.at,
          sourceDocumentTypeCode: HOLD_SOURCE_DOCUMENT_TYPE,
          sourceDocumentId: holdId,
          reasonCode: body.releaseReasonCode,
        });
        // ⚠ // 결정 — 통보 071 — C7·C8 의 `from` 이 `['INSPECTION_PENDING']` 하나라(`transitions.ts:206-209`)
        //   C9(클레임·리콜 재Hold)로 `DEFECTIVE` 에 간 LOT 의 보류는 **영영 못 푼다**. ⛔ `transitions.ts`
        //   를 안 고친다 — 「불량은 발신 전이가 0」(계약 `:4472`)의 형제 필연이고 레인 B·C 와 같은 파일이다.
        if (movedLotIds.length === 0) throw releaseStateLocked('지금 LOT 상태에서는 이 보류를 해제할 수 없습니다.');
      }
      // (g) 재조회 — 응답도 ETag 도 **LOT 을 다시 읽어** 낸다(안 움직였으면 토큰이 그대로다).
      const row = await tx.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: holdId }, include: { lot: true } });
      return { view: lotHoldView(row), versionNo: row.lot.version_no };
    });
  }
}

/**
 * §3-2 (d) — 부분 해제가 저장된 수량과 맞는지. **트랜잭션 안이다**(행을 읽어야 안다).
 * ⛔ 전량 보류(`hold_qty IS NULL`)에 `releaseQty` 는 `INVALID` 다 — 뺄 원본이 없다.
 * ⛔ 초과는 `RANGE` 다(형식이 아니라 «범위»가 틀렸다). ⭐ **「한계와 같은 값」은 통과다** —
 *    `>` 이지 `>=` 가 아니다. 그때 잔량이 0 이라 코어가 행을 «안 만들고»(R-6) LOT 이 움직인다.
 */
function assertReleasableQty(releaseQty: number | undefined, holdQty: Prisma.Decimal | null): Prisma.Decimal | undefined {
  if (releaseQty === undefined) return undefined;
  if (holdQty === null) {
    throw one(field('releaseQty', ERROR_CODE.INVALID, '전량 보류는 부분 해제할 수 없습니다.'));
  }
  const qty = new Prisma.Decimal(releaseQty);
  if (qty.greaterThan(holdQty)) {
    throw one(field('releaseQty', ERROR_CODE.RANGE, '해제 수량이 보류 수량을 넘습니다.'));
  }
  return qty;
}

/**
 * ⚠ **R-3 — 400/409 를 단정하지 않는다.** 계약 `:4589` 가 「03 은 업무 사유 거부를 409 로
 * 말한다 … 어느 쪽이 정본인지는 **횡단 단일안 소관**」이라 스스로 미결로 적었다. §3-3 표가
 * ⑦⑧(이미 해제됨 · 전이 0건)을 **400 `STATE_LOCKED`** 로 판정한 근거는 공유계약 G-1 —
 * 「재로드해도 안 풀린다」이고, 409 인 셋(`VERSION_CONFLICT`·`DUPLICATE_HOLD`·
 * `HOLD_QTY_EXCEEDED`)은 계약이 **409 봉투 enum 에 직접 넣어** 답을 줬다.
 * // 설계 미정 — 통보 071
 */
function releaseStateLocked(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message },
  ]);
}

/**
 * ⭐ **판정 1** — 버전 대조가 업무 게이트(409 둘)보다 먼저다. 0단계 선례
 * `inspection-confirm.service.ts`(「버전 대조가 상태 게이트보다 먼저다」).
 * ⭐ **판정 3** — 하나라도 어긋나면 «전체» 거부다. 그 한 건을 화면이 짚을 축이
 * `conflictingLotId` 뿐이라(계약 `QualityConflictResponse` · `W-03-03` §6) 함께 싣는다.
 */
function assertVersions(body: LotHoldCreate, byLot: ReadonlyMap<bigint, LockedLot>): void {
  for (const ref of body.lots) {
    const lot = byLot.get(BigInt(ref.lotId));
    if (lot === undefined || lot.version_no === ref.versionNo) continue;
    assertUpdated(0, 'user', {
      code: VERSION_CONFLICT,
      currentVersion: String(lot.version_no),
      currentLotStatusCode: lot.status_code,
      conflictingLotId: ref.lotId,
    });
  }
}

/**
 * 「해제되지 않은 **전량** 보류가 이미 있다」(계약 `:4538`). ⛔ 부분 보류의 중복은 막지 않는다 —
 * 그쪽은 수량 합계가 아래에서 걸린다. `lot_hold` 에 UNIQUE 가 0개라 서버가 판정한다(`W-03-03` §5-5).
 * ⛔ 판정은 `status_code` 가 아니라 **`released_at IS NULL`** 로만 한다(문의 13 — 시드 0건).
 */
async function assertNoOpenFullHold(tx: Tx, lotIds: bigint[]): Promise<void> {
  const duplicate = await tx.lot_hold.findFirst({
    where: { lot_id: { in: lotIds }, hold_qty: null, released_at: null },
    select: { lot_id: true },
    orderBy: { lot_hold_id: 'asc' },
  });
  if (duplicate === null) return;
  throw new ConflictException('user', '이미 열려 있는 전량 보류가 있습니다.', {
    code: DUPLICATE_HOLD,
    conflictingLotId: Number(duplicate.lot_id),
  });
}

/**
 * 부분 보류 합계가 보유 수량을 넘으면 409. ⭐ **`holdQty` 는 LOT 한 건에서만 온다** —
 * 2건 이상은 위에서 400 `INVALID` 라 여기 오는 `lots` 는 언제나 하나다.
 *
 * ⭐ **「한계와 같은 값」은 통과다** — `>` 이지 `>=` 가 아니다(기존 500 + 신규 3,500 = 보유 4,000).
 * ⛔ 「보유」는 `inventory_balance.on_hand_qty` 의 LOT 축 합이고 `blocked_qty`·`available_qty`
 *    (GENERATED)는 안 본다 — 계약이 두 자리에서 못 박았다(`:1845`·`:4299`). // 결정 — 통보 076
 */
async function assertHoldQtyWithinOnHand(tx: Tx, body: LotHoldCreate, lotId: bigint): Promise<void> {
  if (body.holdQty === undefined) return;
  const balance = await tx.inventory_balance.aggregate({ _sum: { on_hand_qty: true }, where: { lot_id: lotId } });
  const open = await tx.lot_hold.aggregate({ _sum: { hold_qty: true }, where: { lot_id: lotId, released_at: null } });
  const held = (open._sum.hold_qty ?? new Prisma.Decimal(0)).plus(body.holdQty);
  if (!held.greaterThan(balance._sum.on_hand_qty ?? 0)) return;
  throw new ConflictException('user', '보류 수량 합계가 보유 수량을 넘습니다.', {
    code: HOLD_QTY_EXCEEDED,
    conflictingLotId: Number(lotId),
  });
}

/** 계약 `LotHoldCreate` 의 칸이 LOT 마다 같은 값으로 실린다 — `lots[]` 는 LOT 참조뿐이다. */
function holdInputsOf(body: LotHoldCreate): LotHoldInput[] {
  return body.lots.map((ref) => ({
    lotId: BigInt(ref.lotId),
    reasonCode: body.reasonCode,
    // ⛔ NULL 이 «전량 보류»다 — 0 이 아니다(열린 전량 판정이 `hold_qty IS NULL`).
    holdQty: body.holdQty === undefined ? null : new Prisma.Decimal(body.holdQty),
    uomId: body.uomId === undefined ? null : BigInt(body.uomId),
    releaseCondition: body.releaseCondition ?? null,
    // A12 ⓐ — 「이 보류가 걸었을 때 LOT 이 간 상태」(계약 `LotHold.lotStatusCode` · `:4035`).
    targetLotStatusCode: body.targetLotStatusCode,
    remarks: body.remarks ?? null,
  }));
}

/**
 * 전이가 0건 옮긴 LOT 이 하나라도 있으면 **전체 롤백**이다(판정 3).
 *
 * ⚠ // 결정 — 통보 080. C9(`lot-hold-claim`)의 `from` 이 `['NORMAL']` **하나**라
 * (`transitions.ts:210`) 검사 대기(`INSPECTION_PENDING`) LOT 에는 클레임·리콜 재Hold 를
 * 영영 못 건다. 「불량은 발신 전이가 0」(계약 `:4472`)의 형제 필연이고, 전이표를 고치는 것은
 * 이 PR 범위 밖이다(§5 무변경 · 레인 B·C 와 같은 파일).
 */
function stateLocked(skippedLotIds: bigint[]): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    {
      scope: 'screen',
      code: ERROR_CODE.STATE_LOCKED,
      message: `지금 LOT 상태에서는 이 보류를 걸 수 없습니다. (LOT ${skippedLotIds.join(', ')})`,
    },
  ]);
}

/** 반환 순서 = 입력 순서 — 화면이 보낸 `lots[]` 와 나란히 읽는다(계약 201 본문이 «배열»이다). */
async function rereadViews(tx: Tx, lotHoldIds: bigint[]): Promise<LotHoldView[]> {
  const views: LotHoldView[] = [];
  for (const lotHoldId of lotHoldIds) {
    const row = await tx.lot_hold.findUniqueOrThrow({ where: { lot_hold_id: lotHoldId }, include: { lot: true } });
    views.push(lotHoldView(row));
  }
  return views;
}
