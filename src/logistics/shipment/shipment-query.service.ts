import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { TerminalListScope } from '../terminal-list-scope';
import {
  ShipmentAllocationRow,
  shipmentLotAllocationView,
} from '../shipment-allocation/shipment-allocation-view';
import { oqcPassedByLine } from '../shipment-request/shipment-oqc';
import { BuiltWhere, FROM_SQL, ShipmentQuery, orderBySql, whereSql } from './shipment-query.sql';
import { ERP_SEND_STATUS_SQL, shipmentHistoryFacts } from './shipment-history';
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
              COALESCE(s.warehouse_id, (SELECT gi.source_warehouse_id
                                          FROM logistics.goods_issue_line gil
                                          JOIN logistics.goods_issue gi ON gi.goods_issue_id = gil.goods_issue_id
                                         WHERE gi.source_document_type_code = 'SHIPMENT' AND gi.source_document_id = s.shipment_id
                                           AND gil.lot_id = a.lot_id AND gil.issue_qty = a.allocated_qty
                                         ORDER BY gil.goods_issue_line_id LIMIT 1)) AS warehouse_id,
              i.item_code, lt.lot_no,
              (SELECT x.management_code FROM logistics.shipment_request_lot x
                WHERE x.shipment_id = s.shipment_id AND x.lot_id = a.lot_id LIMIT 1) AS management_code
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
  async list(query: ShipmentQuery, terminal?: TerminalListScope): Promise<PagedResponse<ShipmentView> & { erpSendStatusCounts: Record<string, number> }> {
    const page = pageRequest(query);
    const where = shipmentWhereSql(query, terminal);
    const order = orderBySql(query.sort);
    // ⛔ `count(*) OVER ()` 로 세지 마라 — 범위 «밖» 쪽은 행이 0개라 `total` 이 0 으로 접히고
    //    화면 페이저가 사라져 1쪽으로 돌아올 길이 없어진다. `total` 은 쪽이 아니라 필터
    //    «전체» 기준이다(선례 넷 — `shipment-request-query.service.ts:75` 와 같은 모양).
    // `LIMIT`·`OFFSET` 은 `pageRequest` 가 이미 정수로 자른 값이라 그대로 편다(주입 자리 없음).
    // ERP 송신 거르기 칩의 건수(W-04-12 · 피처 010) — 송신 상태 조건만 빼고 같은 조건으로 센다.
    const facetWhere = shipmentWhereSql({ ...query, erpSendStatus: undefined }, terminal);
    const [ids, counted, facets] = await Promise.all([
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
      this.prisma.$queryRawUnsafe<{ status: string; count: number }[]>(
        `SELECT ${ERP_SEND_STATUS_SQL} AS status, count(*)::int AS count FROM ${FROM_SQL} WHERE ${facetWhere.sql} GROUP BY 1`,
        ...facetWhere.params,
      ),
    ]);
    return {
      ...pagedResponse(await this.views(ids.map((row) => row.shipment_id)), counted[0].total, page),
      erpSendStatusCounts: Object.fromEntries(facets.map((row) => [row.status, row.count])),
    };
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
    const facts = (await shipmentHistoryFacts(this.prisma, [row.shipment_id])).get(String(row.shipment_id));
    return { view: shipmentDetailView(row, views, facts), versionNo: row.version_no };
  }

  /**
   * id 집합 → 뷰. **한 질의**로 끝낸다 — 목록은 헤더만 내리므로 라인을 읽을 이유가 없다.
   * ⭐ `ORDER BY` 를 위 질의가 정했으므로 **그 순서를 여기서 되살린다** — `findMany` 의 순서는
   * 보장이 없어, 쪽 안의 줄 순서가 정렬과 어긋나면 화면이 「경과일 긴 순」을 못 보인다.
   */
  private async views(ids: bigint[]): Promise<ShipmentView[]> {
    if (ids.length === 0) return [];
    const [rows, unassigned, unpacked, facts] = await Promise.all([
      this.prisma.shipment.findMany({ where: { shipment_id: { in: ids } } }),
      this.unassignedPackedBoxCounts(ids),
      this.unpackedLotCounts(ids),
      shipmentHistoryFacts(this.prisma, ids),
    ]);
    const byId = new Map(rows.map((row) => [row.shipment_id.toString(), row]));
    return ids.flatMap((id) => {
      const key = id.toString();
      const row = byId.get(key);
      return row === undefined
        ? []
        : [shipmentView(row, unassigned.get(key) ?? 0, facts.get(key), unpacked.get(key) ?? 0)];
    });
  }

  /**
   * 포장이 끝났는데 아직 어느 출하 단위에도 안 들어간 상자 수(SHIP-UNIT-01 · 장부 P-24).
   *
   * ⭐ 한 상자가 배분 여럿에 걸릴 수 있어 **`DISTINCT` 로 센다** — 안 세면 배분 수만큼
   * 부풀어 「구성할 것이 남았다」가 과장된다.
   * ⛔ 0 건인 출하도 키를 갖는다(호출부가 `?? 0` 으로 메운다) — 키가 없으면 화면이 「0」과
   * 「모른다」를 가를 수 없다.
   */
  private async unassignedPackedBoxCounts(ids: bigint[]): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ shipment_id: bigint; count: number }[]>(Prisma.sql`
      SELECT sl.shipment_id, count(DISTINCT hu.handling_unit_id)::int AS count
        FROM logistics.shipment_line sl
        JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
        JOIN inventory.handling_unit hu ON hu.handling_unit_id = a.handling_unit_id
       WHERE sl.shipment_id IN (${Prisma.join(ids)})
         AND hu.status_code = 'PACKED'
         AND NOT EXISTS (SELECT 1 FROM logistics.shipping_unit_handling_unit link
                          WHERE link.handling_unit_id = hu.handling_unit_id)
       GROUP BY sl.shipment_id
    `);
    return new Map(rows.map((row) => [row.shipment_id.toString(), row.count]));
  }

  /**
   * 아직 포장하지 않은 LOT 배분 수(omf-all-around#329) — POP 출하 포장이 0 인 출하를 목록에서 바로
   * 「확정 불가」로 보인다. ⭐ 배분 목록 `unpackedOnly=true`(`a.handling_unit_id IS NULL`)와 «같은
   * 기준»이다 — 갈리면 목록은 고를 수 있다는데 눌러 보면 담을 LOT 이 없다.
   * 0 건인 출하는 행이 없다 — 호출부가 `?? 0` 으로 메운다.
   */
  private async unpackedLotCounts(ids: bigint[]): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<{ shipment_id: bigint; count: number }[]>(Prisma.sql`
      SELECT sl.shipment_id, count(*)::int AS count
        FROM logistics.shipment_line sl
        JOIN logistics.shipment_lot_allocation a ON a.shipment_line_id = sl.shipment_line_id
       WHERE sl.shipment_id IN (${Prisma.join(ids)})
         AND a.handling_unit_id IS NULL
       GROUP BY sl.shipment_id
    `);
    return new Map(rows.map((row) => [row.shipment_id.toString(), row.count]));
  }
}

