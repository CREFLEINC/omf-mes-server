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

  const orgs = await lineTargetErrors(prisma, input.lines, 'lines', errors);
  if (input.inventoryCountId != null) {
    const found = await prisma.inventory_count.count({
      where: { inventory_count_id: input.inventoryCountId },
    });
    if (found === 0) errors.push(field('inventoryCountId', ERROR_CODE.INVALID, '없는 실사입니다.'));
  }
  assertSinglePlant(input.lines, orgs, errors);
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
 * 조정 헤더에 공장 축이 0 이라 원장 헤더 `plant_id` 를 라인 위치에서 역산한다 — 두 공장에
 * 걸친 전표는 헤더가 거짓을 적게 되므로 여기서 막는다(결정 — 통보 133).
 * ⚠ **공장 축만** 본다 — 사업부·법인은 창고가 각자 알아 두 사업부에 걸쳐도 잔액이 옳다.
 */
export function assertSinglePlant(
  lines: InventoryAdjustmentLineCreate[],
  orgs: Map<number, LocationOrg>,
  errors: ErrorItem[],
): void {
  // 위치를 못 찾은 라인이 있으면 건너뛴다 — 그 라인의 오류가 이미 서 있다.
  const plants = lines.map((line) => orgs.get(line.locationId)?.plant_id);
  if (plants.some((plantId) => plantId === undefined)) return;
  const odd = plants.findIndex((plantId) => plantId !== plants[0]);
  if (odd >= 0) {
    errors.push(field(`lines[${odd}].locationId`, ERROR_CODE.INVALID, '한 전표의 라인이 두 공장에 걸칠 수 없습니다.'));
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
      select: {
        location_id: true,
        warehouse_id: true,
        warehouse: { select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } } },
      },
    }),
    prisma.inventory_count_line.findMany({
      where: { inventory_count_line_id: { in: ids((l) => l.inventoryCountLineId) } },
      select: { inventory_count_line_id: true },
    }),
  ]);

  const itemIds = new Set(items.map((row) => Number(row.item_id)));
  const lotItems = new Map(lots.map((row) => [Number(row.lot_id), Number(row.item_id)]));
  const uomIds = new Set(uoms.map((row) => Number(row.uom_id)));
  const countLineIds = new Set(countLines.map((row) => Number(row.inventory_count_line_id)));
  const orgs = new Map<number, LocationOrg>(
    locations.map((row) => [
      Number(row.location_id),
      {
        legal_entity_id: row.warehouse.plant.legal_entity_id,
        business_unit_id: row.warehouse.business_unit_id,
        plant_id: row.warehouse.plant_id,
        warehouse_id: row.warehouse_id,
      },
    ]),
  );

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
    if (line.inventoryCountLineId != null && !countLineIds.has(line.inventoryCountLineId)) {
      bad('inventoryCountLineId', '없는 실사 라인입니다.');
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
  const found = await Promise.all(
    lines.map((line) =>
      prisma.inventory_balance.findMany({
        where: {
          ...(orgs.get(line.locationId) as LocationOrg),
          location_id: line.locationId,
          item_id: line.itemId,
          lot_id: line.lotId ?? null,
        },
        select: { quality_status_code: true, inventory_status_code: true },
      }),
    ),
  );

  const errors: ErrorItem[] = [];
  // 못 푼 라인도 자리를 지켜 둔다 — 뒤 라인의 오류가 제 첨자를 짚어야 한다.
  const dimensions = found.map((rows, index) => {
    const at = `${array}[${index}].locationId`;
    if (rows.length === 1) {
      return {
        qualityStatusCode: rows[0].quality_status_code,
        inventoryStatusCode: rows[0].inventory_status_code,
      };
    }
    if (rows.length > 1) {
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
