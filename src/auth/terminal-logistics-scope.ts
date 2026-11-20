import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import {
  lineInTerminalScopeWhere,
  plantBusinessUnit,
  requestInBusinessUnitWhere,
} from '../logistics/shipment-request/shipment-request-scope';
import { PrismaService } from '../prisma/prisma.service';
import { handlingUnitInPlant } from './handling-unit-plant';
import { TerminalContext } from './terminal-context';
import { currentSession } from './session-resolver.service';

type TerminalType = 'POP' | 'MOBILE';
const ATTACHED_WORKER = Symbol('terminalLogisticsWorker');
export function currentTerminalLogisticsWorkerId(request: Request): bigint | undefined {
  return (request as Request & { [ATTACHED_WORKER]?: bigint })[ATTACHED_WORKER];
}
export function logisticsAppUserId(request: Request): number {
  const session = currentSession(request);
  if (session) return session.userId;
  throw denied();
}

/** Contract operation keys reached by the POP and mobile clients. */
export const TERMINAL_LOGISTICS_OPERATIONS: Readonly<Record<string, readonly TerminalType[]>> = {
  // ⭐ POP 을 더한다 — P-01-02(출고 QR 발행)가 출고번호로 전표를 찾아 들어간다(사용자 결정 U3).
  //    공장 강제는 컨트롤러가 단말의 `plantId` 를 목록 질의에 넘겨 이미 걸린다.
  'GET /logistics/goods-issues': ['POP', 'MOBILE'],
  'GET /logistics/goods-issues/{goodsIssueId}': ['POP'],
  'GET /logistics/goods-issues/{goodsIssueId}/lines': ['POP', 'MOBILE'],
  'GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances': ['MOBILE'],
  // 입하 LOT 조회·받기·해제·공급사 LOT·마감·마감 취소(피처 005 §2·§3) — PDA M-01-01·M-01-03.
  'GET /logistics/inbound-lots': ['MOBILE'],
  'GET /logistics/inbound-lots/{inboundLotId}': ['MOBILE'],
  'POST /logistics/inbound-lots:receive': ['MOBILE'],
  'POST /logistics/inbound-lots/{inboundLotId}:unregister-lots': ['MOBILE'],
  'POST /logistics/inbound-lots/{inboundLotId}:close-receipt': ['MOBILE'],
  'POST /logistics/inbound-lots/{inboundLotId}:reopen-receipt': ['MOBILE'],
  'PATCH /logistics/inbound-lots/{inboundLotId}/lots/supplier-lot-no': ['MOBILE'],
  'GET /logistics/inbound-receipts': ['POP', 'MOBILE'],
  'GET /logistics/inbound-receipts/{inboundReceiptId}/lines': ['POP', 'MOBILE'],
  'GET /logistics/material-issue-requests/{materialIssueRequestId}': ['MOBILE'],
  'GET /logistics/picking-orders': ['MOBILE'],
  'GET /logistics/picking-orders/{pickingOrderId}': ['MOBILE'],
  'GET /logistics/purchase-orders': ['MOBILE'],
  'GET /logistics/purchase-orders/{purchaseOrderId}': ['MOBILE'],
  'GET /logistics/putaway-tasks': ['MOBILE'],
  'GET /logistics/putaway-tasks/{putawayTaskId}': ['MOBILE'],
  // 지시 없는 적치(피처 009) — LOT 은 단말 공장으로 서비스가 판정한다(다른 공장 LOT 은 이유 OTHER_PLANT 로 답한다).
  'GET /logistics/putaway-pending-lots': ['MOBILE'],
  'GET /logistics/putaway-pending-lots:lookup': ['MOBILE'],
  'GET /logistics/putaway-pending-lots/{lotId}/location-check': ['MOBILE'],
  'POST /logistics/putaway-pending-lots/{lotId}:putaway': ['MOBILE'],
  'POST /logistics/putaway-pending-lots/{lotId}:putaway-temporary': ['MOBILE'],
  // 적치 기록(피처 011 · M-01-14) — 결과는 서비스가 단말 공장·단말·사번 작업자로 좁힌다. 질의에 id 가 없다.
  'GET /logistics/putaway-records': ['MOBILE'],
  'GET /logistics/shipment-lot-allocations': ['POP', 'MOBILE'],
  // POP 출하 완료 찾기(P-04-07 · 피처 010)도 같은 목록을 쓴다 — 공장은 컨트롤러가 단말 공장으로 건다.
  'GET /logistics/shipment-requests': ['MOBILE', 'POP'],
  'GET /logistics/shipment-requests:lookup': ['POP', 'MOBILE'],
  // POP OQC 판정(P-04-06)의 머리·피킹 LOT 몫 — 단말 공장 지시서만(피처 010 검증 1회차).
  'GET /logistics/shipment-requests/{shipmentRequestId}': ['POP'],
  'POST /logistics/shipment-requests/{shipmentRequestId}:complete': ['POP'],
  'GET /logistics/shipments': ['POP'],
  // ⭐ 출하 단위(P-04-05) — POP 전용이다. 모바일은 이 화면을 갖지 않는다.
  //    공장 강제는 서비스가 단말의 `plantId` 로 좁힌다(목록·상세·생성 모두).
  // ⛔ **쓰기 셋을 반드시 함께 둔다.** 이 화면은 「열고 → 담고 → 마감」이 한 흐름이라 읽기와
  //    생성만 열어 두면 첫 상자 스캔에서 401 로 막힌다 — 실제로 그렇게 났다(SHIP-FINAL-01 D2).
  'GET /logistics/shipping-units': ['POP'],
  'GET /logistics/shipping-units/{shippingUnitId}': ['POP'],
  'POST /logistics/shipping-units': ['POP'],
  'POST /logistics/shipping-units/{shippingUnitId}:add-box': ['POP'],
  'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}': ['POP'],
  'POST /logistics/shipping-units/{shippingUnitId}:close': ['POP'],
  'GET /logistics/shipments/{shipmentId}': ['POP'],
  'GET /logistics/shopfloor-receipts': ['POP', 'MOBILE'],
  'GET /logistics/shopfloor-receipts/{shopfloorReceiptId}': ['POP'],
  'GET /logistics/stock-transfers': ['MOBILE'],
  'GET /logistics/stock-transfers/{stockTransferId}/lines': ['MOBILE'],
  'POST /logistics/goods-issues': ['MOBILE'],
  'POST /logistics/goods-receipts': ['MOBILE'],
  'POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances': ['MOBILE'],
  'POST /logistics/inbound-receipts': ['MOBILE'],
  'POST /logistics/inbound-receipts:split': ['MOBILE'],
  'POST /logistics/inbound-receipts:per-line': ['MOBILE'],
  'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick': ['MOBILE'],
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete': ['MOBILE'],
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary': ['MOBILE'],
  'POST /logistics/recycle-entries': ['MOBILE'],
  'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick': ['MOBILE'],
  // 출하 공정 단순화(피처 010) — PDA LOT 통째 피킹. 소유는 지시서 이행 공장 = 단말 공장.
  'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot': ['MOBILE'],
  'POST /logistics/shipment-request-lots/{shipmentRequestLotId}:replace': ['MOBILE'],
  'PUT /logistics/shipment-request-lots/{shipmentRequestLotId}/management-code': ['MOBILE'],
  'POST /logistics/shopfloor-receipts': ['MOBILE'],
  'POST /logistics/stock-transfers': ['MOBILE'],
  'POST /logistics/stock-transfers/{stockTransferId}:arrive': ['MOBILE'],
  'PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}': ['POP'],
  // 생산 LOT 수량 분리(피처 013) — 공장은 서비스가 단말 공장으로 건다(다른 공장 LOT 은 404). 본문 lotId·locationId 는 아래 본문 검사.
  'GET /logistics/product-lot-splits:lookup': ['POP'],
  'POST /logistics/product-lot-splits': ['POP'],
  'GET /logistics/product-lot-splits': ['POP', 'MOBILE'],
  'POST /logistics/product-lot-splits/{productLotSplitId}:confirm': ['MOBILE'],
};

