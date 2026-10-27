import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { GoodsIssueLineWriteInput, postIssue } from '../goods-issue/issue-posting';
import { releaseLineLotReservations } from './shipment-cancel.service';
import { CANCELLED, CONFIRMED, SHIPMENT_TARGET, Tx, hasOpenCancel, lockShipment } from './shipment-guards';
import { AllocationChange, RepackAllocation } from './shipment-repack-plan';

/**
 * 출하에 배분된 상자를 고칠 때 출하·재고를 같이 맞춘다(장부 P-125 · 사용자 결정 2026-10-27 「되돌릴 수 있게」).
 * 원장은 그 출하의 출고 «전체»를 역전기하고 고친 배분으로 새 출고를 세운다 — 코어에 부분 역전기가 없고, 출하 취소와 같은 역전기를 쓴다.
 * 잠금 순서: 출하 → 출하의 배분 → (호출자가) 상자 → 지시 라인. 배분→상자를 잇는 경로가 배분을 먼저 잠그므로 상자보다 배분이 앞이다.
 */

const POSTED = 'POSTED';
const DOCUMENT_CANCELLED = 'CANCELLED';
/**
 * 새 출고의 피킹 소진 축 — 피킹 소진 축(`SHIPMENT`) «밖»의 값이다. 처음 출고가 이미 피킹분을 소진했고 역전기는 피킹분을
 * 되돌리지 않으므로, 새 출고가 다시 소진하면 두 번 깎인다. 늘린 몫만 따로 소진한다(`consumeIncreases`).
 */
const NO_PICK_CONSUME_AXIS = 'GOODS_RECEIPT';
const REORDER = '출하를 취소하고 다시 등록하세요.';

export interface LinkedShipment {
  shipmentId: bigint;
  plantId: bigint;
  /** 살아 있는 출고 원장의 영업일 — 새 출고도 이 날에 선다. 출고가 없으면(취소된 출하) null. */
  businessDate: string | null;
}

/** 트랜잭션 밖 — 이 상자가 출하에 이어졌는지와 새 출고 번호를 뽑을 축. */
export async function linkedShipmentOf(tx: Tx, handlingUnitId: bigint): Promise<LinkedShipment | null> {
  const shipments = await tx.shipment.findMany({
    where: { shipment_line: { some: { shipment_lot_allocation: { some: { handling_unit_id: handlingUnitId } } } } },
    select: { shipment_id: true, warehouse: { select: { plant_id: true } } },
  });
  if (shipments.length === 0) return null;
  if (shipments.length > 1) {
    throw new ConflictException('user', `이 상자는 출하 여러 건에 배분되어 있어 고칠 수 없습니다 — ${REORDER}`);
  }
  const [shipment] = shipments;
  const issue = await liveIssue(tx, shipment.shipment_id);
  const ledger = issue === null ? null : await tx.inventory_transaction.findFirst({
    where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: issue.goods_issue_id, reversal_of_transaction_id: null },
    select: { business_date: true },
  });
  return { shipmentId: shipment.shipment_id, plantId: shipment.warehouse.plant_id,
    businessDate: ledger === null ? null : ledger.business_date.toISOString().slice(0, 10) };
}

function liveIssue(tx: Tx, shipmentId: bigint) {
  return tx.goods_issue.findFirst({
    where: { source_document_type_code: SHIPMENT_TARGET, source_document_id: shipmentId, status_code: POSTED },
    select: { goods_issue_id: true, goods_issue_no: true, issued_at: true, source_warehouse_id: true, issue_type_code: true },
  });
}

export interface LockedRepack {
  shipmentId: bigint;
  shipmentNo: string;
  warehouseId: bigint;
  allocations: RepackAllocation[];
}

