import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface RequestLotKey {
  lot_id: bigint | null;
  /** 옛 호출자·목은 이 칸을 모를 수 있다 — 없으면 NULL 과 같다. */
  inbound_lot_id?: bigint | null;
}

/**
 * 「요청의 LOT 들」 — `lot_id` 가 있으면 그 LOT 하나(옛 IQC 행·이전된 옛 요청·PQC·OQC), 없으면 입하 LOT 의
 * 자재 관리 LOT 전부(분할 자식도 `inbound_lot_id` 를 이어받아 함께 온다 · 피처 005 R-9).
 * ⛔ 이전된 옛 요청은 `inbound_lot_id` 도 갖지만 `lot_id` 를 먼저 본다 — 옛 선별 자식까지 끌어오면 결과가 바뀐다.
 */
export async function requestLotIds(tx: Tx, request: RequestLotKey): Promise<bigint[]> {
  if (request.lot_id !== null) return [request.lot_id];
  if ((request.inbound_lot_id ?? null) === null) return [];
  const lots = await tx.lot.findMany({
    where: { inbound_lot_id: request.inbound_lot_id as bigint },
    orderBy: { lot_id: 'asc' },
    select: { lot_id: true },
  });
  return lots.map((lot) => lot.lot_id);
}