export async function assertTerminalLogisticsScope(
  prisma: PrismaService, request: Request, key: string, terminal: TerminalContext,
): Promise<void> {
  if (!TERMINAL_LOGISTICS_OPERATIONS[key]?.includes(terminal.terminalTypeCode as TerminalType)) throw denied();
  const plant = terminal.plantId;
  const q = request.query as Record<string, unknown>;
  const b = object(request.body);
  const p = request.params;
  const check = async (row: unknown) => { if (!row) throw denied(); };
  const warehouse = async (v: unknown) => check(await prisma.warehouse.findFirst({ where: { warehouse_id: id(v), plant_id: plant }, select: { warehouse_id: true } }));
  const location = async (v: unknown) => check(await prisma.location.findFirst({ where: { location_id: id(v), warehouse: { plant_id: plant } }, select: { location_id: true } }));
  const lot = async (v: unknown) => check(await prisma.lot.findFirst({ where: { lot_id: id(v), plant_id: plant }, select: { lot_id: true } }));
  const worker = async (v: unknown) => check(await prisma.worker.findFirst({ where: { worker_id: id(v), plant_id: plant, is_active: true }, select: { worker_id: true } }));
  const workerNo = async () => {
    const row = await prisma.worker.findFirst({ where: { worker_no: request.header('X-Worker-No') || '', plant_id: plant, is_active: true }, select: { worker_id: true } });
    if (!row) throw denied();
    Object.defineProperty(request, ATTACHED_WORKER, { value: row.worker_id, configurable: true });
  };
  const issue = async (v: unknown) => check(await prisma.goods_issue.findFirst({ where: { goods_issue_id: id(v), warehouse: { plant_id: plant } }, select: { goods_issue_id: true } }));
  const inbound = async (v: unknown) => check(await prisma.inbound_receipt.findFirst({ where: { inbound_receipt_id: id(v), plant_id: plant }, select: { inbound_receipt_id: true } }));
  const inboundLot = async (v: unknown) => check(await prisma.inbound_lot.findFirst({ where: { inbound_lot_id: id(v), plant_id: plant }, select: { inbound_lot_id: true } }));
  const inboundLine = async (v: unknown) => check(await prisma.inbound_receipt_line.findFirst({ where: { inbound_receipt_line_id: id(v), inbound_receipt: { plant_id: plant } }, select: { inbound_receipt_line_id: true } }));
  const pickOrder = async (v: unknown) => check(await prisma.picking_order.findFirst({ where: { picking_order_id: id(v), warehouse: { plant_id: plant } }, select: { picking_order_id: true } }));
  // 창고 보충 수령 원천(피처 004)은 입고 전표가 없다 — 출발 위치 창고의 공장으로 본다.
  const putaway = async (v: unknown) => check(await prisma.putaway_task.findFirst({ where: { putaway_task_id: id(v), OR: [
    { goods_receipt_line: { goods_receipt: { plant_id: plant } } },
    { goods_receipt_line_id: null, location_putaway_task_from_location_idTolocation: { warehouse: { plant_id: plant } } },
  ] }, select: { putaway_task_id: true } }));
  const shipment = async (v: unknown) => check(await prisma.shipment.findFirst({ where: { shipment_id: id(v), warehouse: { plant_id: plant } }, select: { shipment_id: true } }));
  // 지시서 범위(피처 012 R-2) — 피킹은 줄 범위(줄 창고의 공장·단말 창고, 옛 줄은 이행 공장), POP 은 사업부 범위.
  const lineScope = lineInTerminalScopeWhere({ plantId: plant, warehouseId: terminal.warehouseId ?? null });
  const pickableLine = async (requestId: unknown, lineId: unknown) => check(await prisma.shipment_request_line.findFirst({
    where: { AND: [{ shipment_request_line_id: id(lineId), shipment_request_id: id(requestId) }, lineScope] }, select: { shipment_request_line_id: true },
  }));
  const businessUnitRequest = async (v: unknown) => check(await prisma.shipment_request.findFirst({
    where: { AND: [{ shipment_request_id: id(v) }, requestInBusinessUnitWhere(plant, await plantBusinessUnit(prisma, plant))] },
    select: { shipment_request_id: true },
  }));
  const transfer = async (v: unknown) => check(await prisma.stock_transfer.findFirst({ where: { stock_transfer_id: id(v), warehouse_stock_transfer_from_warehouse_idTowarehouse: { plant_id: plant }, warehouse_stock_transfer_to_warehouse_idTowarehouse: { plant_id: plant } }, select: { stock_transfer_id: true } }));
  const workOrder = async (v: unknown) => check(await prisma.work_order.findFirst({ where: { work_order_id: id(v), production_line: { plant_id: plant } }, select: { work_order_id: true } }));
  const handlingUnit = async (v: unknown) => check(await handlingUnitInPlant(prisma, id(v), plant));
  const purchaseOrderLine = async (v: unknown) => check(await prisma.purchase_order_line.findFirst({ where: { purchase_order_line_id: id(v), purchase_order: { plant_id: plant } }, select: { purchase_order_line_id: true } }));
  const goodsReceiptLine = async (v: unknown) => check(await prisma.goods_receipt_line.findFirst({ where: { goods_receipt_line_id: id(v), goods_receipt: { plant_id: plant } }, select: { goods_receipt_line_id: true } }));
  const goodsIssueLine = async (v: unknown) => check(await prisma.goods_issue_line.findFirst({ where: { goods_issue_line_id: id(v), goods_issue: { warehouse: { plant_id: plant } } }, select: { goods_issue_line_id: true } }));
  const pickingLine = async (v: unknown) => check(await prisma.picking_line.findFirst({ where: { picking_line_id: id(v), picking_order: { warehouse: { plant_id: plant } } }, select: { picking_line_id: true } }));
  const shipmentLine = async (v: unknown) => check(await prisma.shipment_line.findFirst({ where: { shipment_line_id: id(v), shipment: { warehouse: { plant_id: plant } } }, select: { shipment_line_id: true } }));
  const shippingUnit = async (v: unknown) => check(await prisma.shipping_unit.findFirst({ where: { shipping_unit_id: id(v), shipment: { warehouse: { plant_id: plant } } }, select: { shipping_unit_id: true } }));
  const shipmentAllocation = async (v: unknown) => check(await prisma.shipment_lot_allocation.findFirst({ where: { shipment_lot_allocation_id: id(v), shipment_line: { shipment: { warehouse: { plant_id: plant } } } }, select: { shipment_lot_allocation_id: true } }));
  const stockTransferLine = async (v: unknown) => check(await prisma.stock_transfer_line.findFirst({ where: { stock_transfer_line_id: id(v), stock_transfer: { warehouse_stock_transfer_from_warehouse_idTowarehouse: { plant_id: plant }, warehouse_stock_transfer_to_warehouse_idTowarehouse: { plant_id: plant } } }, select: { stock_transfer_line_id: true } }));

  const optional = async (fn: (v: unknown) => Promise<void>, v: unknown) => { if (v !== undefined && v !== null && v !== '') await fn(v); };

  // Query values supplied by the client are checked before a domain list query applies its plant predicate.
  await Promise.all([
    optional(warehouse, q.warehouseId), optional(warehouse, q.sourceWarehouseId),
    optional(warehouse, q.fromWarehouseId), optional(warehouse, q.toWarehouseId),
    optional(location, q.locationId), optional(lot, q.lotId), optional(worker, q.assignedWorkerId),
    optional(shipment, q.shipmentId), optional(issue, q.goodsIssueId), optional(workOrder, q.workOrderId),
    optional(handlingUnit, q.handlingUnitId), optional(shipmentLine, q.shipmentLineId),
  ]);
  if (q.plantId !== undefined && id(q.plantId) !== plant) throw denied();

  // ⛔ `DELETE` 도 쓰기다 — 여기서 작업자를 심지 않으면 `logisticsWriteActorOf` 가 단말
  //    경로에서 workerId 를 못 찾아 401 을 낸다. 허용 목록에 넣는 것만으로는 안 통한다.
  if (isWrite(key)) await workerNo();

  switch (key) {
    case 'GET /logistics/goods-issues':
    case 'GET /logistics/inbound-lots':
    case 'GET /logistics/inbound-receipts':
    case 'GET /logistics/picking-orders':
    case 'GET /logistics/purchase-orders':
    case 'GET /logistics/putaway-tasks':
    case 'GET /logistics/putaway-pending-lots':
    case 'GET /logistics/putaway-pending-lots:lookup':
    case 'GET /logistics/putaway-pending-lots/{lotId}/location-check':
    case 'GET /logistics/putaway-records':
    case 'GET /logistics/shipment-lot-allocations':
    case 'GET /logistics/shipment-requests':
    case 'GET /logistics/shipment-requests:lookup': // 지시서 코드 해석 — 서비스가 단말 공장 지시서만 찾는다(남의 공장은 404).
    case 'GET /logistics/shipping-units':
    case 'GET /logistics/shipments':
    case 'GET /logistics/shopfloor-receipts':
    case 'GET /logistics/stock-transfers':
    case 'GET /logistics/product-lot-splits:lookup':
    case 'GET /logistics/product-lot-splits':
    case 'POST /logistics/product-lot-splits':
      break;
    // 분리 기록 → 공장 = 단말 공장(피처 013). 본문 lotIds 는 서비스가 짝인지 본다.
    case 'POST /logistics/product-lot-splits/{productLotSplitId}:confirm':
      await check(await prisma.product_lot_split.findFirst({ where: { product_lot_split_id: id(p.productLotSplitId), plant_id: plant }, select: { product_lot_split_id: true } })); break;
    case 'GET /logistics/goods-issues/{goodsIssueId}':
    case 'GET /logistics/goods-issues/{goodsIssueId}/lines': await issue(p.goodsIssueId); break;
    case 'GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances':
    case 'POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances': await inboundLine(p.inboundReceiptLineId); break;
    case 'GET /logistics/inbound-receipts/{inboundReceiptId}/lines': await inbound(p.inboundReceiptId); break;
    case 'GET /logistics/inbound-lots/{inboundLotId}':
    case 'POST /logistics/inbound-lots/{inboundLotId}:unregister-lots':
    case 'POST /logistics/inbound-lots/{inboundLotId}:close-receipt':
    case 'POST /logistics/inbound-lots/{inboundLotId}:reopen-receipt':
    case 'PATCH /logistics/inbound-lots/{inboundLotId}/lots/supplier-lot-no': await inboundLot(p.inboundLotId); break;
    // 본문에 공장이 없다(단말 공장) — `lots[].lotId` 는 아래 본문 자원 검사가 공장을 본다.
    case 'POST /logistics/inbound-lots:receive': break;
    case 'GET /logistics/material-issue-requests/{materialIssueRequestId}':
      // 창고 보충 요청(피처 004)은 W/O 가 없다 — 출발 창고의 공장으로 본다.
      await check(await prisma.material_issue_request.findFirst({ where: { material_issue_request_id: id(p.materialIssueRequestId), OR: [
        { work_order: { production_line: { plant_id: plant } } },
        { work_order_id: null, source_warehouse: { plant_id: plant } },
      ] }, select: { material_issue_request_id: true } })); break;
    case 'GET /logistics/picking-orders/{pickingOrderId}': await pickOrder(p.pickingOrderId); break;
    case 'GET /logistics/purchase-orders/{purchaseOrderId}':
      await check(await prisma.purchase_order.findFirst({ where: { purchase_order_id: id(p.purchaseOrderId), plant_id: plant }, select: { purchase_order_id: true } })); break;
    case 'GET /logistics/putaway-tasks/{putawayTaskId}': await putaway(p.putawayTaskId); break;
    case 'GET /logistics/shipments/{shipmentId}': await shipment(p.shipmentId); break;
    // 출하 단위의 소유는 그 출하 전표의 창고 공장이다(배분 PUT 과 같은 축).
    case 'GET /logistics/shipping-units/{shippingUnitId}':
      await shippingUnit(p.shippingUnitId); break;
    // ⛔ 본문의 `shipmentId` 는 아래 `checkBodyResources` 가 `issue` 가 아니라 `shipment` 로
    //   판정한다 — 이름이 같아도 다른 표다(`names` 표에 `shipmentId: 'shipment'`).
    case 'POST /logistics/shipping-units': break;
    // 쓰기 셋의 소유도 상세와 «같은 축»이다 — 출하 단위 → 출하 전표 → 창고의 공장.
    case 'POST /logistics/shipping-units/{shippingUnitId}:add-box':
    case 'POST /logistics/shipping-units/{shippingUnitId}:close':
      await shippingUnit(p.shippingUnitId); break;
    // ⛔ 상자 제거는 한 단계 더 본다 — 그 상자가 «이 단위의» 자식인지까지. 공장만 맞으면
    //   남의 단위에 든 상자를 빼낼 수 있고, 링크 표는 상자 하나에 한 행뿐이라 되돌릴 수 없다.
    case 'DELETE /logistics/shipping-units/{shippingUnitId}/boxes/{handlingUnitId}':
      await shippingUnit(p.shippingUnitId);
      await check(await prisma.shipping_unit_handling_unit.findFirst({ where: {
        handling_unit_id: id(p.handlingUnitId), shipping_unit_id: id(p.shippingUnitId),
      }, select: { handling_unit_id: true } })); break;
    case 'GET /logistics/shopfloor-receipts/{shopfloorReceiptId}':
      // 창고 보충 출고 수령(피처 004)은 W/O 가 없다 — 도착 위치 창고의 공장으로 본다.
      await check(await prisma.shopfloor_receipt.findFirst({ where: { shopfloor_receipt_id: id(p.shopfloorReceiptId), OR: [
        { work_order: { production_line: { plant_id: plant } } },
        { work_order_id: null, location: { warehouse: { plant_id: plant } } },
      ] }, select: { shopfloor_receipt_id: true } })); break;
    case 'GET /logistics/stock-transfers/{stockTransferId}/lines': await transfer(p.stockTransferId); break;
    case 'POST /logistics/goods-issues':
      if (b.sourceDocumentTypeCode !== 'PICKING_ORDER') throw denied();
      await Promise.all([warehouse(b.sourceWarehouseId), pickOrder(b.sourceDocumentId)]); break;
    case 'POST /logistics/goods-receipts':
      await Promise.all([plantBody(b, plant), warehouse(b.warehouseId)]); break;
    case 'POST /logistics/inbound-receipts':
    case 'POST /logistics/inbound-receipts:per-line':
      await Promise.all([plantBody(b, plant)]); break;
    case 'POST /logistics/inbound-receipts:split':
      for (const part of [b.normal, b.excess]) if (part !== undefined) await plantBody(object(part), plant);
      if (b.normal === undefined && b.excess === undefined) throw denied();
      break;
    case 'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick':
      await Promise.all([pickOrder(p.pickingOrderId)]);
      await check(await prisma.picking_line.findFirst({ where: { picking_line_id: id(p.pickingLineId), picking_order_id: id(p.pickingOrderId) }, select: { picking_line_id: true } })); break;
    case 'POST /logistics/putaway-tasks/{putawayTaskId}:complete':
    case 'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary':
      await Promise.all([putaway(p.putawayTaskId)]); break;
    // 지시 없는 적치(피처 009) — LOT·위치·창고의 공장은 서비스가 판정 코드(OTHER_PLANT)로 답한다. 아래 본문 자원 검사에서도 뺀다
    //   (다른 공장 위치를 401 이 아니라 400 OTHER_PLANT 로 돌려줘야 PDA 가 판정 문구를 보인다).
    case 'POST /logistics/putaway-pending-lots/{lotId}:putaway':
    case 'POST /logistics/putaway-pending-lots/{lotId}:putaway-temporary':
      return;
    case 'POST /logistics/recycle-entries':
      // 재생재 본문에는 plantId가 없다. 실제 창고/위치 소유 공장으로 검증한다.
      await warehouse(b.warehouseId); break;
    case 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick':
    case 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick-lot': {
      await pickableLine(p.shipmentRequestId, p.shipmentRequestLineId);
      // 줄 출고 창고가 있는 사업부 지시서(피처 012)는 다른 공장 LOT 도 받아서 서비스가 409 `LOT_NOT_IN_LINE_WAREHOUSE`(LOT 이 있는
      // 창고)로 답한다 — 여기서 LOT 공장으로 401 을 내면 PDA 가 「어느 창고에 있는지」를 못 보인다. 옛 줄은 지금처럼 LOT 공장을 본다.
      const line = await prisma.shipment_request_line.findFirst({ where: { shipment_request_line_id: id(p.shipmentRequestLineId) }, select: { warehouse_id: true } });
      if (line?.warehouse_id != null) return;
      await optional(lot, b.lotId); break;
    }
    case 'GET /logistics/shipment-requests/{shipmentRequestId}':
      await businessUnitRequest(p.shipmentRequestId); break;
    // 다른 사업부 지시서는 서비스가 403 `BUSINESS_UNIT_MISMATCH` 로 답한다(피처 012 FR-013 — POP 이 「다른 사업부」를 보인다).
    case 'POST /logistics/shipment-requests/{shipmentRequestId}:complete':
      await check(await prisma.shipment_request.findFirst({ where: { shipment_request_id: id(p.shipmentRequestId) }, select: { shipment_request_id: true } })); break;
    // 피킹 LOT 행 → 그 줄이 단말 범위 안(피처 012 R-2 · 010 은 지시서 이행 공장).
    case 'POST /logistics/shipment-request-lots/{shipmentRequestLotId}:replace':
    case 'PUT /logistics/shipment-request-lots/{shipmentRequestLotId}/management-code':
      await check(await prisma.shipment_request_lot.findFirst({ where: {
        shipment_request_lot_id: id(p.shipmentRequestLotId), shipment_request_line: lineScope,
      }, select: { shipment_request_lot_id: true } })); break;
    case 'POST /logistics/shopfloor-receipts':
      // 창고 보충 출고 수령(피처 004)은 W/O 를 보내지 않는다.
      await Promise.all([issue(b.goodsIssueId), optional(workOrder, b.workOrderId)]); break;
    case 'POST /logistics/stock-transfers':
      await Promise.all([warehouse(b.fromWarehouseId), warehouse(b.toWarehouseId)]); break;
    case 'POST /logistics/stock-transfers/{stockTransferId}:arrive':
      await Promise.all([transfer(p.stockTransferId)]); break;
    case 'PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}':
      await check(await prisma.shipment_lot_allocation.findFirst({ where: { shipment_lot_allocation_id: id(p.shipmentLotAllocationId), shipment_line: { shipment: { warehouse: { plant_id: plant } } } }, select: { shipment_lot_allocation_id: true } })); break;
    default: throw denied();
  }

  if (isWrite(key)) await checkBodyResources(b, { warehouse, location, lot, worker, issue, inbound, inboundLine, pickOrder, putaway, shipment, transfer, workOrder, handlingUnit, purchaseOrderLine, goodsReceiptLine, goodsIssueLine, pickingLine, shipmentLine, stockTransferLine, shipmentAllocation }, plant);
}