/** 출하와 그 배분을 잠그고 고칠 수 있는 출하인지 본다. 막는 까닭은 모두 출하 상태라 409 다. */
export async function lockShipmentForRepack(tx: Tx, shipmentId: bigint): Promise<LockedRepack> {
  const locked = await lockShipment(tx, Number(shipmentId));
  if (locked === undefined) throw new Error(`배분이 가리키는 출하가 없다: ${shipmentId}`);
  const no = locked.shipment_no;
  const blocked = (message: string) => new ConflictException('user', message);
  if (locked.status_code === CANCELLED) throw blocked(`출하 ${no}는 취소된 출하라 이 상자를 고칠 수 없습니다 — 새 상자로 포장하세요.`);
  if (locked.status_code === CONFIRMED) {
    throw blocked(`출하 ${no}가 확정되어 이 상자를 고칠 수 없습니다 — 확정 전 출하의 상자만 고칠 수 있습니다.`);
  }
  if (await hasOpenCancel(tx, locked.shipment_id)) {
    throw blocked(`출하 ${no}의 취소 결재가 진행 중이라 이 상자를 고칠 수 없습니다 — 출하 확정·취소 화면에서 결재가 끝난 뒤 다시 하세요.`);
  }
  const { expedited } = await tx.shipment.findUniqueOrThrow({ where: { shipment_id: locked.shipment_id }, select: { expedited: true } });
  if (expedited) throw blocked(`긴급 직행 출하 ${no}의 상자는 고칠 수 없습니다 — ${REORDER}`);

  const rows = await tx.$queryRaw<{
    shipment_lot_allocation_id: bigint; shipment_line_id: bigint; line_no: number; item_id: bigint; lot_id: bigint;
    lot_no: string; uom_id: bigint; allocated_qty: Prisma.Decimal; handling_unit_id: bigint | null; delivery_label_no: string | null;
  }[]>`
    SELECT a.shipment_lot_allocation_id, a.shipment_line_id, sl.line_no, sl.item_id, a.lot_id, lt.lot_no, a.uom_id,
           a.allocated_qty, a.handling_unit_id, a.delivery_label_no
      FROM logistics.shipment_lot_allocation a
      JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
      JOIN trace.lot lt ON lt.lot_id = a.lot_id
     WHERE sl.shipment_id = ${locked.shipment_id}
     ORDER BY sl.line_no, a.shipment_lot_allocation_id
       FOR UPDATE OF a`;
  return {
    shipmentId: locked.shipment_id, shipmentNo: no, warehouseId: locked.warehouse_id,
    allocations: rows.map((row) => ({
      allocationId: row.shipment_lot_allocation_id, shipmentLineId: row.shipment_line_id, lineNo: row.line_no,
      itemId: row.item_id, lotId: row.lot_id, lotNo: row.lot_no, uomId: row.uom_id, qty: new Prisma.Decimal(row.allocated_qty),
      handlingUnitId: row.handling_unit_id, deliveryLabelNo: row.delivery_label_no,
    })),
  };
}

/** 출하 단위에 담긴 상자는 그 단위에서 빼야 고친다 — 단위가 닫혔으면 다시 열어야 뺄 수 있다. */
export async function assertNotInShippingUnit(tx: Tx, handlingUnitId: bigint): Promise<void> {
  const link = await tx.shipping_unit_handling_unit.findUnique({
    where: { handling_unit_id: handlingUnitId }, select: { shipping_unit: { select: { shipping_unit_no: true } } },
  });
  if (link === null) return;
  throw new ConflictException('user', `이 상자는 출하 단위 ${link.shipping_unit.shipping_unit_no}에 담겨 있어 고칠 수 없습니다 — `
    + 'P-04-05 출하 단위에서 단위를 다시 열고 상자를 뺀 뒤 고치세요.');
}

export interface RepackSync {
  shipmentNo: string;
  cancelledGoodsIssueNo: string;
  goodsIssueNo: string;
  changes: { lineNo: number; lotNo: string; before: string; after: string }[];
}

