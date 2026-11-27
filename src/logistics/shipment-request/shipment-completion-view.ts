import { PrismaService } from '../../prisma/prisma.service';
import type { OqcLotStatus } from '../../quality/inspection/oqc-lot-result';
import { CompletionBlocker } from './shipment-completion-rules';
import {
  CompletedShipmentView,
  ShipmentLotPortionView,
  ShipmentRequestBusinessUnitView,
  ShipmentRequestView,
  ShipmentRequestWarehouseView,
} from './shipment-request-view';

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
  /** 지시서 사업부(피처 012 — POP 머리 「사업부」 칸). 사업부 없는 옛 지시서는 null. */
  businessUnit: ShipmentRequestBusinessUnitView | null;
  /** 재고가 빠질 창고들(정보 — 출하는 하나, 출고 전표는 창고마다 하나). 공장은 그 창고의 공장(피처 012). */
  warehouses: { warehouseId: number; warehouseCode: string; warehouseName: string; plantId: number; plantName: string; lotCount: number; qty: number }[];
  lines: {
    shipmentRequestLineId: number;
    lineNo: number;
    itemId: number;
    itemCode: string;
    itemName: string;
    uomId: number;
    uomCode: string;
    targetQty: number;
    pickedQty: number;
    overQty: number;
    shippedQty: number;
    lotCount: number;
    salesOrderLineId: number | null;
    /** 줄 출고 창고(공장) — null 은 배포 전 줄(창고 미지정 · 피처 012). */
    warehouse: ShipmentRequestWarehouseView | null;
  }[];
  lots: {
    shipmentRequestLotId: number;
    lineNo: number;
    lotId: number;
    lotNo: string;
    itemId: number;
    qty: number;
    uomId: number;
    uomCode: string;
    /** 창고·위치별 몫(적치 대기 자리 포함) — 「창고 A 20 · B 20」. */
    portions: ShipmentLotPortionView[];
    statusCode: string;
    oqcLotStatus: OqcLotStatus | null;
    managementCode: string | null;
  }[];
  /** 교체로 빠진 LOT — 출하에 들지 않는다(확인 화면 「교체로 빠진 LOT n」). */
  replacedLots: {
    shipmentRequestLotId: number;
    lineNo: number;
    lotId: number;
    lotNo: string;
    itemId: number;
    qty: number;
    uomCode: string;
    portions: ShipmentLotPortionView[];
    judgment: string | null;
    nonconformanceNo: string | null;
    replacedAt: string;
  }[];
  blockers: CompletionBlocker[];
  completedShipment: CompletedShipmentView | null;
}

export async function completionView(prisma: PrismaService, view: ShipmentRequestView): Promise<ShipmentRequestCompletionView> {
  const lines = view.lines ?? [];
  const partners = await prisma.partner.findMany({
    where: { partner_id: { in: [BigInt(view.customerId), BigInt(view.shipToPartnerId)] } },
    select: { partner_id: true, partner_code: true, partner_name: true },
  });
  const partner = (id: number) => {
    const row = partners.find((candidate) => candidate.partner_id === BigInt(id));
    return { partnerId: id, partnerCode: row?.partner_code ?? '', partnerName: row?.partner_name ?? '' };
  };
  // 교체된 LOT 은 낼 LOT 이 아니다 — 확인 화면은 살아 있는(또는 이미 출하된) LOT 만 보인다.
  const shown = lines.flatMap((line) => line.lots.filter((lot) => lot.statusCode !== 'REPLACED').map((lot) => ({ line, lot })));
  const replaced = lines.flatMap((line) => line.lots.filter((lot) => lot.statusCode === 'REPLACED').map((lot) => ({ line, lot })));
  const plants = new Map((await prisma.warehouse.findMany({
    where: { warehouse_id: { in: [...new Set(shown.flatMap(({ lot }) => lot.portions.map((portion) => BigInt(portion.warehouseId))))] } },
    select: { warehouse_id: true, plant: { select: { plant_id: true, plant_name: true } } },
  })).map((row) => [Number(row.warehouse_id), { plantId: Number(row.plant.plant_id), plantName: row.plant.plant_name }]));
  const warehouses = new Map<number, ShipmentRequestCompletionView['warehouses'][number] & { lots: Set<number> }>();
  for (const { lot } of shown) {
    for (const portion of lot.portions) {
      const seen = warehouses.get(portion.warehouseId)
        ?? {
          warehouseId: portion.warehouseId, warehouseCode: portion.warehouseCode, warehouseName: portion.warehouseName,
          plantId: plants.get(portion.warehouseId)?.plantId ?? 0, plantName: plants.get(portion.warehouseId)?.plantName ?? '',
          lotCount: 0, qty: 0, lots: new Set<number>(),
        };
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
    salesOrderNo: view.salesOrderNo,
    businessUnit: view.businessUnit,
    warehouses: [...warehouses.values()].map(({ lots: _lots, ...rest }) => rest),
    lines: lines.map((line) => ({
      shipmentRequestLineId: line.shipmentRequestLineId, lineNo: line.lineNo, itemId: line.itemId,
      itemCode: line.itemCode, itemName: line.itemName, uomId: line.uomId, uomCode: line.uomCode,
      targetQty: line.allocatedQty, pickedQty: line.pickedQty, overQty: line.overQty, shippedQty: line.shippedQty,
      lotCount: line.lots.filter((lot) => lot.statusCode !== 'REPLACED').length, salesOrderLineId: line.salesOrderLineId,
      warehouse: line.warehouse,
    })),
    lots: shown.map(({ line, lot }) => ({
      shipmentRequestLotId: lot.shipmentRequestLotId, lineNo: line.lineNo, lotId: lot.lotId, lotNo: lot.lotNo, itemId: lot.itemId,
      qty: lot.pickedQty, uomId: lot.uomId, uomCode: line.uomCode, portions: lot.portions,
      statusCode: lot.statusCode, oqcLotStatus: lot.oqcLotStatus, managementCode: lot.managementCode,
    })),
    replacedLots: replaced.map(({ line, lot }) => ({
      shipmentRequestLotId: lot.shipmentRequestLotId, lineNo: line.lineNo, lotId: lot.lotId, lotNo: lot.lotNo, itemId: lot.itemId,
      qty: lot.pickedQty, uomCode: line.uomCode, portions: lot.portions,
      judgment: lot.replacement?.judgment ?? null, nonconformanceNo: lot.replacement?.nonconformanceNo ?? null,
      replacedAt: lot.replacement?.replacedAt ?? lot.pickedAt,
    })),
    blockers: view.completionBlockers,
    completedShipment: view.completedShipment,
  };
}
