import { SPLIT_RELATION, WORK_ORDER_LOT_SOURCE, inboundLineLotSql, splitAncestors } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { splitGoodsIssues } from '../flow/split-links';

/**
 * 계보 항목(contracts §3·§4)의 LOT 칸 — 그래프를 다 따라간 뒤 LOT 묶음으로 한 번에 읽는다.
 * 종류: 분할·분리 자식(parent 있음) → SPLIT_LOT, 원천 W/O → PRODUCTION_LOT, 그 밖 → MATERIAL_LOT.
 */
export interface TraceTreeLot {
  lotId: number;
  lotNo: string;
  lotTypeCode: string;
  statusCode: string;
  lifecycleStatusCode: string | null;
}

export interface Named {
  partnerId: number;
  code: string;
  name: string;
}

/** 자재 LOT 의 입하 쪽 — 분할 LOT 이면 원래 LOT 것. 공급사 LOT 은 lot_external_identifier 먼저, 없으면 옛 입하 줄(F-6). */
export interface MaterialFacts {
  inboundLotId: number | null;
  inboundLotNo: string | null;
  supplier: Named | null;
  supplierLotNo: string | null;
  receivedAt: string | null;
}

export interface TraceLotNode {
  nodeKey: string;
  kind: 'MATERIAL_LOT' | 'SPLIT_LOT' | 'PRODUCTION_LOT';
  lot: TraceTreeLot;
  item: { itemId: number; code: string; name: string };
  qty: number;
  uomCode: string;
  material?: MaterialFacts;
  producedAt?: string | null;
  split?: { splitAt: string; goodsIssueNo: string | null; lineNo: number | null };
}

export const lotKey = (lotId: bigint | number): string => `L:${lotId}`;

interface HeadRow {
  lot_id: bigint; lot_no: string; lot_type_code: string; status_code: string; lifecycle_status_code: string | null; initial_qty: unknown;
  uom_code: string; item_id: bigint; item_code: string; item_name: string; parent_lot_id: bigint | null; source_type_code: string;
  produced_at: Date | null; split_at: Date | null; split_event_type: string | null; split_event_id: bigint | null;
}

export async function lotNodes(prisma: PrismaService, lotIds: readonly bigint[]): Promise<Map<bigint, TraceLotNode>> {
  if (lotIds.length === 0) return new Map();
  const heads = await prisma.$queryRawUnsafe<HeadRow[]>(
    `SELECT lt.lot_id, lt.lot_no, lt.lot_type_code, lt.status_code, lt.lifecycle_status_code, lt.initial_qty, u.uom_code,
            i.item_id, i.item_code, i.item_name, lt.parent_lot_id, lt.source_type_code,
            (SELECT MIN(pr.occurred_at) FROM production.production_result_lot_allocation pa
               JOIN production.production_result pr ON pr.production_result_id = pa.production_result_id WHERE pa.lot_id = lt.lot_id) AS produced_at,
            sr.occurred_at AS split_at, sr.source_event_type_code AS split_event_type, sr.source_event_id AS split_event_id
       FROM trace.lot lt JOIN mdm.item i ON i.item_id = lt.item_id JOIN mdm.uom u ON u.uom_id = lt.uom_id
       LEFT JOIN LATERAL (SELECT r.occurred_at, r.source_event_type_code, r.source_event_id FROM trace.lot_relation r
                           WHERE r.target_lot_id = lt.lot_id AND r.relation_type_code = '${SPLIT_RELATION}' ORDER BY r.lot_relation_id LIMIT 1) sr ON true
      WHERE lt.lot_id = ANY($1::bigint[])`, [...lotIds],
  );
  const [materials, issues] = await Promise.all([
    materialFacts(prisma, heads.filter((row) => row.lot_type_code === 'MATERIAL').map((row) => row.lot_id)),
    splitGoodsIssues(prisma, heads.flatMap((row) => (row.split_event_type === 'GOODS_ISSUE_LINE' && row.split_event_id !== null ? [row.split_event_id] : []))),
  ]);
  return new Map(heads.map((row) => {
    const kind = row.parent_lot_id !== null ? 'SPLIT_LOT' : row.source_type_code === WORK_ORDER_LOT_SOURCE ? 'PRODUCTION_LOT' : 'MATERIAL_LOT';
    const issue = row.split_event_id === null ? undefined : issues.get(row.split_event_id);
    const node: TraceLotNode = {
      nodeKey: lotKey(row.lot_id),
      kind,
      lot: { lotId: Number(row.lot_id), lotNo: row.lot_no, lotTypeCode: row.lot_type_code, statusCode: row.status_code, lifecycleStatusCode: row.lifecycle_status_code },
      item: { itemId: Number(row.item_id), code: row.item_code, name: row.item_name },
      qty: Number(row.initial_qty),
      uomCode: row.uom_code,
      ...(materials.has(row.lot_id) ? { material: materials.get(row.lot_id) } : {}),
      ...(kind === 'PRODUCTION_LOT' ? { producedAt: row.produced_at?.toISOString() ?? null } : {}),
      ...(kind === 'SPLIT_LOT' && row.split_at !== null
        ? { split: { splitAt: row.split_at.toISOString(), goodsIssueNo: issue?.goodsIssueNo ?? null, lineNo: issue?.lineNo ?? null } } : {}),
    };
    return [row.lot_id, node];
  }));
}