/**
 * 출하 목록의 조건 + 단말 범위 — 단말 작업 수(POP 출하 포장)가 같은 함수로 센다(omf-all-around#190).
 * 범위(피처 012 R-5 · omf-all-around#331): 창고 있는 출하(옛 흐름·긴급 직행)는 출하 창고가 단말 공장(창고 지정 단말은 그 창고),
 * 창고 없는 POP 완료 출하는 그 출하의 «출고 전표» 창고 중 하나라도 단말 공장(창고 지정 단말은 그 창고)이면 보인다 —
 * 재고는 출고 전표 창고에서 빠진다. 「출하 창고 = 단말 창고」만 보던 때 창고 지정 단말에서 새 흐름 출하가 빠졌다.
 */
export function shipmentWhereSql(query: ShipmentQuery, terminal?: TerminalListScope): BuiltWhere {
  const where = whereSql(query);
  if (terminal !== undefined) {
    const plant = `$${where.params.push(terminal.plantId)}::bigint`;
    const warehouse = terminal.warehouseId == null ? null : `$${where.params.push(terminal.warehouseId)}::bigint`;
    const ownWarehouse = warehouse === null ? '' : ` AND s.warehouse_id = ${warehouse}`;
    const issueWarehouse = warehouse === null ? '' : ` AND tg.source_warehouse_id = ${warehouse}`;
    where.sql = `(${where.sql}) AND ((s.warehouse_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM mdm.warehouse tw WHERE tw.warehouse_id = s.warehouse_id AND tw.plant_id = ${plant})${ownWarehouse})
       OR (s.warehouse_id IS NULL AND EXISTS (SELECT 1 FROM logistics.goods_issue tg JOIN mdm.warehouse tw ON tw.warehouse_id = tg.source_warehouse_id
                                               WHERE tg.source_document_type_code = 'SHIPMENT' AND tg.source_document_id = s.shipment_id
                                                 AND tw.plant_id = ${plant}${issueWarehouse})))`;
  }
  return where;
}
