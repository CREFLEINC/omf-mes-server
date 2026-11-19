import { Prisma } from '@prisma/client';

import { InventoryPostingService } from '../../core/inventory-posting';
import { GoodsIssueLineWriteInput, postIssue } from '../goods-issue/issue-posting';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';

/**
 * 출하 완료의 재고 쪽(피처 010 R-8 · D-15) — 출하 «하나»(창고 없음)에 창고마다 내부 재고 차감 기록(`goods_issue`) 하나씩.
 * 피킹 LOT 의 예약 행(잔액 행마다 하나)이 곧 낼 몫이다 — 그 창고·위치에서 `postIssue` 가 피킹분을 소진하고 원장 출고를 쓴다.
 * ⛔ `shipment-posting.ts`(옛 W-04-04)를 거치지 않는다 — 그쪽은 창고 하나·세션 사용자 전제다. 전기 코어(`postIssue`)는 같다.
 */

type Tx = Prisma.TransactionClient;

/** 낼 몫 하나 — 예약 행 하나(창고·위치·LOT·수량). */
export interface CompletionPortion {
  shipmentRequestLineId: bigint;
  itemId: bigint;
  lotId: bigint;
  warehouseId: bigint;
  locationId: bigint;
  qty: Prisma.Decimal;
  uomId: bigint;
}

/** 살아 있는(PICKED) 피킹 LOT 의 예약 행 → 낼 몫. 남은 몫(reserved − released)이 0 인 행은 뺀다. */
export async function completionPortions(tx: Tx, shipmentRequestId: bigint): Promise<CompletionPortion[]> {
  const lots = await tx.shipment_request_lot.findMany({
    where: { status_code: 'PICKED', shipment_request_line: { shipment_request_id: shipmentRequestId } },
    select: { shipment_request_line_id: true, lot_id: true, uom_id: true, shipment_request_line: { select: { item_id: true } } },
  });
  if (lots.length === 0) return [];
  const reservations = await tx.inventory_reservation.findMany({
    where: {
      source_document_type_code: SHIPMENT_REQUEST_LINE,
      source_document_id: { in: [...new Set(lots.map((lot) => lot.shipment_request_line_id))] },
      lot_id: { in: lots.map((lot) => lot.lot_id) },
    },
    orderBy: { inventory_reservation_id: 'asc' },
  });
  return reservations.flatMap((row) => {
    const lot = lots.find((candidate) => candidate.shipment_request_line_id === row.source_document_id && candidate.lot_id === row.lot_id);
    const qty = new Prisma.Decimal(row.reserved_qty).minus(row.released_qty);
    if (lot === undefined || !qty.greaterThan(0) || row.location_id === null) return [];
    return [{
      shipmentRequestLineId: lot.shipment_request_line_id, itemId: lot.shipment_request_line.item_id, lotId: lot.lot_id,
      warehouseId: row.warehouse_id, locationId: row.location_id, qty, uomId: lot.uom_id,
    }];
  });
}

/** 창고 id 목록(처음 나온 순서) — 채번 수를 트랜잭션 밖에서 정할 때도 쓴다. */
export function warehousesOf(portions: readonly CompletionPortion[]): bigint[] {
  return [...new Set(portions.map((portion) => portion.warehouseId))];
}

/**
 * 창고마다 `goods_issue`(원천 = 이 출하) + 라인 + `postIssue`. 돌려주는 것은 몫마다의 출고 라인 id(같은 순서) — 출하 라인이 되짚는다.
 * ⭐ 원천 유형 `SHIPMENT` 이 피킹 소진 축이다(`CONSUMES_PICKED`) — 예약 때 올린 `picked` 가 여기서 내려간다.
 */
