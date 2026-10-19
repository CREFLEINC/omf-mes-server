import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { omitEmpty } from '../../common/http/omit-empty';
import { maintenanceDateRange } from '../../maintenance/maintenance-calendar';
import { PrismaService } from '../../prisma/prisma.service';
import { notificationView } from '../notification/notification-view';
import { DashboardAvailabilityService, DashboardPlant } from './dashboard-availability.service';
import { DashboardEquipmentService } from './dashboard-equipment.service';
import { DashboardQualityService } from './dashboard-quality.service';
import { DashboardRange, DashboardRangeQuery, previousRange } from './dashboard-range';
import { dashboardPlant, dashboardScope, localToday } from './dashboard-scope';
import { DashboardShipmentService } from './dashboard-shipment.service';
import {
  DailyProduction,
  DashboardCard,
  DashboardSummary,
  PerformanceFigures,
  availabilityCard,
  oeeCard,
  performanceCard,
  productionCards,
  productionSection,
  productionTrend,
} from './dashboard-view';

export interface DashboardSummaryQuery extends DashboardRangeQuery {
  plantId?: number;
}

const ALERT_LIMIT = 5;

/**
 * ⛔ 정정된 원본은 빼고 잎만 센다(`ACTIVE_RESULT_WHERE` 와 같은 규칙의 SQL 판).
 * 공장은 품목이 아니라 작업지시 라인의 공장이다 — 같은 품목코드가 두 공장에 있다.
 */
