import { PrismaService } from '../../prisma/prisma.service';
import type { OqcLotStatus } from '../../quality/inspection/oqc-lot-result';
import { CompletionBlocker } from './shipment-completion-rules';
import { CompletedShipmentView, ShipmentRequestView } from './shipment-request-view';

/**
 * 계약 `ShipmentRequestCompletion` — POP 출하 완료 확인 화면(P-04-07)의 값. 스캔과 찾기가 같은 값을 본다(R-9).
 * ⛔ ERP 송신 여부는 싣지 않는다 — 출하 완료 단계 화면에 표시하지 않는다(사용자 결정 2026-11-18).
 */
export interface ShipmentRequestCompletionView {
  shipmentRequestId: number;
  shipmentRequestNo: string;
  code: string;
  versionNo: number;
  requestedShipDate: string;
  customer: { partnerId: number; partnerCode: string; partnerName: string };
  shipTo: { partnerId: number; partnerCode: string; partnerName: string };
  salesOrderNo: string | null;
  /** 재고가 빠질 창고들(정보 — 출하는 하나). */
  warehouses: { warehouseId: number; warehouseCode: string; warehouseName: string; lotCount: number; qty: number }[];
  lines: {
    shipmentRequestLineId: number;
    lineNo: number;
    itemId: number;
    itemCode: string;
    itemName: string;
    uomId: number;
    targetQty: number;
    pickedQty: number;
    overQty: number;
    shippedQty: number;
    lotCount: number;
    salesOrderLineId: number | null;
  }[];
  lots: {
    shipmentRequestLotId: number;
    lineNo: number;
    lotId: number;
    lotNo: string;
    itemId: number;
    qty: number;
    statusCode: string;
    oqcLotStatus: OqcLotStatus | null;
    managementCode: string | null;
  }[];
  blockers: CompletionBlocker[];
  completedShipment: CompletedShipmentView | null;
}

export async function completionView(prisma: PrismaService, view: ShipmentRequestView): Promise<ShipmentRequestCompletionView> {
  const lines = view.lines ?? [];
  const [partners, items, order] = await Promise.all([
    prisma.partner.findMany({
      where: { partner_id: { in: [BigInt(view.customerId), BigInt(view.shipToPartnerId)] } },
      select: { partner_id: true, partner_code: true, partner_name: true },
    }),
    prisma.item.findMany({
      where: { item_id: { in: lines.map((line) => BigInt(line.itemId)) } }, select: { item_id: true, item_code: true, item_name: true },
    }),
    view.salesOrderId === null ? null : prisma.sales_order.findUnique({ where: { sales_order_id: BigInt(view.salesOrderId) }, select: { sales_order_no: true } }),
  ]);
  const partner = (id: number) => {
    const row = partners.find((candidate) => candidate.partner_id === BigInt(id));
    return { partnerId: id, partnerCode: row?.partner_code ?? '', partnerName: row?.partner_name ?? '' };
  };
  // 교체된 LOT 은 낼 LOT 이 아니다 — 확인 화면은 살아 있는(또는 이미 출하된) LOT 만 보인다.
  const shown = lines.flatMap((line) => line.lots.filter((lot) => lot.statusCode !== 'REPLACED').map((lot) => ({ line, lot })));
  const warehouses = new Map<number, ShipmentRequestCompletionView['warehouses'][number] & { lots: Set<number> }>();
  for (const { lot } of shown) {
    for (const portion of lot.portions) {
      const seen = warehouses.get(portion.warehouseId)
        ?? { warehouseId: portion.warehouseId, warehouseCode: portion.warehouseCode, warehouseName: portion.warehouseName, lotCount: 0, qty: 0, lots: new Set<number>() };
      seen.lots.add(lot.lotId);
      seen.lotCount = seen.lots.size;
      seen.qty += portion.qty;
      warehouses.set(portion.warehouseId, seen);
    }
  }
  return {
    shipmentRequestId: view.shipmentRequestId,
    shipmentRequestNo: view.shipmentRequestNo,
    code: view.code,
    versionNo: view.versionNo ?? 1,
    requestedShipDate: view.requestedShipDate,
    customer: partner(view.customerId),
    shipTo: partner(view.shipToPartnerId),
    salesOrderNo: order?.sales_order_no ?? null,
    warehouses: [...warehouses.values()].map(({ lots: _lots, ...rest }) => rest),
    lines: lines.map((line) => {
      const item = items.find((row) => row.item_id === BigInt(line.itemId));
      return {
        shipmentRequestLineId: line.shipmentRequestLineId, lineNo: line.lineNo, itemId: line.itemId,
        itemCode: item?.item_code ?? '', itemName: item?.item_name ?? '', uomId: line.uomId,
        targetQty: line.allocatedQty, pickedQty: line.pickedQty, overQty: line.overQty, shippedQty: line.shippedQty,
        lotCount: line.lots.filter((lot) => lot.statusCode !== 'REPLACED').length, salesOrderLineId: line.salesOrderLineId,
      };
    }),
    lots: shown.map(({ line, lot }) => ({
      shipmentRequestLotId: lot.shipmentRequestLotId, lineNo: line.lineNo, lotId: lot.lotId, lotNo: lot.lotNo, itemId: lot.itemId,
      qty: lot.pickedQty, statusCode: lot.statusCode, oqcLotStatus: lot.oqcLotStatus, managementCode: lot.managementCode,
    })),
    blockers: view.completionBlockers,
    completedShipment: view.completedShipment,
  };
}