export async function postCompletionIssues(
  tx: Tx,
  posting: InventoryPostingService,
  input: {
    shipmentId: bigint;
    portions: readonly CompletionPortion[];
    goodsIssueNos: ReadonlyMap<string, string>;
    businessDate: string;
    occurredAt: Date;
  },
): Promise<bigint[]> {
  const lineIdOf = new Map<CompletionPortion, bigint>();
  for (const warehouseId of warehousesOf(input.portions)) {
    const goodsIssueNo = input.goodsIssueNos.get(String(warehouseId));
    if (goodsIssueNo === undefined) throw new Error(`창고 ${String(warehouseId)} 의 출고 번호가 없다`);
    const issue = await tx.goods_issue.create({
      data: {
        goods_issue_no: goodsIssueNo, issue_type_code: 'SHIPMENT', source_document_type_code: 'SHIPMENT',
        source_document_id: input.shipmentId, source_warehouse_id: warehouseId, issued_at: input.occurredAt, status_code: 'POSTED',
      },
    });
    const mine = input.portions.filter((portion) => portion.warehouseId === warehouseId);
    const lines: GoodsIssueLineWriteInput[] = [];
    for (const [index, portion] of mine.entries()) {
      const created = await tx.goods_issue_line.create({
        data: {
          goods_issue_id: issue.goods_issue_id, line_no: index + 1, item_id: portion.itemId, lot_id: portion.lotId,
          issue_qty: portion.qty, uom_id: portion.uomId, source_location_id: portion.locationId,
        },
      });
      lineIdOf.set(portion, created.goods_issue_line_id);
      lines.push({
        goodsIssueLineId: created.goods_issue_line_id, itemId: portion.itemId, lotId: portion.lotId,
        issueQty: portion.qty, uomId: portion.uomId, sourceLocationId: portion.locationId,
      });
    }
    await postIssue(tx, posting, {
      header: {
        goodsIssueId: issue.goods_issue_id, goodsIssueNo, issueTypeCode: 'SHIPMENT', sourceDocumentTypeCode: 'SHIPMENT',
        sourceDocumentId: input.shipmentId, sourceWarehouseId: warehouseId, destinationTypeCode: null, destinationId: null,
      },
      lines,
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
    }, undefined);
  }
  return input.portions.map((portion) => lineIdOf.get(portion) as bigint);
}

/**
 * 한 출하 라인의 몫들을 LOT 마다 하나로 합친다(처음 나온 순서). 배분 행은 `uq_shipment_lot_allocation`
 * (출하 라인·LOT·HU) 에 걸리므로 LOT 하나에 한 행이다 — 창고·위치별 차감은 출고 전표 라인(몫마다)이 맡는다.
 * 취소의 예약 되돌림(`releaseShipmentReservations`)도 (지시 라인, LOT) 로 찾아 합계를 예약 행마다 나눠 푼다.
 */
export function allocationsOf(portions: readonly CompletionPortion[]): { lotId: bigint; qty: Prisma.Decimal; uomId: bigint }[] {
  const byLot = new Map<string, { lotId: bigint; qty: Prisma.Decimal; uomId: bigint }>();
  for (const portion of portions) {
    const found = byLot.get(String(portion.lotId));
    if (found === undefined) byLot.set(String(portion.lotId), { lotId: portion.lotId, qty: new Prisma.Decimal(portion.qty), uomId: portion.uomId });
    else found.qty = found.qty.plus(portion.qty);
  }
  return [...byLot.values()];
}

/**
 * 출하 라인(지시 라인마다 하나) · LOT 배분(LOT 마다 하나 — 몫을 합친다) · 지시 라인·수주 라인 출하 수량. 라인 순서는 지시 라인 번호다.
 * 수주 라인은 한도 없이 더한다(D-16).
 */
export async function writeCompletionLines(
  tx: Tx,
  input: { shipmentId: bigint; portions: readonly CompletionPortion[]; issueLineIds: readonly bigint[] },
): Promise<void> {
  const lineIds = [...new Set(input.portions.map((portion) => portion.shipmentRequestLineId))];
  const requestLines = await tx.shipment_request_line.findMany({
    where: { shipment_request_line_id: { in: lineIds } },
    select: { shipment_request_line_id: true, line_no: true, item_id: true, uom_id: true, sales_order_line_id: true },
    orderBy: { line_no: 'asc' },
  });
  for (const [index, line] of requestLines.entries()) {
    const mine = input.portions.map((portion, at) => ({ portion, at })).filter(({ portion }) => portion.shipmentRequestLineId === line.shipment_request_line_id);
    const shipped = mine.reduce((sum, { portion }) => sum.plus(portion.qty), new Prisma.Decimal(0));
    const created = await tx.shipment_line.create({
      data: {
        shipment_id: input.shipmentId, line_no: index + 1, shipment_request_line_id: line.shipment_request_line_id,
        item_id: line.item_id, shipped_qty: shipped, uom_id: line.uom_id, goods_issue_line_id: input.issueLineIds[mine[0].at],
      },
    });
    await tx.shipment_lot_allocation.createMany({
      data: allocationsOf(mine.map(({ portion }) => portion)).map((allocation) => ({
        shipment_line_id: created.shipment_line_id, lot_id: allocation.lotId, allocated_qty: allocation.qty, uom_id: allocation.uomId,
      })),
    });
    await tx.shipment_request_line.update({
      where: { shipment_request_line_id: line.shipment_request_line_id },
      data: { shipped_qty: { increment: shipped }, version_no: { increment: 1 } },
    });
    if (line.sales_order_line_id !== null) {
      await tx.sales_order_line.update({
        where: { sales_order_line_id: line.sales_order_line_id },
        data: { shipped_qty: { increment: shipped }, version_no: { increment: 1 } },
      });
    }
  }
}
