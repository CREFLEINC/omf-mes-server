import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one, overlapsAsConflict } from '../../common/errors';
import { assertCodeValues, assertWorkerNoPresent } from '../../common/master';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LockedBalanceRow, lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { releaseReservation } from '../../core/inventory-posting/reservation-qty';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogisticsWriteActor } from '../logistics-write-actor';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestLineView } from './shipment-request-view';

/** 계약 `ShipmentLinePickReturn`. 사번은 `X-Worker-No` 헤더로 온다. */
export interface ShipmentLinePickReturn {
  lotId: number;
  qty: number;
  uomId: number;
  reasonCode: string;
  remarks?: string | null;
}

export type ShipmentPickReturnContext = LogisticsWriteActor & { workerNo?: string };

export interface ShipmentPickReturnResult {
  line: ShipmentRequestLineView;
  /** 반납 수량 중 잔액 피킹분을 가용으로 옮긴 몫과, 잔액이 이미 가용이라 예약만 푼 몫. */
  returned: { fromPickedQty: number; reservationOnlyQty: number };
  balance?: { lotId: number; onHandQty: number; pickedQty: number; availableQty: number };
  notice?: string;
}

const REASON_GROUP = 'PICK_RETURN_REASON';
const REASON_OTHER = 'OTHER';
const QTY_SCALE = 6;
const ZERO = new Prisma.Decimal(0);
const SHIPMENT_CANCELLED = 'CANCELLED';
const OQC_SETTLED: ReadonlySet<string> = new Set(['PASSED', 'REJECTED', 'HELD']);

/**
 * 피킹 반납 — 그 지시 라인이 집었지만 출하하지 않은 LOT 수량을 가용 재고로 되돌린다(장부 P-126).
 * 같은 잔액 행에서 피킹분만 내리고(원장 없음 · 위치 그대로) 그 (지시 라인, LOT) 의 피킹 예약을 «풀린 것»으로 옮긴다 — 라인 피킹이 준다.
 * 한도는 「라인·LOT 의 피킹 − 살아 있는 출하 배분」이다. 그중 잔액 피킹분이 남은 만큼만 피킹 → 가용으로 옮기고, 나머지는 예약만 푼다 —
 * 피킹분은 지시끼리 함께 써서 다른 지시가 그 몫을 출하에 썼다가 취소하면 잔액은 이미 가용이고 이 라인의 예약만 남는다(그 예약을 풀 길이다).
 * 잠금 순서는 `:pick` 과 같다 — 지시 라인 → LOT 잔액 → 예약. 출하 등록·취소·상자 정정과는 반대라 교착하면 409 로 낸다.
 */
