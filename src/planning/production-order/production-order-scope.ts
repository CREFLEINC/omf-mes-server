import { Prisma } from '@prisma/client';

import { plantDenied, scopedPlantWhere } from '../../app/dashboard/dashboard-scope';

/**
 * 사용자 데이터 범위가 허락하는 공장 id — 범위 줄이 없으면 null(제한 없음). 규칙은 대시보드와 같은 `scopedPlantWhere` 가 맡는다.
 * 비활성 공장도 범위 안이면 넣는다 — 이미 받은 ERP W/O 는 공장이 꺼져도 계속 다뤄야 한다.
 */
export async function scopedPlantIds(client: Prisma.TransactionClient, actorUserId: number): Promise<bigint[] | null> {
  const scoped = await scopedPlantWhere(client, actorUserId);
  if (scoped === null) return null;
  const rows = await client.plant.findMany({ where: scoped, select: { plant_id: true } });
  return rows.map((row) => row.plant_id);
}

/** 고른 공장 `plantId` 가 범위 밖이면 403(대시보드와 같은 모양). 통과하면 범위를 돌려준다. */
export async function plantScopeFor(
  client: Prisma.TransactionClient,
  actorUserId: number,
  plantId?: number,
): Promise<bigint[] | null> {
  const ids = await scopedPlantIds(client, actorUserId);
  if (ids !== null && plantId !== undefined && !ids.includes(BigInt(plantId))) throw plantDenied();
  return ids;
}

export function scopeWhere(ids: bigint[] | null): Prisma.production_orderWhereInput {
  return ids === null ? {} : { plant_id: { in: ids } };
}

/** 오더 별칭 `o`. 범위가 비었으면(공장이 하나도 없다) 아무것도 안 맞는다 — 빈 `IN` 은 SQL 오류다. */
export function scopeSql(ids: bigint[] | null): Prisma.Sql[] {
  if (ids === null) return [];
  return [ids.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`o.plant_id IN (${Prisma.join(ids)})`];
}
