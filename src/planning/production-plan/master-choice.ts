import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { usableWhere as usableRoutingWhere } from '../routing/routing.service';

/**
 * 계획이 쓸 BOM·Routing 을 고르는 규칙 — 계획 제안·목록의 기준정보 사유·수기 계획 검증이 이 한 벌을 쓴다.
 * 화면 W-02-02 가 계획 행에 미리 채우는 값(`master-check-pane.tsx` 의 `automaticBomId`·`automaticRoutingId`)과 같아야 한다 —
 * 갈리면 사람이 고른 값과 제안이 고른 값이 다르다.
 */
export const MASTER_REASONS = ['BOM_DEFAULT_REQUIRED', 'ROUTING_REQUIRED', 'ROUTING_DEFAULT_REQUIRED'] as const;
export type MasterReason = (typeof MASTER_REASONS)[number];

export interface RoutingCandidate {
  routingId: bigint;
  isDefault: boolean;
}

/** ERP 기본 BOM — 품목의 기본(`is_default`) BOM 이 하나뿐일 때만. ERP 받기가 새 판을 기본으로 올리고 옛 판의 기본을 내린다(`bom.apply.ts`). */
export function defaultBomOf(defaultBomIds: readonly bigint[]): bigint | null {
  return defaultBomIds.length === 1 ? defaultBomIds[0] : null;
}

/** 쓸 수 있는(확정·유효 기간 안) Routing 이 하나면 그것, 여럿이면 그중 기본 하나. */
export function chooseRouting(usable: readonly RoutingCandidate[]): { routingId: bigint | null; reason?: MasterReason } {
  if (usable.length === 0) return { routingId: null, reason: 'ROUTING_REQUIRED' };
  if (usable.length === 1) return { routingId: usable[0].routingId };
  const defaults = usable.filter((routing) => routing.isDefault);
  return defaults.length === 1 ? { routingId: defaults[0].routingId } : { routingId: null, reason: 'ROUTING_DEFAULT_REQUIRED' };
}

/** 계획을 세우지 못하게 막는 기준정보 — `MASTER_REASONS` 순서. */
export function masterReasonsOf(defaultBomIds: readonly bigint[], usable: readonly RoutingCandidate[]): MasterReason[] {
  const reasons: MasterReason[] = [];
  if (defaultBomOf(defaultBomIds) === null) reasons.push('BOM_DEFAULT_REQUIRED');
  const routing = chooseRouting(usable);
  if (routing.reason !== undefined) reasons.push(routing.reason);
  return reasons;
}

export interface DefaultBomRow {
  bom_id: bigint;
  parent_item_id: bigint;
  bom_code: string;
  bom_version: number;
  version_no: number;
}

export interface UsableRoutingRow {
  routing_id: bigint;
  item_id: bigint;
  routing_code: string;
  routing_version: number;
  is_default: boolean;
  status_code: string;
  effective_from: Date | null;
  effective_to: Date | null;
  version_no: number;
}

/** 품목 여럿의 기본 BOM 과 쓸 수 있는 Routing — 페이지·묶음 단위로 두 질의. */
export async function readMastersOf(
  client: Prisma.TransactionClient,
  itemIds: readonly bigint[],
): Promise<{ boms: Map<bigint, DefaultBomRow[]>; routings: Map<bigint, UsableRoutingRow[]> }> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return { boms: new Map(), routings: new Map() };
  const [boms, routings] = await Promise.all([
    client.bom.findMany({
      where: { parent_item_id: { in: ids }, is_default: true },
      orderBy: { bom_id: 'asc' },
      select: { bom_id: true, parent_item_id: true, bom_code: true, bom_version: true, version_no: true },
    }),
    client.routing.findMany({
      where: { item_id: { in: ids }, ...usableRoutingWhere() },
      orderBy: { routing_id: 'asc' },
      select: {
        routing_id: true, item_id: true, routing_code: true, routing_version: true, is_default: true,
        status_code: true, effective_from: true, effective_to: true, version_no: true,
      },
    }),
  ]);
  return { boms: group(boms, (row) => row.parent_item_id), routings: group(routings, (row) => row.item_id) };
}

/** 품목 여럿의 기준정보 사유 — 목록이 계획 전 오더에 싣는다. */
export async function masterReasonsByItem(client: Prisma.TransactionClient, itemIds: readonly bigint[]): Promise<Map<bigint, MasterReason[]>> {
  const { boms, routings } = await readMastersOf(client, itemIds);
  return new Map(
    [...new Set(itemIds)].map((itemId) => [
      itemId,
      masterReasonsOf(
        (boms.get(itemId) ?? []).map((bom) => bom.bom_id),
        (routings.get(itemId) ?? []).map((routing) => ({ routingId: routing.routing_id, isDefault: routing.is_default })),
      ),
    ]),
  );
}

/**
 * 작성중 계획의 BOM 은 품목의 지금 ERP 기본 BOM 이어야 한다 — 아니면 400 `BOM_NOT_DEFAULT`. 확정된 계획은 부르지 않는다(확정 당시 개정을 유지한다).
 * message 에 지금 기본 개정을 적는다 — 화면이 무엇으로 바꿔야 하는지 안다.
 */
export async function assertDefaultBom(
  client: Prisma.TransactionClient,
  bomId: number | bigint,
  itemId: bigint,
  fieldName = 'bomId',
): Promise<void> {
  const defaults = await client.bom.findMany({
    where: { parent_item_id: itemId, is_default: true },
    select: { bom_id: true, bom_code: true, bom_version: true },
  });
  const chosen = defaultBomOf(defaults.map((bom) => bom.bom_id));
  if (chosen !== null && chosen === BigInt(bomId)) return;
  const message =
    chosen === null
      ? '품목에 ERP 기본 BOM 이 하나로 정해져 있지 않습니다. 기준정보에서 기본 BOM 을 정한 뒤 다시 하세요.'
      : `품목의 ERP 기본 BOM 이 아닙니다 — 지금 기본은 ${defaults[0].bom_code} Rev ${defaults[0].bom_version} 입니다. BOM 을 바꾼 뒤 다시 하세요.`;
  throw one(field(fieldName, ERROR_CODE.BOM_NOT_DEFAULT, message));
}

function group<T>(rows: readonly T[], key: (row: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}
