import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { OqcInspectionRow } from './shipment-inspection';
import { SHIPMENT_REQUEST_LINE } from './shipment-progress';
import {
  FROM_SQL,
  INSPECTION_REQUIRED_SQL,
  PICKING_COMPLETE_SQL,
  ShipmentRequestFilters,
  ShipmentRequestQuery,
  orderBySql,
  whereSql,
} from './shipment-request-query.sql';
import { ShipmentPicksByLine, ShipmentRequestView, shipmentRequestView } from './shipment-request-view';

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
  async list(query: ShipmentRequestQuery): Promise<PagedResponse<ShipmentRequestView>> {
    const page = pageRequest(query);
    const where = whereSql(query);
    const order = orderBySql(query.sort);
    // ⛔ `count(*) OVER ()` 로 세지 마라 — 범위 «밖» 쪽은 행이 0개라 `total` 이 0 으로 접히고,
    //    화면 페이저가 사라져 1쪽으로 돌아올 길이 없어진다(리뷰 실측 · e2e L-40b).
    //    `total` 은 쪽이 아니라 필터 «전체» 기준이다 — 선례 3벌이 같은 모양이다
    //    (`concession-query.ts:87`·`disposition-query.ts:120`·`lot-hold-event-query.ts:128`).
    // `LIMIT`·`OFFSET` 은 `pageRequest` 가 이미 정수로 자른 값이라 그대로 편다(주입 자리 없음).
    const [rows, counted] = await Promise.all([
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
    ]);
    const views = await this.views(rows.map((row) => row.shipment_request_id));
    return pagedResponse(views, counted[0].total, page);
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
  async summary(query: ShipmentRequestFilters): Promise<ShipmentRequestSummaryView> {
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