/** 자재 LOT 의 입하·공급사·공급사 LOT — 분할 LOT 은 뿌리(원래 LOT) 것을 읽는다. */
export async function materialFacts(prisma: PrismaService, lotIds: readonly bigint[]): Promise<Map<bigint, MaterialFacts>> {
  if (lotIds.length === 0) return new Map();
  const chains = await splitAncestors(prisma, lotIds);
  const roots = lotIds.map((id) => {
    const up = chains.get(id) ?? [];
    return up.length === 0 ? id : up[up.length - 1].parent_lot_id;
  });
  const rows = await prisma.$queryRawUnsafe<{
    lot_id: bigint; inbound_lot_id: bigint | null; inbound_lot_no: string | null; received_at: Date | null;
    partner_id: bigint | null; partner_code: string | null; partner_name: string | null; supplier_lot_no: string | null;
  }[]>(
    `SELECT b.lot_id, il.inbound_lot_id, il.inbound_lot_no, COALESCE(iir.receipt_datetime, leg.receipt_datetime) AS received_at,
            sp.partner_id, sp.partner_code, sp.partner_name, COALESCE(x.external_identifier, leg.supplier_lot_no) AS supplier_lot_no
       FROM unnest($1::bigint[], $2::bigint[]) AS b(lot_id, root_id)
       JOIN trace.lot rt ON rt.lot_id = b.root_id
       LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = rt.inbound_lot_id
       LEFT JOIN logistics.inbound_receipt_line ilr ON ilr.inbound_receipt_line_id = il.inbound_receipt_line_id
       LEFT JOIN logistics.inbound_receipt iir ON iir.inbound_receipt_id = ilr.inbound_receipt_id
       LEFT JOIN LATERAL (
         SELECT ir.supplier_id, ir.receipt_datetime, irl.supplier_lot_no FROM logistics.inbound_receipt_line irl
           JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
          WHERE ${inboundLineLotSql('rt', 'irl')} ORDER BY ir.receipt_datetime, irl.inbound_receipt_line_id LIMIT 1
       ) leg ON il.inbound_lot_id IS NULL
       LEFT JOIN LATERAL (
         SELECT x.external_identifier FROM trace.lot_external_identifier x
          WHERE x.lot_id = rt.lot_id AND x.identifier_type_code = 'SUPPLIER_LOT' ORDER BY x.lot_external_identifier_id LIMIT 1
       ) x ON true
       LEFT JOIN mdm.partner sp ON sp.partner_id = COALESCE(il.supplier_id, leg.supplier_id)`,
    [...lotIds], roots,
  );
  return new Map(rows.map((row) => [row.lot_id, {
    inboundLotId: row.inbound_lot_id === null ? null : Number(row.inbound_lot_id),
    inboundLotNo: row.inbound_lot_no,
    supplier: row.partner_id === null ? null : { partnerId: Number(row.partner_id), code: row.partner_code ?? '', name: row.partner_name ?? '' },
    supplierLotNo: row.supplier_lot_no,
    receivedAt: row.received_at?.toISOString() ?? null,
  }]));
}