@Injectable()
export class ShipmentPickReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async returnPick(
    shipmentRequestId: number,
    shipmentRequestLineId: number,
    body: ShipmentLinePickReturn,
    context: ShipmentPickReturnContext,
  ): Promise<ShipmentPickReturnResult> {
    assertWorkerNoPresent(context.workerNo);
    const qty = assertReturnQty(body.qty);
    const remarks = body.remarks?.trim() ?? '';
    await assertCodeValues(this.prisma, [{ field: 'reasonCode', value: body.reasonCode, groupCode: REASON_GROUP }]);
    if (body.reasonCode === REASON_OTHER && remarks === '') {
      throw one(field('remarks', ERROR_CODE.REQUIRED, '반납 사유가 「기타」면 비고에 무슨 일인지 적으세요 — 반납 이력에 남습니다.'));
    }

    const lotId = BigInt(body.lotId);
    const done = await overlapsAsConflict(() => this.prisma.$transaction(async (tx) => {
      const line = await lockLine(tx, shipmentRequestId, shipmentRequestLineId);
      if (line === undefined) throw new NotFoundException('없는 출하작업지시 라인입니다. 출하작업지시를 새로 고쳐 다시 고르세요.');
      if (BigInt(body.uomId) !== line.uom_id) throw one(field('uomId', ERROR_CODE.INVALID, '라인의 단위와 다릅니다 — 라인 단위로 다시 입력하세요.'));
      const lot = await tx.lot.findUnique({ where: { lot_id: lotId }, select: { lot_no: true, item_id: true } });
      if (lot === null || lot.item_id !== line.item_id) {
        throw one(field('lotId', ERROR_CODE.INVALID, '이 라인의 품목이 아닌 LOT 입니다 — 라인에서 피킹한 LOT 을 고르세요.'));
      }

      const reservations = await tx.inventory_reservation.findMany({
        where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: line.shipment_request_line_id, lot_id: lotId },
        orderBy: { inventory_reservation_id: 'desc' },
        select: { inventory_reservation_id: true, reserved_qty: true, released_qty: true, consumed_qty: true },
      });
      const picked = reservations.reduce((sum, r) => sum.plus(r.reserved_qty).minus(r.released_qty), ZERO);
      const shipped = await shippedOf(tx, line.shipment_request_line_id, lotId);
      assertReturnable(lot.lot_no, qty, picked, shipped);

      // 잔액 피킹분이 남은 행만 내린다 — 피킹분은 지시끼리 함께 써서 그 몫이 이미 출하에 쓰였으면(잔액이 이미 가용) 예약만 푼다.
      const rows = (await lockBalancesByItemLot(tx, line.item_id, lotId))
        .filter((row) => line.fulfillment_plant_id === null || row.plantId === line.fulfillment_plant_id);
      const held = await Promise.all(rows.map(async (row) => ({ row, picked: (await tx.inventory_balance.findFirstOrThrow({
        where: balanceWhere(dimensionOf(row)), select: { picked_qty: true },
      })).picked_qty })));
      const pickedRows = held.filter((entry) => entry.picked.greaterThan(0));
      if (pickedRows.length > 1) {
        throw one(field('lotId', ERROR_CODE.INVALID, `LOT ${lot.lot_no}: 피킹분이 남은 재고 차원이 둘 이상이라 반납할 잔액을 정할 수 없습니다 — 재고 현황(W-01-07)에서 확인하세요.`));
      }
      const fromPicked = pickedRows.length === 0 ? ZERO : Prisma.Decimal.min(qty, pickedRows[0].picked);
      const reservationOnly = qty.minus(fromPicked);
      if (fromPicked.greaterThan(0)) {
        await this.posting.pick(tx, [{ dimension: dimensionOf(pickedRows[0].row), delta: fromPicked.negated(), inventoryReservationId: null, field: 'qty' }]);
      }
      const released: { reservationId: number; qty: string }[] = [];
      let remaining = qty;
      // 최근 피킹부터 푼다 — 잘못 집은 것을 되돌리는 일이 대개 마지막 피킹이다.
      for (const reservation of reservations) {
        if (!remaining.greaterThan(0)) break;
        const take = Prisma.Decimal.min(reservation.consumed_qty, remaining);
        if (!take.greaterThan(0)) continue;
        await releaseReservation(tx, reservation.inventory_reservation_id, line.item_id, take, 'qty');
        released.push({ reservationId: Number(reservation.inventory_reservation_id), qty: take.toString() });
        remaining = remaining.minus(take);
      }
      const split = { fromPickedQty: fromPicked.toString(), reservationOnlyQty: reservationOnly.toString() };
      await tx.audit_event.create({ data: {
        occurred_at: new Date(),
        target_type_code: 'SHIPMENT_REQUEST_LINE',
        target_id: line.shipment_request_line_id,
        event_type_code: 'PICK_RETURNED',
        before_value: { lotId: Number(lotId), lotNo: lot.lot_no, pickedQty: picked.toString(), shippedQty: shipped.toString() },
        after_value: { lotId: Number(lotId), lotNo: lot.lot_no, qty: qty.toString(), ...split, reasonCode: body.reasonCode,
          workerNo: context.workerNo ?? null, releasedReservations: released },
        reason: remarks === '' ? body.reasonCode : `${body.reasonCode} · ${remarks}`,
        performed_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
        terminal_id: context.terminalAudit?.terminalId ?? null,
        correlation_id: context.terminalAudit?.correlationId ?? null,
      } });
      const shown = pickedRows[0]?.row ?? (rows.length === 1 ? rows[0] : undefined);
      const balance = shown === undefined ? undefined : await tx.inventory_balance.findFirstOrThrow({
        where: balanceWhere(dimensionOf(shown)), select: { on_hand_qty: true, picked_qty: true, available_qty: true },
      });
      return { balance, fromPicked, reservationOnly };
    }));

    const detail = await this.queries.get(shipmentRequestId);
    const line = (detail.lines ?? []).find((row) => row.shipmentRequestLineId === shipmentRequestLineId) as ShipmentRequestLineView;
    const oqcSettled = line.shippingInspectionRequired && OQC_SETTLED.has(detail.shippingInspectionStatusCode);
    const { balance } = done;
    return {
      line,
      returned: { fromPickedQty: done.fromPicked.toNumber(), reservationOnlyQty: done.reservationOnly.toNumber() },
      ...(balance === undefined ? {} : { balance: {
        lotId: body.lotId, onHandQty: balance.on_hand_qty.toNumber(), pickedQty: balance.picked_qty.toNumber(),
        availableQty: (balance.available_qty ?? ZERO).toNumber(),
      } }),
      ...(oqcSettled ? { notice: '출하검사가 끝난 라인입니다 — 반납한 LOT 이 출하검사 이력의 LOT 과 달라질 수 있으니, 다시 피킹하면 출하검사 대상 LOT 을 확인하세요.' } : {}),
    };
  }
}

