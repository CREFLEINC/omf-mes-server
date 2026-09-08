import { ERROR_CODE, field, one } from '../../common/errors';
import type { ActionName } from '../../core/document-state';

/**
 * 계약 `LotVersionRef` — 둘 다 required. ⭐ 잠그는 대상은 **`trace.lot.version_no`** 다
 * (`lot_hold` 가 아니다 — R-24 · 계약 `:1950`·`:2058`).
 */
export interface LotVersionRef {
  lotId: number;
  versionNo: number;
}

/** 계약 `LotHoldCreate` — required 3(`lots`·`reasonCode`·`targetLotStatusCode`) · 프로퍼티 7. */
export interface LotHoldCreate {
  lots: LotVersionRef[];
  holdQty?: number;
  uomId?: number;
  reasonCode: string;
  releaseCondition?: string;
  targetLotStatusCode: string;
  remarks?: string;
}

export const HOLD_REASON_GROUP = 'LOT_HOLD_REASON';
export const LOT_STATUS_GROUP = 'LOT_STATUS';
/** `lot_status_event.source_document_type_code` — 이 전이를 일으킨 전표. */
export const HOLD_SOURCE_DOCUMENT_TYPE = 'LOT_HOLD';

/** `releaseCondition` 이 필수인 쪽(C10 의심자재) — 「풀리는 조건」을 적어야 검사 대기가 뜻을 갖는다. */
const SUSPECT_TARGET = 'INSPECTION_PENDING';

/**
 * 도착 상태 ↔ 전이표 액션. 계약이 값을 **둘**로 좁혔다 — 의심자재 등록(C10)은
 * `INSPECTION_PENDING`, 클레임·리콜 재Hold(C9)는 `DEFECTIVE`(`LotHoldCreate.targetLotStatusCode`).
 * `LOT_STATUS` 의 나머지 둘(`NORMAL`·`SCRAPPED`)은 전이표에 그 액션이 없어 400 `INVALID` 다 —
 * 액션을 지어내지 않는다(공유계약 F-6 · 0단계 선례 `inspection-confirm.service.ts`
 * `ACTION_BY_JUDGMENT`).
 *
 * ⛔ 평범한 객체가 아니라 `Map` 이다 — `'constructor' in {}` 이 참이라 객체 조회로 값 목록을
 *    좁히면 프로토타입 이름이 통과한다.
 */
const ACTION_BY_TARGET_STATUS = new Map<string, ActionName>([
  ['DEFECTIVE', 'lot-hold-claim'],
  [SUSPECT_TARGET, 'lot-hold-suspect'],
]);

/**
 * 본문 형식 — 트랜잭션 «밖»이다(§3-1 1단계 · DB 를 안 연다). 통과하면 **전이 액션**을 돌려준다:
 * 도착 상태를 두 값으로 좁히는 검사와 액션을 고르는 일이 «같은 표» 하나를 보므로, 둘을 갈라
 * 두면 호출자가 `undefined` 를 다시 좁히는 죽은 갈래를 갖는다.
 * 갈래 순서가 곧 e2e 의 갈래다: 한 요청이 두 규칙에 걸리면 «먼저» 적힌 것이 난다.
 */
export function assertHoldCreateShape(body: LotHoldCreate): ActionName {
  const lots = body.lots ?? [];
  // I-8 「`lines: []` 는 `RANGE`」 선례 — 「형식이 틀렸다」가 아니라 「개수가 모자라다」다.
  if (lots.length === 0) {
    throw one(field('lots', ERROR_CODE.RANGE, '보류할 LOT 을 한 건 이상 지정하세요.'));
  }
  assertDistinctLots(lots);
  assertQtyPair(body);
  // ⭐ 「2건 이상이면 전량 보류만 된다 — 수량은 LOT 마다 달라 뜻을 잃는다」(계약 `:4050` · `W-03-03` §5-3).
  if (lots.length >= 2 && body.holdQty !== undefined) {
    throw one(field('holdQty', ERROR_CODE.INVALID, 'LOT 을 2건 이상 보류할 때는 수량을 지정할 수 없습니다.'));
  }
  const action = ACTION_BY_TARGET_STATUS.get(body.targetLotStatusCode);
  if (action === undefined) {
    throw one(
      field('targetLotStatusCode', ERROR_CODE.INVALID, '보류 등록의 도착 상태는 INSPECTION_PENDING 또는 DEFECTIVE 입니다.'),
    );
  }
  assertReleaseCondition(body);
  return action;
}

