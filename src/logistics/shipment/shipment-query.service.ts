import { Injectable } from '@nestjs/common';

import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { FROM_SQL, ShipmentQuery, orderBySql, whereSql } from './shipment-query.sql';
import { ShipmentView, shipmentView } from './shipment-view';

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
