import { PrismaService } from '../../prisma/prisma.service';
import { RECEIPT_CANCELLED, SHIPMENT_CANCELLED } from './flow-sql';

/**
 * 사슬 노드에 붙는 문서 — 입하·입고(자재 쪽), 생산입고·포장·출하(제품 쪽). 목록과 사슬이 같은 모양을 쓴다.
 * 모두 LOT id 묶음으로 한 번에 읽는다(노드마다 부르지 않는다).
 */
export interface Named {
  id: number;
  code: string;
  name: string;
}

export interface LotHead {
  lotId: number;
  lotNo: string;
  plantId: number;
  item: Named;
  lotTypeCode: string;
  statusCode: string;
  uomId: number;
  uomCode: string;
  completedAt: string | null;
}

export interface ReceiptNode {
  goodsReceiptId: number;
  goodsReceiptNo: string;
  receiptDatetime: string;
  warehouse: Named;
  qty: number;
}

export interface MaterialSide {
  /** 이 LOT 을 등록한 입하 줄 — 재생재·분할 LOT 처럼 입하에서 오지 않았으면 null. */
  inbound: {
    inboundReceiptId: number;
    inboundReceiptNo: string;
    receiptDatetime: string;
    supplier: Named;
    supplierLotNo: string | null;
  } | null;
  /** 자재입고(취소 제외), 입고 일시순. */
  receipts: ReceiptNode[];
  receivedQty: number;
}

export interface ProductSide {
  /** 생산입고(취소 제외), 입고 일시순. */
  productionReceipts: ReceiptNode[];
  packages: { handlingUnitId: number; handlingUnitNo: string; handlingUnitTypeCode: string; qty: number;
    shippingUnit: { shippingUnitId: number; shippingUnitNo: string } | null }[];
  /** 출하(취소 제외), 출하 일시순. 포장에 담긴 채 나갔으면 그 취급 단위 번호. */
  shipments: { shipmentId: number; shipmentNo: string; shippedAt: string | null; statusCode: string; customer: Named;
    qty: number; handlingUnitNo: string | null }[];
}

/** 같은 id 묶음으로 읽은 표에서 꺼낸다 — 비면 조회끼리 어긋난 것이라 구현 오류다. */
export function pick<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`LOT 추적 노드가 비었다: ${String(key)}`);
  return value;
}

const named = (id: bigint, code: string, name: string): Named => ({ id: Number(id), code, name });

