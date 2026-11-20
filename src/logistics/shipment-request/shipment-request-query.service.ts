import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CANCEL_REQUEST_PENDING_SQL, ERP_SEND_STATUS_SQL, ErpSendStatus } from '../shipment/shipment-history';
import { oqcLotDecisionsOf } from '../../quality/inspection/oqc-lot-result';
import { OqcInspectionRow, skippedOqcRows } from './shipment-inspection';
import {
  AccountScope,
  TerminalShipmentScope,
  requestInAccountScopeSql,
  requestInBusinessUnitSql,
  requestPickableByTerminalSql,
} from './shipment-request-scope';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';
import {
  FROM_SQL,
  INSPECTION_REQUIRED_SQL,
  PICKING_COMPLETE_SQL,
  REQUEST_ERP_SEND_STATUS_SQL,
  ShipmentRequestFilters,
  ShipmentRequestQuery,
  orderBySql,
  whereSql,
} from './shipment-request-query.sql';
import {
  CompletionFacts,
  ShipmentLotsByLine,
  ShipmentPicksByLine,
  ShipmentRequestDisplayFacts,
  ShipmentRequestShipmentView,
  ShipmentRequestView,
  shipmentRequestView,
} from './shipment-request-view';

/** 조회 클라이언트 — 서비스 자신 또는 트랜잭션. */
type Db = Prisma.TransactionClient;

/** 03 품질에서 이 축이 세는 것 — 출하검사뿐이다(§1-5). 좁히기용이고 판정은 ③a 가 다시 한다. */
const OQC = 'OQC';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

/** 계약 `ShipmentRequestSummary` — required **8칸**(일곱 + `asOf`). */
export interface ShipmentRequestSummaryView {
  requestCount: number;
  requestedQtyTotal: number;
  allocatedQtyTotal: number;
  shippedQtyTotal: number;
  unallocatedQtyTotal: number;
  pendingInspectionCount: number;
  incompletePickingCount: number;
  asOf: string;
}

interface SummaryRow {
  request_count: number;
  requested_qty_total: Prisma.Decimal;
  allocated_qty_total: Prisma.Decimal;
  shipped_qty_total: Prisma.Decimal;
  unallocated_qty_total: Prisma.Decimal;
  incomplete_picking_count: number;
}

/**
 * 출하작업지시 조회 3건 — 목록(`W-04-02` §3) · 요약(§4-B) · 단건(`M-04-01` 피킹).
 * ⛔ 셋 다 멱등·If-Match·ETag·403 이 0건이다(계약 실측 · §1-1) — 200 과 (단건만) 404 뿐이다.
 */
