import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * 창고 사용 중지가 무엇을 막는지 확인하려면 창고 안에 **재고와 로케이션**이 있어야 한다.
 * `inventory.inventory_balance` 한 행을 넣는 데만 단위·품목·로케이션이 필요해서 모아 둔다.
 *
 * 재고·품목 모듈은 아직 없다. 여기 있는 것은 그 모듈의 시작이 아니라 e2e 가 상황을
 * 꾸미기 위한 최소한이다 — 모듈이 생기면 그쪽 픽스처가 이것을 대신한다.
 */
export type InventoryRefs = { uomId: bigint; itemId: bigint };

export async function createInventoryRefs(
  prisma: PrismaService,
  prefix: string,
): Promise<InventoryRefs> {
  const uom = await prisma.uom.upsert({
    where: { uom_code: `${prefix}-EA` },
    update: {},
    create: { uom_code: `${prefix}-EA`, uom_name: 'e2e 개', decimal_scale: 0 },
  });

  const item = await prisma.item.upsert({
    where: { item_code: `${prefix}-ITEM` },
    update: {},
    create: {
      item_code: `${prefix}-ITEM`,
      item_name: 'e2e 품목',
      item_type_code: 'MATERIAL',
      base_uom_id: uom.uom_id,
      lot_control_type_code: 'NONE',
    },
  });

  return { uomId: uom.uom_id, itemId: item.item_id };
}

export async function createLocation(
  prisma: PrismaService,
  warehouseId: bigint,
  locationCode: string,
  isActive: boolean,
): Promise<bigint> {
  const location = await prisma.location.create({
    data: {
      warehouse_id: warehouseId,
      location_code: locationCode,
      location_name: 'e2e 로케이션',
      location_type_code: 'RACK',
      is_active: isActive,
    },
  });

  return location.location_id;
}

/** 잔량은 `on_hand_qty` 하나로만 준다 — 나머지 세 수량은 기본값 0 이다. */
export async function createBalance(
  prisma: PrismaService,
  args: {
    refs: InventoryRefs;
    legalEntityId: bigint;
    businessUnitId: bigint;
    plantId: bigint;
    warehouseId: bigint;
    locationId: bigint;
    onHandQty: number;
  },
): Promise<void> {
  await prisma.inventory_balance.create({
    data: {
      legal_entity_id: args.legalEntityId,
      business_unit_id: args.businessUnitId,
      plant_id: args.plantId,
      warehouse_id: args.warehouseId,
      location_id: args.locationId,
      item_id: args.refs.itemId,
      uom_id: args.refs.uomId,
      quality_status_code: 'OK',
      inventory_status_code: 'AVAILABLE',
      ownership_type_code: 'OWNED',
      on_hand_qty: args.onHandQty,
    },
  });
}

/** 창고를 지우기 전에 불러야 한다 — 잔량·로케이션이 창고를 FK 로 가리킨다. */
export async function deleteWarehouseContents(
  prisma: PrismaService,
  prefix: string,
): Promise<void> {
  const warehouses = await prisma.warehouse.findMany({
    where: { warehouse_code: { startsWith: prefix } },
    select: { warehouse_id: true },
  });
  const warehouseIds = warehouses.map((row) => row.warehouse_id);

  await prisma.inventory_balance.deleteMany({ where: { warehouse_id: { in: warehouseIds } } });
  await prisma.location.deleteMany({ where: { warehouse_id: { in: warehouseIds } } });
}

export async function deleteInventoryRefs(prisma: PrismaService, prefix: string): Promise<void> {
  await prisma.item.deleteMany({ where: { item_code: { startsWith: prefix } } });
  await prisma.uom.deleteMany({ where: { uom_code: { startsWith: prefix } } });
}
