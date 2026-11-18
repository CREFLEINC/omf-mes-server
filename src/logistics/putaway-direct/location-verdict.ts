import { Prisma } from '@prisma/client';

import { PUTAWAY_STAGING, WAREHOUSE_WHOLE } from '../../common/master';

/**
 * 지시 없는 적치의 위치 판정(피처 009 research R-5) — 위에서부터 처음 맞는 것이 답이다. 위치 확인(`location-check`)과
 * 적치 쓰기가 같은 함수를 부른다. 위치는 전역 유일 코드(#292)로 찾으므로 창고를 먼저 고르지 않는다.
 * ⛔ 품목 지정은 안내다(2026-11-18 결정) — 「지정 품목만 받기」를 켠 위치(7a)만 지정 밖 품목을 막는다.
 */
export type VerdictCode =
  | 'DESIGNATED' | 'UNDESIGNATED' | 'NOT_FOUND' | 'INACTIVE' | 'OTHER_PLANT' | 'STAGING' | 'NOT_LEAF'
  | 'DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE' | 'NORMAL_LOT_IN_DEFECT_WAREHOUSE' | 'RESTRICTED_LOCATION';

export const VERDICT_MESSAGES: Readonly<Record<VerdictCode, string>> = {
  DESIGNATED: '지정 위치입니다.',
  UNDESIGNATED: '지정된 위치가 아닙니다. 정말 적치합니까?',
  NOT_FOUND: '찾을 수 없는 위치입니다.',
  INACTIVE: '찾을 수 없는 위치입니다(사용하지 않는 위치).',
  OTHER_PLANT: '다른 공장 위치입니다.',
  STAGING: '적치 대기 자리에는 둘 수 없습니다.',
  NOT_LEAF: '구역·랙이 아니라 맨 아래 위치를 스캔하세요.',
  DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE: '불량 LOT 은 불량창고에만 둘 수 있습니다.',
  NORMAL_LOT_IN_DEFECT_WAREHOUSE: '정상 LOT 은 불량창고에 둘 수 없습니다.',
  RESTRICTED_LOCATION: '이 위치는 지정 품목만 받습니다.',
};

export interface VerdictLot { plantId: bigint; itemId: bigint; defective: boolean }

export interface VerdictLocation {
  locationId: bigint; locationCode: string; isActive: boolean;
  warehouseId: bigint; warehouseName: string; warehouseActive: boolean; warehousePlantId: bigint; isDefect: boolean;
  systemRoleCode: string | null; hasActiveChild: boolean; itemRestricted: boolean;
  designatedItemIds: bigint[];
  /** 사람이 만든 켜진 위치가 있는 창고 — 없으면 「창고 전체」 하나가 재고 자리다. */
  warehouseDivided: boolean;
}

/** 불량 규칙(6·7) — 임시 적치의 창고 판정도 이것만 본다(R-7). */
export function defectRuleVerdict(isDefectWarehouse: boolean, defectiveLot: boolean): VerdictCode | null {
  if (defectiveLot && !isDefectWarehouse) return 'DEFECT_LOT_NEEDS_DEFECT_WAREHOUSE';
  if (!defectiveLot && isDefectWarehouse) return 'NORMAL_LOT_IN_DEFECT_WAREHOUSE';
  return null;
}

export function verdictOf(location: VerdictLocation | null, lot: VerdictLot): VerdictCode {
  if (location === null) return 'NOT_FOUND';
  if (!location.isActive || !location.warehouseActive) return 'INACTIVE';
  if (location.warehousePlantId !== lot.plantId) return 'OTHER_PLANT';
  if (location.systemRoleCode === PUTAWAY_STAGING) return 'STAGING';
  if (location.hasActiveChild) return 'NOT_LEAF';
  const defect = defectRuleVerdict(location.isDefect, lot.defective);
  if (defect !== null) return defect;
  const designated = location.designatedItemIds.includes(lot.itemId);
  if (location.itemRestricted && !designated) return 'RESTRICTED_LOCATION';
  if (designated) return 'DESIGNATED';
  if (location.systemRoleCode === WAREHOUSE_WHOLE && !location.warehouseDivided) return 'DESIGNATED';
  return 'UNDESIGNATED';
}

/**
 * 미지정 위치 적치가 그 위치의 보관 품목에 이 품목을 더하는가(FR-017a) — 판정이 UNDESIGNATED 이고 사람이 만든 위치일 때뿐이다.
 * 시스템 자리(나뉜 창고의 「창고 전체」)는 UNDESIGNATED 여도 더하지 않는다. 판정 응답과 적치 쓰기가 같은 규칙을 쓴다.
 */
export function designationAddable(verdict: VerdictCode, location: Pick<VerdictLocation, 'systemRoleCode'> | null): boolean {
  return verdict === 'UNDESIGNATED' && location !== null && location.systemRoleCode === null;
}

type Db = Pick<Prisma.TransactionClient, 'location' | 'location_item' | 'warehouse'>;

