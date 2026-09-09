import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertCodeValues } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 재고 조정 «등록»·«치환»의 트랜잭션 밖 검증. 출고 `goods-issue-rules.ts` 의 거울상이다.
 * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다.
 */

/** 서버가 정한다 — 계약 본문에 `statusCode` 칸이 없다. */
export const REGISTERED = 'REGISTERED';
const REASON_GROUP = 'INVENTORY_ADJUSTMENT_REASON';
/** 계약이 승인 유형을 못박아 본문이 받지 않는다. 대상 유형과 «같은 문자열»이다(I-14.md §1-5).
 *  ⛔ 상신과 `:post` 게이트가 한 벌을 나눠 써야 한다 — 갈리면 상신한 전표를 게이트가 못 찾는다. */
export const APPROVAL_TYPE = 'INVENTORY_ADJUSTMENT';
export const TARGET_TYPE = 'INVENTORY_ADJUSTMENT';

/** 계약 `InventoryAdjustmentLineUpsert` — required 4. */
export interface InventoryAdjustmentLineCreate {
  /** ⛔ 등록에서는 «무시한다» — 신규 전표라 짚을 기존 행이 없다(치환에서만 뜻이 있다). */
  inventoryAdjustmentLineId?: number | null;
  inventoryCountLineId?: number | null;
  locationId: number;
  itemId: number;
  lotId?: number | null;
  adjustmentQty: number;
  uomId: number;
  reasonCode?: string | null;
}

/** 계약 `InventoryAdjustmentCreate` — required 2. */
export interface InventoryAdjustmentCreate {
  reasonCode: string;
  inventoryCountId?: number | null;
  /** ⛔ 받아서 «버린다» — 담을 칸이 없다. `erpMessageQueued` 는 늘 false 다. */
  sendToErp?: boolean | null;
  lines: InventoryAdjustmentLineCreate[];
}

/** 라인이 «저장할» 잔액 차원 두 칸. 계약이 안 싣는데 물리는 NOT NULL 이다. */
export interface LineDimension {
  qualityStatusCode: string;
  inventoryStatusCode: string;
}

/** 위치가 매달린 조직 축 — 잔액 행을 겨냥하는 7칸 중 앞의 넷이다. */
export interface LocationOrg {
  legal_entity_id: bigint;
  business_unit_id: bigint;
  plant_id: bigint;
  warehouse_id: bigint;
}

/**
 * ⭐ 등록·치환(`lineTargetErrors`)과 전기(`adjustment-posting.ts`)가 **같은 축을 읽는다.**
 * 한 벌로 두지 않으면 조직 축이 하나 늘 때 한쪽만 고쳐 **등록은 맞고 전기는 틀린 잔액 키**를
 * 만든다 — 7칸 키가 어긋나면 0행 판정이 뒤집힌다(PR ④ 리뷰 Minor-2).
 */
export const LOCATION_ORG_SELECT = {
  location_id: true,
  warehouse_id: true,
  warehouse: {
    select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
  },
} as const;

type LocationOrgRow = {
  location_id: bigint;
  warehouse_id: bigint;
  warehouse: { business_unit_id: bigint; plant_id: bigint; plant: { legal_entity_id: bigint } };
};

export function locationOrgMap(rows: LocationOrgRow[]): Map<number, LocationOrg> {
  return new Map(
    rows.map((row) => [
      Number(row.location_id),
      {
        legal_entity_id: row.warehouse.plant.legal_entity_id,
        business_unit_id: row.warehouse.business_unit_id,
        plant_id: row.warehouse.plant_id,
        warehouse_id: row.warehouse_id,
      },
    ]),
  );
}

/**
 * 전건 검증. 돌려주는 것은 **라인마다의 잔액 차원 두 칸**이다(결정 — 통보 130).
 * 판정 순서가 곧 400 갈래의 순서다.
 */
