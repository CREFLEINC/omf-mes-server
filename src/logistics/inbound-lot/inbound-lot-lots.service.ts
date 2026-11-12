import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import {
  INBOUND_LOT_RECEIVING, LotHoldService, LotLifecycleService, LotQualityStatusService, unregisterMaterialLotsWithin,
} from '../../core/lot';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { lastRegistrations, recordInboundLotEvent } from './inbound-lot-event';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';

export interface InboundLotUnregister {
  lotIds: number[];
  versionNo: number;
}

export interface InboundLotSupplierLotSet {
  lotIds: number[];
  supplierLotNo: string | null;
}

export interface InboundLotSupplierLotResult {
  lots: { lotId: number; lotNo: string; supplierLotNo: string | null }[];
}

const SUPPLIER_LOT = 'SUPPLIER_LOT';
const SUPPLIER_LOT_NO_MAX = 100;
const CANCELLED = 'CANCELLED';
const VOIDED = 'VOIDED';

interface LockedInboundLot {
  inbound_lot_id: bigint;
  plant_id: bigint;
  item_id: bigint;
  supplier_id: bigint;
  status_code: string;
  version_no: number;
  inbound_receipt_line_id: bigint;
}

/** 입하 LOT 의 자재 관리 LOT 해제·공급사 LOT 번호(피처 005 §3 · R-5). 둘 다 입하 중(`RECEIVING`)일 때만이다. */
@Injectable()
export class InboundLotLotsService {
  constructor(
    private readonly lifecycle: LotLifecycleService,
    private readonly quality: LotQualityStatusService,
    private readonly holds: LotHoldService,
  ) {}