/** 위치 하나의 판정 재료 — 코드(스캔) 또는 id(쓰기)로 찾는다. */
export async function loadVerdictLocation(db: Db, by: { locationCode: string } | { locationId: bigint }): Promise<VerdictLocation | null> {
  const row = await db.location.findFirst({
    where: 'locationCode' in by ? { location_code: by.locationCode } : { location_id: by.locationId },
    select: {
      location_id: true, location_code: true, is_active: true, system_role_code: true, item_restricted: true, warehouse_id: true,
      warehouse: { select: { warehouse_name: true, is_active: true, plant_id: true, is_defect: true } },
      location_item: { select: { item_id: true } },
      child_locations: { where: { is_active: true }, select: { location_id: true }, take: 1 },
    },
  });
  if (row === null) return null;
  const human = await db.location.findFirst({
    where: { warehouse_id: row.warehouse_id, is_active: true, system_role_code: null }, select: { location_id: true },
  });
  return {
    locationId: row.location_id, locationCode: row.location_code, isActive: row.is_active,
    warehouseId: row.warehouse_id, warehouseName: row.warehouse.warehouse_name, warehouseActive: row.warehouse.is_active,
    warehousePlantId: row.warehouse.plant_id, isDefect: row.warehouse.is_defect,
    systemRoleCode: row.system_role_code, hasActiveChild: row.child_locations.length > 0, itemRestricted: row.item_restricted,
    designatedItemIds: row.location_item.map((item) => item.item_id), warehouseDivided: human !== null,
  };
}

/** 위치 경로 — 「창고 › 구역 › 랙 › …」(이름). 부모를 거슬러 오른다. */
export async function locationPaths(db: Pick<Prisma.TransactionClient, 'location'>, locationIds: readonly bigint[]): Promise<Map<bigint, string>> {
  const known = new Map<bigint, { name: string; parent: bigint | null; warehouse: string }>();
  let frontier = [...new Set(locationIds)];
  for (let depth = 0; frontier.length > 0 && depth < 10; depth += 1) {
    const rows = await db.location.findMany({
      where: { location_id: { in: frontier } },
      select: { location_id: true, location_name: true, parent_location_id: true, warehouse: { select: { warehouse_name: true } } },
    });
    for (const row of rows) known.set(row.location_id, { name: row.location_name, parent: row.parent_location_id, warehouse: row.warehouse.warehouse_name });
    frontier = rows.map((row) => row.parent_location_id).filter((id): id is bigint => id !== null && !known.has(id));
  }
  const paths = new Map<bigint, string>();
  for (const id of locationIds) {
    const names: string[] = [];
    let current = known.get(id);
    for (let depth = 0; current !== undefined && depth < 10; depth += 1) {
      names.unshift(current.name);
      current = current.parent === null ? undefined : known.get(current.parent);
    }
    const warehouse = known.get(id)?.warehouse;
    if (warehouse !== undefined) paths.set(id, [warehouse, ...names].join(' › '));
  }
  return paths;
}

export interface DesignatedLocationView { locationId: number; locationCode: string; locationPath: string; aliasName?: string }
export interface DesignatedGroupView { warehouseId: number; warehouseName: string; isDefect: boolean; locations: DesignatedLocationView[] }
export interface TemporaryWarehouseView { warehouseId: number; warehouseName: string; isDefect: boolean; designatedCount: number }

/**
 * 그 LOT 의 지정 위치(FR-014) — 공장 안 활성 창고 중 불량 규칙(6·7)에 맞는 창고에서 판정 8·9 에 맞는 위치를 창고별로.
 * 지정 위치가 없는 창고는 빠진다. 임시 적치 창고(US4-1)는 불량 규칙에 맞는 활성 창고 전부 — 지정 위치가 있는 창고가 위.
 */
export async function designationsOf(db: Db, lot: VerdictLot): Promise<{ designated: DesignatedGroupView[]; temporaryWarehouses: TemporaryWarehouseView[] }> {
  const warehouses = await db.warehouse.findMany({
    where: { plant_id: lot.plantId, is_active: true, is_defect: lot.defective },
    select: { warehouse_id: true, warehouse_name: true, is_defect: true },
    orderBy: { warehouse_code: 'asc' },
  });
  const ids = warehouses.map((row) => row.warehouse_id);
  const divided = new Set((await db.location.groupBy({
    by: ['warehouse_id'], where: { warehouse_id: { in: ids }, is_active: true, system_role_code: null },
  })).map((row) => row.warehouse_id));
  const select = { location_id: true, location_code: true, alias_name: true, warehouse_id: true } as const;
  const [held, whole] = await Promise.all([
    db.location_item.findMany({
      where: {
        item_id: lot.itemId,
        location: {
          warehouse_id: { in: ids }, is_active: true, child_locations: { none: { is_active: true } },
          OR: [{ system_role_code: null }, { system_role_code: { not: PUTAWAY_STAGING } }],
        },
      },
      select: { location: { select } },
      orderBy: { location: { location_code: 'asc' } },
    }),
    db.location.findMany({
      where: { warehouse_id: { in: ids.filter((id) => !divided.has(id)) }, is_active: true, system_role_code: WAREHOUSE_WHOLE },
      select,
    }),
  ]);
  const rows = [...held.map((row) => row.location), ...whole.filter((row) => !held.some((h) => h.location.location_id === row.location_id))];
  const paths = await locationPaths(db, rows.map((row) => row.location_id));
  const groups = warehouses.map((warehouse) => ({
    warehouseId: Number(warehouse.warehouse_id), warehouseName: warehouse.warehouse_name, isDefect: warehouse.is_defect,
    locations: rows.filter((row) => row.warehouse_id === warehouse.warehouse_id).map((row) => ({
      locationId: Number(row.location_id), locationCode: row.location_code, locationPath: paths.get(row.location_id) ?? row.location_code,
      ...(row.alias_name === null ? {} : { aliasName: row.alias_name }),
    })),
  }));
  const temporaryWarehouses = groups
    .map((group) => ({ warehouseId: group.warehouseId, warehouseName: group.warehouseName, isDefect: group.isDefect, designatedCount: group.locations.length }))
    .sort((a, b) => Number(b.designatedCount > 0) - Number(a.designatedCount > 0));
  return { designated: groups.filter((group) => group.locations.length > 0), temporaryWarehouses };
}
