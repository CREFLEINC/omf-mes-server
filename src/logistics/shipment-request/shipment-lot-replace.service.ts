import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ConflictException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ 코어 파일은 import 만 한다(R-4) — 전용 「피킹 빼기」 함수 없이 Δ<0 피킹과 예약 해제를 잇는다.
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { releaseReservation } from '../../core/inventory-posting/reservation-qty';
import { LotQualityStatusService } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { createIqcNonconformanceWithin } from '../../quality/inspection/iqc-nonconformance';
import { oqcLotDecidingResult, oqcLotStatusesOf } from '../../quality/inspection/oqc-lot-result';
import type { LogisticsWriteActor } from '../logistics-write-actor';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestLineView, ShipmentRequestLotView } from './shipment-request-view';

export const LOT_NOT_REJECTED = 'LOT_NOT_REJECTED';
const PICKED = 'PICKED';
const REPLACED = 'REPLACED';
const ZERO = new Prisma.Decimal(0);

export interface ShipmentLotReplaceResult {
  replacedLot: ShipmentRequestLotView;
  nonconformanceNo: string | null;
  line: ShipmentRequestLineView;
}

interface LockedLot {
  shipment_request_lot_id: bigint;
  shipment_request_line_id: bigint;
  shipment_request_id: bigint;
  lot_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  picked_qty: Prisma.Decimal;
  status_code: string;
}

/**
 * OQC 불합격 피킹 LOT 교체(PDA [교체] · 피처 010 R-4·R-6 · FR-013·014). 한 트랜잭션에서:
 * 그 LOT 의 예약 전부 해제(잔액 picked → 가용, 예약 consumed → released) · 피킹 LOT 행 REPLACED(근거 결과·부적합·작업자·시각) ·
 * LOT 불량(C6 `inspection-rejected`) · 부적합 1건(PENDING_DECISION, 의뢰 = OQC 의뢰). 지시서는 바뀌지 않고 라인이 다시 피킹을 받는다.
 * ⛔ 판정이 불합격이 아니면(교체 전에 재검 합격이 들어온 경우 포함)·PICKED 가 아니면(출하 완료 뒤 포함) 409 `LOT_NOT_REJECTED`.
 */