/**
 * ⭐⭐ **§12-1 ⓑ — 같은 `lotId` 를 두 번 담을 수 없다.** 계약에 금지 문구가 «없어»
 * README §2 절차로 정했다(2단계 기준 1·2 — 아무 상태도 안 쓰고 거부하는 쪽). // 결정 — 통보 081
 * 허용하면 셋이 함께 깨진다:
 *  ⓐ `WHERE lot_id IN (1,1)` 이 **한 행**이라 「잠근 행수」로 404 를 판정하는 자리가
 *    «없는 LOT 이 아닌데» 404 를 낸다.
 *  ⓑ `sourceDocumentIdByLot` 이 `lot_id` 키라 **같은 LOT 의 보류 둘이 한 항목으로 접혀**
 *    두 번째 `lot_hold_id` 가 이력에서 사라진다(R-12 가 막으려던 것이 다른 문으로 들어온다).
 *  ⓒ `moveWithin` 의 「`moved + skipped` = 입력 집합」 규약이 깨진다.
 * 코드는 `RANGE`(개수)가 아니라 **`INVALID`** 다 — 개수가 아니라 «같은 것을 두 번 담은» 형식 위반이다.
 */
function assertDistinctLots(lots: LotVersionRef[]): void {
  const seen = new Set<number>();
  for (const ref of lots) {
    if (seen.has(ref.lotId)) {
      throw one(field('lots', ERROR_CODE.INVALID, `같은 LOT 을 두 번 지정할 수 없습니다: ${ref.lotId}`));
    }
    seen.add(ref.lotId);
  }
}

/**
 * `ck_lot_hold_qty_uom CHECK ((hold_qty IS NULL) = (uom_id IS NULL))` 를 «손으로 앞당겨» 막는다 —
 * 물리 CHECK 로 흘리면 `prisma-error.ts` 가 500 을 낸다(I-19 #314 Major 선례).
 * ⛔ `holdQty = 0` 은 「전량 보류」가 아니다 — 전량은 **NULL** 이다.
 */
function assertQtyPair(body: LotHoldCreate): void {
  const qty = body.holdQty;
  const hasUom = body.uomId !== undefined;
  if ((qty !== undefined) !== hasUom) {
    const missing = qty !== undefined ? 'uomId' : 'holdQty';
    throw one(field(missing, ERROR_CODE.PAIR, 'holdQty·uomId 는 함께 보내거나 함께 생략합니다.'));
  }
  if (qty !== undefined && !(qty > 0)) {
    throw one(field('holdQty', ERROR_CODE.RANGE, '보류 수량은 0 보다 커야 합니다.'));
  }
}

/**
 * 조건부 필수 — 「`targetLotStatusCode` 가 `INSPECTION_PENDING` 이면 **필수**, `DEFECTIVE` 면
 * **받지 않는다**」(계약 `:4070`). 두 갈래의 코드가 다르다: 「고르라」(`REQUIRED`)와 「지우라」(`INVALID`).
 */
function assertReleaseCondition(body: LotHoldCreate): void {
  const present = body.releaseCondition !== undefined;
  if (body.targetLotStatusCode === SUSPECT_TARGET && !present) {
    throw one(field('releaseCondition', ERROR_CODE.REQUIRED, '검사 대기로 보류할 때는 해제 조건이 필요합니다.'));
  }
  if (body.targetLotStatusCode !== SUSPECT_TARGET && present) {
    throw one(field('releaseCondition', ERROR_CODE.INVALID, '불량으로 보류할 때는 해제 조건을 받지 않습니다.'));
  }
}
