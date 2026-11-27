import { HttpStatus, Injectable } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PageMeta, pageRequest } from '../../common/pagination';
import { LocalPeriod, localPeriod, localPeriodSql, plantToday } from '../../common/period/plant-local-period';
import { inboundLineLotSql } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { LIVE_CONSUMPTION, RECEIPT_CANCELLED } from '../flow/flow-sql';
import { SHIPMENT_DONE, SortDateKind, SortOverride, TraceLotRow, TraceSide, traceLotRows } from './trace-lot-row';

/** 목록 질의(contracts §1) — 조건이 없으면 최근, 공급사·고객 + 기간이면 조건. */
export interface TraceLotQuery {
  plantId: number;
  partnerId?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  size?: number;
}

export interface TraceLotPage {
  mode: 'RECENT' | 'CONDITION';
  items: TraceLotRow[];
  page: PageMeta;
}

/** 최근·조건 모두 한 쪽 100개(plan 「설계에서 정한 세부」). */
export const TRACE_LIST_SIZE = 100;
/** 최근 목록은 투입·출하·입고 줄을 시각 역순으로 이만큼씩 훑어 겹치지 않는 LOT 을 모은다. */
const SCAN_BATCH = 1000;

interface Hit {
  lotId: bigint;
  at: Date;
}

/**
 * LOT 목록 둘(피처 015 · R-12). 최근은 기존 시각 인덱스(투입 `occurred_at`·출하 `shipped_at`·입고 `receipt_datetime`)를
 * 역순으로 훑어 겹치지 않는 LOT 을 모은다 — 공장 전체를 LOT 마다 묶지 않는다.
 */
@Injectable()
export class TraceLotsService {
  constructor(private readonly prisma: PrismaService) {}

  async materials(query: TraceLotQuery): Promise<TraceLotPage> {
    const period = await this.period(query, '입하일');
    if (period === undefined) {
      const hits = await this.recent(
        `FROM production.material_consumption mc JOIN trace.lot lt ON lt.lot_id = mc.lot_id WHERE lt.plant_id = $1::bigint AND ${LIVE_CONSUMPTION}`,
        { lot: 'mc.lot_id', at: 'mc.occurred_at', tie: 'mc.material_consumption_id' }, [query.plantId], TRACE_LIST_SIZE,
      );
      return this.recentPage(hits, 'MATERIAL', 'CONSUMED');
    }
    // 입하일 — 입하 LOT 의 입하일(공장 현지 날짜). 005 이전 LOT 은 입하 LOT 이 없어 첫 자재 입고일(공장 현지)로 본다.
    // 분할 자손은 빼고 입하에 직접 든 LOT 만 — 자손은 계보가 따라간다.
    const candidates = `
      SELECT lt.lot_id, il.receiving_date AS d, ir.receipt_datetime AS at
        FROM trace.inbound_lot il
        JOIN trace.lot lt ON lt.inbound_lot_id = il.inbound_lot_id
        JOIN logistics.inbound_receipt_line irl ON irl.inbound_receipt_line_id = il.inbound_receipt_line_id
        JOIN logistics.inbound_receipt ir ON ir.inbound_receipt_id = irl.inbound_receipt_id
       WHERE il.plant_id = $1::bigint AND il.supplier_id = $2::bigint AND il.receiving_date BETWEEN $3::date AND $4::date
      UNION ALL
      SELECT lg.lot_id, (lg.first_at AT TIME ZONE p.timezone_code)::date, lg.first_at
        FROM (SELECT DISTINCT lt.lot_id, lt.plant_id, f.first_at
                FROM logistics.inbound_receipt ir
                JOIN logistics.inbound_receipt_line irl ON irl.inbound_receipt_id = ir.inbound_receipt_id
                JOIN trace.lot lt ON ${inboundLineLotSql('lt', 'irl')}
                CROSS JOIN LATERAL (
                  SELECT MIN(gr.receipt_datetime) AS first_at FROM logistics.goods_receipt_line gl
                    JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = gl.goods_receipt_id
                   WHERE gl.lot_id = lt.lot_id AND gr.receipt_type_code = 'MATERIAL' AND gr.status_code <> ${RECEIPT_CANCELLED}
                ) f
               WHERE ir.plant_id = $1::bigint AND ir.supplier_id = $2::bigint AND lt.plant_id = $1::bigint AND lt.inbound_lot_id IS NULL
                 AND f.first_at IS NOT NULL) lg
        JOIN mdm.plant p ON p.plant_id = lg.plant_id
       WHERE (lg.first_at AT TIME ZONE p.timezone_code)::date BETWEEN $3::date AND $4::date`;
    return this.conditionPage(candidates, 'd DESC, at DESC, lot_id DESC',
      [query.plantId, query.partnerId, period.from, period.to], query, 'MATERIAL', 'INBOUND');
  }