interface LineRow {
  shipment_request_line_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  fulfillment_plant_id: bigint | null;
}

/** `:pick` 과 같은 잠금 — 라인만 잠그고 헤더는 소유 대조로만 본다(같은 지시의 두 라인 작업이 서로 막지 않게). */
async function lockLine(tx: Prisma.TransactionClient, shipmentRequestId: number, shipmentRequestLineId: number): Promise<LineRow | undefined> {
  const [line] = await tx.$queryRaw<LineRow[]>`
    SELECT l.shipment_request_line_id, l.item_id, l.uom_id, h.fulfillment_plant_id
      FROM logistics.shipment_request_line l
      JOIN logistics.shipment_request h ON h.shipment_request_id = l.shipment_request_id
     WHERE l.shipment_request_line_id = ${shipmentRequestLineId}
       AND l.shipment_request_id = ${shipmentRequestId}
       FOR UPDATE OF l FOR SHARE OF h`;
  return line;
}

/** 그 (지시 라인, LOT) 의 살아 있는 출하 배분 합 — 취소 완료된 출하는 빼고, 취소 요청 중인 출하는 센다. */
export async function shippedOf(tx: Prisma.TransactionClient, shipmentRequestLineId: bigint, lotId: bigint): Promise<Prisma.Decimal> {
  const { _sum } = await tx.shipment_lot_allocation.aggregate({
    where: { lot_id: lotId, shipment_line: { shipment_request_line_id: shipmentRequestLineId, shipment: { status_code: { not: SHIPMENT_CANCELLED } } } },
    _sum: { allocated_qty: true },
  });
  return _sum.allocated_qty ?? ZERO;
}

function assertReturnQty(value: number): Prisma.Decimal {
  const qty = new Prisma.Decimal(value);
  if (!qty.greaterThan(ZERO)) throw one(field('qty', ERROR_CODE.RANGE, '반납 수량은 0 보다 커야 합니다.'));
  if (qty.decimalPlaces() > QTY_SCALE) throw one(field('qty', ERROR_CODE.RANGE, `수량은 소수점 ${QTY_SCALE}자리까지입니다.`));
  return qty;
}

/** 반납 한도 — 라인·LOT 의 «피킹 − 출하»(피킹됐지만 출하 안 됨). 잔액 피킹분이 모자란 몫은 예약만 풀므로 한도가 아니다. */
export function assertReturnable(lotNo: string, qty: Prisma.Decimal, picked: Prisma.Decimal, shipped: Prisma.Decimal): void {
  const unshipped = Prisma.Decimal.max(picked.minus(shipped), ZERO);
  if (!qty.greaterThan(unshipped)) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [field('qty', ERROR_CODE.RANGE,
    `LOT ${lotNo}: 출하하지 않은 피킹분은 ${unshipped.toString()} 입니다(피킹 ${picked.toString()} · 출하 ${shipped.toString()}) — `
    + '출하에 쓴 몫은 출하 취소나 상자 정정으로 먼저 줄이세요.')]);
}

function dimensionOf(row: LockedBalanceRow) {
  return {
    legalEntityId: row.legalEntityId, businessUnitId: row.businessUnitId, plantId: row.plantId, warehouseId: row.warehouseId,
    locationId: row.locationId, itemId: row.itemId, lotId: row.lotId, qualityStatusCode: row.quality_status_code,
    inventoryStatusCode: row.inventory_status_code, ownershipTypeCode: row.ownership_type_code, ownerPartnerId: row.owner_partner_id,
  };
}

function balanceWhere(d: {
  legalEntityId: bigint; businessUnitId: bigint; plantId: bigint; warehouseId: bigint; locationId: bigint; itemId: bigint; lotId: bigint | null;
  qualityStatusCode: string; inventoryStatusCode: string; ownershipTypeCode: string; ownerPartnerId: bigint | null;
}): Prisma.inventory_balanceWhereInput {
  return {
    legal_entity_id: d.legalEntityId, business_unit_id: d.businessUnitId, plant_id: d.plantId, warehouse_id: d.warehouseId,
    location_id: d.locationId, item_id: d.itemId, lot_id: d.lotId, quality_status_code: d.qualityStatusCode,
    inventory_status_code: d.inventoryStatusCode, ownership_type_code: d.ownershipTypeCode, owner_partner_id: d.ownerPartnerId,
  };
}
