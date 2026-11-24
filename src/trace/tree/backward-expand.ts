import { CONSUMED_RELATION, GraphStep, SPLIT_RELATION, WORK_ORDER_LOT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';
import { LIVE_CONSUMPTION, tracedSql } from '../flow/flow-sql';
import { TraceEdge, TraceOtherNode, workOrderNodes } from './forward-expand';
import { lotKey } from './trace-node-facts';

const keyIds = (frontier: string[], head: string): bigint[] => frontier.filter((key) => key.startsWith(head)).map((key) => BigInt(key.slice(2)));
export const serialKey = (serialId: bigint | number): string => `N:${serialId}`;

/**
 * 역방향 한 단계(피처 015 T026) — 뿌리에서 멀어지는 쪽으로 질의 5번:
 * 분할·분리 자식 → 원래 LOT(SPLIT_FROM), 원천 W/O LOT → W/O(PRODUCED_BY) → 투입 LOT(CONSUMED — 계보가 있는 W/O 는 그 LOT 의 계보,
 * 없으면 W/O 투입 전부, 실적 배분이 없으면 잇지 않는다: 지금 backward 규칙), 생산 원천이 아닌 자재 LOT → 입하 LOT(RECEIVED_FROM·IQC),
 * 시리얼 → LOT(SERIAL_OF)·부품 시리얼(ASSEMBLED, 한 단계).
 */
export function backwardExpand(prisma: PrismaService): (frontier: string[]) => Promise<GraphStep<TraceOtherNode, TraceEdge>> {
  return async (frontier) => {
    const lots = keyIds(frontier, 'L:');
    const serials = keyIds(frontier, 'N:');
    const [heads, inputs, inbound, serialRows] = await Promise.all([
      prisma.$queryRawUnsafe<{ lot_id: bigint; parent_lot_id: bigint | null; work_order_id: bigint | null; split_qty: unknown; made_qty: unknown }[]>(
        `SELECT lt.lot_id, lt.parent_lot_id, CASE WHEN lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND lt.parent_lot_id IS NULL THEN lt.source_id END AS work_order_id,
                (SELECT r.relation_qty FROM trace.lot_relation r WHERE r.target_lot_id = lt.lot_id AND r.source_lot_id = lt.parent_lot_id
                    AND r.relation_type_code = '${SPLIT_RELATION}' LIMIT 1) AS split_qty,
                (SELECT SUM(pa.allocated_qty) FROM production.production_result_lot_allocation pa WHERE pa.lot_id = lt.lot_id) AS made_qty
           FROM trace.lot lt WHERE lt.lot_id = ANY($1::bigint[]) ORDER BY lt.lot_id`, lots,
      ),
      prisma.$queryRawUnsafe<{ work_order_id: bigint; input_lot_id: bigint; traced: boolean; qty: unknown; first_at: Date | null; last_at: Date | null }[]>(
        `WITH made AS (
           SELECT lt.lot_id, lt.source_id AS work_order_id, ${tracedSql('lt.source_id')} AS traced FROM trace.lot lt
            WHERE lt.lot_id = ANY($1::bigint[]) AND lt.source_type_code = '${WORK_ORDER_LOT_SOURCE}' AND lt.parent_lot_id IS NULL
              AND EXISTS (SELECT 1 FROM production.production_result_lot_allocation pa WHERE pa.lot_id = lt.lot_id)
         ), pairs AS (
           SELECT m.work_order_id, r.source_lot_id AS input_lot_id, true AS traced FROM made m
             JOIN trace.lot_relation r ON r.target_lot_id = m.lot_id AND r.relation_type_code = '${CONSUMED_RELATION}' WHERE m.traced
           UNION
           SELECT m.work_order_id, mc.lot_id, false FROM made m JOIN production.material_consumption mc ON mc.work_order_id = m.work_order_id WHERE NOT m.traced
         )
         SELECT p.work_order_id, p.input_lot_id, p.traced, c.qty, c.first_at, c.last_at FROM pairs p
           LEFT JOIN LATERAL (SELECT SUM(mc.input_qty) AS qty, MIN(mc.occurred_at) AS first_at, MAX(mc.occurred_at) AS last_at
                                FROM production.material_consumption mc WHERE mc.work_order_id = p.work_order_id AND mc.lot_id = p.input_lot_id AND ${LIVE_CONSUMPTION}) c ON true
          ORDER BY p.work_order_id, c.first_at NULLS LAST, p.input_lot_id`, lots,
      ),
      prisma.$queryRawUnsafe<{
        lot_id: bigint; inbound_lot_id: bigint; inbound_lot_no: string; receiving_date: Date; partner_id: bigint; partner_code: string; partner_name: string;
        judgment: string | null;
      }[]>(
        `SELECT lt.lot_id, il.inbound_lot_id, il.inbound_lot_no, il.receiving_date, sp.partner_id, sp.partner_code, sp.partner_name, q.judgment
           FROM trace.lot lt JOIN trace.inbound_lot il ON il.inbound_lot_id = lt.inbound_lot_id JOIN mdm.partner sp ON sp.partner_id = il.supplier_id
           LEFT JOIN LATERAL (SELECT iq.overall_judgment_code AS judgment FROM quality.inspection_request iq
                               WHERE iq.inbound_lot_id = il.inbound_lot_id AND iq.inspection_type_code = 'IQC' AND iq.status_code <> 'CANCELLED'
                               ORDER BY iq.confirmed_at DESC NULLS LAST, iq.inspection_request_id DESC LIMIT 1) q ON true
          WHERE lt.lot_id = ANY($1::bigint[]) AND lt.parent_lot_id IS NULL`, lots,
      ),
      serialSteps(prisma, serials),
    ]);
    const nodes: TraceOtherNode[] = [...serialRows.nodes];
    const edges: TraceEdge[] = [...serialRows.edges];
    const reached: string[] = [...serialRows.reached];
    nodes.push(...(await workOrderNodes(prisma, [...new Set([...heads.flatMap((row) => (row.work_order_id === null ? [] : [row.work_order_id])),
      ...inputs.map((row) => row.work_order_id)])])));
    for (const row of heads) {
      if (row.parent_lot_id !== null) {
        edges.push({ from: lotKey(row.lot_id), to: lotKey(row.parent_lot_id), kind: 'SPLIT_FROM', qty: row.split_qty === null ? null : Number(row.split_qty), basis: 'RECORDED' });
        reached.push(lotKey(row.parent_lot_id));
      } else if (row.work_order_id !== null) {
        edges.push({ from: lotKey(row.lot_id), to: `W:${row.work_order_id}`, kind: 'PRODUCED_BY', qty: row.made_qty === null ? null : Number(row.made_qty), basis: 'RECORDED' });
      }
    }
    for (const row of inputs) {
      edges.push({ from: `W:${row.work_order_id}`, to: lotKey(row.input_lot_id), kind: 'CONSUMED', qty: row.qty === null ? null : Number(row.qty),
        basis: row.traced ? GENEALOGY_BASIS : WORK_ORDER_BASIS, ...(row.first_at === null ? {} : { firstAt: row.first_at.toISOString() }),
        ...(row.last_at === null ? {} : { lastAt: row.last_at.toISOString() }) });
      reached.push(lotKey(row.input_lot_id));
    }
    for (const row of inbound) {
      const key = `I:${row.inbound_lot_id}`;
      nodes.push({ key, nodeKey: key, kind: 'INBOUND_LOT', inboundLot: {
        inboundLotId: Number(row.inbound_lot_id), inboundLotNo: row.inbound_lot_no, receivedDate: row.receiving_date.toISOString().slice(0, 10),
        supplier: { partnerId: Number(row.partner_id), code: row.partner_code, name: row.partner_name }, iqcJudgmentCode: row.judgment,
      } });
      edges.push({ from: lotKey(row.lot_id), to: key, kind: 'RECEIVED_FROM', qty: null, basis: 'RECORDED' });
    }
    return { nodes, edges, reached };
  };
}

/** 시리얼 — 자기 항목·그 LOT(SERIAL_OF), 조립 기록의 부품 시리얼(ASSEMBLED)과 그 LOT. 부품 시리얼의 LOT 은 일반 역추적으로 이어진다. */
async function serialSteps(prisma: PrismaService, serialIds: bigint[]): Promise<GraphStep<TraceOtherNode, TraceEdge>> {
  if (serialIds.length === 0) return { nodes: [], edges: [], reached: [] };
  const rows = await prisma.$queryRawUnsafe<{ parent_id: bigint | null; serial_number_id: bigint; serial_no: string; lot_id: bigint; produced_at: Date | null; created_at: Date }[]>(
    `SELECT NULL::bigint AS parent_id, s.serial_number_id, s.serial_no, s.lot_id, s.produced_at, s.created_at FROM trace.serial_number s
      WHERE s.serial_number_id = ANY($1::bigint[])
     UNION ALL
     SELECT r.parent_serial_number_id, c.serial_number_id, c.serial_no, c.lot_id, c.produced_at, c.created_at FROM trace.serial_component_relation r
       JOIN trace.serial_number c ON c.serial_number_id = r.component_serial_number_id
      WHERE r.parent_serial_number_id = ANY($1::bigint[])
     ORDER BY 1 NULLS FIRST, 3`, serialIds,
  );
  const nodes: TraceOtherNode[] = [];
  const edges: TraceEdge[] = [];
  for (const row of rows) {
    const key = serialKey(row.serial_number_id);
    nodes.push({ key, nodeKey: key, kind: row.parent_id === null ? 'SERIAL' : 'COMPONENT_SERIAL', serialNo: row.serial_no,
      producedAt: (row.produced_at ?? row.created_at).toISOString(), lotId: Number(row.lot_id) });
    if (row.parent_id !== null) edges.push({ from: serialKey(row.parent_id), to: key, kind: 'ASSEMBLED', qty: null, basis: 'RECORDED' });
    edges.push({ from: key, to: lotKey(row.lot_id), kind: 'SERIAL_OF', qty: null, basis: 'RECORDED' });
  }
  return { nodes, edges, reached: rows.map((row) => lotKey(row.lot_id)) };
}
