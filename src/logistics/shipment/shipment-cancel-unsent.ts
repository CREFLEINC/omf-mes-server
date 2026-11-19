import { Prisma } from '@prisma/client';

import { ConflictException } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ 코어 파일은 import 만 한다 — 예약을 다시 거는 것은 피킹(`:pick-lot`)과 같은 ⓒ안이다.
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { IF_SHIPMENT_PGI } from '../../core/outbox';
import { SHIPMENT_REQUEST_LINE } from '../shipment-request/shipment-progress';

/**
 * POP 완료 출하의 ERP 송신 전 취소(피처 010 R-10 · FR-023·024).
 * ⭐ 「아직 안 보냄」 = 그 출하의 PGI 메시지를 `FOR UPDATE NOWAIT` 로 잡을 수 있고 잡은 이가 없으며
 *    - `PENDING ∧ sent_at 없음 ∧ 바깥 행 0`(아직 보내지 않음), 또는
 *    - 송신 오류(2026-11-19 사용자 결정 · FR-023): `FAILED` 이거나 재처리로 다시 `PENDING` 이 됐고, 바깥 행이 모두 ERP 가 거절한 행(REJECTED)
 *      뿐이다 — ERP 에 들어갔거나(INSERTED) 반영됐거나(APPLIED) 들어갔는지 모르는(RESERVED) 행이 하나라도 있으면 보낸 것으로 본다.
 *    메시지가 없으면(수주 없는 출하 — 보낼 것이 없다) 보내기 전이다. 깨지면 409 `ERP_ALREADY_SENT`.
 */
export const ERP_ALREADY_SENT = 'ERP_ALREADY_SENT';

type Tx = Prisma.TransactionClient;

/** 송신 전으로 볼 수 있는 메시지 상태 — 대기와 송신 오류(재처리로 다시 대기가 된 것 포함). */
const UNSENT_STATUSES = ['PENDING', 'FAILED'];
/** ERP 가 거절한 바깥 행 — ERP 에 반영되지 않았다(`outbound-rows.ts` OUTBOUND_ROW_STATUS.REJECTED). */
const REJECTED_ROW = 'REJECTED';

export function alreadySent(): ConflictException {
  return new ConflictException('user', 'ERP 로 이미 보냈습니다. ERP 에서 처리하세요.', { code: ERP_ALREADY_SENT });
}

/** 보내기 전이면 그 메시지 id(없으면 null)를 돌려준다 — 실행이 같은 트랜잭션에서 CANCELLED 로 바꾼다. */
export async function assertNotSentWithin(tx: Tx, shipmentId: bigint): Promise<bigint | null> {
  let rows: { integration_message_id: bigint; status_code: string; sent_at: Date | null; locked_by: string | null }[];
  try {
    rows = await tx.$queryRaw`
      SELECT integration_message_id, status_code, sent_at, locked_by
        FROM integration.integration_message
       WHERE interface_code = ${IF_SHIPMENT_PGI} AND target_type_code = 'SHIPMENT' AND target_id = ${shipmentId}
       ORDER BY integration_message_id DESC
       LIMIT 1
         FOR UPDATE NOWAIT`;
  } catch (error) {
    // 러너가 지금 그 메시지를 잡고 있다 — 보내는 중이다.
    if (error instanceof Prisma.PrismaClientKnownRequestError && /55P03|could not obtain lock/.test(`${error.code} ${error.message}`)) throw alreadySent();
    throw error;
  }
  const message = rows[0];
  if (message === undefined) return null;
  if (message.locked_by !== null || !UNSENT_STATUSES.includes(message.status_code)) throw alreadySent();
  const rowsOf = await tx.erp_outbound_row.groupBy({
    by: ['status_code'], where: { integration_message_id: message.integration_message_id }, _count: { _all: true },
  });
  const outbound = rowsOf.reduce((sum, row) => sum + row._count._all, 0);
  // 처음 보내기 전(PENDING): 바깥 행이 없어야 한다. 송신 오류(FAILED · 재처리로 PENDING): 거절된 행만 있어야 한다.
  if (message.status_code === 'PENDING' && message.sent_at === null && outbound === 0) return message.integration_message_id;
  const failedBefore = message.status_code === 'FAILED' || message.sent_at !== null;
  if (failedBefore && rowsOf.every((row) => row.status_code === REJECTED_ROW)) return message.integration_message_id;
  throw alreadySent();
}

/** 예약을 다시 걸 몫 — 취소가 풀어 준 예약 하나(라인·LOT·창고·위치·수량). */
export interface ReleasedPortion {
  shipmentRequestLineId: bigint;
  itemId: bigint;
  lotId: bigint;
  warehouseId: bigint;
  locationId: bigint | null;
  uomId: bigint;
  qty: Prisma.Decimal;
}

