import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';

/**
 * 출하 등록의 **손검사 셋** — HTTP·DB 를 모른다(행을 읽는 것은 호출자가 넘긴다).
 *
 * ⭐ 왜 파일이 따로인가 — 이 판정들은 **DB 왕복 «전»**에 돌아야 하고(잘못된 수량으로 잔액을
 * 잠그면 교착 창이 넓어진다), 전수 변이를 단위로 돌릴 수 있어야 한다. 전기(`shipment-posting.ts`)
 * 는 이것을 통과한 값만 본다.
 */

/** `numeric(20,6)` — 소수 6자리 · 정수부 14자리. */
const QTY_SCALE = 6;
const QTY_INT_LIMIT = '100000000000000';
/** 계약 「배분 LOT 이 Release 가 아니면 400」(결정 10 · `W-04-05` §5-3)의 그 값. */
const RELEASED = 'NORMAL';

export interface ShipmentQtyLine {
  shippedQty: number;
  allocations: { allocatedQty: number }[];
}

/**
 * ⭐⭐ **수량이 지나는 칸이 아홉이고 전부 `numeric(20,6)` 이다**(계획서 §7).
 * 계약이 `multipleOf`·`maximum` 을 **안 줬다** ⇒ 둘 다 손으로 막는다:
 *
 * ⓐ **소수 일곱째 자리** — `10.0000005` 를 보내면 Postgres 가 **조용히 `10.000001` 로
 *   반올림**한다. 원장은 `block_ledger_header_mutation` 때문에 소급 정정이 안 되므로 그
 *   반올림이 영구다.
 * ⓑ **정수부 15자리**(`1e15`) — 계약 미선언 **500** 이 된다.
 *
 * ⛔ I-16·I-17 이 **연속으로** 이 축을 빠뜨려 매번 리뷰 Blocker 가 됐다. 그리고 이 슬라이스의
 * 초안은 **출하 경로에만** 걸어 재등록·긴급 입고가 0건이었다(R-12). ⇒ 경로마다 부른다.
 */
export function assertQty(path: string, quantity: number): void {
  const qty = new Prisma.Decimal(quantity);
  if (qty.decimalPlaces() > QTY_SCALE) {
    throw one(field(path, ERROR_CODE.RANGE, `수량은 소수점 ${QTY_SCALE}자리까지입니다.`));
  }
  if (qty.abs().gte(QTY_INT_LIMIT)) {
    throw one(field(path, ERROR_CODE.RANGE, '수량은 정수 14자리를 넘을 수 없습니다.'));
  }
}

/**
 * 출하 본문의 수량 전건 — 라인과 그 배분을 **둘 다** 본다.
 * ⛔ 라인만 보면 배분의 `1e15` 가 그대로 `shipment_lot_allocation.allocated_qty` 로 흘러간다.
 */
export function assertShipmentQty(lines: ShipmentQtyLine[]): void {
  for (const [index, line] of lines.entries()) {
    assertQty(`lines[${index}].shippedQty`, line.shippedQty);
    for (const [inner, allocation] of line.allocations.entries()) {
      assertQty(`lines[${index}].allocations[${inner}].allocatedQty`, allocation.allocatedQty);
    }
  }
}

/**
 * ⭐ **배분 합 = 라인 수량**. DB 에 이 불변식을 보는 제약이 **없다** — 어긋난 채 들어가면
 * 원장(`Σ 배분`)과 `shipment_line.shipped_qty`(라인 값)가 **영구히 갈린다**.
 * ⚠ `Decimal` 로 센다 — `0.1 + 0.2 !== 0.3` 이라 `number` 합으로는 정상 요청이 400 이 된다.
 */
export function assertAllocationSum(lines: ShipmentQtyLine[]): void {
  const errors: ErrorItem[] = [];
  for (const [index, line] of lines.entries()) {
    const sum = line.allocations.reduce(
      (total, allocation) => total.plus(new Prisma.Decimal(allocation.allocatedQty)),
      new Prisma.Decimal(0),
    );
    if (!sum.equals(new Prisma.Decimal(line.shippedQty))) {
      errors.push(
        field(
          `lines[${index}].allocations`,
          ERROR_CODE.RANGE,
          `배분 합(${sum.toString()})이 출하 수량(${line.shippedQty})과 다릅니다.`,
        ),
      );
    }
  }
  // ⭐ 라인 전건을 모아 한 봉투로 던진다 — 화면이 라인마다 한 번씩 왕복하지 않는다.
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * ⭐⭐ **품질 게이트 — 출하는 «Release 만» 낸다.** 계약이 「배분 LOT 이 Release 가 아니면 400
 * 이다(결정 10 · `W-04-05` §5-3)」라 적었고 ⛔ **긴급 직행도 건너뛰지 않는다**고 못 박았다.
 *
 * ⛔ **출고 코어의 게이트로는 부족하다.** `issue-posting.ts:307-322` 의 `assertLotNotBlocked`
 * 는 `mdm.judgment_type_control.blocks_issue` 를 보는 **음성** 판정이고, 그 표의 `JUDGMENT_TYPE`
 * 값 목록이 **0개라 오늘 아무것도 막지 않는다**(I-4 §5-3 이 그렇게 적었다). 출하 계약은
 * **양성** 판정(「Release 만」)을 요구하므로 여기서 따로 본다.
 *
 * ⚠ 두 게이트를 **둘 다** 둔다 — 판정 유형 표가 채워지면 폐기·반품 갈래는 그쪽이 막고,
 * 출하는 그보다 좁게 막는다. 겹치는 것은 문제가 아니다.
 */
export function assertLotsReleased(
  lots: { lotId: bigint | number; statusCode: string }[],
  pathOf: (lotId: bigint | number) => string,
): void {
  const errors: ErrorItem[] = [];
  for (const lot of lots) {
    if (lot.statusCode === RELEASED) continue;
    errors.push(
      field(
        pathOf(lot.lotId),
        ERROR_CODE.STATE_LOCKED,
        `출하할 수 없는 LOT 상태입니다(${lot.statusCode}).`,
      ),
    );
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

const one = (item: ErrorItem): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [item]);
