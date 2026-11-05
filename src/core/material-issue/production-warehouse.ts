import { Prisma } from '@prisma/client';

import { PUTAWAY_STAGING, WAREHOUSE_WHOLE } from '../../common/master';

/**
 * 생산 창고 판정(피처 004 · research R-3·R-7). 생산 창고 = 부서 생산 창고로 연결된 활성 창고(003 의 공장 모드
 * `usesProductionWarehouses` 와 같은 연결 표). 창고 보충의 요청·관리 품목·자동 보충이 같은 정의를 쓴다.
 */

type Db = Pick<Prisma.TransactionClient, 'department_production_warehouse' | 'location'>;

/** 공장의 생산 창고 — 어느 부서에든 연결된 그 공장의 활성 창고(중복 제거, 창고 번호 순). */
export async function plantProductionWarehouses(db: Db, plantId: bigint): Promise<bigint[]> {
  const rows = await db.department_production_warehouse.findMany({
    where: { warehouse: { plant_id: plantId, is_active: true } },
    select: { warehouse_id: true },
    distinct: ['warehouse_id'],
    orderBy: { warehouse_id: 'asc' },
  });
  return rows.map((row) => row.warehouse_id);
}

export async function isProductionWarehouse(db: Db, warehouseId: bigint): Promise<boolean> {
  const row = await db.department_production_warehouse.findFirst({
    where: { warehouse_id: warehouseId, warehouse: { is_active: true } },
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
  const role = (await isDividedWarehouse(db, warehouseId)) ? PUTAWAY_STAGING : WAREHOUSE_WHOLE;
  const row = await db.location.findFirst({
    where: { warehouse_id: warehouseId, system_role_code: role },
    select: { location_id: true },
  });
  if (row === null) throw new Error(`창고 ${warehouseId} 에 ${role} 위치가 없다`);
  return row.location_id;
}