  async products(query: TraceLotQuery): Promise<TraceLotPage> {
    const period = await this.period(query, '출하일');
    if (period === undefined) return this.recentProducts(query.plantId);
    const params: unknown[] = [query.plantId, query.partnerId];
    const bind = (value: unknown) => `$${params.push(value)}`;
    // 같은 LOT 이 기간 안 여러 출하에 있으면 한 줄 — 기간 안 마지막 출하일.
    const candidates = `
      SELECT a.lot_id, MAX(s.shipped_at) AS at
        FROM logistics.shipment s
        JOIN logistics.shipment_request sr ON sr.shipment_request_id = s.shipment_request_id
        JOIN logistics.shipment_line sl ON sl.shipment_id = s.shipment_id
        JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
        JOIN trace.lot lt ON lt.lot_id = a.lot_id
        JOIN mdm.plant p ON p.plant_id = lt.plant_id
       WHERE lt.plant_id = $1::bigint AND sr.customer_id = $2::bigint AND ${SHIPMENT_DONE('s')}
         AND ${localPeriodSql('s.shipped_at', 'p.timezone_code', period, bind)}
       GROUP BY a.lot_id`;
    return this.conditionPage(candidates, 'at DESC, lot_id DESC', params, query, 'PRODUCT', 'SHIPPED');
  }

  /**
   * 제품 최근 — LOT 마다 「마지막 출하일, 없으면 마지막 생산 입고일」 하나(사용자 결정 2-나). 출하 완료 줄과
   * 출하 없는 LOT 의 생산 입고 줄을 따로 훑어 모은 뒤 그 날짜로 다시 정렬한다.
   */
  private async recentProducts(plantId: number): Promise<TraceLotPage> {
    const [shipped, received] = await Promise.all([
      this.recent(
        `FROM logistics.shipment s JOIN logistics.shipment_line sl ON sl.shipment_id = s.shipment_id
           JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
           JOIN trace.lot lt ON lt.lot_id = a.lot_id
          WHERE lt.plant_id = $1::bigint AND ${SHIPMENT_DONE('s')}`,
        { lot: 'a.lot_id', at: 's.shipped_at', tie: 'a.shipment_lot_allocation_id' }, [plantId], TRACE_LIST_SIZE,
      ),
      this.recent(
        `FROM logistics.goods_receipt gr JOIN logistics.goods_receipt_line gl ON gl.goods_receipt_id = gr.goods_receipt_id
           JOIN trace.lot lt ON lt.lot_id = gl.lot_id
          WHERE lt.plant_id = $1::bigint AND gr.receipt_type_code = 'PRODUCT' AND gr.status_code <> ${RECEIPT_CANCELLED}
            AND NOT EXISTS (SELECT 1 FROM logistics.shipment_lot_allocation xa
                              JOIN logistics.shipment_line xl ON xl.shipment_line_id = xa.shipment_line_id
                              JOIN logistics.shipment xs ON xs.shipment_id = xl.shipment_id
                             WHERE xa.lot_id = lt.lot_id AND ${SHIPMENT_DONE('xs')})`,
        { lot: 'gl.lot_id', at: 'gr.receipt_datetime', tie: 'gl.goods_receipt_line_id' }, [plantId], TRACE_LIST_SIZE,
      ),
    ]);
    // 입고 쪽은 출하 완료가 없는 LOT 만 훑었으니 겹치지 않는다.
    const kinds = new Map<bigint, SortDateKind>([...shipped.map((hit) => [hit.lotId, 'SHIPPED'] as const), ...received.map((hit) => [hit.lotId, 'RECEIVED'] as const)]);
    const top = sortHits([...shipped, ...received]).slice(0, TRACE_LIST_SIZE);
    const sort: SortOverride = new Map(top.map((hit) => [hit.lotId, { at: hit.at, kind: kinds.get(hit.lotId) as SortDateKind }]));
    const items = await traceLotRows(this.prisma, top.map((hit) => hit.lotId), 'PRODUCT', sort);
    return { mode: 'RECENT', items, page: { page: 1, size: TRACE_LIST_SIZE, total: items.length } };
  }