/** 고친 배분을 출하·지시 라인·수주 라인·예약·잔액·원장에 옮긴다. `changes` 는 비어 있지 않다. */
export async function syncShipment(
  tx: Tx,
  posting: InventoryPostingService,
  input: { locked: LockedRepack; changes: AllocationChange[]; goodsIssueNo: string; appUserId?: number; now: Date },
): Promise<RepackSync> {
  const { locked, changes, appUserId } = input;
  const lines = await tx.shipment_line.findMany({
    where: { shipment_id: locked.shipmentId },
    select: { shipment_line_id: true, shipment_request_line_id: true },
  });
  const requestLineOf = new Map(lines.map((line) => [line.shipment_line_id, line.shipment_request_line_id]));
  await assertIncreasesFit(tx, locked, changes, requestLineOf);

  for (const { allocation, after } of changes) {
    const delta = after.minus(allocation.qty);
    if (after.isZero()) {
      await tx.shipment_lot_allocation.delete({ where: { shipment_lot_allocation_id: allocation.allocationId } });
    } else {
      await tx.shipment_lot_allocation.update({ where: { shipment_lot_allocation_id: allocation.allocationId }, data: { allocated_qty: after } });
    }
    const requestLineId = requestLineOf.get(allocation.shipmentLineId) as bigint;
    await tx.shipment_line.update({ where: { shipment_line_id: allocation.shipmentLineId }, data: { shipped_qty: { increment: delta } } });
    const requestLine = await tx.shipment_request_line.update({
      where: { shipment_request_line_id: requestLineId },
      data: { shipped_qty: { increment: delta }, version_no: { increment: 1 } },
      select: { sales_order_line_id: true },
    });
    if (requestLine.sales_order_line_id !== null) {
      await tx.sales_order_line.update({
        where: { sales_order_line_id: requestLine.sales_order_line_id },
        data: { shipped_qty: { increment: delta }, version_no: { increment: 1 } },
      });
    }
    // 줄인 몫은 출하 취소처럼 지시 라인의 피킹 예약을 푼다 — 실물은 «가용»으로 돌아온다(역전기가 피킹분을 되돌리지 않는다).
    if (delta.isNegative()) await releaseLineLotReservations(tx, requestLineId, allocation.itemId, allocation.lotId, delta.negated());
  }

  const { cancelled, issued } = await reissue(tx, posting, input);
  await tx.shipment.update({
    where: { shipment_id: locked.shipmentId },
    data: { version_no: { increment: 1 }, ...(appUserId === undefined ? {} : { updated_by: BigInt(appUserId) }) },
  });
  return {
    shipmentNo: locked.shipmentNo, cancelledGoodsIssueNo: cancelled, goodsIssueNo: issued,
    changes: changes.map(({ allocation, after }) => ({
      lineNo: allocation.lineNo, lotNo: allocation.lotNo, before: allocation.qty.toString(), after: after.toString(),
    })),
  };
}

