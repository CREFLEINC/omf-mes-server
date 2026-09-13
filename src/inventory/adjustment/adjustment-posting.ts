import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { InventoryWriteActor } from '../inventory-write-actor';
import type { BalanceLockKey } from '../../core/inventory-posting/balance-lock';
import {
  LOCATION_ORG_SELECT,
  LocationOrg,
  assertSinglePlant,
  locationOrgMap,
} from './inventory-adjustment-rules';

/**
 * 재고 조정 «전기» — 조직 축 역산 · 잔액 선잠금 · 음수재고 손검사 · 원장 · 되짚기.
 * `issue-posting.ts`(I-4)·`transfer-posting.ts`(I-13)의 형제이고 갈리는 것은 둘이다.
 *
 * ⭐ ⓐ **부호가 방향을 정한다** — 감(−)은 `from` 만, 증(+)은 `to` 만 싣는다. 원장 라인은
 *   `qty > 0` CHECK 라 부호를 실을 자리가 없고, 한 전표에 둘이 섞인다(§3-2).
 * ⭐ ⓑ **`item.negative_stock_allowed` 를 본다** — 출고는 계약이 「보유 수량 이하」로 예외 없이
 *   닫아 이 축을 무시했지만, 화면 `W-01-12` §6 이 「음수 재고가 되는 조정」을 인정한다(§3-4).
 *
 * ⛔ HTTP 층을 모른다 — 헤더 잠금·승인 게이트·상태 전이는 `:post` 서비스의 일이다.
 */

/** 원장 판별자 4값 중 하나. 유형 값 목록이 0건이라 같은 값을 유형에도 쓴다(입고·출고·이동 선례). */
const SOURCE_DOCUMENT_TYPE = 'INVENTORY_ADJUSTMENT';
const POSTED = 'POSTED';

type Tx = Prisma.TransactionClient;

export interface AdjustmentLineWriteInput {
  /** 되짚기(§3-6) 대상. */
  inventoryAdjustmentLineId: bigint;
  locationId: bigint;
  itemId: bigint;
  /** ⭐ 널일 수 있다 — 조정은 LOT 없는 재고도 움직인다(I-4 와 갈리는 자리 · §3-2). */
  lotId: bigint | null;
  /** ⭐ **부호를 갖는다**(계약 ⌜증감 수량. 음수가 올 수 있다⌝). */
  adjustmentQty: Prisma.Decimal;
  uomId: bigint;
  /** 등록·치환이 잔액 행에서 읽어 «저장한» 값이다 — 여기서 다시 도출하지 않는다(§3-3). */
  qualityStatusCode: string;
  inventoryStatusCode: string;
}

export interface PostAdjustmentInput {
  inventoryAdjustmentId: bigint;
  inventoryAdjustmentNo: string;
  lines: AdjustmentLineWriteInput[];
  /** ⛔ 본문 값 그대로다 — 서버가 수신 시각으로 다시 잡지 않는다(C-8 · CLAUDE.md). */
  businessDate: string;
  /** ⛔ 본문 값 그대로다(C-1). 헤더 `adjusted_at` 도 이 값을 받는다. */
  occurredAt: Date;
}

/**
 * 잠근 잔액 행. ⛔ `lockBalancesInOrder` 가 내리는 `available_qty` 로는 트리거 셋째 갈래
 * (`reserved+picked+blocked > 0`)를 못 잰다 — STORED 생성 컬럼이라 옛 값이고 세 칸을 못
 * 가른다(§3-4).
 */
interface LockedRow extends BalanceLockKey {
  ownership_type_code: string;
  owner_partner_id: bigint | null;
  on_hand_qty: Prisma.Decimal;
  reserved_qty: Prisma.Decimal;
  picked_qty: Prisma.Decimal;
  blocked_qty: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);

const keyOf = (k: BalanceLockKey): string =>
  `${k.legalEntityId}:${k.businessUnitId}:${k.plantId}:${k.warehouseId}:${k.locationId}:${k.itemId}:${k.lotKey}`;

