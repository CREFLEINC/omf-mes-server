import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';

type Db = Pick<Prisma.TransactionClient, 'product_lot_split'>;

export const LOT_SPLIT_UNCONFIRMED = 'LOT_SPLIT_UNCONFIRMED';

/** 확인 전(PDA 두 라벨 확인 전) 분리의 원래·자식으로 걸린 LOT(피처 013 FR-011). */
export async function unconfirmedSplitLots(db: Db, lotIds: readonly bigint[]): Promise<Set<bigint>> {
  if (lotIds.length === 0) return new Set();
  const ids = [...lotIds];
  const rows = await db.product_lot_split.findMany({
    where: { confirmed_at: null, OR: [{ parent_lot_id: { in: ids } }, { child_lot_id: { in: ids } }] },
    select: { parent_lot_id: true, child_lot_id: true },
  });
  const hit = new Set(rows.flatMap((row) => [row.parent_lot_id, row.child_lot_id]));
  return new Set(ids.filter((id) => hit.has(id)));
}

/** 출하 피킹의 확인 전 분리 거절 — 409 `LOT_SPLIT_UNCONFIRMED`(라벨을 안 붙인 LOT 이 나가지 않게). */
export async function assertNoUnconfirmedSplit(db: Db, lotId: bigint): Promise<void> {
  if ((await unconfirmedSplitLots(db, [lotId])).size === 0) return;
  throw new ConflictException('user', '분리 확인 전인 LOT 입니다. PDA 「LOT 분리 확인」에서 두 라벨을 먼저 스캔하세요.', { code: LOT_SPLIT_UNCONFIRMED });
}
