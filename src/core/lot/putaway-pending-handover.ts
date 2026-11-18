import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationEmitter } from '../notification';

type Tx = Prisma.TransactionClient;

/** 적치를 기다리는 LOT 상태 — 합격·무검사는 정상, 불합격은 불량(불량창고에 적치한다). */
const PUTTABLE = ['NORMAL', 'DEFECTIVE'];

export type PutawayPendingActor = { appUserId?: number | bigint; workerId?: bigint } | null;

/**
 * 인계 작업 「적치 대기」(피처 009 · omf-all-around#294 · research R-9) — PDA 에서 적치(=입고)할 자재 관리 LOT 이 생길 때.
 * 입하 LOT 단위로 한 번(IQC 판정 확정 · 검사 불필요·생략 품목은 입하 마감), 005 이전 흐름 IQC 단건 확정은 LOT 하나로.
 * 공장 = LOT 공장. 적치할 LOT 이 없으면(보류 확정·검사 대기 마감) 보내지 않는다. 확정 취소·마감 취소 뒤 다시 확정·마감하면
 * 다시 알린다(`repeatable`).
 * ⛔ 입고 1건 = 지시 n건 인 「적치」(PUTAWAY_REQUESTED)는 제품·반품 입고용으로 남는다.
 */
@Injectable()
export class PutawayPendingNotifier {
  constructor(private readonly emitter: NotificationEmitter) {}

  async inboundLot(tx: Tx, inboundLotId: bigint, actor: PutawayPendingActor): Promise<void> {
    await this.emitter.guarded(tx, `PUTAWAY_PENDING INBOUND_LOT ${inboundLotId}`, async () => {
      const inbound = await tx.inbound_lot.findUniqueOrThrow({
        where: { inbound_lot_id: inboundLotId },
        select: { inbound_lot_no: true, plant_id: true, item: { select: { item_code: true, item_name: true } } },
      });
      const lotCount = await tx.lot.count({ where: { inbound_lot_id: inboundLotId, status_code: { in: PUTTABLE } } });
      if (lotCount === 0) return;
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'PUTAWAY_PENDING', plantId: inbound.plant_id, aggregateTypeCode: 'INBOUND_LOT', aggregateId: inboundLotId,
        occurredAt: new Date(), repeatable: true,
        values: {
          inbound_lot_no: inbound.inbound_lot_no, item: `${inbound.item.item_code} ${inbound.item.item_name}`,
          lot_count: lotCount, actor: await actorName(tx, actor),
        },
      });
    }, undefined);
  }

  /** 005 이전 흐름 IQC 단건 확정 — 대상 LOT 하나. 입하 LOT 번호가 없으면 LOT 번호를 싣는다. */
  async lot(tx: Tx, lotId: bigint, actor: PutawayPendingActor): Promise<void> {
    await this.emitter.guarded(tx, `PUTAWAY_PENDING LOT ${lotId}`, async () => {
      const lot = await tx.lot.findUniqueOrThrow({
        where: { lot_id: lotId },
        select: {
          lot_no: true, plant_id: true, status_code: true, item: { select: { item_code: true, item_name: true } },
          inbound_lot: { select: { inbound_lot_no: true } },
        },
      });
      if (!PUTTABLE.includes(lot.status_code)) return;
      await this.emitter.emitHandover(tx, {
        alertTypeCode: 'PUTAWAY_PENDING', plantId: lot.plant_id, aggregateTypeCode: 'LOT', aggregateId: lotId,
        occurredAt: new Date(), repeatable: true,
        values: {
          inbound_lot_no: lot.inbound_lot?.inbound_lot_no ?? lot.lot_no, item: `${lot.item.item_code} ${lot.item.item_name}`,
          lot_count: 1, actor: await actorName(tx, actor),
        },
      });
    }, undefined);
  }
}

async function actorName(tx: Tx, actor: PutawayPendingActor): Promise<string | null> {
  if (actor?.appUserId !== undefined) {
    return (await tx.app_user.findUnique({ where: { app_user_id: BigInt(actor.appUserId) }, select: { user_name: true } }))?.user_name ?? null;
  }
  if (actor?.workerId !== undefined) {
    return (await tx.worker.findUnique({ where: { worker_id: actor.workerId }, select: { worker_name: true } }))?.worker_name ?? null;
  }
  return null;
}
