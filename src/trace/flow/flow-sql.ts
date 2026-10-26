import { PageRequest } from '../../common/pagination';
import { liveAllocationSql } from '../../core/lot/lot-allocation';
import { CONSUMED_RELATION } from '../../core/lot/lot-genealogy';
import { WORK_ORDER_LOT_SOURCE } from '../../core/lot/lot-source';
import { HU_STATUS_PACKED } from '../../inventory/handling-unit/handling-unit-status';
import { PrismaService } from '../../prisma/prisma.service';
import { GENEALOGY_BASIS, WORK_ORDER_BASIS } from '../lot/lot-genealogy-query.service';
import { StageCode, stageCounts } from './flow-stage';

// LOT 추적 목록·사슬이 함께 쓰는 SQL 조각. 값은 모두 코드 상수라 그대로 끼운다(사용자 값은 호출 쪽이 bind 한다).
// 계보 규칙은 `lot-genealogy-query.service.ts`·`lot-impact.service.ts` 와 같다 — 계보(`lot_relation`)가 한 줄이라도
// 있는 W/O 는 계보로, 실적은 있는데 계보가 0줄인 W/O 는 W/O 단위로 잇는다.
// ⭐ 실적 배분이 없는 생산 LOT 은 잇지 않는다 — 투입만 하고 실적이 없는 W/O 의 빈 선발행 LOT 이 영향 LOT 으로 보이면 안 된다.

/** 입고는 취소 완료만 뺀다 — 취소 요청 중인 입고는 재고가 그대로이고 반려되면 남는다(입고 줄 현황과 같은 기준). */
export const RECEIPT_CANCELLED = `'CANCELLED'`;
export const SHIPMENT_CANCELLED = `'CANCELLED'`;
/** 포장 단계는 확정(`:pack`)된 취급 단위만 센다 — 아직 열린 상자는 「포장 중」이다. */
export const HU_PACKED = `'${HU_STATUS_PACKED}'`;
/** 정정된 원 투입은 빼고 정정 투입을 넣는다 — 계보의 투입 구간(`inputWindows`)과 같은 셈. */
export const LIVE_CONSUMPTION = `NOT EXISTS (SELECT 1 FROM production.material_consumption cx WHERE cx.corrects_consumption_id = mc.material_consumption_id)`;
const WO = `'${WORK_ORDER_LOT_SOURCE}'`;
const CONSUMED = `'${CONSUMED_RELATION}'`;

/** 계보가 한 줄이라도 있는 W/O 인가 — `tracedWorkOrders` 와 같은 판정. `workOrder` 는 W/O id 를 내는 SQL 식이다. */
export function tracedSql(workOrder: string): string {
  return `EXISTS (SELECT 1 FROM trace.lot_relation tr JOIN trace.lot tt ON tt.lot_id = tr.target_lot_id
                   WHERE tr.relation_type_code = ${CONSUMED} AND tt.source_type_code = ${WO} AND tt.source_id = ${workOrder})`;
}

const HAS_PRODUCTION = (lot: string) =>
  `EXISTS (SELECT 1 FROM production.production_result_lot_allocation pa WHERE pa.lot_id = ${lot} AND ${liveAllocationSql('pa')})`;

/** `sources`(LOT id 를 내는 SQL)의 각 LOT 이 들어간 생산 LOT — (source_lot_id, target_lot_id, work_order_id, basis). */
export function forwardLinksSql(sources: string): string {
  return `
    SELECT r.source_lot_id, r.target_lot_id, t.source_id AS work_order_id, '${GENEALOGY_BASIS}' AS basis
      FROM trace.lot_relation r
      JOIN trace.lot t ON t.lot_id = r.target_lot_id
     WHERE r.relation_type_code = ${CONSUMED} AND r.source_lot_id IN (${sources})
    UNION
    SELECT DISTINCT mc.lot_id, pl.lot_id, mc.work_order_id, '${WORK_ORDER_BASIS}'
      FROM production.material_consumption mc
      JOIN trace.lot pl ON pl.source_type_code = ${WO} AND pl.source_id = mc.work_order_id
     WHERE mc.lot_id IN (${sources}) AND ${HAS_PRODUCTION('pl.lot_id')} AND NOT ${tracedSql('mc.work_order_id')}`;
}

