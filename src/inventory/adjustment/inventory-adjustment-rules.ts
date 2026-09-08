import { ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 재고 조정 «등록»·«치환»의 트랜잭션 밖 검증. 출고 `goods-issue-rules.ts` 의 거울상이다.
 * ⛔ 없는 id 를 그냥 넘기면 FK 위반이 **500** 으로 샌다.
 */

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

/** 위치가 매달린 조직 축 — 잔액 행을 겨냥하는 7칸 중 앞의 넷이다. */
export interface LocationOrg {
  legal_entity_id: bigint;
  business_unit_id: bigint;
  plant_id: bigint;
  warehouse_id: bigint;
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
