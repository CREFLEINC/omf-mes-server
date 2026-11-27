import { Prisma } from '@prisma/client';

import { PUTAWAY_STAGING, WAREHOUSE_WHOLE } from '../../common/master';

/**
 * 생산 창고 판정(피처 004 · research R-3·R-7). 생산 창고 = 유형이 생산창고인 활성 창고 — 한 공장의 모든 라인이
 * 같은 생산 창고들을 쓴다(사용자 결정 2026-11-25 · 부서 연결을 대신함). 창고 보충의 요청·관리 품목·자동 보충과
 * 출고 요청의 출발 창고(`source-warehouse.ts`)가 같은 정의를 쓴다.
 */

export const PRODUCTION_WAREHOUSE = 'PRODUCTION';

type Db = Pick<Prisma.TransactionClient, 'warehouse' | 'location'>;

/** 공장의 생산 창고 — 그 공장의 활성 생산창고(창고 번호 순). */
export async function plantProductionWarehouses(db: Db, plantId: bigint): Promise<bigint[]> {
  const rows = await db.warehouse.findMany({
    where: { plant_id: plantId, warehouse_type_code: PRODUCTION_WAREHOUSE, is_active: true },
    select: { warehouse_id: true },
    orderBy: { warehouse_id: 'asc' },
  });
  return rows.map((row) => row.warehouse_id);
}

export async function isProductionWarehouse(db: Db, warehouseId: bigint): Promise<boolean> {
  const row = await db.warehouse.findFirst({
    where: { warehouse_id: warehouseId, warehouse_type_code: PRODUCTION_WAREHOUSE, is_active: true },
    select: { warehouse_id: true },
  });
  return row !== null;
}

/**
 * 나뉜 창고 = 사람이 만든(시스템 역할 없는) 활성 위치가 하나라도 있다. 적치 허용 위치(`allowed-locations.ts`)와
 * 같은 정의다 — 다르면 수령 때 적치 지시를 만들었는데 둘 곳이 없거나, 둘 곳이 있는데 지시가 없다.
 */
export async function isDividedWarehouse(db: Db, warehouseId: bigint): Promise<boolean> {
  const row = await db.location.findFirst({
    where: { warehouse_id: warehouseId, is_active: true, system_role_code: null },
    select: { location_id: true },
  });
  return row !== null;
}

/** 보충 출고의 도착 위치 — 나뉜 창고는 적치 대기, 아니면 창고 전체(R-7). 창고마다 트리거가 둘 다 만든다. */
export async function arrivalLocationId(db: Db, warehouseId: bigint): Promise<bigint> {
  const { role, locationId } = await arrivalOf(db, warehouseId);
  if (locationId === null) throw new Error(`창고 ${warehouseId} 에 ${role} 위치가 없다`);
  return locationId;
}

/** `arrivalLocationId` 와 같은 규칙 — 그 위치가 없으면 던지지 않고 null 이다(보여 주기만 하는 자리). DB 오류는 그대로 던진다. */
export async function findArrivalLocationId(db: Db, warehouseId: bigint): Promise<bigint | null> {
  return (await arrivalOf(db, warehouseId)).locationId;
}

async function arrivalOf(db: Db, warehouseId: bigint): Promise<{ role: string; locationId: bigint | null }> {
  const role = (await isDividedWarehouse(db, warehouseId)) ? PUTAWAY_STAGING : WAREHOUSE_WHOLE;
  const row = await db.location.findFirst({
    where: { warehouse_id: warehouseId, system_role_code: role },
    select: { location_id: true },
  });
  return { role, locationId: row?.location_id ?? null };
}
