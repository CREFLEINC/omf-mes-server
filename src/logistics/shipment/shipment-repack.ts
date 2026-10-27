import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
import { LockedBalanceRow, lockBalancesInOrder } from '../../core/inventory-posting/balance-lock';
import { BalanceDimension } from '../../core/inventory-posting/reservation-qty';
import { GoodsIssueLineWriteInput, postIssue } from '../goods-issue/issue-posting';
import { CANCELLED, CONFIRMED, SHIPMENT_TARGET, Tx, hasOpenCancel, lockShipment } from './shipment-guards';
import { CANCELLED_SO_LINE } from '../shipment-request/shipment-request.constants';
import { AllocationChange, REORDER, RepackAllocation, netChanges } from './shipment-repack-plan';

/**
 * 출하에 배분된 상자를 고칠 때 출하·재고를 같이 맞춘다(장부 P-125).
 * 원장은 그 출하의 출고 «전체»를 역전기하고 고친 배분으로 새 출고를 세운다 — 코어에 부분 역전기가 없고, 출하 취소와 같은 역전기를 쓴다.
 * 줄인 몫은 «피킹됐지만 아직 출하 안 됨»으로 남는다 — 역전기로 돌아온 수량을 피킹으로 되돌리고 새 출고가 고친 수량만 소진한다.
 * 지시 라인의 피킹 예약은 건드리지 않는다(라인 피킹 = 예약 합, 출하 수량이 줄면 그만큼이 그 라인의 피킹 미출하분이다).
 *
 * 잠금 순서: 출하 → 출하의 배분 → (호출자) 상자 → 지시 라인(id 순) → 출하의 LOT 잔액(id 순 한 번에) → 수주 라인.
 * 배분에 상자를 잇는 경로가 배분 → 상자 순이고, 피킹(M-04-01)이 지시 라인 → 잔액 순이라 그 순서에 맞춘다.
 * ⚠ 출하 등록은 잔액 → 지시 라인 순이라 같은 지시 라인·LOT 에서 등록과 정정이 겹치면 교착할 수 있다 — 피킹과 등록이 이미 서로
 *   반대라 둘 다 맞출 수는 없다. 교착은 호출자가 409 「다른 작업과 겹쳤습니다」로 바꾼다(장부 P-125).
 */

const POSTED = 'POSTED';
const DOCUMENT_CANCELLED = 'CANCELLED';
const GOODS_ISSUE = 'GOODS_ISSUE';
/** 출하 출고의 피킹 소진 축 — 출하 등록과 같은 값이라 새 출고도 피킹분을 소진한다. */
const SHIPMENT_CONSUME_AXIS = SHIPMENT_TARGET;
const LABEL_NOTICE = '수량이 바뀌어 이 출하의 출고 전표 QR·납품 라벨이 실물과 다릅니다 — 출력 이력에서 다시 발행하세요.';

export interface LinkedShipment {
  shipmentId: bigint;
  plantId: bigint;
  /** 살아 있는 출고 원장의 영업일 — 새 출고도 이 날에 선다. */
  businessDate: string | null;
}

/** 취소된 출하의 배분은 상자를 묶지 않는다 — 그 상자는 새로 포장해 쓸 수 있다. */
const LIVE_ALLOCATION = (handlingUnitId: bigint): Prisma.shipment_lot_allocationWhereInput => ({
  handling_unit_id: handlingUnitId, shipment_line: { shipment: { status_code: { not: CANCELLED } } },
});

/** 트랜잭션 밖 — 이 상자가 출하에 이어졌는지와 새 출고 번호를 뽑을 축. */
export async function linkedShipmentOf(tx: Tx, handlingUnitId: bigint): Promise<LinkedShipment | null> {
  const shipments = await tx.shipment.findMany({
    where: { shipment_line: { some: { shipment_lot_allocation: { some: LIVE_ALLOCATION(handlingUnitId) } } } },
    select: { shipment_id: true, warehouse: { select: { plant_id: true } } },
  });
  if (shipments.length === 0) return null;
  if (shipments.length > 1) {
    throw new ConflictException('user', `이 상자는 출하 여러 건에 배분되어 있어 고칠 수 없습니다 — ${REORDER}`);
  }
  const [shipment] = shipments;
  const issue = await liveIssue(tx, shipment.shipment_id);
  const ledger = issue === null ? null : await tx.inventory_transaction.findFirst({
    where: { source_document_type_code: GOODS_ISSUE, source_document_id: issue.goods_issue_id, reversal_of_transaction_id: null },
    select: { business_date: true },
  });
  return { shipmentId: shipment.shipment_id, plantId: shipment.warehouse.plant_id,
    businessDate: ledger === null ? null : ledger.business_date.toISOString().slice(0, 10) };
}

