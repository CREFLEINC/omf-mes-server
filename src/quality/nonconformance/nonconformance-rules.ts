import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';

/** 계약 `NonconformanceLotCreate` — 3칸 «전건» required. */
export interface NonconformanceLotCreate {
  lotId: number;
  affectedQty: number;
  uomId: number;
}

/** 계약 `NonconformanceCreate` — required 4(`itemId`·`severityCode`·`description`·`lots`) · 프로퍼티 7. */
export interface NonconformanceCreate {
  itemId: number;
  workOrderId?: number | null;
  inspectionResultId?: number | null;
  severityCode: string;
  description: string;
  responsibleDepartmentId?: number | null;
  lots: NonconformanceLotCreate[];
}

/** 계약 `DispositionRequest` — required 2 · 프로퍼티 3. ⛔ **세 칸 전부 담을 데가 0이다**(§1-3). */
export interface DispositionRequest {
  requestedQty: number;
  uomId: number;
  remarks?: string | null;
}

/** 「고객이 늘린다」(G-31)라 enum 이 아니다 — 쓰기에서만 DB 코드표와 대조한다(조회 필터엔 안 건다). */
export const SEVERITY_GROUP = 'NONCONFORMANCE_SEVERITY';

/** `app.qty_t` = `numeric(20,6)` — 소수 6자리 · 정수 14자리가 손실 없이 담기는 한계다. */
const QTY_SCALE = 6;
const QTY_INT_LIMIT = '100000000000000';

/**
 * 수량이 `numeric(20,6)` 에 **손실 없이** 담기는가. ⓐ 소수 자릿수 초과는 INSERT 때 **반올림**돼
 * `1e-7` 이 0 이 되고 `CHECK (> 0)` 를 깬다 ⓑ 정수 15자리는 `numeric field overflow` 다 —
 * ⛔ **둘 다 500 으로 샌다**(계약이 제약을 0개 둬 가드가 안 막는다 · 선례
 * `maintenance/result/result-write-input.ts:252`). ⚠ `scale` 은 호출자가 준다.
 */
export function assertQtyPrecision(name: string, qty: number, scale: number): void {
  const decimal = new Prisma.Decimal(qty);
  if (decimal.decimalPlaces() > scale) {
    throw one(field(name, ERROR_CODE.RANGE, `수량은 소수점 ${scale}자리까지입니다.`));
  }
  // ⛔ `Infinity`(JSON `1e400`)는 `decimalPlaces()` 가 NaN 이라 위를 지난다 — 여기서 잡힌다.
  // ⛔ `.abs()` 를 씌우지 않는다 — 음수는 두 호출부 «앞»에서 이미 막혀(등록은 `> 0`, 판정 저장은
  //    계약 `exclusiveMinimum: 0`) 되돌려도 안 깨지는 절이 된다(R-15 · 리뷰 Minor-3).
  if (decimal.gte(QTY_INT_LIMIT)) {
    throw one(field(name, ERROR_CODE.RANGE, '수량은 정수 14자리를 넘을 수 없습니다.'));
  }
}

/**
 * 등록 본문 형식 — 트랜잭션 «밖»이다(DB 를 안 연다). 통과하면 `lots[]` 가 공유하는 **단위 하나**를
 * 돌려준다: 단위가 전부 같은지 보는 검사와 「그래서 이 부적합의 단위는 무엇인가」가 같은 사실이라
 * 둘을 가르면 호출자가 `lots[0]` 을 다시 집는 죽은 갈래를 갖는다.
 * ⛔ **`lots` 빈 배열을 다시 세지 않는다** — 계약 `minItems:1` 을 검증 가드가 이미 400 `RANGE` 로
 *    막는다(§3-4 순서 1 · R-15). 다시 단언하면 «되돌려도 안 깨지는 절»이 된다.
 * ⭐ **갈래 순서가 판정이다**(§3-4) — 한 요청이 두 규칙을 어기면 «먼저» 적힌 것이 난다:
 *    ① 같은 LOT 두 번 → ② 단위 혼합 → ③ 수량 → ④ 내용 공백만.
 */
