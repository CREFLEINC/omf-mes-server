import { GraphStep, SPLIT_RELATION, StepEdge } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { TraceBasis } from '../lot/lot-genealogy-query.service';
import { HU_PACKED, LIVE_CONSUMPTION, SHIPMENT_CANCELLED, forwardLinksSql } from '../flow/flow-sql';
import { lotKey } from './trace-node-facts';

/** 계보 줄(contracts §3·§4) — `basis` 는 RECORDED(기록) 또는 지금 규칙의 추정 둘. */
export interface TraceEdge extends StepEdge {
  qty: number | null;
  basis: 'RECORDED' | TraceBasis;
  firstAt?: string;
  lastAt?: string;
}

/** LOT 이 아닌 항목(W/O·출하·포장·재고·시리얼·입하 LOT) — LOT 항목은 따라간 뒤 `lotNodes` 가 채운다. */
export interface TraceOtherNode {
  key: string;
  nodeKey: string;
  kind: string;
  [field: string]: unknown;
}

const ids = (frontier: string[]): bigint[] => frontier.map((key) => BigInt(key.slice(2)));
const iso = (at: Date | null) => at?.toISOString() ?? null;

/**
 * 정방향 한 단계(피처 015 T018) — 그 단계 LOT 묶음에서 질의 7번: 투입(LOT → W/O), 이음(W/O → 생산 LOT, 지금 `forwardLinksSql`
 * 규칙 그대로), 분할·분리 자식(SPLIT — 008·013, F-5 고침), 포장(옛 기록), 출하(취소 제외), 재고 위치, W/O 머리.
 */
export function forwardExpand(prisma: PrismaService): (frontier: string[]) => Promise<GraphStep<TraceOtherNode, TraceEdge>> {
  return async (frontier) => {
    const lots = ids(frontier);
    const [consumed, links, splits, packs, ships, stocks] = await Promise.all([
      prisma.$queryRawUnsafe<{ lot_id: bigint; work_order_id: bigint; qty: unknown; first_at: Date; last_at: Date }[]>(
        `SELECT mc.lot_id, mc.work_order_id, SUM(mc.input_qty) AS qty, MIN(mc.occurred_at) AS first_at, MAX(mc.occurred_at) AS last_at
           FROM production.material_consumption mc WHERE mc.lot_id = ANY($1::bigint[]) AND ${LIVE_CONSUMPTION}
          GROUP BY mc.lot_id, mc.work_order_id ORDER BY MIN(mc.occurred_at), mc.work_order_id`, lots,
      ),
      prisma.$queryRawUnsafe<{ target_lot_id: bigint; work_order_id: bigint; basis: TraceBasis; qty: unknown }[]>(
        `SELECT DISTINCT k.target_lot_id, k.work_order_id, k.basis,
                (SELECT SUM(pa.allocated_qty) FROM production.production_result_lot_allocation pa WHERE pa.lot_id = k.target_lot_id) AS qty
           FROM (${forwardLinksSql('SELECT unnest($1::bigint[])')}) k ORDER BY k.work_order_id, k.target_lot_id`, lots,
      ),
      prisma.$queryRawUnsafe<{ source_lot_id: bigint; target_lot_id: bigint; qty: unknown }[]>(
        `SELECT r.source_lot_id, r.target_lot_id, r.relation_qty AS qty FROM trace.lot_relation r
          WHERE r.source_lot_id = ANY($1::bigint[]) AND r.relation_type_code = '${SPLIT_RELATION}' ORDER BY r.occurred_at, r.target_lot_id`, lots,
      ),
      prisma.$queryRawUnsafe<{ lot_id: bigint; handling_unit_id: bigint; handling_unit_no: string; qty: unknown }[]>(
        `SELECT hc.lot_id, hu.handling_unit_id, hu.handling_unit_no, SUM(hc.qty) AS qty FROM inventory.handling_unit_content hc
           JOIN inventory.handling_unit hu ON hu.handling_unit_id = hc.handling_unit_id AND hu.status_code = ${HU_PACKED}
          WHERE hc.lot_id = ANY($1::bigint[]) GROUP BY hc.lot_id, hu.handling_unit_id ORDER BY hu.handling_unit_no`, lots,
      ),
      prisma.$queryRawUnsafe<{
        lot_id: bigint; handling_unit_id: bigint | null; shipment_id: bigint; shipment_no: string; shipped_at: Date | null; status_code: string;
        partner_id: bigint; partner_code: string; partner_name: string; qty: unknown;
      }[]>(
        `SELECT a.lot_id, a.handling_unit_id, s.shipment_id, s.shipment_no, s.shipped_at, s.status_code,
                c.partner_id, c.partner_code, c.partner_name, SUM(a.allocated_qty) AS qty
           FROM logistics.shipment_lot_allocation a
           JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
           JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
           JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
           JOIN mdm.partner c ON c.partner_id = sr.customer_id
          WHERE a.lot_id = ANY($1::bigint[]) AND s.status_code <> ${SHIPMENT_CANCELLED}
          GROUP BY a.lot_id, a.handling_unit_id, s.shipment_id, c.partner_id ORDER BY s.shipped_at, s.shipment_id`, lots,
      ),
      stockRows(prisma, lots),
    ]);
    const nodes: TraceOtherNode[] = [];
    const edges: TraceEdge[] = [];
    const add = (node: TraceOtherNode) => nodes.push(node);

    const workOrders = await workOrderNodes(prisma, [...new Set([...consumed.map((row) => row.work_order_id), ...links.map((row) => row.work_order_id)])]);
    workOrders.forEach(add);
    for (const row of consumed) {
      edges.push({ from: lotKey(row.lot_id), to: `W:${row.work_order_id}`, kind: 'CONSUMED', qty: Number(row.qty), basis: 'RECORDED',
        firstAt: row.first_at.toISOString(), lastAt: row.last_at.toISOString() });
    }
    for (const row of links) {
      edges.push({ from: `W:${row.work_order_id}`, to: lotKey(row.target_lot_id), kind: 'PRODUCED', qty: row.qty === null ? null : Number(row.qty), basis: row.basis });
    }
    for (const row of splits) edges.push({ from: lotKey(row.source_lot_id), to: lotKey(row.target_lot_id), kind: 'SPLIT', qty: Number(row.qty), basis: 'RECORDED' });
    const packed = new Set<string>();
    for (const row of packs) {
      packed.add(`${row.lot_id}:${row.handling_unit_id}`);
      add({ key: `H:${row.handling_unit_id}`, nodeKey: `H:${row.handling_unit_id}`, kind: 'PACKAGE', handlingUnitNo: row.handling_unit_no });
      edges.push({ from: lotKey(row.lot_id), to: `H:${row.handling_unit_id}`, kind: 'PACKED', qty: Number(row.qty), basis: 'RECORDED' });
    }
    for (const row of ships) {
      const key = `S:${row.shipment_id}`;
      add({ key, nodeKey: key, kind: 'SHIPMENT', shipment: {
        shipmentId: Number(row.shipment_id), shipmentNo: row.shipment_no, shippedAt: iso(row.shipped_at), statusCode: row.status_code,
        customer: { partnerId: Number(row.partner_id), code: row.partner_code, name: row.partner_name },
      } });
      // 옛 흐름(010 이전) — 포장한 상자로 나갔으면 생산 LOT → 포장 → 출하, 아니면 생산 LOT → 출하.
      const via = row.handling_unit_id !== null && packed.has(`${row.lot_id}:${row.handling_unit_id}`) ? `H:${row.handling_unit_id}` : lotKey(row.lot_id);
      edges.push({ from: via, to: key, kind: 'SHIPPED', qty: Number(row.qty), basis: 'RECORDED' });
    }
    for (const row of stocks) {
      add(row.node);
      edges.push({ from: lotKey(row.lotId), to: row.node.key, kind: 'STOCKED', qty: row.qty, basis: 'RECORDED' });
    }
    return { nodes, edges, reached: [...links.map((row) => lotKey(row.target_lot_id)), ...splits.map((row) => lotKey(row.target_lot_id))] };
  };
}