/** 생산 LOT 하나에 들어간 자재 LOT 수 — 계보 W/O 는 계보로, 아니면 그 W/O 의 투입 LOT 전부. */
export function inputCountSql(lot: string, workOrder: string): string {
  return `CASE WHEN ${tracedSql(workOrder)}
            THEN (SELECT COUNT(DISTINCT ir.source_lot_id) FROM trace.lot_relation ir
                   WHERE ir.target_lot_id = ${lot} AND ir.relation_type_code = ${CONSUMED})
            ELSE (SELECT COUNT(DISTINCT im.lot_id) FROM production.material_consumption im WHERE im.work_order_id = ${workOrder})
          END`;
}

/** 생산 LOT 하나의 뒤 단계 — 생산입고 줄 수·수량, 포장(취급 단위) 수·수량, 출하 수·수량·마지막 출하 일시. */
export function downstreamLateralSql(lot: string): string {
  return `
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS received_count, COALESCE(SUM(dl.receipt_qty), 0) AS received_qty
        FROM logistics.goods_receipt_line dl
        JOIN logistics.goods_receipt dg ON dg.goods_receipt_id = dl.goods_receipt_id
       WHERE dl.lot_id = ${lot} AND dg.receipt_type_code = 'PRODUCT' AND dg.status_code <> ${RECEIPT_CANCELLED}
    ) dr ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT hc.handling_unit_id) AS hu_count, COALESCE(SUM(hc.qty), 0) AS packed_qty
        FROM inventory.handling_unit_content hc
        JOIN inventory.handling_unit hh ON hh.handling_unit_id = hc.handling_unit_id AND hh.status_code = ${HU_PACKED}
       WHERE hc.lot_id = ${lot}
    ) dp ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT ds.shipment_id) AS shipment_count, COALESCE(SUM(da.allocated_qty), 0) AS shipped_qty,
             MAX(ds.shipped_at) AS last_shipped_at
        FROM logistics.shipment_lot_allocation da
        JOIN logistics.shipment_line dsl ON dsl.shipment_line_id = da.shipment_line_id
        JOIN logistics.shipment ds ON ds.shipment_id = dsl.shipment_id
       WHERE da.lot_id = ${lot} AND ds.status_code <> ${SHIPMENT_CANCELLED}
    ) dsh ON true`;
}

/**
 * `WITH … staged AS (…)` 를 한 번만 돌려 단계별 건수(단계 조건 없이)와 그 쪽의 행을 함께 받는다.
 * staged 를 두 번 읽으므로 PostgreSQL 이 한 번 계산해 둔다 — 두 질의로 나누면 하위 집계를 두 번 돈다.
 * 바깥에도 같은 정렬을 건다 — LATERAL 안의 순서는 바깥 결과의 순서를 보장하지 않는다.
 */
export async function stagedPage<R extends { lot_id: bigint | null }>(
  prisma: PrismaService,
  withSql: string,
  params: unknown[],
  options: { stages: readonly StageCode[]; filter: string[] | undefined; orderBy: string; page: PageRequest },
): Promise<{ rows: R[]; counts: Record<string, number>; total: number }> {
  const values = [...params, ...(options.filter === undefined ? [] : [options.filter]), options.page.take, options.page.skip];
  const at = params.length + (options.filter === undefined ? 0 : 1);
  const where = options.filter === undefined ? '' : `WHERE stage = ANY($${params.length + 1}::text[])`;
  const rows = await prisma.$queryRawUnsafe<(R & { stage_counts: { stage: string; count: number }[] | null })[]>(
    `${withSql}, counts AS (SELECT json_agg(json_build_object('stage', stage, 'count', n)) AS stage_counts
                             FROM (SELECT stage, COUNT(*) AS n FROM staged GROUP BY stage) g)
     SELECT c.stage_counts, p.* FROM counts c
       LEFT JOIN LATERAL (SELECT * FROM staged ${where} ORDER BY ${options.orderBy} LIMIT $${at + 1} OFFSET $${at + 2}) p ON true
      ORDER BY ${options.orderBy}`,
    ...values,
  );
  const counts = stageCounts(options.stages, (rows[0]?.stage_counts ?? []).map((row) => ({ stage: row.stage, count: BigInt(row.count) })));
  const total = Object.entries(counts).filter(([stage]) => options.filter === undefined || options.filter.includes(stage))
    .reduce((sum, [, count]) => sum + count, 0);
  return { rows: rows.filter((row) => row.lot_id !== null), counts, total };
}
