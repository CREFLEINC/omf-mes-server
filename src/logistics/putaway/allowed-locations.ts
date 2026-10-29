import { Prisma } from '@prisma/client';

import { WAREHOUSE_WHOLE } from '../../common/master';

export interface AllowedLocation {
  locationId: number; locationCode: string; locationName: string; locationLevelCode: string | null;
}

export interface AllowedPair { itemId: bigint; warehouseId: bigint }

export const allowedKey = (pair: AllowedPair): string => `${pair.itemId}:${pair.warehouseId}`;

const LOCATION_SELECT = {
  location_id: true, warehouse_id: true, location_code: true, location_name: true, location_level_code: true,
} as const;

/**
 * 적치 지시의 둬도 되는 위치(사용자 결정 2026-10-29 · 적치 규칙 제거) — 그 창고에서 이 품목을 보관 품목으로 걸어 둔,
 * 켜진 맨 아래 위치 전부(코드 순). 저장하지 않고 읽을 때 계산한다 — 보관 품목을 바꾸면 대기 중 지시에 바로 반영된다.
 * 사람이 만든 켜진 위치가 없는 창고는 「창고 전체」 하나다(장부 P-149) — 창고 단위로 두는 창고에서 갈 곳이 그 하나뿐이다.
 * 질의 수는 쌍 수와 상관없이 셋 이하다 — 목록 한 쪽을 한 번에 계산한다.
 */
export async function allowedLocationsOf(
  db: Pick<Prisma.TransactionClient, 'location' | 'location_item'>,
  pairs: readonly AllowedPair[],
): Promise<Map<string, AllowedLocation[]>> {
  const result = new Map<string, AllowedLocation[]>();
  if (pairs.length === 0) return result;
  const warehouseIds = [...new Set(pairs.map((pair) => pair.warehouseId))];
  const divided = new Set((await db.location.groupBy({
    by: ['warehouse_id'],
    where: { warehouse_id: { in: warehouseIds }, is_active: true, system_role_code: null },
  })).map((row) => row.warehouse_id));
  const undivided = warehouseIds.filter((id) => !divided.has(id));
  const whole = undivided.length > 0
    ? await db.location.findMany({
      where: { warehouse_id: { in: undivided }, is_active: true, system_role_code: WAREHOUSE_WHOLE },
      select: LOCATION_SELECT,
    })
    : [];
  const held = divided.size > 0
    ? await db.location_item.findMany({
      where: {
        item_id: { in: [...new Set(pairs.map((pair) => pair.itemId))] },
        // 「켜진 하위 없음」은 재고 코어의 맨 아래 판정(`leaf-location.ts`)과 같은 정의다 — 다르면 목록에 있는 위치가 전기에서 막힌다.
        location: { warehouse_id: { in: [...divided] }, is_active: true, child_locations: { none: { is_active: true } } },
      },
      select: { item_id: true, location: { select: LOCATION_SELECT } },
      orderBy: { location: { location_code: 'asc' } },
    })
    : [];
  for (const pair of pairs) {
    const locations = divided.has(pair.warehouseId)
      ? held.filter((row) => row.item_id === pair.itemId && row.location.warehouse_id === pair.warehouseId).map((row) => row.location)
      : whole.filter((row) => row.warehouse_id === pair.warehouseId);
    result.set(allowedKey(pair), locations.map(view));
  }
  return result;
}

function view(row: { location_id: bigint; location_code: string; location_name: string; location_level_code: string | null }): AllowedLocation {
  return {
    locationId: Number(row.location_id), locationCode: row.location_code,
    locationName: row.location_name, locationLevelCode: row.location_level_code,
  };
}