  /**
   * 등록 해제. LOT 을 먼저(`lot_id` 오름차순) 잠그고 입하 LOT 을 잠근다 — 받기와 같은 순서다.
   * 마지막 LOT 을 풀면 입하 줄·헤더를 취소하고 입하 LOT 을 `VOIDED` 로 — 열린 자리를 비워 같은 조합의 다음 받기가 새로 연다(R-20).
   * ⚠ 줄 수량은 `CHECK (received_qty > 0)` 이라 마지막 해제에서는 줄이지 않고 줄을 취소한다.
   */
  async unregister(tx: Prisma.TransactionClient, inboundLotId: number, body: InboundLotUnregister, actor: LogisticsWriteActor): Promise<InboundLotView> {
    const lotIds = [...new Set(body.lotIds.map((id) => BigInt(id)))];
    if (lotIds.length !== body.lotIds.length) throw one(field('lotIds', ERROR_CODE.INVALID, '같은 LOT 을 두 번 실었습니다.'));
    await this.holds.lockLotsWithin(tx, lotIds);
    const inboundLot = await lockInboundLot(tx, inboundLotId);
    // 다른 PDA 의 받기·해제가 먼저 바꿨으면 다시 읽어 와야 한다(재로드로 풀린다).
    assertUpdated(inboundLot.version_no === body.versionNo ? 1 : 0);
    assertReceiving(inboundLot, '해제할');
    const lots = await tx.lot.findMany({
      where: { lot_id: { in: lotIds }, inbound_lot_id: inboundLot.inbound_lot_id },
      select: { lot_id: true, lot_no: true, initial_qty: true, package_uom_id: true, package_count: true, qty_per_package: true },
    });
    if (lots.length !== lotIds.length) throw one(field('lotIds', ERROR_CODE.INVALID, '이 입하 LOT 의 자재 관리 LOT 이 아닌 것이 섞여 있습니다.'));

    const at = new Date();
    const registered = await lastRegistrations(tx, inboundLot.inbound_lot_id);
    const targets: { lotId: bigint; batchId: bigint }[] = [];
    for (const lot of lots) {
      const batchId = registered.get(String(lot.lot_id))?.batchId;
      targets.push({ lotId: lot.lot_id, batchId: batchId == null ? await this.labelBatch(tx, inboundLot, lot, actor) : BigInt(batchId) });
    }
    await unregisterMaterialLotsWithin(tx, { lifecycle: this.lifecycle, quality: this.quality, holds: this.holds },
      { inboundLotId: inboundLot.inbound_lot_id, lots: targets, actor, at });
    const qty = lots.reduce((sum, lot) => sum.plus(lot.initial_qty), new Prisma.Decimal(0));
    const remaining = await tx.lot.count({ where: { inbound_lot_id: inboundLot.inbound_lot_id } });
    await recordInboundLotEvent(tx, inboundLot.inbound_lot_id, 'LOTS_UNREGISTERED', actor, {
      lots: lots.map((lot) => ({ lotId: String(lot.lot_id), lotNo: lot.lot_no, lotQty: lot.initial_qty.toString() })),
    }, at);
    await this.shrink(tx, inboundLot, qty, remaining === 0, actor, at);
    if (actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, {
        actor: actor.terminalAudit, targetTypeCode: 'INBOUND_LOT', targetId: inboundLot.inbound_lot_id, eventTypeCode: 'LOTS_UNREGISTERED',
      });
    }
    const [view] = await loadInboundLotViews(tx, { inbound_lot_id: inboundLot.inbound_lot_id });
    return view;
  }

  /**
   * 사전부착 라벨로 받기 때 만든 LOT 은 되돌릴 발행 묶음이 없다 — 그 LOT 하나짜리 묶음을 이 자리에서 만든다. 대기 목록·발행 묶음
   * 목록에 다시 보이고, 같은 라벨을 다시 스캔하면 그 LOT 으로 받는다. 채널은 행위자로 가른다(단말 작업자 = POP, 계정 = WEB).
   */
  private async labelBatch(
    tx: Prisma.TransactionClient, inboundLot: LockedInboundLot,
    lot: { lot_id: bigint; initial_qty: Prisma.Decimal; package_uom_id: bigint | null; package_count: number | null; qty_per_package: Prisma.Decimal | null },
    actor: LogisticsWriteActor,
  ): Promise<bigint> {
    const supplierLot = await tx.lot_external_identifier.findFirst({
      where: { lot_id: lot.lot_id, identifier_type_code: SUPPLIER_LOT }, select: { external_identifier: true },
      orderBy: { lot_external_identifier_id: 'asc' },
    });
    const batch = await tx.material_lot_batch.create({
      data: {
        plant_id: inboundLot.plant_id, item_id: inboundLot.item_id, supplier_id: inboundLot.supplier_id, lot_qty: lot.initial_qty,
        package_uom_id: lot.package_uom_id, package_count: lot.package_count, qty_per_package: lot.qty_per_package,
        supplier_lot_no: supplierLot?.external_identifier.slice(0, SUPPLIER_LOT_NO_MAX) ?? null, lot_count: 1,
        created_channel_code: actor.appUserId === undefined ? 'POP' : 'WEB',
        created_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId), created_worker_id: actor.workerId ?? null,
      },
      select: { material_lot_batch_id: true },
    });
    return batch.material_lot_batch_id;
  }

  /** 줄 수량을 줄이거나(남은 LOT 이 있으면), 줄·헤더를 취소하고 입하 LOT 을 `VOIDED` 로(마지막 해제). */
  private async shrink(
    tx: Prisma.TransactionClient, inboundLot: LockedInboundLot, qty: Prisma.Decimal, emptied: boolean, actor: LogisticsWriteActor, at: Date,
  ): Promise<void> {
    const by = actor.appUserId === undefined ? null : BigInt(actor.appUserId);
    const line = await tx.inbound_receipt_line.update({
      where: { inbound_receipt_line_id: inboundLot.inbound_receipt_line_id },
      data: emptied ? { status_code: CANCELLED, updated_by: by } : { received_qty: { decrement: qty }, updated_by: by },
      select: { inbound_receipt_id: true },
    });
    await tx.inbound_lot.update({
      where: { inbound_lot_id: inboundLot.inbound_lot_id },
      data: { version_no: { increment: 1 }, updated_by: by, ...(emptied ? { status_code: VOIDED, open_since_date: null } : {}) },
    });
    if (!emptied) return;
    const alive = await tx.inbound_receipt_line.count({ where: { inbound_receipt_id: line.inbound_receipt_id, status_code: { notIn: [CANCELLED] } } });
    if (alive === 0) {
      await tx.inbound_receipt.update({ where: { inbound_receipt_id: line.inbound_receipt_id }, data: { status_code: CANCELLED, updated_by: by } });
    }
    await recordInboundLotEvent(tx, inboundLot.inbound_lot_id, 'VOIDED', actor, {}, at);
  }

  /** 공급사 LOT 번호 넣기·바꾸기·지우기(N:1). 입하 LOT `versionNo` 를 받지 않는다 — 마지막 저장이 이긴다. */
  async setSupplierLotNo(
    tx: Prisma.TransactionClient, inboundLotId: number, body: InboundLotSupplierLotSet, actor: LogisticsWriteActor,
  ): Promise<InboundLotSupplierLotResult> {
    const value = body.supplierLotNo?.trim() || null;
    if (body.lotIds.length === 0) throw one(field('lotIds', ERROR_CODE.INVALID, '자재 관리 LOT 을 고르세요.'));
    if ((value?.length ?? 0) > SUPPLIER_LOT_NO_MAX) {
      throw one(field('supplierLotNo', ERROR_CODE.RANGE, `공급사 LOT 번호는 ${String(SUPPLIER_LOT_NO_MAX)}자 안입니다.`));
    }
    const lotIds = [...new Set(body.lotIds.map((id) => BigInt(id)))];
    const inboundLot = await lockInboundLot(tx, inboundLotId);
    assertReceiving(inboundLot, '공급사 LOT 번호를 바꿀');
    const lots = await tx.lot.findMany({
      where: { lot_id: { in: lotIds }, inbound_lot_id: inboundLot.inbound_lot_id },
      select: { lot_id: true, lot_no: true, lot_external_identifier: { where: { identifier_type_code: SUPPLIER_LOT }, select: { external_identifier: true } } },
      orderBy: { lot_id: 'asc' },
    });
    if (lots.length !== lotIds.length) throw one(field('lotIds', ERROR_CODE.INVALID, '이 입하 LOT 의 자재 관리 LOT 이 아닌 것이 섞여 있습니다.'));
    const at = new Date();
    const by = actor.appUserId === undefined ? null : BigInt(actor.appUserId);
    for (const lot of lots) {
      const before = lot.lot_external_identifier[0]?.external_identifier ?? null;
      await tx.lot_external_identifier.deleteMany({ where: { lot_id: lot.lot_id, identifier_type_code: SUPPLIER_LOT } });
      if (value !== null) {
        await tx.lot_external_identifier.create({
          data: { lot_id: lot.lot_id, identifier_type_code: SUPPLIER_LOT, external_identifier: value, partner_id: inboundLot.supplier_id, created_by: by },
        });
      }
      await recordInboundLotEvent(tx, inboundLot.inbound_lot_id, 'SUPPLIER_LOT_SET', actor,
        { lotId: String(lot.lot_id), lotNo: lot.lot_no, before, after: value }, at);
    }
    if (actor.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, {
        actor: actor.terminalAudit, targetTypeCode: 'INBOUND_LOT', targetId: inboundLot.inbound_lot_id, eventTypeCode: 'SUPPLIER_LOT_SET',
      });
    }
    return { lots: lots.map((lot) => ({ lotId: Number(lot.lot_id), lotNo: lot.lot_no, supplierLotNo: value })) };
  }
}

async function lockInboundLot(tx: Prisma.TransactionClient, inboundLotId: number): Promise<LockedInboundLot> {
  const rows = await tx.$queryRaw<LockedInboundLot[]>`
    SELECT inbound_lot_id, plant_id, item_id, supplier_id, status_code, version_no, inbound_receipt_line_id
      FROM trace.inbound_lot
     WHERE inbound_lot_id = ${BigInt(inboundLotId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 입하 LOT 입니다.');
  return rows[0];
}

/** 입하 중이 아니면(마감·최종 마감·폐기) 구성을 못 바꾼다 — 마감 취소가 먼저다. */
function assertReceiving(inboundLot: LockedInboundLot, action: string): void {
  if (inboundLot.status_code === INBOUND_LOT_RECEIVING) return;
  throw new ContractException(HttpStatus.CONFLICT, [{
    scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: `입하 중인 입하 LOT 만 ${action} 수 있습니다.`,
  }]);
}