export function assertCreateShape(body: NonconformanceCreate): number {
  const seen = new Set<number>();
  for (const [index, lot] of body.lots.entries()) {
    if (seen.has(lot.lotId)) {
      throw one(field(`lots[${index}].lotId`, ERROR_CODE.INVALID, `같은 LOT 을 두 번 지정할 수 없습니다: ${lot.lotId}`));
    }
    seen.add(lot.lotId);
  }

  // ⭐ **R-2 — 계약 지침을 «알고» 다른 쪽을 골랐다.** `DispositionRemainingSummary.x-internal-note`
  //   는 「합을 내리지 말고 두 값을 보여라」이나 그것은 «응답을 어떻게 그리는가»의 지침이고,
  //   여기서 막는 것은 «입력이 애초에 그 상태가 되는 것»이다. `Nonconformance.affectedQtyTotal`·
  //   `uomId` 가 둘 다 **단수 required** 라 단위가 섞이면 담을 칸이 없다(§1-3 3안표 · 통보 089 §6).
  if (new Set(body.lots.map((lot) => lot.uomId)).size > 1) {
    throw one(field('lots', ERROR_CODE.INVALID, '대상 LOT 의 단위가 서로 달라 대상 수량 합을 낼 수 없습니다.'));
  }

  for (const [index, lot] of body.lots.entries()) {
    // ⭐ **살아 있는 절 둘이다.** 계약 `affectedQty` 에 제약이 **0개**라(`format:double` 뿐) 가드가
    //   안 막고, `app.qty_t` 는 `numeric(20,6)` 이라 ⓐ 0 이하와 ⓑ 정밀도(아래)가 둘 다
    //   **500 으로 샌다**(선례 `lot-hold-rules.ts`).
    if (!(lot.affectedQty > 0)) {
      throw one(field(`lots[${index}].affectedQty`, ERROR_CODE.RANGE, '영향 수량은 0 보다 커야 합니다.'));
    }
    assertQtyPrecision(`lots[${index}].affectedQty`, lot.affectedQty, QTY_SCALE);
  }

  // ⭐ **공백만(`" "`)은 «살아 있는 절»이다** — 계약 `minLength:1` 이 그것을 통과시킨다(빈 문자열
  //   `""` 은 가드가 `RANGE` 로 막아 **두 갈래의 코드가 다르다** · A-12 · §1-6).
  if (body.description.trim() === '') {
    throw one(field('description', ERROR_CODE.REQUIRED, '부적합 내용을 공백만으로 채울 수 없습니다.'));
  }
  return body.lots[0].uomId;
}

/**
 * 의뢰 본문 형식 — ⛔ **셋 다 저장하지 않는다**(§1-3). 그래도 형식은 본다: 값이 뜻을 잃은 채
 * 조용히 버려지면 「의뢰 수량 0」이 성공으로 보인다.
 * ⭐ `requestedQty >= 1` 은 «살아 있는 절»이다 — 계약에 `minimum` 이 **없고** 설명만 「1 이상이어야
 *    한다」(`W-04-07` §5-7)라 가드가 안 막는다.
 * ⚠ **상한(대상 수량)은 안 막는다** — 화면이 막고(`W-04-07` §6) 계약이 서버 거부를 안 적었다.
 */
export function assertDispositionRequestShape(body: DispositionRequest, nonconformanceUomId: number): void {
  if (!(body.requestedQty >= 1)) {
    throw one(field('requestedQty', ERROR_CODE.RANGE, '판정 의뢰 수량은 1 이상이어야 합니다.'));
  }
  if (body.uomId !== nonconformanceUomId) {
    throw one(field('uomId', ERROR_CODE.INVALID, '부적합의 단위와 같아야 합니다.'));
  }
}