/**
 * 피킹 LOT 을 PICKED 로 되돌리고 같은 잔액 행에 예약을 다시 건다(피킹 ⓒ안 — 예약 걸고 곧바로 피킹). LOT 통째 — 한 몫이라도 그 자리
 * 가용이 모자라면 그 LOT 은 풀린 채로 두고(예약 없음) 피킹 LOT 행을 지워 다시 스캔할 수 있게 한다(R-10 「다시 잡을 수 없는 LOT」).
 * OQC 결과는 그대로 둔다(판정 근거). 돌려주는 값은 풀린 채로 둔 LOT id 들.
 */
export async function restorePicksWithin(
  tx: Tx,
  posting: InventoryPostingService,
  input: { shipmentId: bigint; portions: readonly ReleasedPortion[]; reservationNo: string; appUserId: number },
): Promise<bigint[]> {
  const lots = await tx.shipment_request_lot.findMany({
    where: { shipment_id: input.shipmentId, status_code: 'SHIPPED' },
    select: { shipment_request_lot_id: true, shipment_request_line_id: true, lot_id: true },
  });
  const loose: bigint[] = [];
  let seq = 0;
  for (const lot of lots) {
    const mine = input.portions.filter((portion) => portion.lotId === lot.lot_id && portion.shipmentRequestLineId === lot.shipment_request_line_id);
    const balances = mine.length === 0 ? [] : await lockBalancesByItemLot(tx, mine[0].itemId, lot.lot_id);
    const matched = mine.map((portion) => ({
      portion,
      balance: balances.find((row) => row.warehouseId === portion.warehouseId && row.locationId === portion.locationId
        && new Prisma.Decimal(row.available_qty ?? 0).greaterThanOrEqualTo(portion.qty)),
    }));
    if (mine.length === 0 || matched.some((entry) => entry.balance === undefined)) {
      loose.push(lot.lot_id);
      await tx.shipment_request_lot.delete({ where: { shipment_request_lot_id: lot.shipment_request_lot_id } });
      continue;
    }
    for (const { portion, balance } of matched) {
      if (balance === undefined) continue;
      seq += 1;
      const dimension = {
        legalEntityId: balance.legalEntityId, businessUnitId: balance.businessUnitId, plantId: balance.plantId,
        warehouseId: balance.warehouseId, locationId: balance.locationId, itemId: balance.itemId, lotId: balance.lotId,
        qualityStatusCode: balance.quality_status_code, inventoryStatusCode: balance.inventory_status_code,
        ownershipTypeCode: balance.ownership_type_code, ownerPartnerId: balance.owner_partner_id,
      };
      const [reservationId] = await posting.reserve(tx, [{
        dimension, qty: portion.qty, reservationNo: seq === 1 ? input.reservationNo : `${input.reservationNo}-${seq}`,
        reservationTypeCode: 'SHIPMENT', sourceDocumentTypeCode: SHIPMENT_REQUEST_LINE, sourceDocumentId: portion.shipmentRequestLineId,
        uomId: portion.uomId, statusCode: 'REGISTERED', createdBy: BigInt(input.appUserId), field: 'shipmentId',
      }]);
      await posting.pick(tx, [{ dimension, delta: portion.qty, inventoryReservationId: reservationId, field: 'shipmentId' }]);
    }
    await tx.shipment_request_lot.update({
      where: { shipment_request_lot_id: lot.shipment_request_lot_id },
      data: { status_code: 'PICKED', shipment_id: null, updated_by: BigInt(input.appUserId), version_no: { increment: 1 } },
    });
  }
  return loose;
}

/** 출하 완료가 쓴 예약 몫(소진됨)을 모두 푼다 — consumed → released. 다시 걸 몫을 돌려준다. */
export async function releaseCompletionReservations(
  tx: Tx,
  release: (reservationId: bigint, itemId: bigint, qty: Prisma.Decimal) => Promise<void>,
  shipmentId: bigint,
): Promise<ReleasedPortion[]> {
  const lots = await tx.shipment_request_lot.findMany({
    where: { shipment_id: shipmentId, status_code: 'SHIPPED' },
    select: { shipment_request_line_id: true, lot_id: true, uom_id: true, shipment_request_line: { select: { item_id: true } } },
  });
  const portions: ReleasedPortion[] = [];
  for (const lot of lots) {
    const reservations = await tx.inventory_reservation.findMany({
      where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: lot.shipment_request_line_id, lot_id: lot.lot_id, consumed_qty: { gt: 0 } },
      orderBy: { inventory_reservation_id: 'asc' },
    });
    for (const reservation of reservations) {
      const qty = new Prisma.Decimal(reservation.consumed_qty);
      await release(reservation.inventory_reservation_id, lot.shipment_request_line.item_id, qty);
      portions.push({
        shipmentRequestLineId: lot.shipment_request_line_id, itemId: lot.shipment_request_line.item_id, lotId: lot.lot_id,
        warehouseId: reservation.warehouse_id, locationId: reservation.location_id, uomId: lot.uom_id, qty,
      });
    }
  }
  return portions;
}
