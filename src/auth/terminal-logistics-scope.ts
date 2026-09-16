import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

import { ContractException, ERROR_CODE } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
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
  'GET /logistics/inbound-receipts': ['POP', 'MOBILE'],
  'GET /logistics/inbound-receipts/{inboundReceiptId}/lines': ['POP', 'MOBILE'],
  'GET /logistics/material-issue-requests/{materialIssueRequestId}': ['MOBILE'],
  'GET /logistics/picking-orders': ['MOBILE'],
  'GET /logistics/picking-orders/{pickingOrderId}': ['MOBILE'],
  'GET /logistics/purchase-orders': ['MOBILE'],
  'GET /logistics/purchase-orders/{purchaseOrderId}': ['MOBILE'],
  'GET /logistics/putaway-rules': ['MOBILE'],
  'GET /logistics/putaway-rules/{putawayRuleId}': ['MOBILE'],
  'GET /logistics/putaway-tasks': ['MOBILE'],
  'GET /logistics/putaway-tasks/{putawayTaskId}': ['MOBILE'],
  'GET /logistics/shipment-lot-allocations': ['POP', 'MOBILE'],
  'GET /logistics/shipment-requests': ['MOBILE'],
  'GET /logistics/shipments': ['POP'],
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
  'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick': ['MOBILE'],
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete': ['MOBILE'],
  'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary': ['MOBILE'],
  'POST /logistics/recycle-entries': ['MOBILE'],
  'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick': ['MOBILE'],
  'POST /logistics/shopfloor-receipts': ['MOBILE'],
  'POST /logistics/stock-transfers': ['MOBILE'],
  'POST /logistics/stock-transfers/{stockTransferId}:arrive': ['MOBILE'],
  'PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}': ['POP'],
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
  const inboundLine = async (v: unknown) => check(await prisma.inbound_receipt_line.findFirst({ where: { inbound_receipt_line_id: id(v), inbound_receipt: { plant_id: plant } }, select: { inbound_receipt_line_id: true } }));
  const pickOrder = async (v: unknown) => check(await prisma.picking_order.findFirst({ where: { picking_order_id: id(v), warehouse: { plant_id: plant } }, select: { picking_order_id: true } }));
  const putaway = async (v: unknown) => check(await prisma.putaway_task.findFirst({ where: { putaway_task_id: id(v), goods_receipt_line: { goods_receipt: { plant_id: plant } } }, select: { putaway_task_id: true } }));
  const shipment = async (v: unknown) => check(await prisma.shipment.findFirst({ where: { shipment_id: id(v), warehouse: { plant_id: plant } }, select: { shipment_id: true } }));
  // 미배정 요청은 터미널에서 피킹할 수 없고, 출하가 생기기 전에도 이행 공장으로 소유를 판정한다.
  const shipmentRequest = async (v: unknown) => check(await prisma.shipment_request.findFirst({ where: { shipment_request_id: id(v), fulfillment_plant_id: plant }, select: { shipment_request_id: true } }));
  const transfer = async (v: unknown) => check(await prisma.stock_transfer.findFirst({ where: { stock_transfer_id: id(v), warehouse_stock_transfer_from_warehouse_idTowarehouse: { plant_id: plant }, warehouse_stock_transfer_to_warehouse_idTowarehouse: { plant_id: plant } }, select: { stock_transfer_id: true } }));
  const workOrder = async (v: unknown) => check(await prisma.work_order.findFirst({ where: { work_order_id: id(v), production_line: { plant_id: plant } }, select: { work_order_id: true } }));
  const handlingUnit = async (v: unknown) => check(await prisma.handling_unit.findFirst({ where: { handling_unit_id: id(v), OR: [{ warehouse: { plant_id: plant } }, { location: { warehouse: { plant_id: plant } } }] }, select: { handling_unit_id: true } }));
  const purchaseOrderLine = async (v: unknown) => check(await prisma.purchase_order_line.findFirst({ where: { purchase_order_line_id: id(v), purchase_order: { plant_id: plant } }, select: { purchase_order_line_id: true } }));
  const goodsReceiptLine = async (v: unknown) => check(await prisma.goods_receipt_line.findFirst({ where: { goods_receipt_line_id: id(v), goods_receipt: { plant_id: plant } }, select: { goods_receipt_line_id: true } }));
  const goodsIssueLine = async (v: unknown) => check(await prisma.goods_issue_line.findFirst({ where: { goods_issue_line_id: id(v), goods_issue: { warehouse: { plant_id: plant } } }, select: { goods_issue_line_id: true } }));
  const pickingLine = async (v: unknown) => check(await prisma.picking_line.findFirst({ where: { picking_line_id: id(v), picking_order: { warehouse: { plant_id: plant } } }, select: { picking_line_id: true } }));
  const shipmentLine = async (v: unknown) => check(await prisma.shipment_line.findFirst({ where: { shipment_line_id: id(v), shipment: { warehouse: { plant_id: plant } } }, select: { shipment_line_id: true } }));
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

  if (key.startsWith('POST ') || key.startsWith('PUT ')) await workerNo();

  switch (key) {
    case 'GET /logistics/goods-issues':
    case 'GET /logistics/inbound-receipts':
    case 'GET /logistics/picking-orders':
    case 'GET /logistics/purchase-orders':
    case 'GET /logistics/putaway-rules':
    case 'GET /logistics/putaway-tasks':
    case 'GET /logistics/shipment-lot-allocations':
    case 'GET /logistics/shipment-requests':
    case 'GET /logistics/shipments':
    case 'GET /logistics/shopfloor-receipts':
    case 'GET /logistics/stock-transfers':
      break;
    case 'GET /logistics/goods-issues/{goodsIssueId}':
    case 'GET /logistics/goods-issues/{goodsIssueId}/lines': await issue(p.goodsIssueId); break;
    case 'GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances':
    case 'POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances': await inboundLine(p.inboundReceiptLineId); break;
    case 'GET /logistics/inbound-receipts/{inboundReceiptId}/lines': await inbound(p.inboundReceiptId); break;
    case 'GET /logistics/material-issue-requests/{materialIssueRequestId}':
      await check(await prisma.material_issue_request.findFirst({ where: { material_issue_request_id: id(p.materialIssueRequestId), work_order: { production_line: { plant_id: plant } } }, select: { material_issue_request_id: true } })); break;
    case 'GET /logistics/picking-orders/{pickingOrderId}': await pickOrder(p.pickingOrderId); break;
    case 'GET /logistics/purchase-orders/{purchaseOrderId}':
      await check(await prisma.purchase_order.findFirst({ where: { purchase_order_id: id(p.purchaseOrderId), plant_id: plant }, select: { purchase_order_id: true } })); break;
    case 'GET /logistics/putaway-rules/{putawayRuleId}':
      await check(await prisma.putaway_rule.findFirst({ where: { putaway_rule_id: id(p.putawayRuleId), warehouse: { plant_id: plant } }, select: { putaway_rule_id: true } })); break;
    case 'GET /logistics/putaway-tasks/{putawayTaskId}': await putaway(p.putawayTaskId); break;
    case 'GET /logistics/shipments/{shipmentId}': await shipment(p.shipmentId); break;
    case 'GET /logistics/shopfloor-receipts/{shopfloorReceiptId}':
      await check(await prisma.shopfloor_receipt.findFirst({ where: { shopfloor_receipt_id: id(p.shopfloorReceiptId), work_order: { production_line: { plant_id: plant } } }, select: { shopfloor_receipt_id: true } })); break;
    case 'GET /logistics/stock-transfers/{stockTransferId}/lines': await transfer(p.stockTransferId); break;
    case 'POST /logistics/goods-issues':
      if (b.sourceDocumentTypeCode !== 'PICKING_ORDER') throw denied();
      await Promise.all([warehouse(b.sourceWarehouseId), pickOrder(b.sourceDocumentId)]); break;
    case 'POST /logistics/goods-receipts':
      await Promise.all([plantBody(b, plant), warehouse(b.warehouseId)]); break;
    case 'POST /logistics/inbound-receipts':
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
    case 'POST /logistics/recycle-entries':
      // 재생재 본문에는 plantId가 없다. 실제 창고/위치 소유 공장으로 검증한다.
      await warehouse(b.warehouseId); break;
    case 'POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick':
      await shipmentRequest(p.shipmentRequestId);
      await check(await prisma.shipment_request_line.findFirst({ where: { shipment_request_line_id: id(p.shipmentRequestLineId), shipment_request_id: id(p.shipmentRequestId) }, select: { shipment_request_line_id: true } }));
      await optional(lot, b.lotId); break;
    case 'POST /logistics/shopfloor-receipts':
      await Promise.all([issue(b.goodsIssueId), workOrder(b.workOrderId)]); break;
    case 'POST /logistics/stock-transfers':
      await Promise.all([warehouse(b.fromWarehouseId), warehouse(b.toWarehouseId)]); break;
    case 'POST /logistics/stock-transfers/{stockTransferId}:arrive':
      await Promise.all([transfer(p.stockTransferId)]); break;
    case 'PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}':
      await check(await prisma.shipment_lot_allocation.findFirst({ where: { shipment_lot_allocation_id: id(p.shipmentLotAllocationId), shipment_line: { shipment: { warehouse: { plant_id: plant } } } }, select: { shipment_lot_allocation_id: true } })); break;
    default: throw denied();
  }

  if (key.startsWith('POST ') || key.startsWith('PUT ')) await checkBodyResources(b, { warehouse, location, lot, worker, issue, inbound, inboundLine, pickOrder, putaway, shipment, transfer, workOrder, handlingUnit, purchaseOrderLine, goodsReceiptLine, goodsIssueLine, pickingLine, shipmentLine, stockTransferLine, shipmentAllocation }, plant);
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
function denied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [{ scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED, message: '단말 인증 범위 밖입니다.' }]);
}