async function checkBodyResources(
  body: Record<string, unknown>,
  checks: Record<string, (v: unknown) => Promise<void>>,
  plant: bigint,
): Promise<void> {
  const names: Record<string, string> = {
    warehouseId: 'warehouse', sourceWarehouseId: 'warehouse', fromWarehouseId: 'warehouse', toWarehouseId: 'warehouse',
    locationId: 'location', fromLocationId: 'location', toLocationId: 'location', destinationLocationId: 'location', sourceLocationId: 'location',
    actualLocationId: 'location', dockLocationId: 'location', lotId: 'lot', workerId: 'worker',
    assignedWorkerId: 'worker', goodsIssueId: 'issue', inboundReceiptId: 'inbound',
    inboundReceiptLineId: 'inboundLine', pickingOrderId: 'pickOrder', putawayTaskId: 'putaway',
    shipmentId: 'shipment', stockTransferId: 'transfer', workOrderId: 'workOrder',
    handlingUnitId: 'handlingUnit', purchaseOrderLineId: 'purchaseOrderLine', goodsReceiptLineId: 'goodsReceiptLine',
    goodsIssueLineId: 'goodsIssueLine', pickingLineId: 'pickingLine', shipmentLineId: 'shipmentLine',
    stockTransferLineId: 'stockTransferLine', originalShipmentLotAllocationId: 'shipmentAllocation',
  };
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (key === 'plantId') { if (id(value) !== plant) throw denied(); continue; }
    if (names[key]) await checks[names[key]](value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (entry && typeof entry === 'object' && !Array.isArray(entry)) await checkBodyResources(object(entry), checks, plant);
    } else if (value && typeof value === 'object') {
      await checkBodyResources(object(value), checks, plant);
    }
  }
}

async function plantBody(body: Record<string, unknown>, plant: bigint): Promise<void> {
  if (id(body.plantId) !== plant) throw denied();
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function id(value: unknown): bigint {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) return -1n;
  const parsed = BigInt(value);
  return parsed > 0n && parsed < 9223372036854775808n ? parsed : -1n;
}
/** 쓰기로 치는 동사 — 작업자 사번과 본문 자원 검사가 걸리는 기준이다. */
function isWrite(key: string): boolean {
  return key.startsWith('POST ') || key.startsWith('PUT ') || key.startsWith('PATCH ') || key.startsWith('DELETE ');
}
function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' }]);
}
