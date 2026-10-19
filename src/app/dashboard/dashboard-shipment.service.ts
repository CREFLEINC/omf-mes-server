import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { DashboardPlant } from './dashboard-availability.service';
import { coarseRange, localDate, num, plantScope } from './dashboard-scope';
import { DashboardShipment } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

interface ShippedRow {
  shipped_qty: string | null;
  shipment_count: number;
}

interface OpenRequestRow {
  shipment_request_id: bigint;
  shipment_request_no: string;
  customer_name: string | null;
  requested_ship_date: string;
  remaining_qty: string;
}

/**
 * 출하 현황(#118 2차 · 결정 5·6·7).
 * - 출하 확정 = 상태 CONFIRMED 이고 «실제 출하 시각(shipped_at)»이 기준일인 출하. 공장은 출하 창고의 공장.
 * - 미출하 요청 = Σ출하 < Σ요청. 요청 상태는 늘 REGISTERED 라 상태로 가르지 못한다.
 * - 요청의 공장 = `fulfillment_plant_id`, 비었으면 그 요청을 출하한 창고의 공장.
 */
@Injectable()
export class DashboardShipmentService {
  async read(
    tx: Tx,
    plants: readonly DashboardPlant[],
    baseDate: string,
    plantFiltered: boolean,
  ): Promise<DashboardShipment> {
    if (plants.length === 0) {
      return { todayShippedQty: 0, todayShipmentCount: 0, waitingRequestCount: 0, oldestWaitingShipDate: null, nextShipment: null,
        overdueCount: 0 };
    }
    const scope = plantScope(plants);
    const [shipped] = await tx.$queryRaw<ShippedRow[]>(Prisma.sql`
      WITH ${scope}
      SELECT SUM(sl.shipped_qty)::text AS shipped_qty, COUNT(DISTINCT s.shipment_id)::int AS shipment_count
      FROM logistics.shipment s
      JOIN mdm.warehouse w ON w.warehouse_id = s.warehouse_id
      JOIN plant_scope ps ON ps.plant_id = w.plant_id
      JOIN logistics.shipment_line sl ON sl.shipment_id = s.shipment_id
      WHERE s.status_code = 'CONFIRMED'
        AND ${coarseRange(Prisma.sql`s.shipped_at`, baseDate, baseDate)}
        AND ${localDate(Prisma.sql`s.shipped_at`)} = ${baseDate}::date`);

    const open = await tx.$queryRaw<OpenRequestRow[]>(Prisma.sql`
      WITH ${scope},
      request_plant AS (
        SELECT r.shipment_request_id,
          COALESCE(r.fulfillment_plant_id, (
            SELECT w.plant_id FROM logistics.shipment s
            JOIN mdm.warehouse w ON w.warehouse_id = s.warehouse_id
            WHERE s.shipment_request_id = r.shipment_request_id
            ORDER BY s.shipment_id LIMIT 1)) AS plant_id
        FROM logistics.shipment_request r
      )
      SELECT r.shipment_request_id, r.shipment_request_no, p.partner_name AS customer_name,
        to_char(r.requested_ship_date, 'YYYY-MM-DD') AS requested_ship_date,
        (SUM(l.requested_qty) - SUM(l.shipped_qty))::text AS remaining_qty
      FROM logistics.shipment_request r
      JOIN request_plant rp ON rp.shipment_request_id = r.shipment_request_id
      JOIN logistics.shipment_request_line l ON l.shipment_request_id = r.shipment_request_id
      LEFT JOIN mdm.partner p ON p.partner_id = r.customer_id
      WHERE ${plantFiltered ? Prisma.sql`rp.plant_id IN (SELECT plant_id FROM plant_scope)` : Prisma.sql`TRUE`}
      GROUP BY r.shipment_request_id, p.partner_name
      HAVING SUM(l.shipped_qty) < SUM(l.requested_qty)
      ORDER BY r.requested_ship_date, r.shipment_request_id`);
    const waiting = open.filter((row) => row.requested_ship_date <= baseDate);
    const next = open.find((row) => row.requested_ship_date > baseDate);

    const [overdue] = await tx.$queryRaw<{ overdue: number }[]>(Prisma.sql`
      WITH ${scope}
      SELECT COUNT(*)::int AS overdue
      FROM logistics.sales_order_line sol
      WHERE sol.requested_delivery_date < ${baseDate}::date AND sol.shipped_qty < sol.ordered_qty
        AND ${
          plantFiltered
            ? Prisma.sql`EXISTS (
                SELECT 1 FROM logistics.shipment_request_line srl
                JOIN logistics.shipment_request r ON r.shipment_request_id = srl.shipment_request_id
                WHERE srl.sales_order_line_id = sol.sales_order_line_id
                  AND r.fulfillment_plant_id IN (SELECT plant_id FROM plant_scope))`
            : Prisma.sql`TRUE`
        }`);

    return {
      todayShippedQty: num(shipped?.shipped_qty),
      todayShipmentCount: shipped?.shipment_count ?? 0,
      waitingRequestCount: waiting.length,
      // open 이 요청일 순이라 첫 줄이 가장 이르다.
      oldestWaitingShipDate: waiting[0]?.requested_ship_date ?? null,
      nextShipment:
        next === undefined
          ? null
          : {
              shipmentRequestId: Number(next.shipment_request_id),
              shipmentRequestNo: next.shipment_request_no,
              customerName: next.customer_name,
              requestedShipDate: next.requested_ship_date,
              requestedQty: num(next.remaining_qty),
            },
      overdueCount: overdue?.overdue ?? 0,
    };
  }
}
