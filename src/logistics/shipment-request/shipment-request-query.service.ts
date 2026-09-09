import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { OqcInspectionRow } from './shipment-inspection';
import {
  SHIPMENT_PROGRESS_CASE_SQL,
  SHIPMENT_PROGRESS_TOTALS_SQL,
  SHIPMENT_REQUEST_LINE,
} from './shipment-progress';
import { ShipmentPicksByLine, ShipmentRequestView, shipmentRequestView } from './shipment-request-view';

/** 03 품질에서 이 축이 세는 것 — 출하검사뿐이다(§1-5). 좁히기용이고 판정은 ③a 가 다시 한다. */
const OQC = 'OQC';
const LOT = 'LOT';
const SHIPMENT_REQUEST = 'SHIPMENT_REQUEST';

/**
 * 계약 질의 **14축**. ⛔ `statusCode` 는 받고 «버린다» — 계약이 「이 축으로는 거를 수 없다(「칸
 * 불필요」로 닫힌 칸)」라 적었다. 파라미터를 지우지 않았으므로 400 도 내지 않는다(e2e L-36).
 */
export interface ShipmentRequestQuery {
  customerId?: number;
  shipToPartnerId?: number;
  itemId?: number;
  statusCode?: string;
  shipmentProgressCode?: string;
  timeSlotCode?: string;
  shippingInspectionRequired?: boolean;
  shipDateFrom?: string;
  shipDateTo?: string;
  pickingCompleteOnly?: boolean;
  shippableRemainderOnly?: boolean;
  sort?: string;
  page?: number;
  size?: number;
}

/** 요약은 목록과 **같은 축**에서 `page`·`size`·`sort` 만 빠진다(계약 명시 · 11축). */
export type ShipmentRequestSummaryQuery = Omit<ShipmentRequestQuery, 'page' | 'size' | 'sort'>;

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
 * ⭐ 바깥 별칭은 `sr` · LATERAL 안쪽은 `t` 다 — ③a 의 두 상수가 각각 `sr.shipment_request_id` 로
 * 상관되고 `t.picked_qty` 를 읽는다. ⛔ 별칭을 바꾸면 Postgres `42703` 으로 **500** 이다.
 * ⚠ 안쪽이 집계라 라인 0건이어도 «한 행»을 낸다 — `ON TRUE` 가 헤더를 안 떨어뜨린다.
 */
const FROM_SQL = `logistics.shipment_request sr
    JOIN LATERAL (${SHIPMENT_PROGRESS_TOTALS_SQL}) t ON TRUE`;

/** 라인 하나의 `P` — ③a `pickedQtyOf` 와 **같은 식**이다(`- res.released_qty` 가 그 한 글자). */
const LINE_PICKED_SQL = `(SELECT coalesce(sum(res.reserved_qty - res.released_qty), 0)
                     FROM inventory.inventory_reservation res
                    WHERE res.source_document_type_code = '${SHIPMENT_REQUEST_LINE}'
                      AND res.source_document_id = l.shipment_request_line_id)`;

/**
 * `pickingCompleteOnly` — 「라인 «전체»가 `pickedQty = allocatedQty`」. ⭐ **라인 축이라 헤더
 * 4합계로 도출할 수 없다** — 라인1 `P=10/A=5` · 라인2 `P=0/A=5` 면 헤더는 `P=A` 인데 답은 거짓이다.
 * ⛔ 앞 절(`EXISTS(라인)`)을 빼지 마라 — 라인 0건이 `NOT EXISTS` 만으로는 **공허참**이다(e2e L-9).
 * ⭐ `incompletePickingCount` 가 이 상수를 `NOT (…)` 로 뒤집는다 — 복제하면 둘이 갈린다.
 */
const PICKING_COMPLETE_SQL = `(EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id)
        AND NOT EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id
                      AND ${LINE_PICKED_SQL} < l.allocated_qty))`;

/** `shippableRemainderOnly` — 「`shippedQty < allocatedQty` 인 라인이 «하나라도»」. 정량자가 위와 반대다. */
const SHIPPABLE_REMAINDER_SQL = `EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id
                      AND l.shipped_qty < l.allocated_qty)`;