export async function lotHeads(prisma: PrismaService, lotIds: readonly bigint[]): Promise<Map<bigint, LotHead>> {
  if (lotIds.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<{
    lot_id: bigint; lot_no: string; plant_id: bigint; item_id: bigint; item_code: string; item_name: string;
    lot_type_code: string; status_code: string; uom_id: bigint; uom_code: string; completed_at: Date | null;
  }[]>(
    `SELECT lt.lot_id, lt.lot_no, lt.plant_id, i.item_id, i.item_code, i.item_name, lt.lot_type_code, lt.status_code,
            u.uom_id, u.uom_code, lt.completed_at
       FROM trace.lot lt JOIN mdm.item i ON i.item_id = lt.item_id JOIN mdm.uom u ON u.uom_id = lt.uom_id
      WHERE lt.lot_id = ANY($1::bigint[])`, [...lotIds],
  );
  return new Map(rows.map((row) => [row.lot_id, {
    lotId: Number(row.lot_id), lotNo: row.lot_no, plantId: Number(row.plant_id),
    item: named(row.item_id, row.item_code, row.item_name), lotTypeCode: row.lot_type_code, statusCode: row.status_code,
    uomId: Number(row.uom_id), uomCode: row.uom_code, completedAt: row.completed_at?.toISOString() ?? null,
  }]));
}

interface ReceiptRow {
  lot_id: bigint; goods_receipt_id: bigint; goods_receipt_no: string; receipt_datetime: Date;
  warehouse_id: bigint; warehouse_code: string; warehouse_name: string; qty: unknown;
}

async function receiptsOf(prisma: PrismaService, lotIds: readonly bigint[], type: string): Promise<Map<bigint, ReceiptNode[]>> {
  const rows = await prisma.$queryRawUnsafe<ReceiptRow[]>(
    `SELECT l.lot_id, gr.goods_receipt_id, gr.goods_receipt_no, gr.receipt_datetime,
            w.warehouse_id, w.warehouse_code, w.warehouse_name, SUM(l.receipt_qty) AS qty
       FROM logistics.goods_receipt_line l
       JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = l.goods_receipt_id
       JOIN mdm.warehouse w ON w.warehouse_id = gr.warehouse_id
      WHERE l.lot_id = ANY($1::bigint[]) AND gr.receipt_type_code = $2 AND gr.status_code NOT IN ${RECEIPT_CANCELLED}
      GROUP BY l.lot_id, gr.goods_receipt_id, w.warehouse_id
      ORDER BY gr.receipt_datetime, gr.goods_receipt_id`, [...lotIds], type,
  );
  return groupBy(rows, (row) => ({
    goodsReceiptId: Number(row.goods_receipt_id), goodsReceiptNo: row.goods_receipt_no,
    receiptDatetime: row.receipt_datetime.toISOString(),
    warehouse: named(row.warehouse_id, row.warehouse_code, row.warehouse_name), qty: Number(row.qty),
  }));
}

export async function materialSides(prisma: PrismaService, lotIds: readonly bigint[]): Promise<Map<bigint, MaterialSide>> {
  if (lotIds.length === 0) return new Map();
  const [receipts, inbound] = await Promise.all([
    receiptsOf(prisma, lotIds, 'MATERIAL'),
    prisma.$queryRawUnsafe<{
      lot_id: bigint; inbound_receipt_id: bigint; inbound_receipt_no: string; receipt_datetime: Date;
      partner_id: bigint; partner_code: string; partner_name: string; supplier_lot_no: string | null;
    }[]>(
      // 한 LOT 에 입하 줄이 여럿이면(같은 공급사 LOT 재입하) 처음 것을 보인다.
      `SELECT DISTINCT ON (irl.lot_id) irl.lot_id, ir.inbound_receipt_id, ir.inbound_receipt_no, ir.receipt_datetime,
              sp.partner_id, sp.partner_code, sp.partner_name, irl.supplier_lot_no
         FROM logistics.inbound_receipt_line irl
         JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
         JOIN mdm.partner sp ON sp.partner_id = ir.supplier_id
        WHERE irl.lot_id = ANY($1::bigint[])
        ORDER BY irl.lot_id, ir.receipt_datetime, irl.inbound_receipt_line_id`, [...lotIds],
    ),
  ]);
  const inboundOf = new Map(inbound.map((row) => [row.lot_id, {
    inboundReceiptId: Number(row.inbound_receipt_id), inboundReceiptNo: row.inbound_receipt_no,
    receiptDatetime: row.receipt_datetime.toISOString(),
    supplier: named(row.partner_id, row.partner_code, row.partner_name), supplierLotNo: row.supplier_lot_no,
  }]));
  return new Map(lotIds.map((lotId) => {
    const lines = receipts.get(lotId) ?? [];
    return [lotId, { inbound: inboundOf.get(lotId) ?? null, receipts: lines, receivedQty: lines.reduce((sum, line) => sum + line.qty, 0) }];
  }));
}

export async function productSides(prisma: PrismaService, lotIds: readonly bigint[]): Promise<Map<bigint, ProductSide>> {
  if (lotIds.length === 0) return new Map();
  const [receipts, packages, shipments] = await Promise.all([
    receiptsOf(prisma, lotIds, 'PRODUCT'),
    prisma.$queryRawUnsafe<{
      lot_id: bigint; handling_unit_id: bigint; handling_unit_no: string; handling_unit_type_code: string; qty: unknown;
      shipping_unit_id: bigint | null; shipping_unit_no: string | null;
    }[]>(
      `SELECT hc.lot_id, hu.handling_unit_id, hu.handling_unit_no, hu.handling_unit_type_code, SUM(hc.qty) AS qty,
              su.shipping_unit_id, su.shipping_unit_no
         FROM inventory.handling_unit_content hc
         JOIN inventory.handling_unit hu ON hu.handling_unit_id = hc.handling_unit_id
         LEFT JOIN logistics.shipping_unit_handling_unit suh ON suh.handling_unit_id = hu.handling_unit_id
         LEFT JOIN logistics.shipping_unit su ON su.shipping_unit_id = suh.shipping_unit_id
        WHERE hc.lot_id = ANY($1::bigint[])
        GROUP BY hc.lot_id, hu.handling_unit_id, su.shipping_unit_id
        ORDER BY hu.handling_unit_no`, [...lotIds],
    ),
    prisma.$queryRawUnsafe<{
      lot_id: bigint; shipment_id: bigint; shipment_no: string; shipped_at: Date | null; status_code: string;
      partner_id: bigint; partner_code: string; partner_name: string; qty: unknown; handling_unit_no: string | null;
    }[]>(
      `SELECT a.lot_id, s.shipment_id, s.shipment_no, s.shipped_at, s.status_code,
              c.partner_id, c.partner_code, c.partner_name, SUM(a.allocated_qty) AS qty, hu.handling_unit_no
         FROM logistics.shipment_lot_allocation a
         JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
         JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
         JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
         JOIN mdm.partner c ON c.partner_id = sr.customer_id
         LEFT JOIN inventory.handling_unit hu ON hu.handling_unit_id = a.handling_unit_id
        WHERE a.lot_id = ANY($1::bigint[]) AND s.status_code <> ${SHIPMENT_CANCELLED}
        GROUP BY a.lot_id, s.shipment_id, c.partner_id, hu.handling_unit_no
        ORDER BY s.shipped_at, s.shipment_id`, [...lotIds],
    ),
  ]);
  const packOf = groupBy(packages, (row) => ({
    handlingUnitId: Number(row.handling_unit_id), handlingUnitNo: row.handling_unit_no, handlingUnitTypeCode: row.handling_unit_type_code,
    qty: Number(row.qty),
    shippingUnit: row.shipping_unit_id === null ? null : { shippingUnitId: Number(row.shipping_unit_id), shippingUnitNo: row.shipping_unit_no ?? '' },
  }));
  const shipOf = groupBy(shipments, (row) => ({
    shipmentId: Number(row.shipment_id), shipmentNo: row.shipment_no, shippedAt: row.shipped_at?.toISOString() ?? null,
    statusCode: row.status_code, customer: named(row.partner_id, row.partner_code, row.partner_name), qty: Number(row.qty),
    handlingUnitNo: row.handling_unit_no,
  }));
  return new Map(lotIds.map((lotId) => [lotId, {
    productionReceipts: receipts.get(lotId) ?? [], packages: packOf.get(lotId) ?? [], shipments: shipOf.get(lotId) ?? [],
  }]));
}

function groupBy<R extends { lot_id: bigint }, T>(rows: R[], map: (row: R) => T): Map<bigint, T[]> {
  const grouped = new Map<bigint, T[]>();
  for (const row of rows) grouped.set(row.lot_id, [...(grouped.get(row.lot_id) ?? []), map(row)]);
  return grouped;
}