const LEAF_RESULT = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM production.production_result c
  WHERE c.corrects_production_result_id = pr.production_result_id)`;

interface DailyRow {
  day: string;
  total_qty: string;
  good_qty: string;
  ng_qty: string;
  hold_qty: string;
  rework_good_qty: string;
}

interface PerformanceRow {
  included: number;
  excluded: number;
  ideal_sec: string;
}

@Injectable()
export class DashboardSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: DashboardAvailabilityService,
    private readonly equipment: DashboardEquipmentService,
    private readonly shipments: DashboardShipmentService,
    private readonly quality: DashboardQualityService,
  ) {}

  async read(actorUserId: number, query: DashboardSummaryQuery): Promise<DashboardSummary> {
    const now = new Date();
    const asOf = now.toISOString();
    return this.prisma.$transaction(
      async (tx) => {
        const { plantRows, range, period, plants } = await dashboardScope(tx, query, now);
        const baseDate = range.to;

        const byDay = await this.dailyProduction(tx, plants, {
          from: [previousRange(range).from, period.chartDays[0]].sort()[0],
          to: baseDate,
        });
        const [productionCard, yieldCard] = productionCards(byDay, range);
        const availability = await this.availability.figures(tx, plants, range, now.getTime());
        const availabilityRate = availabilityCard(availability);
        const performanceRate = performanceCard(await this.performance(tx, plants), availability);
        const alarms = await this.alarms(tx, actorUserId);
        const todayPlants = plantRows.map((row) => {
          const date = localToday(now, row.timezone_code);
          return dashboardPlant(row.plant_id, row.timezone_code, { from: date, to: date }, now.getTime());
        });
        const equipment = await this.equipment.read(tx, todayPlants, now.getTime());

        return omitEmpty({
          baseDate,
          dateFrom: range.from,
          dateTo: range.to,
          plantId: query.plantId,
          cards: [
            productionCard,
            yieldCard,
            availabilityRate,
            performanceRate,
            oeeCard([availabilityRate, performanceRate, yieldCard]),
            alarms.card,
          ],
          alerts: alarms.alerts,
          asOf,
          trend: productionTrend(byDay, period.chartDays, asOf),
          production: productionSection(byDay, range),
          equipment,
          shipment: await this.shipments.read(tx, plants, range, query.plantId !== undefined),
          quality: await this.quality.read(tx, plants, period),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * 일자 = 실적 발생 시각의 공장 현지 달력 날짜(자정 기준 — 야간조 경계는 설계 미정).
   * 재작업 W/O 실적은 총생산에 넣지 않고 그 양품만 그날 NG→양품으로 옮긴다(#116 결정).
   */
  private async dailyProduction(
    tx: Prisma.TransactionClient,
    plants: readonly DashboardPlant[],
    days: DashboardRange,
  ): Promise<Map<string, DailyProduction>> {
    const byDay = new Map<string, DailyProduction>();
    for (const plant of plants) {
      const range = maintenanceDateRange(days.from, days.to, plant.timezone);
      const rows = await tx.$queryRaw<DailyRow[]>(Prisma.sql`
        SELECT to_char((pr.occurred_at AT TIME ZONE ${plant.timezone})::date, 'YYYY-MM-DD') AS day,
          COALESCE(SUM(pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty)
            FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS total_qty,
          COALESCE(SUM(pr.good_qty) FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS good_qty,
          COALESCE(SUM(pr.defect_qty + pr.scrap_qty + pr.rework_qty)
            FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS ng_qty,
          COALESCE(SUM(pr.hold_qty) FILTER (WHERE wo.work_order_type_code <> 'REWORK'), 0)::text AS hold_qty,
          COALESCE(SUM(pr.good_qty) FILTER (WHERE wo.work_order_type_code = 'REWORK'), 0)::text AS rework_good_qty
        FROM production.production_result pr
        JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
        JOIN mdm.production_line l ON l.production_line_id = wo.production_line_id
        WHERE l.plant_id = ${plant.plantId}
          AND pr.occurred_at >= ${range.gte} AND pr.occurred_at < ${range.lt}
          AND ${LEAF_RESULT}
        GROUP BY 1`);
      for (const row of rows) {
        const before = byDay.get(row.day);
        byDay.set(row.day, {
          day: row.day,
          totalQty: (before?.totalQty ?? 0) + Number(row.total_qty),
          goodQty: (before?.goodQty ?? 0) + Number(row.good_qty),
          ngQty: (before?.ngQty ?? 0) + Number(row.ng_qty),
          holdQty: (before?.holdQty ?? 0) + Number(row.hold_qty),
          reworkGoodQty: (before?.reworkGoodQty ?? 0) + Number(row.rework_good_qty),
        });
      }
    }
    return byDay;
  }

  /**
   * Σ(표준 C/T × 생산수량 ÷ 캐비티수) — C/T 는 1 shot 기준, 금형이 없으면 캐비티 1.
   * 분모(실제 가동시간)와 같은 구간(`measured`)의 실적만 센다 — 집계 시각 뒤의 실적은 넣지 않는다.
   * ⚠ 총생산과 달리 재작업 W/O 실적도 넣는다 — 분모(실제 가동시간)에 재작업 세션 시간이 들어가므로
   *   그 시간에 만든 수량도 분자에 있어야 설비 속도가 된다(#118 결정).
   * 분모가 설비 있는 세션만 세므로 설비 없는 실적도 뺀다.
   */
  private async performance(
    tx: Prisma.TransactionClient,
    plants: readonly DashboardPlant[],
  ): Promise<PerformanceFigures> {
    let idealSec = 0;
    let includedResultCount = 0;
    let excludedResultCount = 0;
    for (const plant of plants) {
      const [row] = await tx.$queryRaw<PerformanceRow[]>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE measurable)::int AS included,
          COUNT(*) FILTER (WHERE NOT measurable)::int AS excluded,
          COALESCE(SUM(cycle_sec * qty / cavity) FILTER (WHERE measurable), 0)::text AS ideal_sec
        FROM (
          SELECT ro.standard_cycle_time_sec AS cycle_sec,
            pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty AS qty,
            COALESCE(NULLIF(m.cavity_count, 0), 1) AS cavity,
            (ro.standard_cycle_time_sec > 0 AND pr.equipment_id IS NOT NULL) IS TRUE AS measurable
          FROM production.production_result pr
          JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
          JOIN mdm.production_line l ON l.production_line_id = wo.production_line_id
          JOIN planning.routing_operation ro ON ro.routing_operation_id = wo.routing_operation_id
          LEFT JOIN mdm.mold m ON m.mold_id = pr.mold_id
          WHERE l.plant_id = ${plant.plantId}
            AND pr.occurred_at >= ${new Date(plant.measured.start)} AND pr.occurred_at < ${new Date(plant.measured.end)}
            AND ${LEAF_RESULT}
        ) result`);
      idealSec += Number(row.ideal_sec);
      includedResultCount += row.included;
      excludedResultCount += row.excluded;
    }
    return { idealSec, includedResultCount, excludedResultCount };
  }

  /** 미처리 알람 = 로그인 사용자의 안 읽은 알림(`unread-count` 와 같은 값). 알림에는 공장 칸이 없다. */
  private async alarms(tx: Prisma.TransactionClient, actorUserId: number) {
    const where = { recipient_user_id: actorUserId, read_at: null };
    const [count, rows] = await Promise.all([
      tx.notification.count({ where }),
      tx.notification.findMany({
        where,
        include: { notification_event: true },
        orderBy: [{ notification_event: { occurred_at: 'desc' } }, { notification_id: 'desc' }],
        take: ALERT_LIMIT,
      }),
    ]);
    const card: DashboardCard = {
      cardCode: 'UNHANDLED_ALARM',
      label: '미처리 알람',
      value: count,
      unit: '건',
      note: '내가 읽지 않은 알림 기준입니다 — 공장 조건은 적용되지 않습니다.',
      valueStatusCode: 'AVAILABLE',
    };
    return { card, alerts: rows.map(notificationView) };
  }
}
