import { Prisma } from '@prisma/client';

import type { InboundLotActor } from '../../core/lot';

/** 입하 LOT 이력(`trace.inbound_lot_event` · `INBOUND_LOT_EVENT_TYPE`). 행위자가 둘 다 비면 시스템이다. */
export type InboundLotEventCode =
  | 'CREATED_BY_RECEIVE' | 'LOTS_REGISTERED' | 'LOTS_UNREGISTERED' | 'SUPPLIER_LOT_SET' | 'VOIDED';

/**
 * `LOTS_REGISTERED.summary.lots[]` 한 줄. 해제가 `batchId` 로 원천 묶음을 되돌리고, 상세가 `fromSupplierLabel`·등록 시각을
 * 여기서 읽는다 — 받기가 원천을 입하 줄로 바꾸면 묶음을 되짚을 칸이 LOT 에 남지 않기 때문이다.
 */
export interface RegisteredLotSummary {
  lotId: string;
  lotNo: string;
  lotQty: string;
  batchId: string | null;
  fromSupplierLabel: boolean;
}

export async function recordInboundLotEvent(
  tx: Prisma.TransactionClient,
  inboundLotId: bigint,
  eventTypeCode: InboundLotEventCode,
  actor: InboundLotActor,
  summary: Prisma.InputJsonObject,
  at: Date,
): Promise<void> {
  await tx.inbound_lot_event.create({
    data: {
      inbound_lot_id: inboundLotId,
      event_type_code: eventTypeCode,
      summary,
      occurred_at: at,
      actor_user_id: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
      actor_worker_id: actor.workerId ?? null,
    },
  });
}

/** 이 입하 LOT 의 받기 이벤트들에서 LOT 마다 «마지막» 등록 줄과 그 시각. */
export async function lastRegistrations(
  db: Pick<Prisma.TransactionClient, 'inbound_lot_event'>,
  inboundLotId: bigint,
): Promise<Map<string, RegisteredLotSummary & { at: Date }>> {
  const events = await db.inbound_lot_event.findMany({
    where: { inbound_lot_id: inboundLotId, event_type_code: 'LOTS_REGISTERED' },
    select: { summary: true, occurred_at: true },
    orderBy: [{ occurred_at: 'asc' }, { inbound_lot_event_id: 'asc' }],
  });
  const byLot = new Map<string, RegisteredLotSummary & { at: Date }>();
  for (const event of events) {
    const lots = (event.summary as { lots?: RegisteredLotSummary[] } | null)?.lots ?? [];
    for (const lot of lots) byLot.set(lot.lotId, { ...lot, at: event.occurred_at });
  }
  return byLot;
}