@Injectable()
export class ShipmentLotReplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly qualities: LotQualityStatusService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async replace(shipmentRequestLotId: number, actor: LogisticsWriteActor): Promise<ShipmentLotReplaceResult> {
    const now = new Date();
    // ⛔ 채번은 트랜잭션 «밖»이다(P2024). 교체가 막히면 결번이 남는다(결번 허용).
    const nonconformanceNo = await this.numbering.next('NONCONFORMANCE', null, now.toISOString().slice(0, 10));
    const { requestId, lineId, created } = await this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, shipmentRequestLotId);
      const judged = await assertRejected(tx, lot);
      await this.unpick(tx, lot);
      const ncId = await createIqcNonconformanceWithin(tx, {
        nonconformanceNo,
        inspectionResultId: judged.inspectionResultId,
        inspectionRequestId: judged.inspectionRequestId,
        request: { inspection_type_code: 'OQC', lot_id: lot.lot_id, item_id: lot.item_id, uom_id: lot.uom_id, work_order_id: null },
        lotIds: [lot.lot_id],
        qty: Number(lot.picked_qty),
        appUserId: actor.appUserId,
        at: now,
        title: '출하검사 불합격 — 출하 피킹 LOT 교체',
      });
      await tx.shipment_request_lot.update({
        where: { shipment_request_lot_id: lot.shipment_request_lot_id },
        data: {
          status_code: REPLACED, replaced_at: now, replaced_worker_id: actor.workerId ?? null,
          replace_inspection_result_id: judged.inspectionResultId, replace_nonconformance_id: ncId,
          updated_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId), version_no: { increment: 1 },
        },
      });
      await this.qualities.moveWithin(tx, [lot.lot_id], 'inspection-rejected', {
        ...(actor.appUserId === undefined ? { changedWorkerId: actor.workerId } : { changedBy: BigInt(actor.appUserId) }),
        changedAt: now, sourceDocumentTypeCode: 'INSPECTION_RESULT', sourceDocumentId: judged.inspectionResultId,
      });
      if (actor.terminalAudit !== undefined) {
        await recordTerminalWorkerAudit(tx, {
          actor: actor.terminalAudit, targetTypeCode: 'SHIPMENT_REQUEST_LOT', targetId: lot.shipment_request_lot_id, eventTypeCode: 'REPLACE',
        });
      }
      return { requestId: lot.shipment_request_id, lineId: lot.shipment_request_line_id, created: ncId !== null };
    });

    const detail = await this.queries.get(Number(requestId));
    const line = (detail.lines ?? []).find((row) => row.shipmentRequestLineId === Number(lineId));
    const replacedLot = line?.lots.find((row) => row.shipmentRequestLotId === shipmentRequestLotId);
    if (line === undefined || replacedLot === undefined) throw new Error('교체한 피킹 LOT 을 다시 읽지 못했다');
    return { replacedLot, nonconformanceNo: created ? nonconformanceNo : null, line };
  }

  /**
   * 그 라인·LOT 의 예약 행마다 남은 몫(reserved − released)을 되돌린다 — 잔액 `picked −q`(가용으로), 예약 `consumed −q · released +q`.
   * 잔액 행은 코어 순서로 잠그고 예약의 창고·위치로 고른다(예약은 차원 4칸만 담는다).
   */
  private async unpick(tx: Prisma.TransactionClient, lot: LockedLot): Promise<void> {
    const reservations = await tx.inventory_reservation.findMany({
      where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: lot.shipment_request_line_id, lot_id: lot.lot_id },
      orderBy: { inventory_reservation_id: 'asc' },
    });
    const balances = await lockBalancesByItemLot(tx, lot.item_id, lot.lot_id);
    for (const reservation of reservations) {
      const qty = new Prisma.Decimal(reservation.reserved_qty).minus(reservation.released_qty);
      if (!qty.greaterThan(ZERO)) continue;
      const balance = balances.find((row) => row.warehouseId === reservation.warehouse_id && row.locationId === reservation.location_id);
      if (balance === undefined) throw new Error(`교체할 피킹분의 잔액 행이 없다: 예약 ${String(reservation.inventory_reservation_id)}`);
      const dimension = {
        legalEntityId: balance.legalEntityId, businessUnitId: balance.businessUnitId, plantId: balance.plantId,
        warehouseId: balance.warehouseId, locationId: balance.locationId, itemId: balance.itemId, lotId: balance.lotId,
        qualityStatusCode: balance.quality_status_code, inventoryStatusCode: balance.inventory_status_code,
        ownershipTypeCode: balance.ownership_type_code, ownerPartnerId: balance.owner_partner_id,
      };
      await this.posting.pick(tx, [{ dimension, delta: qty.negated(), inventoryReservationId: null, field: 'shipmentRequestLotId' }]);
      await releaseReservation(tx, reservation.inventory_reservation_id, lot.item_id, qty, 'shipmentRequestLotId');
    }
  }
}

/** 피킹 LOT 행·라인을 잠근다 — 같은 행의 교체·코드 저장·출하 완료가 서로를 기다린다. */
async function lockLot(tx: Prisma.TransactionClient, shipmentRequestLotId: number): Promise<LockedLot> {
  const [lot] = await tx.$queryRaw<LockedLot[]>`
    SELECT srl.shipment_request_lot_id, srl.shipment_request_line_id, l.shipment_request_id, srl.lot_id,
           l.item_id, l.uom_id, srl.picked_qty, srl.status_code
      FROM logistics.shipment_request_lot srl
      JOIN logistics.shipment_request_line l ON l.shipment_request_line_id = srl.shipment_request_line_id
     WHERE srl.shipment_request_lot_id = ${shipmentRequestLotId}
       FOR UPDATE OF srl, l`;
  if (lot === undefined) throw new NotFoundException('없는 피킹 LOT 입니다.');
  return lot;
}

async function assertRejected(
  tx: Prisma.TransactionClient,
  lot: LockedLot,
): Promise<{ inspectionResultId: bigint; inspectionRequestId: bigint }> {
  if (lot.status_code !== PICKED) {
    throw conflict(lot.status_code === REPLACED ? '이미 교체한 LOT 입니다.' : '출하가 완료된 LOT 은 교체할 수 없습니다.');
  }
  const status = (await oqcLotStatusesOf(tx, [lot.shipment_request_id])).get(lot.shipment_request_lot_id);
  const judged = await oqcLotDecidingResult(tx, lot.shipment_request_id, lot.item_id, lot.lot_id);
  if (status === 'REJECTED' && judged !== null) return judged;
  if (status === 'ACCEPTED') throw conflict('교체 전에 이 LOT 의 재검 합격이 들어와 교체할 필요가 없습니다.');
  throw conflict('출하검사 불합격 LOT 만 교체할 수 있습니다.');
}

function conflict(message: string): ConflictException {
  return new ConflictException('user', message, { code: LOT_NOT_REJECTED });
}