/** 지금 재고 — LOT·위치마다 한 항목(`K:LOT:위치`). 정방향 끝 LOT 의 행방(R-3)과 투입 전 LOT 의 현재 위치(US1-4). */
export async function stockRows(prisma: PrismaService, lots: bigint[]): Promise<{ lotId: bigint; qty: number; node: TraceOtherNode }[]> {
  const rows = await prisma.$queryRawUnsafe<{
    lot_id: bigint; warehouse_id: bigint; warehouse_code: string; warehouse_name: string; location_id: bigint; location_code: string; location_name: string; qty: unknown;
  }[]>(
    `SELECT b.lot_id, w.warehouse_id, w.warehouse_code, w.warehouse_name, l.location_id, l.location_code, l.location_name, SUM(b.on_hand_qty) AS qty
       FROM inventory.inventory_balance b JOIN mdm.warehouse w ON w.warehouse_id = b.warehouse_id JOIN mdm.location l ON l.location_id = b.location_id
      WHERE b.lot_id = ANY($1::bigint[]) AND b.on_hand_qty > 0
      GROUP BY b.lot_id, w.warehouse_id, l.location_id ORDER BY w.warehouse_code, l.location_code`, lots,
  );
  return rows.map((row) => {
    const key = `K:${row.lot_id}:${row.location_id}`;
    return { lotId: row.lot_id, qty: Number(row.qty), node: { key, nodeKey: key, kind: 'STOCK',
      warehouse: { warehouseId: Number(row.warehouse_id), code: row.warehouse_code, name: row.warehouse_name },
      location: { locationId: Number(row.location_id), code: row.location_code, name: row.location_name }, qty: Number(row.qty) } };
  });
}

export async function workOrderNodes(prisma: PrismaService, workOrderIds: bigint[]): Promise<TraceOtherNode[]> {
  if (workOrderIds.length === 0) return [];
  const rows = await prisma.work_order.findMany({
    where: { work_order_id: { in: workOrderIds } },
    select: { work_order_id: true, work_order_no: true, status_code: true, item: { select: { item_id: true, item_code: true, item_name: true } } },
  });
  return rows.map((row) => ({ key: `W:${row.work_order_id}`, nodeKey: `W:${row.work_order_id}`, kind: 'WORK_ORDER',
    workOrder: { workOrderId: Number(row.work_order_id), workOrderNo: row.work_order_no, statusCode: row.status_code },
    item: { itemId: Number(row.item.item_id), code: row.item.item_code, name: row.item.item_name } }));
}