/**
 * 전기 한 벌. 되짚기까지 마치고 끝난다 — 상태 전이는 호출자가 잇는다.
 * ⛔ `posting.post()` 도 `lockBalancesInOrder` 를 «자기가» 부른다 — 같은
 * `ORDER BY inventory_balance_id` 라 교착이 없다(I-5 R-5).
 */
export async function postAdjustment(
  tx: Tx,
  posting: InventoryPostingService,
  input: PostAdjustmentInput,
  actor: InventoryWriteActor,
): Promise<void> {
  const { lines } = input;
  const orgs = await locationOrgs(tx, lines);
  // 조정 헤더에 공장 칸이 0이라 원장 헤더 `plant_id` 를 라인 위치에서 역산한다 — 두 공장에
  // 걸친 전표는 헤더가 거짓을 적게 된다(통보 133 · 등록·치환과 «같은 함수»다).
  const plantErrors: ErrorItem[] = [];
  assertSinglePlant(lines.map((line) => ({ locationId: Number(line.locationId) })), orgs, 'lines', plantErrors);
  if (plantErrors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, plantErrors);
  const org = (line: AdjustmentLineWriteInput): LocationOrg => orgs.get(Number(line.locationId)) as LocationOrg;

  const keys = lines.map((line) => balanceKey(line, org(line)));
  const locked = await lockBalances(tx, keys);
  const found = new Map<string, LockedRow[]>();
  for (const row of locked) found.set(keyOf(row), [...(found.get(keyOf(row)) ?? []), row]);

  // ⛔ 같은 (위치·품목·LOT) 라인이 둘이면 라인별 검사는 둘 다 통과하고 둘째 UPDATE 에서
  //    트리거가 500 을 낸다 — 키별 «부호 있는 합»으로 본다(I-4 R-1 ③).
  const demanded = new Map<string, { net: Prisma.Decimal; index: number }>();
  for (const [index, key] of keys.entries()) {
    const seen = demanded.get(keyOf(key));
    // 오류를 짚을 자리는 그 키를 «처음» 쓴 라인이다 — 같은 키에 두 번 담지 않는다.
    demanded.set(keyOf(key), {
      net: (seen?.net ?? ZERO).plus(lines[index].adjustmentQty),
      index: seen?.index ?? index,
    });
  }
  const allowsNegative = await negativeStockAllowed(tx, lines);

  const errors: ErrorItem[] = [];
  const picked = new Map<string, LockedRow>();
  for (const [id, { net, index }] of demanded) {
    const rows = found.get(id) ?? [];
    const at = `lines[${index}].locationId`;
    if (rows.length === 0) {
      // 등록·치환이 이 행을 읽어 라인의 두 상태 칸을 세웠으므로 여기 0행은 그 사이 차원이
      // 사라졌다는 뜻이다 — 소유 축(`ownershipTypeCode` required)을 되읽을 곳이 없어 증(+)도
      // 전기할 수 없다. ⛔ 등록 경로(§3-3)는 부호로 코드를 가르지만 여기는 «부호와 무관하게»
      // 하나다 — 잔액 행을 지우는 코드가 저장소에 0건이라 도달 불가에 가까운 방어이고,
      // 재볼 수 없는 갈래를 둘로 늘리지 않는다(PR ④ 리뷰 Minor-3).
      errors.push(
        field(at, ERROR_CODE.NEGATIVE_BALANCE, '이 위치의 재고 차원이 없어 조정할 수 없습니다.'),
      );
    } else if (rows.length > 1) {
      // 어느 차원의 잔액을 조정할지 계약이 말하지 않아 «거절»한다(결정 — 통보 130).
      // ⛔ 하나를 골라 조용히 전기하면 소급 정정이 불가능하다 — 거절은 나중에 열 수 있다.
      errors.push(field(at, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 조정할지 정할 수 없습니다.'));
    } else {
      picked.set(id, rows[0]);
      errors.push(...negativeErrors(rows[0], net, index, allowsNegative.get(String(lines[index].itemId)) === true));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const posted = await posting.post(tx, {
    businessDate: input.businessDate,
    occurredAt: input.occurredAt,
    transactionTypeCode: SOURCE_DOCUMENT_TYPE,
    // 전표 번호를 그대로 원장 번호로 쓴다(3선례) — 두 표를 사람이 맞대 볼 수 있다.
    transactionNo: input.inventoryAdjustmentNo,
    statusCode: POSTED,
    plantId: Number(org(lines[0]).plant_id),
    sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: Number(input.inventoryAdjustmentId),
    idempotencyKey: `${SOURCE_DOCUMENT_TYPE}:${input.inventoryAdjustmentNo}`,
    createdBy: actor.appUserId,
    lines: lines.map((line, index) => {
      // ⚠ 소유 축은 라인에 저장할 칸이 없다 — «잠근 잔액 행»에서 되읽는다(§3-3).
      const balance = picked.get(keyOf(keys[index])) as LockedRow;
      const endpoint = {
        warehouseId: Number(org(line).warehouse_id),
        locationId: Number(line.locationId),
        // ⚠ 라인 저장값이 이긴다 — 「승인자가 본 것」이 원장에 나가야 한다(§3-3).
        qualityStatusCode: line.qualityStatusCode,
        inventoryStatusCode: line.inventoryStatusCode,
      };
      return {
        itemId: Number(line.itemId),
        // ⛔ 널이면 키를 «생략»한다 — `lotId: null` 은 타입 밖이고 0 은 다른 LOT 이다.
        ...(line.lotId === null ? {} : { lotId: Number(line.lotId) }),
        qty: Number(line.adjustmentQty.abs()),
        uomId: Number(line.uomId),
        ...(line.adjustmentQty.lessThan(ZERO) ? { from: endpoint } : { to: endpoint }),
        ownershipTypeCode: balance.ownership_type_code,
        ...(balance.owner_partner_id === null ? {} : { ownerPartnerId: Number(balance.owner_partner_id) }),
      };
    }),
  });
  // 흡수가 오면 잔액은 안 움직였는데 되짚기와 상태 전이가 그대로 돈다 — 조용히 지나느니 되돌린다.
  if (posted.alreadyPosted) {
    throw new Error(`원장이 이미 있다 — 상태 잠금을 지나쳤다: ${input.inventoryAdjustmentNo}`);
  }

  // posting 은 라인을 받은 «순서»대로 `line_no` 를 매긴다 — 자리로 짝짓는다(3선례).
  const ledger = await tx.inventory_transaction_line.findMany({
    where: {
      inventory_transaction_id: posted.inventoryTransactionId,
      business_date: new Date(`${input.businessDate}T00:00:00.000Z`),
    },
    orderBy: { line_no: 'asc' },
    select: { inventory_transaction_line_id: true },
  });
  // 어긋나면 라인이 «남의 원장»을 가리키게 된다 — 조용히 어긋나느니 되돌린다.
  if (ledger.length !== lines.length) {
    throw new Error(`원장 라인 수가 조정 라인과 다르다: ${ledger.length} ≠ ${lines.length}`);
  }
  for (const [index, line] of lines.entries()) {
    await tx.inventory_adjustment_line.update({
      where: { inventory_adjustment_line_id: line.inventoryAdjustmentLineId },
      data: { inventory_transaction_line_id: ledger[index].inventory_transaction_line_id },
    });
  }
}

/**
 * 트리거 `check_balance_qty()` 세 갈래를 **그대로** 앞당긴다 — 위반은
 * `PrismaClientUnknownRequestError` 라 공용 그물에 안 걸려 **500 으로 샌다**
 * (`prisma-error.ts` 머리 주석 · I-4 `goods-issue-rules.ts:91-92` 와 같은 이유).
 */
function negativeErrors(
  row: LockedRow,
  net: Prisma.Decimal,
  index: number,
  allowsNegative: boolean,
): ErrorItem[] {
  const held = row.reserved_qty.plus(row.picked_qty).plus(row.blocked_qty);
  const after = row.on_hand_qty.plus(net);
  const at = `lines[${index}].adjustmentQty`;
  const bad = (message: string): ErrorItem[] => [field(at, ERROR_CODE.NEGATIVE_BALANCE, message)];
  if (after.greaterThanOrEqualTo(ZERO)) {
    return after.lessThan(held) ? bad('예약·피킹·보류된 수량보다 적게 남길 수 없습니다.') : [];
  }
  // ⭐ 참이면 «전기된다» — 화면 `W-01-12` §6 이 음수 재고가 되는 조정을 직접 인정한다.
  if (!allowsNegative) return bad('이 품목은 음수 재고를 허용하지 않습니다.');
  return held.greaterThan(ZERO) ? bad('예약·피킹·보류된 수량이 있어 음수 재고로 갈 수 없습니다.') : [];
}

const balanceKey = (line: AdjustmentLineWriteInput, org: LocationOrg): BalanceLockKey => ({
  legalEntityId: org.legal_entity_id,
  businessUnitId: org.business_unit_id,
  plantId: org.plant_id,
  warehouseId: org.warehouse_id,
  locationId: line.locationId,
  itemId: line.itemId,
  lotKey: line.lotId ?? 0n,
});

/**
 * 잔액 행의 조직 축 넷은 창고가 안다 — 조정 헤더에는 공장 칸조차 없다(§3-5).
 * ⭐ `select` 와 대응표 조립은 **등록·치환과 한 벌**이다(`LOCATION_ORG_SELECT`·`locationOrgMap`) —
 * 갈라 두면 축이 하나 늘 때 한쪽만 고쳐 7칸 키가 어긋난다.
 */
async function locationOrgs(tx: Tx, lines: AdjustmentLineWriteInput[]): Promise<Map<number, LocationOrg>> {
  return locationOrgMap(
    await tx.location.findMany({
      where: { location_id: { in: [...new Set(lines.map((line) => line.locationId))] } },
      select: LOCATION_ORG_SELECT,
    }),
  );
}

/**
 * ⛔ 잠금 SELECT 에 `JOIN mdm.item` 을 넣지 않는다 — `FOR UPDATE` 가 품목 마스터 행까지
 * 잠가 조정 둘이 같은 품목이면 서로를 기다린다. 축이 다르니 문장도 따로 둔다.
 */
async function negativeStockAllowed(tx: Tx, lines: AdjustmentLineWriteInput[]): Promise<Map<string, boolean>> {
  const rows = await tx.item.findMany({
    where: { item_id: { in: [...new Set(lines.map((line) => line.itemId))] } },
    select: { item_id: true, negative_stock_allowed: true },
  });
  return new Map(rows.map((row) => [String(row.item_id), row.negative_stock_allowed]));
}

/**
 * ⭐ **7칸 행생성자 한 문장**이다 — `AND` 로 쪼개면 라인 1 의 위치와 라인 2 의 LOT 이 짝지어져
 * 0행/2행+ 판정이 뭉개진다(I-4 R-1 ①). `ORDER BY inventory_balance_id … FOR UPDATE` 는
 * `lockBalancesInOrder` 와 «같은 순서»라야 교착 창이 닫힌다(I-4 R-1 ② · I-5 R-5).
 * ⛔ 없는 행을 미리 만들어 두지 않는다 — 「재고가 없다」가 「0 이 있다」로 바뀐다.
 */
async function lockBalances(tx: Tx, keys: BalanceLockKey[]): Promise<LockedRow[]> {
  if (keys.length === 0) return [];
  const values = keys.map(
    (k) =>
      Prisma.sql`(${k.legalEntityId}::bigint, ${k.businessUnitId}::bigint, ${k.plantId}::bigint, ${k.warehouseId}::bigint, ${k.locationId}::bigint, ${k.itemId}::bigint, ${k.lotKey}::bigint)`,
  );
  return tx.$queryRaw<LockedRow[]>`
    SELECT legal_entity_id AS "legalEntityId", business_unit_id AS "businessUnitId",
           plant_id AS "plantId", warehouse_id AS "warehouseId", location_id AS "locationId",
           item_id AS "itemId", COALESCE(lot_id, 0) AS "lotKey",
           ownership_type_code, owner_partner_id,
           on_hand_qty, reserved_qty, picked_qty, blocked_qty
      FROM inventory.inventory_balance
     WHERE (legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id,
            COALESCE(lot_id, 0))
           IN (VALUES ${Prisma.join(values)})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
}