/** 계약이 「출하일·고객·작업지시번호 셋만」이라 못박았다 — 그 밖은 400 `INVALID`(e2e L-39). */
const SORT_COLUMNS: Record<string, string> = {
  requestedShipDate: 'sr.requested_ship_date',
  customerId: 'sr.customer_id',
  shipmentRequestNo: 'sr.shipment_request_no',
};

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
  async list(query: ShipmentRequestQuery): Promise<PagedResponse<ShipmentRequestView>> {
    const page = pageRequest(query);
    const where = whereSql(query);
    // `LIMIT`·`OFFSET` 은 `pageRequest` 가 이미 정수로 자른 값이라 그대로 편다(주입 자리 없음).
    // `count(*) OVER ()` — `total` 은 쪽이 아니라 필터 «전체» 기준이다.
    const rows = await this.prisma.$queryRawUnsafe<{ shipment_request_id: bigint; total: bigint }[]>(
      `SELECT sr.shipment_request_id, count(*) OVER () AS total
         FROM ${FROM_SQL}
        WHERE ${where.sql}
        ORDER BY ${orderBySql(query.sort)}
        LIMIT ${page.take} OFFSET ${page.skip}`,
      ...where.params,
    );
    const views = await this.views(rows.map((row) => row.shipment_request_id));
    return pagedResponse(views, Number(rows[0]?.total ?? 0), page);
  }

  /**
   * `W-04-02` 요약 — 모집단이 **필터 전체**다(목록 쪽이 아니다).
   * ⛔ `page`·`size`·`sort` 를 읽지 않는다 — 계약이 요약에서 그 셋을 뺐다(e2e L-50).
   * ⭐ `pendingInspectionCount` **만** SQL 이 아니라 TS 롤업이다(계획서 §5-1 표는 SQL 이라 적었다) —
   *   검사 판정(확정 · 최대 회차 · 헤더 대상의 `lot_id` 병존 · 5값 우선순위)을 SQL 로 다시 적으면
   *   ③a `lineInspectionStatus()` 와 **세 벌**이 되고 R-10 이 금한 「축이 갈리는」 자리를 스스로
   *   만든다. 같은 함수라야 목록의 `shippingInspectionStatusCode` 와 이 건수가 «구조적으로»
   *   못 어긋난다. ⚠ 대가로 모집단 전건을 읽는다 — `shipDateFrom` 이 필수라 범위가 늘 닫혀 있다.
   */
  async summary(query: ShipmentRequestSummaryQuery): Promise<ShipmentRequestSummaryView> {
    const where = whereSql(query);
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
      `SELECT sr.shipment_request_id FROM ${FROM_SQL} WHERE ${where.sql}`,
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

  async get(shipmentRequestId: number): Promise<ShipmentRequestView> {
    const [view] = await this.views([BigInt(shipmentRequestId)]);
    if (view === undefined) throw new NotFoundException('없는 출하작업지시입니다.');
    return view;
  }

  /**
   * 헤더 id 집합 → 뷰. **세 질의**로 끝낸다 — 헤더+라인 1 · 예약 1 · 검사 1. ⛔ 건마다·라인마다
   * 부르면 쪽 크기만큼 N+1 이다(e2e L-42 가 예약 조회 «횟수»를 센다). ⭐ 단건도 이 길을 쓴다.
   */
  private async views(ids: bigint[]): Promise<ShipmentRequestView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.shipment_request.findMany({
      where: { shipment_request_id: { in: ids } },
      include: { shipment_request_line: { orderBy: { line_no: 'asc' } } },
    });
    const lines = rows.flatMap((row) => row.shipment_request_line);
    const picks = await this.picksByLine(lines.map((line) => line.shipment_request_line_id));
    // ⛔ 맵 «전체»를 훑지 않는다 — 이 건들의 라인에서 뽑는다. 앞 질의가 느슨해지면 섞여 든 남의
    //    LOT 이 그대로 둘째 질의의 `IN` 목록으로 새 나간다(응답은 ③a 가 다시 걸러 안 바뀐다).
    const lotIds = lines
      .flatMap((line) => picks.get(String(line.shipment_request_line_id)) ?? [])
      .flatMap((pick) => (pick.lot_id === null ? [] : [pick.lot_id]));
    const inspections = await this.oqcResults(ids, lotIds);
    const byId = new Map(rows.map((row) => [String(row.shipment_request_id), row]));
    // ⛔ Prisma 의 `in` 은 순서를 보장하지 않는다 — SQL 이 정한 정렬을 여기서 되살린다(L-37·L-38).
    return ids.flatMap((id) => {
      const row = byId.get(String(id));
      return row === undefined ? [] : [shipmentRequestView(row, picks, inspections)];
    });
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
  private async picksByLine(lineIds: bigint[]): Promise<ShipmentPicksByLine> {
    const rows = await this.prisma.inventory_reservation.findMany({
      where: {
        source_document_type_code: SHIPMENT_REQUEST_LINE,
        source_document_id: { in: lineIds },
      },
      include: { lot: { select: { lot_no: true } } },
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
  ): Promise<OqcInspectionRow[]> {
    const rows = await this.prisma.inspection_result.findMany({
      where: {
        inspection_request: {
          inspection_type_code: OQC,
          OR: [
            { lot_id: { in: lotIds } },
            { target_type_code: LOT, target_id: { in: lotIds } },
            { target_type_code: SHIPMENT_REQUEST, target_id: { in: shipmentRequestIds } },
          ],
        },
      },
      include: { inspection_request: true },
    });
    return rows.map((row) => ({
      inspectionRequestId: row.inspection_request_id,
      inspectionTypeCode: row.inspection_request.inspection_type_code,
      targetTypeCode: row.inspection_request.target_type_code,
      targetId: row.inspection_request.target_id,
      lotId: row.inspection_request.lot_id,
      statusCode: row.status_code,
      inspectionRound: row.inspection_round,
      overallJudgmentCode: row.overall_judgment_code,
    }));
  }
}

/** ⭐ `EXISTS` 다 — 조인이면 라인 수만큼 헤더가 중복되고 `page.total` 이 부푼다(e2e L-6·L-7). */
function lineExists(condition: string): string {
  return `EXISTS (SELECT 1 FROM logistics.shipment_request_line l
                    WHERE l.shipment_request_id = sr.shipment_request_id AND ${condition})`;
}

/**
 * 목록·요약이 **같은 함수**로 `WHERE` 를 만든다 — 복붙하면 요약 카드와 목록이 다른 것을 센다
 * (e2e L-45). `@db.Date` 라 타임존을 붙이지 않고 날짜끼리 비교한다(CLAUDE.md).
 */
export function whereSql(query: ShipmentRequestSummaryQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown): string => `$${params.push(value)}`;
  // ⭐ 요약에도 **같은** 게이트다 — 계약이 「필수 · 목록과 같은 기준을 쓴다」라 적었다(L-2·L-2b).
  if (query.shipDateFrom === undefined) {
    throw one(field('shipDateFrom', ERROR_CODE.REQUIRED, '출하 희망일 시작은 필수입니다.'));
  }
  // 경계를 «포함»한다 — 같은 날을 주면 그 날 것이 걸린다(L-3·L-4).
  const and = [`sr.requested_ship_date >= ${bind(query.shipDateFrom)}::date`];
  if (query.shipDateTo !== undefined) {
    and.push(`sr.requested_ship_date <= ${bind(query.shipDateTo)}::date`);
  }
  if (query.customerId !== undefined) and.push(`sr.customer_id = ${bind(query.customerId)}::bigint`);
  if (query.shipToPartnerId !== undefined) {
    and.push(`sr.ship_to_partner_id = ${bind(query.shipToPartnerId)}::bigint`);
  }
  // ⛔ 시간대가 NULL 인 행은 안 걸린다 — `IS NULL` 을 함께 집으면 필터가 뜻을 잃는다(L-8).
  if (query.timeSlotCode !== undefined) {
    and.push(`sr.ship_time_slot_code = ${bind(query.timeSlotCode)}`);
  }
  if (query.itemId !== undefined) and.push(lineExists(`l.item_id = ${bind(query.itemId)}::bigint`));
  if (query.shippingInspectionRequired !== undefined) {
    and.push(lineExists(`l.shipping_inspection_required = ${bind(query.shippingInspectionRequired)}`));
  }
  // ⛔ 여기서 `CASE` 를 다시 적지 마라 — 응답 칸은 TS 판정이라 그 순간 두 벌이 갈린다(§5-1).
  if (query.shipmentProgressCode !== undefined) {
    and.push(`${SHIPMENT_PROGRESS_CASE_SQL} = ${bind(query.shipmentProgressCode)}`);
  }
  // 계약이 한 방향만 적었다 — `false` 는 필터를 «안 건다»(선례 `unassignedOnly`).
  if (query.pickingCompleteOnly === true) and.push(PICKING_COMPLETE_SQL);
  if (query.shippableRemainderOnly === true) and.push(SHIPPABLE_REMAINDER_SQL);
  return { sql: and.join('\n      AND '), params };
}

/**
 * 기본은 **임박한 것이 위**다(계약 침묵 · `W-04-02` 가 출하일 순으로 읽는다). ⛔ 2차 키를 빼지
 * 마라 — 출하일이 같은 행이 여럿이면 쪽 경계에서 행이 겹치거나 샌다.
 * ⭐ `export` 다 — **2차 키 부재는 HTTP 로 «구조적으로» 반증되지 않는다**(README §6-3 ⑹).
 * 동률 순서는 SQL 표준이 «미정의»라 Postgres 가 우연히 PK 순서를 내주면 e2e 가 초록이다(실측 —
 * 갱신으로 물리 순서를 흔들어도 그대로였다). 그래서 `*-query.spec.ts` 가 **문자열로** 대조한다.
 */
export function orderBySql(sort: string | undefined): string {
  const key = sort ?? 'requestedShipDate';
  if (!Object.prototype.hasOwnProperty.call(SORT_COLUMNS, key)) {
    throw one(
      field('sort', ERROR_CODE.INVALID, `정렬은 ${Object.keys(SORT_COLUMNS).join(' · ')} 셋뿐입니다.`),
    );
  }
  return `${SORT_COLUMNS[key]} ASC, sr.shipment_request_id ASC`;
}