export async function assertCreatable(
  prisma: PrismaService,
  input: InventoryAdjustmentCreate,
): Promise<LineDimension[]> {
  const errors: ErrorItem[] = [];
  // 계약이 「최소 1행」이라 적었으나 `minItems` 를 걸지 않아 가드가 빈 배열을 통과시킨다.
  if (input.lines.length === 0) {
    errors.push(field('lines', ERROR_CODE.LINE_REQUIRED, '조정 라인이 1건 이상이어야 합니다.'));
  }
  // CHECK `adjustment_qty <> 0` 을 앞당긴다 — 그냥 넘기면 500 으로 샌다. 화면 `W-01-12` §6
  // 의 「차이 0인 라인은 제외」와 같은 규칙이다.
  for (const [index, line] of input.lines.entries()) {
    if (line.adjustmentQty === 0) {
      errors.push(field(`lines[${index}].adjustmentQty`, ERROR_CODE.INVALID, '증감 수량이 0일 수 없습니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const countId = input.inventoryCountId ?? null;
  const orgs = await lineTargetErrors(prisma, input.lines, 'lines', countId, errors);
  if (countId !== null) {
    const found = await prisma.inventory_count.count({ where: { inventory_count_id: countId } });
    if (found === 0) errors.push(field('inventoryCountId', ERROR_CODE.INVALID, '없는 실사입니다.'));
  }
  assertSinglePlant(input.lines, orgs, 'lines', errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  await assertCodeValues(prisma, [
    { field: 'reasonCode', value: input.reasonCode, groupCode: REASON_GROUP },
    ...input.lines.map((line, index) => ({
      field: `lines[${index}].reasonCode`,
      value: line.reasonCode,
      groupCode: REASON_GROUP,
    })),
  ]);
  return resolveLineDimensions(prisma, input.lines, orgs, 'lines');
}

/**
 * 치환의 트랜잭션 밖 검증. 등록과 같은 판정이고 갈리는 것은 셋이다 — 오류가 짚는 배열 이름이
 * `items` 고(계약 requestBody `{required:['items']}`), 헤더 사유는 이미 저장된 값이라 다시
 * 대조하지 않으며, 실사 축은 본문이 아니라 «저장된 헤더»가 준다.
 */
export async function assertReplaceable(
  prisma: PrismaService,
  items: InventoryAdjustmentLineCreate[],
  inventoryCountId: number | null,
): Promise<LineDimension[]> {
  const errors: ErrorItem[] = [];
  // 계약이 등록 쪽에만 「최소 1행」을 적었으나 같은 자원이라 치환도 0행을 막는다.
  if (items.length === 0) {
    errors.push(field('items', ERROR_CODE.LINE_REQUIRED, '조정 라인이 1건 이상이어야 합니다.'));
  }
  for (const [index, line] of items.entries()) {
    if (line.adjustmentQty === 0) {
      errors.push(field(`items[${index}].adjustmentQty`, ERROR_CODE.INVALID, '증감 수량이 0일 수 없습니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  const orgs = await lineTargetErrors(prisma, items, 'items', inventoryCountId, errors);
  assertSinglePlant(items, orgs, 'items', errors);
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

  await assertCodeValues(
    prisma,
    items.map((line, index) => ({
      field: `items[${index}].reasonCode`,
      value: line.reasonCode,
      groupCode: REASON_GROUP,
    })),
  );
  return resolveLineDimensions(prisma, items, orgs, 'items');
}

/**
 * 조정 헤더에 공장 축이 0 이라 원장 헤더 `plant_id` 를 라인 위치에서 역산한다 — 두 공장에
 * 걸친 전표는 헤더가 거짓을 적게 되므로 여기서 막는다(결정 — 통보 133).
 * ⚠ **공장 축만** 본다 — 사업부·법인은 창고가 각자 알아 두 사업부에 걸쳐도 잔액이 옳다.
 */
export function assertSinglePlant(
  // ⭐ 위치 축만 본다 — `:post`(`adjustment-posting.ts`)가 «저장된» 라인으로 같은 판정을
  //    다시 밟으므로 등록 본문 모양에 묶지 않는다(중복 작성 금지).
  lines: { locationId: number }[],
  orgs: Map<number, LocationOrg>,
  array: 'lines' | 'items',
  errors: ErrorItem[],
): void {
  // 위치를 못 찾은 라인이 있으면 건너뛴다 — 그 라인의 오류가 이미 서 있다.
  const plants = lines.map((line) => orgs.get(line.locationId)?.plant_id);
  if (plants.some((plantId) => plantId === undefined)) return;
  const odd = plants.findIndex((plantId) => plantId !== plants[0]);
  if (odd >= 0) {
    errors.push(field(`${array}[${odd}].locationId`, ERROR_CODE.INVALID, '한 전표의 라인이 두 공장에 걸칠 수 없습니다.'));
  }
}

/**
 * 라인 축 FK 그물 — 등록과 «치환»(PR ③)이 나눠 쓴다. ⛔ 던지지 않고 «모아 돌려준다».
 * `array` 는 오류가 짚을 배열 이름이다(등록 `lines` · 치환 `items` — 계약 칸 이름이 다르다).
 * 돌려주는 것은 위치 → 조직 축 대응표다. 위치를 두 번 읽지 않으려고 여기서 낸다.
 */
export async function lineTargetErrors(
  prisma: PrismaService,
  lines: InventoryAdjustmentLineCreate[],
  array: 'lines' | 'items',
  inventoryCountId: number | null,
  errors: ErrorItem[],
): Promise<Map<number, LocationOrg>> {
  const ids = (of: (line: InventoryAdjustmentLineCreate) => number | null | undefined): number[] => [
    ...new Set(lines.map(of).filter((id): id is number => id != null)),
  ];
  const [items, lots, uoms, locations, countLines] = await Promise.all([
    prisma.item.findMany({ where: { item_id: { in: ids((l) => l.itemId) } }, select: { item_id: true } }),
    prisma.lot.findMany({
      where: { lot_id: { in: ids((l) => l.lotId) } },
      select: { lot_id: true, item_id: true },
    }),
    prisma.uom.findMany({ where: { uom_id: { in: ids((l) => l.uomId) } }, select: { uom_id: true } }),
    prisma.location.findMany({
      where: { location_id: { in: ids((l) => l.locationId) } },
      select: LOCATION_ORG_SELECT,
    }),
    prisma.inventory_count_line.findMany({
      where: { inventory_count_line_id: { in: ids((l) => l.inventoryCountLineId) } },
      select: { inventory_count_line_id: true, inventory_count_id: true },
    }),
  ]);

  const itemIds = new Set(items.map((row) => Number(row.item_id)));
  const lotItems = new Map(lots.map((row) => [Number(row.lot_id), Number(row.item_id)]));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
  const countLineOwners = new Map(
    countLines.map((row) => [Number(row.inventory_count_line_id), Number(row.inventory_count_id)]),
  );
  const orgs = locationOrgMap(locations);

  for (const [index, line] of lines.entries()) {
    const at = `${array}[${index}]`;
    const bad = (name: string, message: string): void => {
      errors.push(field(`${at}.${name}`, ERROR_CODE.INVALID, message));
    };
    if (!itemIds.has(line.itemId)) bad('itemId', '없는 품목입니다.');
    if (!uomIds.has(line.uomId)) bad('uomId', '없는 단위입니다.');
    if (!orgs.has(line.locationId)) bad('locationId', '없는 위치입니다.');
    if (line.lotId != null) {
      // LOT 과 품목이 어긋나면 원장이 거짓을 적는다 — 계보가 그 두 축으로 이어진다.
      if (!lotItems.has(line.lotId)) bad('lotId', '없는 LOT 입니다.');
      else if (lotItems.get(line.lotId) !== line.itemId) bad('itemId', '이 LOT 의 품목이 아닙니다.');
    }
    if (line.inventoryCountLineId != null) {
      const owner = countLineOwners.get(line.inventoryCountLineId);
      if (owner === undefined) bad('inventoryCountLineId', '없는 실사 라인입니다.');
      // ⭐ 실재만 보면 «남의 실사» 라인을 가리켜도 통과한다 — 그러면 I-15 `:close` 가
      //    「이 실사의 차이가 조정됐나」를 라인 축으로 못 가른다(마이그를 넣은 이유다).
      else if (owner !== inventoryCountId) {
        bad('inventoryCountLineId', '이 조정이 가리키는 실사의 라인이 아닙니다.');
      }
    }
  }
  return orgs;
}

/**
 * ⭐ 라인의 `quality_status_code`·`inventory_status_code` 를 **잔액 행에서 읽는다**.
 * 계약 라인이 두 칸을 안 싣는데 물리는 NOT NULL 이고, `QUALITY_STATUS` 코드 그룹은 DB 에
 * 아예 없어 상수를 세울 근거도 0 이다. 등록·치환 시점에 읽어 라인에 저장하고 `:post` 는 그
 * 저장값을 그대로 싣는다 — 「승인자가 본 것」이 원장에 나간다(결정 — 통보 130).
 * ⛔ `FOR UPDATE` 를 걸지 않는다 — 등록은 재고를 안 움직인다. 잠금은 `:post` 몫이다.
 */
export async function resolveLineDimensions(
  prisma: PrismaService,
  lines: InventoryAdjustmentLineCreate[],
  orgs: Map<number, LocationOrg>,
  array: 'lines' | 'items',
): Promise<LineDimension[]> {
  // ⭐ 라인마다 한 번씩 읽으면 N+1 이다 — 7칸 키 전건을 한 문장으로 모아 읽고 키로 가른다.
  //    같은 키를 쓰는 라인 둘은 같은 행 묶음을 보므로 0행·1행·2행+ 판정은 라인마다 그대로다.
  const keys = lines.map((line) => ({
    ...(orgs.get(line.locationId) as LocationOrg),
    location_id: line.locationId,
    item_id: line.itemId,
    lot_id: line.lotId ?? null,
  }));
  const rows = await prisma.inventory_balance.findMany({ where: { OR: keys } });
  const byKey = new Map<string, typeof rows>();
  for (const row of rows) byKey.set(balanceKey(row), [...(byKey.get(balanceKey(row)) ?? []), row]);

  const errors: ErrorItem[] = [];
  // 못 푼 라인도 자리를 지켜 둔다 — 뒤 라인의 오류가 제 첨자를 짚어야 한다.
  const dimensions = keys.map((key, index) => {
    const found = byKey.get(balanceKey(key)) ?? [];
    const at = `${array}[${index}].locationId`;
    if (found.length === 1) {
      return {
        qualityStatusCode: found[0].quality_status_code,
        inventoryStatusCode: found[0].inventory_status_code,
      };
    }
    if (found.length > 1) {
      errors.push(field(at, ERROR_CODE.INVALID, '재고 차원이 둘 이상이라 어느 것을 조정할지 정할 수 없습니다.'));
    } else if (lines[index].adjustmentQty < 0) {
      errors.push(field(at, ERROR_CODE.NEGATIVE_BALANCE, '이 위치에 그 LOT 의 재고가 없습니다.'));
    } else {
      // ⚠ 물리적 불가가 아니라 «정책»이다 — 코어 `move()` 는 빈 차원을 만들 수 있다.
      errors.push(field(at, ERROR_CODE.INVALID, '이 위치에 그 품목의 재고가 없어 어느 상태로 넣을지 정할 수 없습니다.'));
    }
    return { qualityStatusCode: '', inventoryStatusCode: '' };
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return dimensions;
}

/** 잔액 7칸 키를 한 문자열로 — 입력(number)과 조회 결과(bigint)를 같은 모양으로 맞춘다. */
const KEY_COLUMNS = ['legal_entity_id', 'business_unit_id', 'plant_id', 'warehouse_id', 'location_id', 'item_id', 'lot_id'];
function balanceKey(row: object): string {
  return KEY_COLUMNS.map((column) => String((row as Record<string, unknown>)[column])).join(':');
}
