import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { filter } from '../../common/master';
import { PageRequest, PagedResponse, pageRequest } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProductionOrderChangeFieldRow,
  ProductionOrderLastChange,
  ProductionOrderRow,
  ProductionOrderView,
  changedFieldsOf,
  productionOrderView,
} from './production-order-view';

interface DerivedRow {
  expanded: number;
  planned: number;
  acknowledgedAt: Date | null;
  acknowledgedBy: bigint | null;
  acknowledgeDecisionCode: string | null;
}

/** 조회 2건(PR ①) — `:acknowledge`·`:resync` 는 PR ④ 몫이다. */
export interface ProductionOrderListQuery {
  statusCode?: string;
  unacknowledgedOnly?: boolean;
  businessUnitId?: number;
  plantId?: number;
  itemId?: number;
  dueDateFrom?: string;
  dueDateTo?: string;
  q?: string;
  includeChildren?: boolean;
  withLastChange?: boolean;
  page?: number;
  size?: number;
}
export interface ProductionOrderDetailQuery {
  withLastChange?: boolean;
}

/** 정렬은 계약에 축이 없다 — 서버가 고정한다(§1-2). */
const ORDER_BY: Prisma.production_orderOrderByWithRelationInput[] = [
  { due_date: { sort: 'asc', nulls: 'last' } },
  { production_order_id: 'asc' },
];

@Injectable()
export class ProductionOrderService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ProductionOrderListQuery): Promise<PagedResponse<ProductionOrderView>> {
    const page = pageRequest(query);
    const base = buildWhere(query);
    const where = query.unacknowledgedOnly === true ? await this.excludeAcknowledged(base) : base;
    const withLastChange = query.withLastChange === true;
    if (query.includeChildren === true) return this.listWithChildren(where, page, withLastChange);

