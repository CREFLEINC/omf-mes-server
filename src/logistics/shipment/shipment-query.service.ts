import { Injectable, NotFoundException } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ShipmentAllocationRow,
  shipmentLotAllocationView,
} from '../shipment-allocation/shipment-allocation-view';
import { oqcPassedByLine } from '../shipment-request/shipment-oqc';
import { FROM_SQL, ShipmentQuery, orderBySql, whereSql } from './shipment-query.sql';
import {
  ShipmentDetailView,
  ShipmentView,
  shipmentDetailView,
  shipmentLineView,
  shipmentView,
} from './shipment-view';

/**
 * ⭐ I-22 `shipment-allocation-query.service.ts:52-55` 의 `SELECT`/`FROM` 을 **그대로** 쓴다 —
 * `itemCode`·`warehouseId` 는 조인이 만드는 파생 칸이라 모양이 갈리면 두 화면이 다른 값을 그린다.
 */
const ALLOCATION_SQL = `SELECT a.shipment_lot_allocation_id, a.shipment_line_id, a.lot_id,
              a.handling_unit_id, a.allocated_qty, a.uom_id,
              sl.shipment_id, sl.item_id, sl.shipment_request_line_id,
              s.warehouse_id, i.item_code, lt.lot_no
         FROM logistics.shipment_lot_allocation a
         JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
         JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
         JOIN mdm.item i ON i.item_id = sl.item_id
         JOIN trace.lot lt ON lt.lot_id = a.lot_id
        WHERE sl.shipment_id = $1::bigint
        ORDER BY a.shipment_lot_allocation_id ASC`;

interface AllocationQueryRow extends ShipmentAllocationRow {
  shipment_request_line_id: bigint;
}

/**
 * ⛔ **기본값을 두지 않는다.** `shipment_line.shipment_request_line_id` 가 **NOT NULL FK** 라
 * `oqcPassedByLine` 이 그 라인을 «못 찾을 수 없다» — `?? false` 나 `?? true` 를 적으면 그 줄은
 * **도달 불가**고, 「이 경우를 지켜본다」는 **반증할 수 없는 단언**이 된다(변이 M-11 이 살아남아
 * 드러났다 · README ⭐ 되풀이 병). 없으면 조용히 값을 지어내는 대신 **터진다** —
 * 「검사 화면은 불합격인데 라벨은 뽑힌다」보다 500 이 낫다.
 */
function oqcOf(passed: Map<string, boolean>, allocation: AllocationQueryRow): boolean {
  const key = allocation.shipment_request_line_id.toString();
  const found = passed.get(key);
  if (found === undefined) {
    throw new Error(`출하작업지시 라인 ${key} 의 출하검사 판정이 없다 — FK 가 깨졌다.`);
  }
  return found;
}

/**
 * 출하 목록 — 화면 `W-04-02`·`W-04-04`·`W-04-12` 가 함께 쓴다(계약).
 * ⛔ 멱등·If-Match·ETag·403 이 **0건**이다(계약 실측 · §1-1) — 200 뿐이다.
 */
@Injectable()
export class ShipmentQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ⛔ **`lines` 를 싣지 않는다**(§4-3) — `Shipment.required` 에 없고 목록 화면 어느 열도 라인을
   * 읽지 않는다. 상세(PR ②b)가 싣는다.
   */
  async list(query: ShipmentQuery): Promise<PagedResponse<ShipmentView>> {
    const page = pageRequest(query);
    const where = whereSql(query);
    const order = orderBySql(query.sort);
    // ⛔ `count(*) OVER ()` 로 세지 마라 — 범위 «밖» 쪽은 행이 0개라 `total` 이 0 으로 접히고
    //    화면 페이저가 사라져 1쪽으로 돌아올 길이 없어진다. `total` 은 쪽이 아니라 필터
    //    «전체» 기준이다(선례 넷 — `shipment-request-query.service.ts:75` 와 같은 모양).
    // `LIMIT`·`OFFSET` 은 `pageRequest` 가 이미 정수로 자른 값이라 그대로 편다(주입 자리 없음).
    const [ids, counted] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ shipment_id: bigint }[]>(
        `SELECT s.shipment_id
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
    return pagedResponse(await this.views(ids.map((row) => row.shipment_id)), counted[0].total, page);
  }

  /**
   * 상세 — 라인과 LOT 배분을 함께 내린다(계약 「genealogy 종결점이다」).
   * ⛔ 없는 id 는 404 다(계약이 그 응답만 선언했다 · 403 은 0건).
   */
  async get(shipmentId: number): Promise<{ view: ShipmentDetailView; versionNo: number }> {
    const row = await this.prisma.shipment.findUnique({
      where: { shipment_id: BigInt(shipmentId) },
    });
    if (row === null) throw new NotFoundException('없는 출하입니다.');
    const lines = await this.prisma.shipment_line.findMany({
      where: { shipment_id: row.shipment_id },
      orderBy: { line_no: 'asc' },
    });
    const allocations = await this.prisma.$queryRawUnsafe<AllocationQueryRow[]>(
      ALLOCATION_SQL,
      shipmentId,
    );
    // ⭐ 판정은 공용 함수 하나다 — 배분 목록(P-04-01·P-04-02)과 «같은 값»이어야 한다(I-22 R-10).
    //    ⛔ 여기서 다시 판정하면 같은 배분의 `oqcPassed` 가 두 화면에서 갈린다.
    const passed = await oqcPassedByLine(
      this.prisma,
      allocations.map((allocation) => allocation.shipment_request_line_id),
    );
    const byLine = new Map<string, AllocationQueryRow[]>();
    for (const allocation of allocations) {
      const key = allocation.shipment_line_id.toString();
      byLine.set(key, [...(byLine.get(key) ?? []), allocation]);
    }
    const views = lines.map((line) =>
      shipmentLineView(
        line,
        (byLine.get(line.shipment_line_id.toString()) ?? []).map((allocation) =>
          shipmentLotAllocationView(allocation, oqcOf(passed, allocation)),
        ),
      ),
    );
    return { view: shipmentDetailView(row, views), versionNo: row.version_no };
  }

  /**
   * id 집합 → 뷰. **한 질의**로 끝낸다 — 목록은 헤더만 내리므로 라인을 읽을 이유가 없다.
   * ⭐ `ORDER BY` 를 위 질의가 정했으므로 **그 순서를 여기서 되살린다** — `findMany` 의 순서는
   * 보장이 없어, 쪽 안의 줄 순서가 정렬과 어긋나면 화면이 「경과일 긴 순」을 못 보인다.
   */
  private async views(ids: bigint[]): Promise<ShipmentView[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.shipment.findMany({ where: { shipment_id: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.shipment_id.toString(), row]));
    return ids.flatMap((id) => {
      const row = byId.get(id.toString());
      return row === undefined ? [] : [shipmentView(row)];
    });
  }
}