  private async recentPage(hits: Hit[], side: TraceSide, kind: SortDateKind): Promise<TraceLotPage> {
    const top = sortHits(hits).slice(0, TRACE_LIST_SIZE);
    const sort: SortOverride = new Map(top.map((hit) => [hit.lotId, { at: hit.at, kind }]));
    const items = await traceLotRows(this.prisma, top.map((hit) => hit.lotId), side, sort);
    return { mode: 'RECENT', items, page: { page: 1, size: TRACE_LIST_SIZE, total: items.length } };
  }

  /**
   * `from`(FROM … WHERE …, `$1` 부터 `params`)의 줄을 `at`·`tie` 역순으로 훑어 LOT 마다 처음 본 시각(= 마지막 시각)을 모은다.
   * 다음 묶음은 마지막 (at, tie) 뒤에서 이어 읽는다.
   */
  private async recent(from: string, columns: { lot: string; at: string; tie: string }, params: unknown[], need: number): Promise<Hit[]> {
    const found = new Map<bigint, Date>();
    let cursor: { at: Date; tie: bigint } | null = null;
    const n = params.length;
    for (;;) {
      const rows: { lot_id: bigint; at: Date; tie: bigint }[] = await this.prisma.$queryRawUnsafe(
        `SELECT ${columns.lot} AS lot_id, ${columns.at} AS at, ${columns.tie} AS tie ${from}
            AND ($${n + 1}::timestamptz IS NULL OR (${columns.at}, ${columns.tie}) < ($${n + 1}::timestamptz, $${n + 2}::bigint))
          ORDER BY ${columns.at} DESC, ${columns.tie} DESC LIMIT ${SCAN_BATCH}`,
        ...params, cursor?.at ?? null, cursor?.tie ?? null,
      );
      for (const row of rows) {
        if (!found.has(row.lot_id)) found.set(row.lot_id, row.at);
        if (found.size >= need) return [...found].map(([lotId, at]) => ({ lotId, at }));
      }
      if (rows.length < SCAN_BATCH) return [...found].map(([lotId, at]) => ({ lotId, at }));
      const last = rows[rows.length - 1];
      cursor = { at: last.at, tie: last.tie };
    }
  }

  /** 조건 결과 한 쪽 — `candidates` 는 (lot_id, at[, d]) 를 내는 SELECT. */
  private async conditionPage(
    candidates: string, orderBy: string, params: unknown[], query: TraceLotQuery, side: TraceSide, kind: SortDateKind,
  ): Promise<TraceLotPage> {
    const page = pageRequest({ page: query.page, size: query.size ?? TRACE_LIST_SIZE }, TRACE_LIST_SIZE);
    const n = params.length;
    const [rows, [count]] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ lot_id: bigint; at: Date }[]>(
        `SELECT lot_id, at FROM (${candidates}) c ORDER BY ${orderBy} LIMIT $${n + 1} OFFSET $${n + 2}`, ...params, page.take, page.skip,
      ),
      this.prisma.$queryRawUnsafe<{ total: bigint }[]>(`SELECT COUNT(*) AS total FROM (${candidates}) c`, ...params),
    ]);
    const sort: SortOverride = new Map(rows.map((row) => [row.lot_id, { at: row.at, kind }]));
    const items = await traceLotRows(this.prisma, rows.map((row) => row.lot_id), side, sort);
    return { mode: 'CONDITION', items, page: { page: page.page, size: page.size, total: Number(count.total) } };
  }

  /** 조건 칸은 셋 다 있거나 셋 다 없어야 한다. 기간은 역전·366일 초과를 막는다(`localPeriod`). */
  private async period(query: TraceLotQuery, label: string): Promise<LocalPeriod & { to: string } | undefined> {
    const given = { partnerId: query.partnerId, dateFrom: query.dateFrom, dateTo: query.dateTo };
    const missing = Object.entries(given).filter(([, value]) => value === undefined).map(([name]) => name);
    if (missing.length === 3) return undefined;
    if (missing.length > 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, missing.map((name) => field(name, ERROR_CODE.REQUIRED,
        `상대(partnerId)·${label} 시작(dateFrom)·종료(dateTo)는 함께 넣어야 합니다. ${name} 을 넣어 다시 찾으세요.`)));
    }
    const today = await plantToday(this.prisma, query.plantId);
    const period = localPeriod(query.dateFrom, query.dateTo, { from: 'dateFrom', to: 'dateTo', label }, today);
    return { from: period.from, to: period.to as string };
  }
}

function sortHits(hits: Hit[]): Hit[] {
  return [...hits].sort((a, b) => b.at.getTime() - a.at.getTime() || (b.lotId > a.lotId ? 1 : b.lotId < a.lotId ? -1 : 0));
}