/** 늘린 몫은 지시 라인 배정·수주 수량 안이어야 하고, 잔액에 그만큼 피킹분이 남아 있어야 한다(피킹분은 지시끼리 함께 쓴다). */
async function assertIncreasesFit(
  tx: Tx, locked: LockedRepack, changes: AllocationChange[], requestLineOf: Map<bigint, bigint>,
): Promise<void> {
  const errors: ErrorItem[] = [];
  const byRequestLine = new Map<bigint, Prisma.Decimal>();
  const byLot = new Map<bigint, { allocation: RepackAllocation; qty: Prisma.Decimal }>();
  for (const { allocation, after } of changes) {
    const delta = after.minus(allocation.qty);
    if (!delta.isPositive() || delta.isZero()) continue;
    const requestLineId = requestLineOf.get(allocation.shipmentLineId) as bigint;
    byRequestLine.set(requestLineId, (byRequestLine.get(requestLineId) ?? new Prisma.Decimal(0)).plus(delta));
    const lot = byLot.get(allocation.lotId) ?? { allocation, qty: new Prisma.Decimal(0) };
    byLot.set(allocation.lotId, { allocation, qty: lot.qty.plus(delta) });
  }
  for (const [requestLineId, increase] of byRequestLine) {
    const line = await tx.shipment_request_line.findUniqueOrThrow({
      where: { shipment_request_line_id: requestLineId },
      select: { line_no: true, allocated_qty: true, shipped_qty: true, shipment_request: { select: { shipment_request_no: true } },
        sales_order_line: { select: { line_no: true, ordered_qty: true, shipped_qty: true, sales_order: { select: { sales_order_no: true } } } } },
    });
    if (line.shipped_qty.plus(increase).greaterThan(line.allocated_qty)) {
      errors.push(field('items', ERROR_CODE.RANGE, `출하작업지시 ${line.shipment_request.shipment_request_no} ${line.line_no}번 줄의 배정 수량`
        + `(${line.allocated_qty.toString()})을 넘습니다 — 출하작업지시에서 배정을 늘리거나 수량을 줄이세요.`));
    }
    const order = line.sales_order_line;
    if (order !== null && order.shipped_qty.plus(increase).greaterThan(order.ordered_qty)) {
      errors.push(field('items', ERROR_CODE.RANGE, `수주 ${order.sales_order.sales_order_no} ${order.line_no}번 줄의 수주 수량`
        + `(${order.ordered_qty.toString()})을 넘습니다 — 수량을 줄이세요.`));
    }
  }
  for (const { allocation, qty } of byLot.values()) {
    const picked = await pickedOf(tx, locked.warehouseId, allocation);
    if (picked.lessThan(qty)) {
      errors.push(field('items', ERROR_CODE.NEGATIVE_BALANCE, `LOT ${allocation.lotNo}: 늘린 수량(${qty.toString()})만큼 남은 피킹분이 없습니다`
        + `(남은 피킹분 ${picked.toString()}) — 모바일 출하 피킹(M-04-01)에서 더 피킹한 뒤 고치세요.`));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

async function pickedOf(tx: Tx, warehouseId: bigint, allocation: RepackAllocation): Promise<Prisma.Decimal> {
  const rows = (await lockBalancesByItemLot(tx, allocation.itemId, allocation.lotId)).filter((row) => row.warehouseId === warehouseId);
  if (rows.length !== 1) return new Prisma.Decimal(0);
  const balance = await tx.inventory_balance.findFirstOrThrow({
    where: { warehouse_id: warehouseId, location_id: rows[0].locationId, item_id: allocation.itemId, lot_id: allocation.lotId },
    select: { picked_qty: true },
  });
  return balance.picked_qty;
}

/** 옛 출고를 역전기·취소하고, 늘린 몫의 피킹분을 소진한 뒤, 지금 배분 전체로 새 출고를 세운다. 영업일·발생 시각은 처음 출고 것이다. */
async function reissue(
  tx: Tx,
  posting: InventoryPostingService,
  input: { locked: LockedRepack; changes: AllocationChange[]; goodsIssueNo: string; appUserId?: number; now: Date },
): Promise<{ cancelled: string; issued: string }> {
  const { locked, appUserId } = input;
  const old = await liveIssue(tx, locked.shipmentId);
  if (old === null) throw new Error(`출하에 살아 있는 출고 전표가 없다: ${locked.shipmentNo}`);
  const [ledger] = await tx.inventory_transaction.findMany({
    where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: old.goods_issue_id, reversal_of_transaction_id: null },
    select: { inventory_transaction_id: true, business_date: true },
  });
  const businessDate = ledger.business_date.toISOString().slice(0, 10);
  await posting.reverse(tx, { inventoryTransactionId: ledger.inventory_transaction_id, businessDate, occurredAt: input.now, createdBy: appUserId });
  await tx.goods_issue.update({ where: { goods_issue_id: old.goods_issue_id }, data: { status_code: DOCUMENT_CANCELLED, version_no: { increment: 1 } } });
  await consumeIncreases(tx, posting, locked.warehouseId, input.changes);

  const oldLines = await tx.goods_issue_line.findMany({ where: { goods_issue_id: old.goods_issue_id }, select: { lot_id: true, source_location_id: true } });
  const locationOf = new Map(oldLines.map((line) => [line.lot_id, line.source_location_id]));
  const allocations = await tx.shipment_lot_allocation.findMany({
    where: { shipment_line: { shipment_id: locked.shipmentId } },
    orderBy: [{ shipment_line: { line_no: 'asc' } }, { shipment_lot_allocation_id: 'asc' }],
    select: { shipment_line_id: true, lot_id: true, allocated_qty: true, uom_id: true, shipment_line: { select: { item_id: true } } },
  });
  const issue = await tx.goods_issue.create({
    data: {
      goods_issue_no: input.goodsIssueNo, issue_type_code: old.issue_type_code, source_document_type_code: SHIPMENT_TARGET,
      source_document_id: locked.shipmentId, source_warehouse_id: old.source_warehouse_id, issued_at: old.issued_at,
      status_code: POSTED, created_by: appUserId === undefined ? null : BigInt(appUserId),
    },
  });
  const issueLines: GoodsIssueLineWriteInput[] = [];
  const firstLineOf = new Map<bigint, bigint>();
  for (const [index, allocation] of allocations.entries()) {
    const sourceLocationId = locationOf.get(allocation.lot_id) as bigint;
    const created = await tx.goods_issue_line.create({
      data: { goods_issue_id: issue.goods_issue_id, line_no: index + 1, item_id: allocation.shipment_line.item_id, lot_id: allocation.lot_id,
        issue_qty: allocation.allocated_qty, uom_id: allocation.uom_id, source_location_id: sourceLocationId },
    });
    if (!firstLineOf.has(allocation.shipment_line_id)) firstLineOf.set(allocation.shipment_line_id, created.goods_issue_line_id);
    issueLines.push({ goodsIssueLineId: created.goods_issue_line_id, itemId: allocation.shipment_line.item_id, lotId: allocation.lot_id,
      issueQty: new Prisma.Decimal(allocation.allocated_qty), uomId: allocation.uom_id, sourceLocationId });
  }
  await postIssue(tx, posting, {
    header: { goodsIssueId: issue.goods_issue_id, goodsIssueNo: input.goodsIssueNo, issueTypeCode: old.issue_type_code,
      sourceDocumentTypeCode: NO_PICK_CONSUME_AXIS, sourceDocumentId: locked.shipmentId, sourceWarehouseId: old.source_warehouse_id,
      destinationTypeCode: null, destinationId: null },
    lines: issueLines, businessDate, occurredAt: old.issued_at,
  }, appUserId);
  for (const [shipmentLineId, goodsIssueLineId] of firstLineOf) {
    await tx.shipment_line.update({ where: { shipment_line_id: shipmentLineId }, data: { goods_issue_line_id: goodsIssueLineId } });
  }
  return { cancelled: old.goods_issue_no, issued: input.goodsIssueNo };
}

async function consumeIncreases(tx: Tx, posting: InventoryPostingService, warehouseId: bigint, changes: AllocationChange[]): Promise<void> {
  for (const { allocation, after } of changes) {
    const delta = after.minus(allocation.qty);
    if (!delta.isPositive() || delta.isZero()) continue;
    const [row] = (await lockBalancesByItemLot(tx, allocation.itemId, allocation.lotId)).filter((balance) => balance.warehouseId === warehouseId);
    await posting.consume(tx, [{
      dimension: {
        legalEntityId: row.legalEntityId, businessUnitId: row.businessUnitId, plantId: row.plantId, warehouseId: row.warehouseId,
        locationId: row.locationId, itemId: row.itemId, lotId: row.lotId, qualityStatusCode: row.quality_status_code,
        inventoryStatusCode: row.inventory_status_code, ownershipTypeCode: row.ownership_type_code, ownerPartnerId: row.owner_partner_id,
      },
      qty: delta,
      field: 'items',
    }]);
  }
}
