import { inboundLineLotSql, inboundLotOfSql, splitAncestors } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LIVE_CONSUMPTION, RECEIPT_CANCELLED } from '../flow/flow-sql';

/**
 * 피처 015 목록 줄 `TraceLotRow`(contracts 머리) — 목록 둘과 번호 풀기가 같은 줄을 쓴다.
 * 자재 쪽(`MATERIAL`)은 공급사·입하 LOT(분할 LOT 이면 원래 LOT 것), 제품 쪽(`PRODUCT`)은 마지막 출하의 고객을 싣는다.
 */
export type TraceSide = 'MATERIAL' | 'PRODUCT';
export type SortDateKind = 'CONSUMED' | 'INBOUND' | 'SHIPPED' | 'RECEIVED';

export interface TraceLotRow {
  lot: { lotId: number; lotNo: string; lotTypeCode: string; statusCode: string; lifecycleStatusCode: string | null };
  item: { itemId: number; code: string; name: string };
  qty: number;
  uomCode: string;
  partner: { partnerId: number; code: string; name: string } | null;
  inboundLotNo: string | null;
  sortDate: string | null;
  sortDateKind: SortDateKind | null;
}

/** 목록이 정한 정렬 날짜 — 없으면 줄 만들기가 최근 규칙(자재: 마지막 투입, 제품: 마지막 출하 없으면 입고)으로 구한다. */
export type SortOverride = Map<bigint, { at: Date; kind: SortDateKind }>;

/** 출하 완료 — 확정되고 실제 출하 시각이 있는 출하(대시보드 「출하 확정」과 같은 기준). */
export const SHIPMENT_DONE = (alias: string) => `${alias}.status_code = 'CONFIRMED' AND ${alias}.shipped_at IS NOT NULL`;

interface RowSql {
  lot_id: bigint;
  lot_no: string;
  lot_type_code: string;
  status_code: string;
  lifecycle_status_code: string | null;
  initial_qty: unknown;
  uom_code: string;
  item_id: bigint;
  item_code: string;
  item_name: string;
  partner_id: bigint | null;
  partner_code: string | null;
  partner_name: string | null;
  inbound_lot_no: string | null;
  shipped_at: Date | null;
  base_at: Date | null;
}

/** 공급사 — 입하 LOT(분할이면 조상의 것), 없으면(005 이전) 원래 LOT 을 등록한 옛 입하 줄의 공급사. */
const MATERIAL_SIDE = `
  LEFT JOIN trace.inbound_lot il ON il.inbound_lot_id = ${inboundLotOfSql('lt')}
  LEFT JOIN LATERAL (
    SELECT ir.supplier_id FROM trace.lot rt
      JOIN logistics.inbound_receipt_line irl ON ${inboundLineLotSql('rt', 'irl')}
      JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
     WHERE rt.lot_id = b.root_id ORDER BY ir.receipt_datetime, irl.inbound_receipt_line_id LIMIT 1
  ) leg ON il.inbound_lot_id IS NULL
  LEFT JOIN mdm.partner pt ON pt.partner_id = COALESCE(il.supplier_id, leg.supplier_id)
  LEFT JOIN LATERAL (
    SELECT MAX(mc.occurred_at) AS at FROM production.material_consumption mc WHERE mc.lot_id = lt.lot_id AND ${LIVE_CONSUMPTION}
  ) srt ON true`;

/** 고객 — 마지막 완료 출하의 고객. 정렬 날짜는 마지막 출하, 없으면 마지막 생산 입고. */
const PRODUCT_SIDE = `
  LEFT JOIN LATERAL (
    SELECT sr.customer_id, s.shipped_at FROM logistics.shipment_lot_allocation a
      JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
      JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
      JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
     WHERE a.lot_id = lt.lot_id AND ${SHIPMENT_DONE('s')}
     ORDER BY s.shipped_at DESC, s.shipment_id DESC LIMIT 1
  ) sh ON true
  LEFT JOIN mdm.partner pt ON pt.partner_id = sh.customer_id
  LEFT JOIN LATERAL (
    SELECT MAX(gr.receipt_datetime) AS at FROM logistics.goods_receipt_line gl
      JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = gl.goods_receipt_id
     WHERE gl.lot_id = lt.lot_id AND gr.receipt_type_code = 'PRODUCT' AND gr.status_code <> ${RECEIPT_CANCELLED}
  ) rc ON true`;

/** LOT 들을 목록 줄로 — 받은 순서를 지킨다. 공장 밖 LOT 은 호출 쪽이 이미 걸렀다. */
export async function traceLotRows(prisma: PrismaService, lotIds: readonly bigint[], side: TraceSide, sort?: SortOverride): Promise<TraceLotRow[]> {
  if (lotIds.length === 0) return [];
  const ancestors = side === 'MATERIAL' ? await splitAncestors(prisma, lotIds) : new Map();
  const roots = lotIds.map((id) => {
    const chain = ancestors.get(id) ?? [];
    return chain.length === 0 ? id : chain[chain.length - 1].parent_lot_id;
  });
  const material = side === 'MATERIAL';
  const rows = await prisma.$queryRawUnsafe<RowSql[]>(
    `SELECT lt.lot_id, lt.lot_no, lt.lot_type_code, lt.status_code, lt.lifecycle_status_code, lt.initial_qty, u.uom_code,
            i.item_id, i.item_code, i.item_name, pt.partner_id, pt.partner_code, pt.partner_name,
            ${material ? 'il.inbound_lot_no, NULL::timestamptz AS shipped_at, srt.at AS base_at' : 'NULL AS inbound_lot_no, sh.shipped_at, rc.at AS base_at'}
       FROM unnest($1::bigint[], $2::bigint[]) WITH ORDINALITY AS b(lot_id, root_id, ord)
       JOIN trace.lot lt ON lt.lot_id = b.lot_id
       JOIN mdm.item i ON i.item_id = lt.item_id
       JOIN mdm.uom u ON u.uom_id = lt.uom_id
       ${material ? MATERIAL_SIDE : PRODUCT_SIDE}
      ORDER BY b.ord`,
    [...lotIds], roots,
  );
  return rows.map((row) => {
    const own = sort?.get(row.lot_id);
    const fallback: { at: Date; kind: SortDateKind } | undefined = material
      ? (row.base_at === null ? undefined : { at: row.base_at, kind: 'CONSUMED' })
      : row.shipped_at !== null ? { at: row.shipped_at, kind: 'SHIPPED' }
        : row.base_at === null ? undefined : { at: row.base_at, kind: 'RECEIVED' };
    const chosen = own ?? fallback;
    return {
      lot: { lotId: Number(row.lot_id), lotNo: row.lot_no, lotTypeCode: row.lot_type_code, statusCode: row.status_code, lifecycleStatusCode: row.lifecycle_status_code },
      item: { itemId: Number(row.item_id), code: row.item_code, name: row.item_name },
      qty: Number(row.initial_qty),
      uomCode: row.uom_code,
      partner: row.partner_id === null ? null : { partnerId: Number(row.partner_id), code: row.partner_code ?? '', name: row.partner_name ?? '' },
      inboundLotNo: row.inbound_lot_no,
      sortDate: chosen?.at.toISOString() ?? null,
      sortDateKind: chosen?.kind ?? null,
    };
  });
}