/** 잠근 뒤 이 상자에 이어진 살아 있는 배분 수 — 트랜잭션 밖에서 본 연결과 견준다. */
export function countLiveAllocations(tx: Tx, handlingUnitId: bigint): Promise<number> {
  return tx.shipment_lot_allocation.count({ where: LIVE_ALLOCATION(handlingUnitId) });
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
    throw blocked(`출하 ${no}가 확정되어 이 상자를 고칠 수 없습니다 — 수량이 다르면 반품·클레임 입고 등록(W-04-06)으로 처리하세요.`);
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

/**
 * 출하 단위에 담긴 상자는 그 단위에서 빼야 고친다. 상자를 잠근 «뒤»에 본다 — 단위에 넣기가 상자를 잠그지 않아도
 * 출하 잠금(넣기는 단위 → 출하 순)으로 갈리고, 넣기가 출하를 잠그지 않는 판에서도 이 정정이 커밋 전 넣기를 놓치지 않는다.
 */
export async function assertNotInShippingUnit(tx: Tx, handlingUnitId: bigint): Promise<void> {
  const link = await tx.shipping_unit_handling_unit.findUnique({
    where: { handling_unit_id: handlingUnitId },
    select: { shipping_unit: { select: { shipping_unit_no: true, status_code: true } } },
  });
  if (link === null) return;
  const { shipping_unit_no: no, status_code: status } = link.shipping_unit;
  const step = status === 'OPEN' ? '상자를 뺀 뒤' : '단위를 다시 열고 상자를 뺀 뒤';
  throw new ConflictException('user', `이 상자는 출하 단위 ${no}에 담겨 있어 고칠 수 없습니다 — P-04-05 출하 단위에서 ${step} 고치세요.`);
}

export interface RepackSync {
  shipmentNo: string;
  cancelledGoodsIssueNo: string;
  goodsIssueNo: string;
  changes: { lineNo: number; lotNo: string; before: string; after: string }[];
  notice: string;
}

interface SyncInput {
  locked: LockedRepack;
  changes: AllocationChange[];
  goodsIssueNo: string;
  appUserId?: number;
  now: Date;
}

/** 고친 배분을 출하·지시 라인·수주 라인·잔액·원장에 옮긴다. `changes` 는 비어 있지 않다. */
export async function syncShipment(tx: Tx, posting: InventoryPostingService, input: SyncInput): Promise<RepackSync> {
  const { locked, changes, appUserId } = input;
  const net = netChanges(locked.allocations, changes);
  const old = await liveIssue(tx, locked.shipmentId);
  if (old === null) throw new Error(`출하에 살아 있는 출고 전표가 없다: ${locked.shipmentNo}`);
  const oldLines = await tx.goods_issue_line.findMany({ where: { goods_issue_id: old.goods_issue_id }, select: { lot_id: true, source_location_id: true } });
  const locationOf = new Map(oldLines.map((line) => [line.lot_id, line.source_location_id]));
  await lockRequestLines(tx, locked.shipmentId);
  const balances = await lockLotBalances(tx, locked, net.byLot, locationOf);
  await assertFits(tx, locked, net, balances);

  for (const { allocation, after } of changes) {
    if (after.isZero()) await tx.shipment_lot_allocation.delete({ where: { shipment_lot_allocation_id: allocation.allocationId } });
    else await tx.shipment_lot_allocation.update({ where: { shipment_lot_allocation_id: allocation.allocationId }, data: { allocated_qty: after } });
  }
  await rollUp(tx, net.byLine);
  const reissued = await reissue(tx, posting, input, old, net, balances, locationOf);
  await tx.shipment.update({
    where: { shipment_id: locked.shipmentId },
    data: { version_no: { increment: 1 }, ...(appUserId === undefined ? {} : { updated_by: BigInt(appUserId) }) },
  });
  return {
    shipmentNo: locked.shipmentNo, cancelledGoodsIssueNo: old.goods_issue_no, goodsIssueNo: reissued,
    changes: changes.map(({ allocation, after }) => ({
      lineNo: allocation.lineNo, lotNo: allocation.lotNo, before: allocation.qty.toString(), after: after.toString(),
    })),
    notice: LABEL_NOTICE,
  };
}

type LotBalance = LockedBalanceRow & { picked: Prisma.Decimal };

/** 이 출하가 걸친 지시 라인을 id 순으로 잠근다 — 피킹과 같은 «지시 라인 → 잔액» 순서. */
async function lockRequestLines(tx: Tx, shipmentId: bigint): Promise<void> {
  await tx.$queryRaw`
    SELECT shipment_request_line_id FROM logistics.shipment_request_line
     WHERE shipment_request_line_id IN (SELECT shipment_request_line_id FROM logistics.shipment_line WHERE shipment_id = ${shipmentId})
     ORDER BY shipment_request_line_id
       FOR UPDATE`;
}

/** 출하의 LOT 잔액을 id 순으로 한 번에 잠근다. 창고에 그 LOT 의 잔액 행이 하나가 아니면 어느 것을 고칠지 정할 수 없다. */
async function lockLotBalances(
  tx: Tx, locked: LockedRepack, byLot: ReturnType<typeof netChanges>['byLot'], locationOf: Map<bigint, bigint>,
): Promise<Map<bigint, LotBalance>> {
  const warehouse = await tx.warehouse.findUniqueOrThrow({
    where: { warehouse_id: locked.warehouseId },
    select: { business_unit_id: true, plant_id: true, plant: { select: { legal_entity_id: true } } },
  });
  const keys = [...byLot.values()].map(({ allocation }) => ({
    legalEntityId: warehouse.plant.legal_entity_id, businessUnitId: warehouse.business_unit_id, plantId: warehouse.plant_id,
    warehouseId: locked.warehouseId, locationId: locationOf.get(allocation.lotId) as bigint, itemId: allocation.itemId, lotKey: allocation.lotId,
  }));
  const rows = await lockBalancesInOrder(tx, keys);
  const errors: ErrorItem[] = [];
  const balances = new Map<bigint, LotBalance>();
  for (const { allocation } of byLot.values()) {
    const mine = rows.filter((row) => row.lotKey === allocation.lotId);
    if (mine.length !== 1) {
      errors.push(field('items', ERROR_CODE.INVALID, `LOT ${allocation.lotNo}: 이 창고의 재고 차원이 하나가 아니라 고칠 수 없습니다 — `
        + '재고 현황·상태 조회(W-01-07)에서 그 LOT 의 재고를 확인하세요.'));
      continue;
    }
    const { picked_qty: picked } = await tx.inventory_balance.findFirstOrThrow({ where: dimensionWhere(dimensionOf(mine[0])), select: { picked_qty: true } });
    balances.set(allocation.lotId, { ...mine[0], picked });
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return balances;
}

/** 순증감이 지시 라인 배정·수주 수량 안이어야 하고, LOT 마다 늘어난 만큼 잔액 피킹분이 남아 있어야 한다. */
async function assertFits(tx: Tx, locked: LockedRepack, net: ReturnType<typeof netChanges>, balances: Map<bigint, LotBalance>): Promise<void> {
  const errors: ErrorItem[] = [];
  const lines = await tx.shipment_line.findMany({
    where: { shipment_id: locked.shipmentId, shipment_line_id: { in: [...net.byLine.keys()] } },
    select: { shipment_line_id: true, shipment_request_line: { select: {
      line_no: true, allocated_qty: true, shipped_qty: true, shipment_request: { select: { shipment_request_no: true } },
      sales_order_line: { select: { line_no: true, ordered_qty: true, shipped_qty: true, cancelled_at: true, sales_order: { select: { sales_order_no: true } } } },
    } } },
  });
  for (const line of lines) {
    const delta = net.byLine.get(line.shipment_line_id) as Prisma.Decimal;
    if (!delta.greaterThan(0)) continue;
    const request = line.shipment_request_line;
    if (request.shipped_qty.plus(delta).greaterThan(request.allocated_qty)) {
      errors.push(field('items', ERROR_CODE.RANGE, `출하작업지시 ${request.shipment_request.shipment_request_no} ${request.line_no}번 줄의 배정 수량`
        + `(${request.allocated_qty.toString()})을 넘습니다 — 출하작업지시에서 배정을 늘리거나 수량을 줄이세요.`));
    }
    const order = request.sales_order_line;
    if (order?.cancelled_at != null) {
      errors.push(field('items', ERROR_CODE.INVALID, `수주 ${order.sales_order.sales_order_no} ${order.line_no}번 줄: ${CANCELLED_SO_LINE} `
        + '— 늘리는 정정은 할 수 없으니 수량을 줄이거나 그대로 두세요.'));
    } else if (order !== null && order.shipped_qty.plus(delta).greaterThan(order.ordered_qty)) {
      errors.push(field('items', ERROR_CODE.RANGE, `수주 ${order.sales_order.sales_order_no} ${order.line_no}번 줄의 수주 수량`
        + `(${order.ordered_qty.toString()})을 넘습니다 — 수량을 줄이세요.`));
    }
  }
  for (const [lotId, lot] of net.byLot) {
    const increase = lot.after.minus(lot.before);
    const picked = (balances.get(lotId) as LotBalance).picked;
    if (increase.greaterThan(picked)) {
      errors.push(field('items', ERROR_CODE.NEGATIVE_BALANCE, `LOT ${lot.allocation.lotNo}: 늘린 수량(${increase.toString()})만큼 남은 피킹분이 없습니다`
        + `(남은 피킹분 ${picked.toString()}) — 모바일 출하 피킹(M-04-01)에서 더 피킹한 뒤 고치세요.`));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 출하 줄·지시 라인·수주 라인 출하 수량에 줄별 순증감을 한 번씩 더한다 — 중간 상태가 CHECK 를 깨지 않게. */
async function rollUp(tx: Tx, byLine: Map<bigint, Prisma.Decimal>): Promise<void> {
  for (const [shipmentLineId, delta] of byLine) {
    if (delta.isZero()) continue;
    const line = await tx.shipment_line.update({
      where: { shipment_line_id: shipmentLineId }, data: { shipped_qty: { increment: delta } }, select: { shipment_request_line_id: true },
    });
    const request = await tx.shipment_request_line.update({
      where: { shipment_request_line_id: line.shipment_request_line_id },
      data: { shipped_qty: { increment: delta }, version_no: { increment: 1 } },
      select: { sales_order_line_id: true },
    });
    if (request.sales_order_line_id === null) continue;
    await tx.sales_order_line.update({
      where: { sales_order_line_id: request.sales_order_line_id },
      data: { shipped_qty: { increment: delta }, version_no: { increment: 1 } },
    });
  }
}

/**
 * 옛 출고를 역전기·취소하고, 돌아온 «전» 수량을 피킹으로 되돌린 뒤(예약 없이 가용 → 피킹), 지금 배분 전체로 새 출고를 세워
 * 피킹분을 «후» 수량만큼 소진한다. 영업일·발생 시각은 처음 출고 것이다.
 */
async function reissue(
  tx: Tx, posting: InventoryPostingService, input: SyncInput,
  old: NonNullable<Awaited<ReturnType<typeof liveIssue>>>, net: ReturnType<typeof netChanges>,
  balances: Map<bigint, LotBalance>, locationOf: Map<bigint, bigint>,
): Promise<string> {
  const { locked, appUserId } = input;
  const ledgers = await tx.inventory_transaction.findMany({
    where: { source_document_type_code: GOODS_ISSUE, source_document_id: old.goods_issue_id, reversal_of_transaction_id: null },
    select: { inventory_transaction_id: true, business_date: true },
  });
  if (ledgers.length !== 1) throw new Error(`${GOODS_ISSUE}/${old.goods_issue_id} 의 원장이 ${ledgers.length} 행이다 — 정확히 하나여야 한다.`);
  const businessDate = ledgers[0].business_date.toISOString().slice(0, 10);
  const reversed = await posting.reverse(tx, {
    inventoryTransactionId: ledgers[0].inventory_transaction_id, businessDate, occurredAt: input.now, createdBy: appUserId,
  });
  if (reversed.alreadyReversed) throw new Error(`${old.goods_issue_no} 는 이미 되돌려졌다 — 살아 있는 출고 판정을 지나쳤다.`);
  await tx.goods_issue.update({ where: { goods_issue_id: old.goods_issue_id }, data: { status_code: DOCUMENT_CANCELLED, version_no: { increment: 1 } } });
  await posting.pick(tx, [...net.byLot].map(([lotId, lot]) => ({
    dimension: dimensionOf(balances.get(lotId) as LotBalance), delta: lot.before, inventoryReservationId: null, field: 'items',
  })));

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
      sourceDocumentTypeCode: SHIPMENT_CONSUME_AXIS, sourceDocumentId: locked.shipmentId, sourceWarehouseId: old.source_warehouse_id,
      destinationTypeCode: null, destinationId: null },
    lines: issueLines, businessDate, occurredAt: old.issued_at,
  }, appUserId);
  for (const [shipmentLineId, goodsIssueLineId] of firstLineOf) {
    await tx.shipment_line.update({ where: { shipment_line_id: shipmentLineId }, data: { goods_issue_line_id: goodsIssueLineId } });
  }
  return input.goodsIssueNo;
}

function dimensionOf(row: LockedBalanceRow): BalanceDimension {
  return {
    legalEntityId: row.legalEntityId, businessUnitId: row.businessUnitId, plantId: row.plantId, warehouseId: row.warehouseId,
    locationId: row.locationId, itemId: row.itemId, lotId: row.lotId, qualityStatusCode: row.quality_status_code,
    inventoryStatusCode: row.inventory_status_code, ownershipTypeCode: row.ownership_type_code, ownerPartnerId: row.owner_partner_id,
  };
}

function dimensionWhere(d: BalanceDimension): Prisma.inventory_balanceWhereInput {
  return {
    legal_entity_id: d.legalEntityId, business_unit_id: d.businessUnitId, plant_id: d.plantId, warehouse_id: d.warehouseId,
    location_id: d.locationId, item_id: d.itemId, lot_id: d.lotId, quality_status_code: d.qualityStatusCode,
    inventory_status_code: d.inventoryStatusCode, ownership_type_code: d.ownershipTypeCode, owner_partner_id: d.ownerPartnerId,
  };
}