@Injectable()
export class ShipmentRequestQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⭐ **`lines` 를 싣는다**(R-9) — `W-04-02` 7열 중 «유일한 수량 열»과 `W-04-05` 의 「배정 500」이
   * 라인 없이는 못 선다. `ShipmentRequest` 에 합계 칸이 0개다.
   */
  async list(
    query: ShipmentRequestQuery,
    terminal?: ShipmentRequestTerminalFilter,
    scopes?: readonly AccountScope[],
  ): Promise<PagedResponse<ShipmentRequestView> & { erpSendStatusCounts: Record<string, number> }> {
    const page = pageRequest(query);
    const where = shipmentRequestWhereSql(query, terminal, scopes);
    // ERP 송신 칩 건수(W-04-02 · 피처 012 FR-018) — 송신 상태 조건만 빼고 같은 조건으로 센다(010 출하 목록과 같은 방식).
    const facetWhere = shipmentRequestWhereSql({ ...query, erpSendStatus: undefined }, terminal, scopes);
    const order = orderBySql(query.sort);
    // ⛔ `count(*) OVER ()` 로 세지 마라 — 범위 «밖» 쪽은 행이 0개라 `total` 이 0 으로 접히고,
    //    화면 페이저가 사라져 1쪽으로 돌아올 길이 없어진다(리뷰 실측 · e2e L-40b).
    //    `total` 은 쪽이 아니라 필터 «전체» 기준이다 — 선례 3벌이 같은 모양이다
    //    (`concession-query.ts:87`·`disposition-query.ts:120`·`lot-hold-event-query.ts:128`).
    // `LIMIT`·`OFFSET` 은 `pageRequest` 가 이미 정수로 자른 값이라 그대로 편다(주입 자리 없음).
    const [rows, counted, facets] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ shipment_request_id: bigint }[]>(
        `SELECT sr.shipment_request_id
           FROM ${FROM_SQL}
          WHERE ${where.sql}
          ORDER BY ${order}
          LIMIT ${page.take} OFFSET ${page.skip}`,
        ...where.params,
      ),
      this.prisma.$queryRawUnsafe<{ total: number }[]>(
        `SELECT count(*)::int AS total FROM ${FROM_SQL} WHERE ${where.sql}`,
        ...where.params,
      ),
      this.prisma.$queryRawUnsafe<{ status: string; count: number }[]>(
        `SELECT ${REQUEST_ERP_SEND_STATUS_SQL} AS status, count(*)::int AS count FROM ${FROM_SQL} WHERE ${facetWhere.sql} GROUP BY 1`,
        ...facetWhere.params,
      ),
    ]);
    const views = await this.views(rows.map((row) => row.shipment_request_id));
    return {
      ...pagedResponse(views, counted[0].total, page),
      erpSendStatusCounts: Object.fromEntries(facets.map((row) => [row.status, row.count])),
    };
  }

  /**
   * `W-04-02` 요약 — 모집단이 **필터 전체**다(목록 쪽이 아니다).
   * ⛔ `page`·`size`·`sort` 를 읽지 않는다 — 계약이 요약에서 그 셋을 뺐다(e2e L-50).
   * ⭐ `pendingInspectionCount` **만** SQL 이 아니라 TS 롤업이다(계획서 §5-1 표는 SQL 이라 적었다) —
   *   검사 판정을 SQL 로 다시 적으면 ③a `lineInspectionStatus()` 와 **세 벌**이 되고 R-10 이 금한
   *   「축이 갈리는」 자리를 스스로 만든다.
   * ⚠⚠ **대가로 그 한 칸이 모집단을 적재한다.** `shipDateTo` 는 «선택»이라 범위가 `[from, ∞)` 로
   *   반쯤 열려 있다(`?shipDateFrom=1900-01-01` 한 방이면 표 전체다 · 리뷰 실측) ⇒
   *   `INSPECTION_REQUIRED_SQL` 로 **무손실** 좁히기를 건다(e2e L-48b 가 무손실을 확인한다).
   *   ⛔ 검사 필수 건이 많으면 여전히 선형이다 — 상한은 §11 인계로 남긴다.
   */
  async summary(query: ShipmentRequestFilters, scopes?: readonly AccountScope[]): Promise<ShipmentRequestSummaryView> {
    const where = shipmentRequestWhereSql(query, undefined, scopes);
    // ⛔ `coalesce` 를 벗기지 마라 — 0건이면 `sum()` 이 NULL 인데 8칸이 전건 required 다(§6-3 ⑷).
    const [totals] = await this.prisma.$queryRawUnsafe<SummaryRow[]>(
      `SELECT count(*)::int AS request_count,
              coalesce(sum(t.requested_qty), 0) AS requested_qty_total,
              coalesce(sum(t.allocated_qty), 0) AS allocated_qty_total,
              coalesce(sum(t.shipped_qty), 0) AS shipped_qty_total,
              coalesce(sum(t.requested_qty - t.allocated_qty), 0) AS unallocated_qty_total,
              count(*) FILTER (WHERE NOT ${PICKING_COMPLETE_SQL})::int AS incomplete_picking_count
         FROM ${FROM_SQL}
        WHERE ${where.sql}`,
      ...where.params,
    );
    const ids = await this.prisma.$queryRawUnsafe<{ shipment_request_id: bigint }[]>(
      `SELECT sr.shipment_request_id
         FROM ${FROM_SQL}
        WHERE ${where.sql}
          AND ${INSPECTION_REQUIRED_SQL}`,
      ...where.params,
    );
    const views = await this.views(ids.map((row) => row.shipment_request_id));
    return {
      requestCount: totals.request_count,
      // ⛔ `Number(...)` 로 접지 마라 — `Number(null)` 이 **0** 이라 위 `coalesce` 를 지워도
      //    응답이 안 바뀐다(변이 점검 1회차에서 초록이었다). `Decimal` 로 받아 널이면 터지게 둔다.
      requestedQtyTotal: totals.requested_qty_total.toNumber(),
      allocatedQtyTotal: totals.allocated_qty_total.toNumber(),
      shippedQtyTotal: totals.shipped_qty_total.toNumber(),
      unallocatedQtyTotal: totals.unallocated_qty_total.toNumber(),
      pendingInspectionCount: views.filter((view) => view.shippingInspectionStatusCode === 'PENDING')
        .length,
      incompletePickingCount: totals.incomplete_picking_count,
      asOf: new Date().toISOString(),
    };
  }

  /** 단건. 계정 범위를 주면 그 밖의 지시서는 「없다」(404 — 계약이 403 을 선언하지 않았다 · 피처 012 D-12). */
  async get(shipmentRequestId: number, scopes?: readonly AccountScope[]): Promise<ShipmentRequestView> {
    if (scopes !== undefined && !(await this.inAccountScope(BigInt(shipmentRequestId), scopes))) {
      throw new NotFoundException('없는 출하작업지시입니다.');
    }
    const [view] = await this.views([BigInt(shipmentRequestId)]);
    if (view === undefined) throw new NotFoundException('없는 출하작업지시입니다.');
    return view;
  }

  /**
   * 헤더 id 집합 → 뷰. **세 질의**로 끝낸다 — 헤더+라인 1 · 예약 1 · 검사 1. ⛔ 건마다·라인마다
   * 부르면 쪽 크기만큼 N+1 이다(e2e L-42 가 예약 조회 «횟수»를 센다). ⭐ 단건도 이 길을 쓴다.
   */
  /** 트랜잭션 안에서 같은 뷰를 읽는다 — 출하 완료 관문이 잠근 뒤의 값으로 판정한다(피처 010). */
  async getWithin(db: Db, shipmentRequestId: bigint): Promise<ShipmentRequestView> {
    const [view] = await this.views([shipmentRequestId], db);
    if (view === undefined) throw new NotFoundException('없는 출하작업지시입니다.');
    return view;
  }

  private async inAccountScope(id: bigint, scopes: readonly AccountScope[]): Promise<boolean> {
    const params: unknown[] = [id];
    const scope = requestInAccountScopeSql('sr', scopes, (value) => `$${params.push(value)}`);
    if (scope === null) return true;
    const rows = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM logistics.shipment_request sr WHERE sr.shipment_request_id = $1::bigint AND ${scope}`, ...params,
    );
    return rows.length > 0;
  }

  private async views(ids: bigint[], db: Db = this.prisma): Promise<ShipmentRequestView[]> {
    if (ids.length === 0) return [];
    const rows = await db.shipment_request.findMany({
      where: { shipment_request_id: { in: ids } },
      include: { shipment_request_line: { orderBy: { line_no: 'asc' } } },
    });
    const lines = rows.flatMap((row) => row.shipment_request_line);
    const picks = await this.picksByLine(lines.map((line) => line.shipment_request_line_id), db);
    // ⛔ 맵 «전체»를 훑지 않는다 — 이 건들의 라인에서 뽑는다. 앞 질의가 느슨해지면 섞여 든 남의
    //    LOT 이 그대로 둘째 질의의 `IN` 목록으로 새 나간다(응답은 ③a 가 다시 걸러 안 바뀐다).
    const lotIds = lines
      .flatMap((line) => picks.get(String(line.shipment_request_line_id)) ?? [])
      .flatMap((pick) => (pick.lot_id === null ? [] : [pick.lot_id]));
    const inspections = await this.oqcResults(ids, lotIds, db);
    const [lots, oqcStatuses, facts, display, shipments] = await Promise.all([
      this.lotsByLine(lines.map((line) => line.shipment_request_line_id), db),
      oqcLotDecisionsOf(db, ids),
      completionFactsOf(db, ids, lines.flatMap((line) => (line.sales_order_line_id === null ? [] : [line.sales_order_line_id]))),
      displayFactsOf(db, rows),
      shipmentsOf(db, ids),
    ]);
    const byId = new Map(rows.map((row) => [String(row.shipment_request_id), row]));
    // ⛔ Prisma 의 `in` 은 순서를 보장하지 않는다 — SQL 이 정한 정렬을 여기서 되살린다(L-37·L-38).
    return ids.flatMap((id) => {
      const row = byId.get(String(id));
      return row === undefined ? [] : [shipmentRequestView(row, picks, inspections, lots, oqcStatuses, facts, { ...display, shipments })];
    });
  }

  /** 피킹 LOT 행(피처 010) — 라인 id 를 모아 한 방으로 읽는다. 교체된 행도 이력으로 싣는다. */
  private async lotsByLine(lineIds: bigint[], db: Db): Promise<ShipmentLotsByLine> {
    const rows = await db.shipment_request_lot.findMany({
      where: { shipment_request_line_id: { in: lineIds } },
      include: {
        lot: { select: { lot_no: true, item_id: true } },
        picked_worker: { select: { worker_no: true, worker_name: true } },
        replaced_worker: { select: { worker_no: true, worker_name: true } },
        replace_inspection_result: { select: { inspection_result_no: true, inspection_round: true, inspected_at: true, overall_judgment_code: true } },
        replace_nonconformance: { select: { nonconformance_no: true } },
      },
      orderBy: { shipment_request_lot_id: 'asc' },
    });
    const grouped: ShipmentLotsByLine = new Map();
    for (const row of rows) {
      const key = String(row.shipment_request_line_id);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  /**
   * ⭐ 라인 id 를 **모아 한 방**으로 읽는다 — 라인마다 부르면 N+1 이다.
   * ⛔ 축은 `(source_document_type_code, source_document_id)` **둘 다**다. 유형을 빼면 같은 id 를 쓰는
   *    «자재» 예약이 섞여 들어와 수량이 부풀고 남의 LOT 이 `picks[]` 에 뜬다(#409 인계 · §11 ②).
   *    `ix_reservation_source (type, id, status)` 가 그대로 탄다(§2-7).
   * ⛔ `status_code` 로 좁히지 않는다 — 계약이 「누적 피킹 수량」이라 적었고 되돌림은 **수량 축**
   *    (`released_qty`)이 감당하기로 한 자리다(§5-1 · R-14). ⚠ 그 되돌림이 **오늘은 일어나지
   *    않는다** — `released_qty` 를 쓰는 코드가 저장소에 0개이고 ⓒ안에서 `consumed = reserved` 라
   *    `ck_reservation_qty` 가 올리는 것 자체를 막는다(**통보 241** · §11 ①). 그래서 지금은 상태와
   *    무관하게 예약 행 전건이 `pickedQty` 에 남는다 — I-23 이 되돌림 칸을 정할 때 함께 푼다.
   */
  private async picksByLine(lineIds: bigint[], db: Db): Promise<ShipmentPicksByLine> {
    const rows = await db.inventory_reservation.findMany({
      where: {
        source_document_type_code: SHIPMENT_REQUEST_LINE,
        source_document_id: { in: lineIds },
      },
      include: {
        lot: { select: { lot_no: true } },
        warehouse: { select: { warehouse_code: true, warehouse_name: true } },
        location: { select: { location_code: true, system_role_code: true } },
      },
      orderBy: { inventory_reservation_id: 'asc' },
    });
    const grouped: ShipmentPicksByLine = new Map();
    for (const row of rows) {
      const key = String(row.source_document_id);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return grouped;
  }

  /**
   * 검사 결과 모집단을 **느슨하게** 당겨 온다 — `CONFIRMED`·최대 회차·대상 판정은
   * `shipment-inspection.ts` 가 다시 판다(둘째 그물). 여기서는 표를 안 훑도록 좁히기만 한다.
   * ⭐ `lot_id` 는 `target_type_code` 와 **병존**한다(R-5) — LOT 축을 `target_id` 하나로 좁히면
   *   「LOT 대상인데 `lot_id` 가 다른 LOT 을 가리키는」 의뢰가 통째로 빠진다.
   */
  private async oqcResults(
    shipmentRequestIds: bigint[],
    lotIds: bigint[],
    db: Db,
  ): Promise<OqcInspectionRow[]> {
    const targets: Prisma.inspection_requestWhereInput[] = [
      { lot_id: { in: lotIds } },
      { target_type_code: LOT, target_id: { in: lotIds } },
      { target_type_code: SHIPMENT_REQUEST, target_id: { in: shipmentRequestIds } },
    ];
    const rows = await db.inspection_result.findMany({
      where: { inspection_request: { inspection_type_code: OQC, OR: targets } },
      include: { inspection_request: true },
    });
    // 생략된 의뢰는 결과가 없다 — 같은 축으로 따로 읽어 «합격»으로 더한다(omf-all-around#119 · 장부 P-83).
    const skipped = await db.inspection_request.findMany({
      where: { inspection_type_code: OQC, status_code: 'SKIPPED', OR: targets },
    });
    return [...rows.map((row) => ({
      inspectionRequestId: row.inspection_request_id,
      inspectionTypeCode: row.inspection_request.inspection_type_code,
      targetTypeCode: row.inspection_request.target_type_code,
      targetId: row.inspection_request.target_id,
      lotId: row.inspection_request.lot_id,
      statusCode: row.status_code,
      inspectionRound: row.inspection_round,
      overallJudgmentCode: row.overall_judgment_code,
    })), ...skippedOqcRows(skipped)];
  }
}

/** 출하 완료 관문의 바깥 사실 — POP 완료 출하(취소 아님)와 취소된 수주 라인(피처 010). */
export async function completionFactsOf(
  prisma: Db,
  shipmentRequestIds: bigint[],
  salesOrderLineIds: bigint[],
): Promise<CompletionFacts> {
  const [shipments, cancelled] = await Promise.all([
    prisma.shipment.findMany({
      where: { shipment_request_id: { in: shipmentRequestIds }, completed_terminal_id: { not: null }, status_code: { not: 'CANCELLED' } },
      select: {
        shipment_id: true, shipment_no: true, shipment_request_id: true, confirmed_at: true, shipped_at: true,
        completed_terminal: { select: { terminal_id: true, terminal_code: true } },
        completed_worker: { select: { worker_id: true, worker_no: true, worker_name: true } },
      },
    }),
    salesOrderLineIds.length === 0 ? [] : prisma.sales_order_line.findMany({
      where: { sales_order_line_id: { in: salesOrderLineIds }, cancelled_at: { not: null } }, select: { sales_order_line_id: true },
    }),
  ]);
  return {
    completed: new Map(shipments.map((row) => [String(row.shipment_request_id), {
      shipmentId: Number(row.shipment_id), shipmentNo: row.shipment_no,
      completedAt: (row.confirmed_at ?? row.shipped_at ?? new Date(0)).toISOString(),
      completedTerminal: row.completed_terminal === null ? null
        : { terminalId: Number(row.completed_terminal.terminal_id), terminalCode: row.completed_terminal.terminal_code },
      completedWorker: row.completed_worker === null ? null
        : { workerId: Number(row.completed_worker.worker_id), workerNo: row.completed_worker.worker_no, workerName: row.completed_worker.worker_name },
    }])),
    cancelledSalesOrderLines: new Set(cancelled.map((row) => String(row.sales_order_line_id))),
  };
}

/**
 * 지시서마다 출하(취소 포함, 최신순) — W-04-02 상세 「출하」 칸·ERP 송신 칩(피처 012 FR-019·R-9). 송신 상태·취소 상신 중은
 * 010 출하 내역과 같은 SQL 한 벌이다. 쪽 안 지시서 전체를 한 방으로 읽는다.
 */
async function shipmentsOf(db: Db, ids: bigint[]): Promise<Map<string, ShipmentRequestShipmentView[]>> {
  const rows = await db.$queryRawUnsafe<{
    shipment_request_id: bigint; shipment_id: bigint; shipment_no: string; status_code: string; erp_send_status: ErpSendStatus; cancel_request_pending: boolean;
  }[]>(
    `SELECT s.shipment_request_id, s.shipment_id, s.shipment_no, s.status_code,
            ${ERP_SEND_STATUS_SQL} AS erp_send_status, ${CANCEL_REQUEST_PENDING_SQL} AS cancel_request_pending
       FROM logistics.shipment s
      WHERE s.shipment_request_id = ANY($1::bigint[])
      ORDER BY s.shipment_id DESC`,
    ids,
  );
  const grouped = new Map<string, ShipmentRequestShipmentView[]>();
  for (const row of rows) {
    const key = String(row.shipment_request_id);
    grouped.set(key, [...(grouped.get(key) ?? []), {
      shipmentId: Number(row.shipment_id), shipmentNo: row.shipment_no, statusCode: row.status_code,
      erpSendStatus: row.erp_send_status, cancelRequestPending: row.cancel_request_pending,
    }]);
  }
  return grouped;
}

/**
 * 표시용 이름·번호(시안 차이 보완) — 수주 번호, 수주 라인(수주·출하 수량·취소), 품목 코드·이름, 단위 코드.
 * 쪽 안의 지시서 전체를 표마다 한 방으로 읽는다(N+1 없음).
 */
async function displayFactsOf(
  db: Db,
  rows: {
    sales_order_id: bigint | null; customer_id: bigint; ship_to_partner_id: bigint; business_unit_id: bigint | null;
    shipment_request_line: { sales_order_line_id: bigint | null; item_id: bigint; uom_id: bigint; warehouse_id: bigint | null }[];
  }[],
): Promise<ShipmentRequestDisplayFacts> {
  const lines = rows.flatMap((row) => row.shipment_request_line);
  const unique = (values: bigint[]) => [...new Set(values.map(String))].map(BigInt);
  const orderIds = unique(rows.flatMap((row) => (row.sales_order_id === null ? [] : [row.sales_order_id])));
  const orderLineIds = unique(lines.flatMap((line) => (line.sales_order_line_id === null ? [] : [line.sales_order_line_id])));
  const partnerIds = unique(rows.flatMap((row) => [row.customer_id, row.ship_to_partner_id]));
  const unitIds = unique(rows.flatMap((row) => (row.business_unit_id === null ? [] : [row.business_unit_id])));
  const warehouseIds = unique(lines.flatMap((line) => (line.warehouse_id === null ? [] : [line.warehouse_id])));
  const [units, warehouses] = await Promise.all([
    unitIds.length === 0 ? [] : db.business_unit.findMany({
      where: { business_unit_id: { in: unitIds } }, select: { business_unit_id: true, business_unit_code: true, business_unit_name: true },
    }),
    warehouseIds.length === 0 ? [] : db.warehouse.findMany({
      where: { warehouse_id: { in: warehouseIds } },
      select: { warehouse_id: true, warehouse_code: true, warehouse_name: true, plant: { select: { plant_id: true, plant_name: true } } },
    }),
  ]);
  const [orders, orderLines, items, uoms, partners] = await Promise.all([
    orderIds.length === 0 ? [] : db.sales_order.findMany({ where: { sales_order_id: { in: orderIds } }, select: { sales_order_id: true, sales_order_no: true } }),
    orderLineIds.length === 0 ? [] : db.sales_order_line.findMany({
      where: { sales_order_line_id: { in: orderLineIds } },
      select: { sales_order_line_id: true, line_no: true, ordered_qty: true, shipped_qty: true, cancelled_at: true, sales_order: { select: { sales_order_no: true } } },
    }),
    lines.length === 0 ? [] : db.item.findMany({ where: { item_id: { in: unique(lines.map((line) => line.item_id)) } }, select: { item_id: true, item_code: true, item_name: true } }),
    lines.length === 0 ? [] : db.uom.findMany({ where: { uom_id: { in: unique(lines.map((line) => line.uom_id)) } }, select: { uom_id: true, uom_code: true } }),
    partnerIds.length === 0 ? [] : db.partner.findMany({ where: { partner_id: { in: partnerIds } }, select: { partner_id: true, partner_code: true, partner_name: true } }),
  ]);
  return {
    salesOrderNos: new Map(orders.map((row) => [String(row.sales_order_id), row.sales_order_no])),
    salesOrderLines: new Map(orderLines.map((row) => [String(row.sales_order_line_id), {
      salesOrderNo: row.sales_order.sales_order_no, lineNo: row.line_no,
      orderedQty: Number(row.ordered_qty), shippedQty: Number(row.shipped_qty), cancelled: row.cancelled_at !== null,
    }])),
    items: new Map(items.map((row) => [String(row.item_id), { itemCode: row.item_code, itemName: row.item_name }])),
    uomCodes: new Map(uoms.map((row) => [String(row.uom_id), row.uom_code])),
    partners: new Map(partners.map((row) => [String(row.partner_id), {
      partnerId: Number(row.partner_id), partnerCode: row.partner_code, partnerName: row.partner_name,
    }])),
    businessUnits: new Map(units.map((row) => [String(row.business_unit_id), {
      businessUnitId: Number(row.business_unit_id), businessUnitCode: row.business_unit_code, businessUnitName: row.business_unit_name,
    }])),
    warehouses: new Map(warehouses.map((row) => [String(row.warehouse_id), {
      warehouseId: Number(row.warehouse_id), warehouseCode: row.warehouse_code, warehouseName: row.warehouse_name,
      plantId: Number(row.plant.plant_id), plantName: row.plant.plant_name,
    }])),
  };
}

/**
 * 단말이 부른 지시서 목록의 범위(피처 012 R-2) — PDA 피킹은 줄 범위(`LINE`: 단말 공장·창고의 줄이 하나라도),
 * POP 찾기·완료는 사업부 범위(`BUSINESS_UNIT`). 규칙은 `shipment-request-scope.ts` 한 곳이다.
 */
export interface ShipmentRequestTerminalFilter extends TerminalShipmentScope {
  rule: 'LINE' | 'BUSINESS_UNIT';
}

/** 출하작업지시 목록의 조건 + 단말 범위 — 단말 작업 수(PDA 피킹·POP 완료 대기)가 같은 함수로 센다(omf-all-around#190). */
export function shipmentRequestWhereSql(
  query: ShipmentRequestFilters,
  terminal?: ShipmentRequestTerminalFilter,
  scopes?: readonly AccountScope[],
): { sql: string; params: unknown[] } {
  const where = whereSql(query);
  const bind = (value: unknown): string => `$${where.params.push(value)}`;
  // 계정 데이터 범위(W-04-02 · 피처 012 D-12) — 범위 줄이 없는 계정은 전부다.
  const account = scopes === undefined ? null : requestInAccountScopeSql('sr', scopes, bind);
  if (account !== null) where.sql = `(${where.sql}) AND ${account}`;
  if (terminal !== undefined) {
    // 이행 공장도 사업부도 없는 이전 요청은 단말에 보이지 않는다(범위 모듈의 옛 갈래).
    const scope = terminal.rule === 'LINE'
      ? requestPickableByTerminalSql('sr', terminal, bind)
      : requestInBusinessUnitSql('sr', terminal.plantId, bind);
    where.sql = `(${where.sql}) AND ${scope}`;
  }
  return where;
}