    const [rows, total] = await Promise.all([
      this.prisma.production_order.findMany({ where, orderBy: ORDER_BY, skip: page.skip, take: page.take }),
      this.prisma.production_order.count({ where }),
    ]);
    return { items: await this.viewsOf(rows, withLastChange), page: { page: page.page, size: page.size, total } };
  }

  /** 없으면 404 다(계약 선언). */
  async detail(id: number, query: ProductionOrderDetailQuery): Promise<{ view: ProductionOrderView; versionNo: number }> {
    const row = await this.prisma.production_order.findUnique({ where: { production_order_id: id } });
    if (!row) throw new NotFoundException('없는 생산오더입니다.');
    const [view] = await this.viewsOf([row], query.withLastChange === true);
    return { view, versionNo: row.version_no };
  }

  /** §5-3 — 루트로 total·페이지를 세고 재귀 CTE 로 하위를 붙인다. 하위엔 필터를 다시 안 건다. */
  private async listWithChildren(
    where: Prisma.production_orderWhereInput,
    page: PageRequest,
    withLastChange: boolean,
  ): Promise<PagedResponse<ProductionOrderView>> {
    const rootWhere = { AND: [where, { parent_production_order_id: null }] };
    const [total, rootRows] = await Promise.all([
      this.prisma.production_order.count({ where: rootWhere }),
      this.prisma.production_order.findMany({
        where: rootWhere,
        orderBy: ORDER_BY,
        skip: page.skip,
        take: page.take,
        select: { production_order_id: true },
      }),
    ]);
    const rootIds = rootRows.map((r) => r.production_order_id);
    const meta = { page: page.page, size: page.size, total };
    if (rootIds.length === 0) return { items: [], page: meta };

    const descendants = await this.prisma.$queryRaw<{ production_order_id: bigint }[]>(Prisma.sql`
      WITH RECURSIVE t AS (
        SELECT production_order_id, parent_production_order_id, bom_level FROM planning.production_order
         WHERE production_order_id IN (${Prisma.join(rootIds)})
        UNION ALL
        SELECT c.production_order_id, c.parent_production_order_id, c.bom_level FROM planning.production_order c
          JOIN t ON c.parent_production_order_id = t.production_order_id)
      SELECT production_order_id FROM t`);
    const rows = await this.prisma.production_order.findMany({
      where: { production_order_id: { in: descendants.map((d) => d.production_order_id) } },
      orderBy: [{ bom_level: 'asc' }, { production_order_id: 'asc' }],
    });
    return { items: await this.viewsOf(rows, withLastChange), page: meta };
  }

  /** §5-2 — 「확인됨」 집합을 `notIn` 으로 뺀다. 빈 집합이면 조건을 안 건다. */
  private async excludeAcknowledged(base: Prisma.production_orderWhereInput): Promise<Prisma.production_orderWhereInput> {
    const rows = await this.prisma.$queryRaw<{ production_order_id: bigint }[]>(Prisma.sql`
      SELECT DISTINCT a.production_order_id FROM production.production_order_acknowledgement a
        JOIN planning.production_order o USING (production_order_id)
       WHERE a.acknowledged_at IS NOT NULL
         AND (o.last_change_received_at IS NULL OR a.acknowledged_at >= o.last_change_received_at)`);
    const ids = rows.map((r) => r.production_order_id);
    return ids.length === 0 ? base : { AND: [base, { production_order_id: { notIn: ids } }] };
  }

  /** 페이지 파생 — 집계 2칸 + 확인 3칸을 한 쿼리로, (요청 시) 변경 이력을 더한다. 행마다 돌지 않는다. */
  private async viewsOf(rows: ProductionOrderRow[], withLastChange: boolean): Promise<ProductionOrderView[]> {
    const ids = rows.map((r) => r.production_order_id);
    const [derived, changes] = await Promise.all([
      this.derivedOf(ids),
      withLastChange ? this.lastChangesOf(rows) : Promise.resolve(new Map<bigint, ProductionOrderLastChange>()),
    ]);
    return rows.map((row) => {
      const d = derived.get(row.production_order_id);
      return productionOrderView(row, {
        expandedWorkOrderCount: d?.expanded ?? 0,
        plannedWorkOrderCount: d?.planned ?? 0,
        acknowledgement: d?.acknowledgedAt === null || d?.acknowledgedAt === undefined ? undefined : { acknowledgedAt: d.acknowledgedAt, acknowledgedBy: d.acknowledgedBy, acknowledgeDecisionCode: d.acknowledgeDecisionCode },
        lastChange: changes.get(row.production_order_id),
      });
    });
  }

  /** §5-1(집계 2칸) + §2-3(확인 3칸, `acknowledged_at` 최대 1행)을 한 쿼리로 낸다 — 행마다 돌지 않는다. */
  private async derivedOf(ids: bigint[]): Promise<Map<bigint, DerivedRow>> {
    const map = new Map<bigint, DerivedRow>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.$queryRaw<({ production_order_id: bigint } & DerivedRow)[]>(Prisma.sql`
      SELECT o.production_order_id, COALESCE(ewo.n, 0)::int AS expanded, COALESCE(pwo.n, 0)::int AS planned,
             ack.acknowledged_at, ack.acknowledged_by, ack.acknowledge_decision_code
        FROM planning.production_order o
        LEFT JOIN (SELECT p.production_order_id, count(*) n FROM production.work_order w
                     JOIN planning.production_plan p ON p.production_plan_id = w.production_plan_id GROUP BY 1) ewo
          ON ewo.production_order_id = o.production_order_id
        LEFT JOIN (SELECT p.production_order_id, sum(oc.cnt) n FROM planning.production_plan p
                     LEFT JOIN (SELECT routing_id, count(*) cnt FROM planning.routing_operation GROUP BY 1) oc
                       ON oc.routing_id = p.routing_id GROUP BY 1) pwo
          ON pwo.production_order_id = o.production_order_id
        LEFT JOIN LATERAL (SELECT acknowledged_at, acknowledged_by, acknowledge_decision_code
                              FROM production.production_order_acknowledgement
                             WHERE production_order_id = o.production_order_id AND acknowledged_at IS NOT NULL
                             ORDER BY acknowledged_at DESC LIMIT 1) ack ON true
       WHERE o.production_order_id IN (${Prisma.join(ids)})`);
    for (const row of rows) map.set(row.production_order_id, row);
    return map;
  }

  /** §5-4 — `withLastChange=true` 일 때만. `last_change_received_at` 이 널이면 지도에 없다(키 생략). */
  private async lastChangesOf(rows: ProductionOrderRow[]): Promise<Map<bigint, ProductionOrderLastChange>> {
    const map = new Map<bigint, ProductionOrderLastChange>();
    const withChange = rows.filter((r) => r.last_change_received_at !== null);
    if (withChange.length === 0) return map;

    const fields = await this.prisma.production_order_change_field.findMany({
      where: { production_order_id: { in: withChange.map((r) => r.production_order_id) } },
    });
    const byOrder = new Map<bigint, ProductionOrderChangeFieldRow[]>();
    for (const f of fields) byOrder.set(f.production_order_id, [...(byOrder.get(f.production_order_id) ?? []), f]);

    const codes = new Set<string>();
    for (const row of withChange) {
      for (const f of byOrder.get(row.production_order_id) ?? []) {
        if (f.field_code !== 'STATUS_CODE') continue;
        codes.add(row.status_code);
        if (f.before_status_code !== null) codes.add(f.before_status_code);
      }
    }
    // 상태 표시명 — `mdm.code_value` 를 페이지 단위 1쿼리로. 못 찾으면 코드 그대로.
    const nameRows =
      codes.size === 0
        ? []
        : await this.prisma.code_value.findMany({
            where: { code: { in: [...codes] }, code_group: { group_code: 'PRODUCTION_ORDER_STATUS' } },
            select: { code: true, code_name: true },
          });
    const names = new Map(nameRows.map((v) => [v.code, v.code_name]));
    const statusName = (code: string): string => names.get(code) ?? code;

    for (const row of withChange) {
      map.set(row.production_order_id, {
        receivedAt: (row.last_change_received_at as Date).toISOString(),
        changedFields: changedFieldsOf(byOrder.get(row.production_order_id) ?? [], row.status_code, row.order_qty, row.due_date, statusName),
      });
    }
    return map;
  }
}

function buildWhere(query: ProductionOrderListQuery): Prisma.production_orderWhereInput {
  return {
    ...(query.statusCode === undefined ? {} : { status_code: query.statusCode }),
    ...filter('business_unit_id', query.businessUnitId),
    ...filter('plant_id', query.plantId),
    ...filter('item_id', query.itemId),
    ...dueDateWhere(query.dueDateFrom, query.dueDateTo),
    // 「P/O 번호 검색」(계약) — 부분일치.
    ...(query.q === undefined ? {} : { production_order_no: { contains: query.q, mode: Prisma.QueryMode.insensitive } }),
  };
}

/** `due_date` 는 `@db.Date` 다 — 타임존 캐스팅 없이 그대로 비교한다(CLAUDE.md). */
function dueDateWhere(from?: string, to?: string): Prisma.production_orderWhereInput {
  if (from === undefined && to === undefined) return {};
  return {
    due_date: {
      ...(from === undefined ? {} : { gte: new Date(`${from}T00:00:00.000Z`) }),
      ...(to === undefined ? {} : { lte: new Date(`${to}T00:00:00.000Z`) }),
    },
  };
}
