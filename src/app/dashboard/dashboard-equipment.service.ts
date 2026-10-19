import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DowntimeSummaryCalendarService } from '../../maintenance/downtime/downtime-summary-calendar.service';
import { plannedSpans } from '../../maintenance/downtime/downtime-summary-planned';
import type { DashboardPlant } from './dashboard-availability.service';
import { EquipmentSignals, equipmentStatus, pickDowntime } from './dashboard-equipment-status';
import { Span, clip, subtract, union } from './dashboard-intervals';
import { num } from './dashboard-scope';
import { DashboardEquipment, DashboardEquipmentItem, EQUIPMENT_STATUSES } from './dashboard-sections';

type Tx = Prisma.TransactionClient;

interface EquipmentRow {
  equipment_id: bigint;
  equipment_code: string;
  equipment_name: string;
  equipment_type_code: string;
  type_name: string | null;
  production_line_id: bigint | null;
  line_name: string | null;
}

interface LastSessionRow {
  work_session_id: bigint;
  equipment_id: bigint;
  started_at: Date;
  ended_at: Date | null;
  work_order_no: string;
  item_code: string;
  item_name: string;
  cycle_sec: string | null;
}

interface LastSession {
  readonly row: LastSessionRow;
  /** 판단 시각에 끝나지 않았으면 그 상태, 끝났으면 null. */
  readonly open: EquipmentSignals['session'];
}

interface ProductionRow {
  equipment_id: bigint;
  total_qty: string;
  ng_qty: string;
}

/**
 * 생산 설비 — 계측기(유형이 INSTRUMENT_TYPE 계열이거나 옛 계측기 유형 INSPECTION)를 뺀다(#118 헤더 결정 2026-10-19).
 * 유형 코드가 비활성이거나 EQUIPMENT_TYPE 에 없다는 이유로는 빼지 않는다. ⚠ 설비 별칭이 `e` 여야 한다.
 */
export const PRODUCTION_EQUIPMENT = Prisma.sql`(e.equipment_type_code <> 'INSPECTION' AND NOT EXISTS (
  SELECT 1 FROM mdm.code_value iv JOIN mdm.code_group ig ON ig.code_group_id = iv.code_group_id
  WHERE ig.group_code = 'INSTRUMENT_TYPE' AND iv.code = e.equipment_type_code))`;

/**
 * 설비 현황 — 공장의 사용 중 생산 설비(PRODUCTION_EQUIPMENT · 계측기 제외)마다
 * 판단 시각의 상태를 정한다. 판단 시각 = 지금, 기준일이 지났으면 기준일 끝.
 */
@Injectable()
export class DashboardEquipmentService {
  constructor(private readonly calendars: DowntimeSummaryCalendarService) {}

  async read(tx: Tx, plants: readonly DashboardPlant[], baseDate: string, now: number): Promise<DashboardEquipment> {
    const items: DashboardEquipmentItem[] = [];
    let judgedAt = 0;
    for (const plant of plants) {
      const at = Math.min(now, plant.day.end - 1);
      judgedAt = Math.max(judgedAt, at);
      items.push(...(await this.plantItems(tx, plant, baseDate, new Date(at))));
    }
    items.sort((a, b) => a.equipmentCode.localeCompare(b.equipmentCode));
    const statusCounts = Object.fromEntries(EQUIPMENT_STATUSES.map((code) => [code, 0])) as DashboardEquipment['statusCounts'];
    for (const item of items) statusCounts[item.statusCode] += 1;
    return { asOf: new Date(judgedAt || now).toISOString(), statusCounts, items };
  }

  private async plantItems(tx: Tx, plant: DashboardPlant, baseDate: string, at: Date): Promise<DashboardEquipmentItem[]> {
    const equipment = await tx.$queryRaw<EquipmentRow[]>(Prisma.sql`
      SELECT e.equipment_id, e.equipment_code, e.equipment_name, e.equipment_type_code,
        cv.code_name AS type_name, e.production_line_id, l.line_name
      FROM mdm.equipment e
      LEFT JOIN mdm.code_group cg ON cg.group_code = 'EQUIPMENT_TYPE'
      LEFT JOIN mdm.code_value cv ON cv.code_group_id = cg.code_group_id AND cv.code = e.equipment_type_code
      LEFT JOIN mdm.production_line l ON l.production_line_id = e.production_line_id
      WHERE e.plant_id = ${plant.plantId} AND e.is_active AND e.status_code = 'IN_SERVICE' AND ${PRODUCTION_EQUIPMENT}
      ORDER BY e.equipment_code`);
    if (equipment.length === 0) return [];
    const ids = equipment.map((row) => row.equipment_id);
    const [breakdowns, downtimes, sessions, production, idle] = await Promise.all([
      this.breakdowns(tx, ids, at),
      this.downtimes(tx, ids, at),
      this.sessions(tx, ids, at),
      this.production(tx, ids, plant),
      this.idle(tx, plant, equipment, baseDate, at),
    ]);
    return equipment.map((row) => {
      const key = row.equipment_id;
      const session = sessions.get(key);
      const open = session !== undefined && session.open !== null ? session : undefined;
      const signals: EquipmentSignals = {
        breakdown: breakdowns.get(key) ?? null,
        downtime: downtimes.get(key) ?? null,
        session: open?.open ?? null,
        idle: idle.get(key),
        lastSessionEndedAt: session !== undefined && session.open === null ? session.row.ended_at : null,
      };
      const made = production.get(key);
      const totalQty = num(made?.total_qty);
      const ngQty = num(made?.ng_qty);
      return {
        equipmentId: Number(key),
        equipmentCode: row.equipment_code,
        equipmentName: row.equipment_name,
        equipmentTypeCode: row.equipment_type_code,
        equipmentTypeName: row.type_name,
        productionLineId: row.production_line_id === null ? null : Number(row.production_line_id),
        productionLineName: row.line_name,
        ...equipmentStatus(signals),
        todayTotalQty: totalQty,
        todayNgQty: ngQty,
        defectRate: totalQty > 0 ? (ngQty / totalQty) * 100 : null,
        standardCycleTimeSec: session?.row.cycle_sec == null ? null : Number(session.row.cycle_sec),
        currentWorkOrderNo: open?.row.work_order_no ?? null,
        currentItemCode: open?.row.item_code ?? null,
        currentItemName: open?.row.item_name ?? null,
      };
    });
  }

  private async breakdowns(tx: Tx, ids: bigint[], at: Date): Promise<Map<bigint, EquipmentSignals['breakdown']>> {
    const rows = await tx.breakdown.findMany({
      where: {
        equipment_id: { in: ids },
        reported_at: { lte: at },
        OR: [{ completed_at: { gt: at } }, { completed_at: null, status_code: { not: 'DONE' } }],
      },
      orderBy: { reported_at: 'asc' },
      select: { equipment_id: true, reported_at: true, stopped_at: true, description: true },
    });
    return new Map(rows.map((row) => [row.equipment_id, { since: row.stopped_at ?? row.reported_at, description: row.description }]));
  }

  private async downtimes(tx: Tx, ids: bigint[], at: Date): Promise<Map<bigint, EquipmentSignals['downtime']>> {
    const rows = await tx.equipment_downtime.findMany({
      where: { equipment_id: { in: ids }, started_at: { lte: at }, OR: [{ ended_at: null }, { ended_at: { gt: at } }] },
      orderBy: { started_at: 'asc' },
      select: { equipment_id: true, started_at: true, reason_code: true },
    });
    const names = await codeNames(tx, 'DOWNTIME_REASON', rows.map((row) => row.reason_code));
    const result = new Map<bigint, EquipmentSignals['downtime']>();
    for (const id of new Set(rows.map((row) => row.equipment_id))) {
      const picked = pickDowntime(
        rows.filter((row) => row.equipment_id === id).map((row) => ({ since: row.started_at, reasonCode: row.reason_code })),
      );
      if (picked !== null) result.set(id, { ...picked, reasonName: names.get(picked.reasonCode ?? '') ?? null });
    }
    return result;
  }

  /** 설비마다 판단 시각 전에 시작한 마지막 세션 — 끝나지 않았으면 STOP·RESUME 이벤트로 멈춤을 가린다. */
  private async sessions(tx: Tx, ids: bigint[], at: Date): Promise<Map<bigint, LastSession>> {
    const rows = await tx.$queryRaw<LastSessionRow[]>(Prisma.sql`
      SELECT DISTINCT ON (ws.equipment_id) ws.work_session_id, ws.equipment_id, ws.started_at, ws.ended_at,
        wo.work_order_no, i.item_code, i.item_name, ro.standard_cycle_time_sec::text AS cycle_sec
      FROM production.work_session ws
      JOIN production.work_order wo ON wo.work_order_id = ws.work_order_id
      JOIN mdm.item i ON i.item_id = wo.item_id
      JOIN planning.routing_operation ro ON ro.routing_operation_id = wo.routing_operation_id
      WHERE ws.equipment_id IN (${Prisma.join(ids)}) AND ws.started_at <= ${at}
      ORDER BY ws.equipment_id, ws.started_at DESC, ws.work_session_id DESC`);
    const openRows = rows.filter((row) => row.ended_at === null || row.ended_at > at);
    const events = await tx.work_session_event.findMany({
      where: {
        work_session_id: { in: openRows.map((row) => row.work_session_id) },
        event_type_code: { in: ['STOP', 'RESUME'] },
        occurred_at: { lte: at },
      },
      orderBy: [{ occurred_at: 'asc' }, { work_session_event_id: 'asc' }],
      select: { work_session_id: true, event_type_code: true, occurred_at: true, reason_code: true },
    });
    const lastEvent = new Map(events.map((event) => [event.work_session_id, event]));
    const names = await codeNames(tx, 'WORK_SESSION_EVENT_REASON', events.map((event) => event.reason_code));
    return new Map<bigint, LastSession>(
      rows.map((row) => {
        if (!openRows.includes(row)) return [row.equipment_id, { row, open: null }];
        const event = lastEvent.get(row.work_session_id);
        const stopped = event?.event_type_code === 'STOP';
        return [
          row.equipment_id,
          {
            row,
            open: {
              stopped,
              since: event?.occurred_at ?? row.started_at,
              reasonCode: stopped ? event.reason_code : null,
              reasonName: stopped ? (names.get(event.reason_code ?? '') ?? null) : null,
            },
          },
        ];
      }),
    );
  }

  /** 기준일 설비별 총생산·NG — 1차 카드와 같은 규칙(정정 원본 제외 · 재작업 W/O 실적 제외). */
  private async production(tx: Tx, ids: bigint[], plant: DashboardPlant): Promise<Map<bigint, ProductionRow>> {
    const rows = await tx.$queryRaw<ProductionRow[]>(Prisma.sql`
      SELECT pr.equipment_id,
        SUM(pr.good_qty + pr.defect_qty + pr.hold_qty + pr.scrap_qty + pr.rework_qty)::text AS total_qty,
        SUM(pr.defect_qty + pr.scrap_qty + pr.rework_qty)::text AS ng_qty
      FROM production.production_result pr
      JOIN production.work_order wo ON wo.work_order_id = pr.work_order_id
      WHERE pr.equipment_id IN (${Prisma.join(ids)}) AND wo.work_order_type_code <> 'REWORK'
        AND pr.occurred_at >= ${new Date(plant.day.start)} AND pr.occurred_at < ${new Date(plant.day.end)}
        AND NOT EXISTS (SELECT 1 FROM production.production_result c
          WHERE c.corrects_production_result_id = pr.production_result_id)
      GROUP BY pr.equipment_id`);
    return new Map(rows.map((row) => [row.equipment_id, row]));
  }

  /**
   * 계획 정지 구간이거나 근무달력상 비근무 시각이면 그 시작을 낸다(모르면 null).
   * 달력을 해석하지 못한 설비는 비근무로 단정하지 않는다.
   */
  private async idle(
    tx: Tx,
    plant: DashboardPlant,
    equipment: readonly EquipmentRow[],
    baseDate: string,
    at: Date,
  ): Promise<Map<bigint, EquipmentSignals['idle']>> {
    const time = at.getTime();
    const stops = await tx.planned_stop.findMany({
      where: {
        OR: [
          { equipment_id: { in: equipment.map((row) => row.equipment_id) } },
          { production_line_id: { in: equipment.flatMap((row) => row.production_line_id ?? []) } },
        ],
        planned_start_at: { lte: at },
        planned_end_at: { gt: at },
      },
      orderBy: { planned_start_at: 'asc' },
    });
    const slots = await this.calendars.slotsWithin(
      tx,
      [
        {
          plantId: plant.plantId.toString(),
          businessUnitId: null,
          timezone: plant.timezone,
          rangeStartUs: BigInt(plant.day.start) * 1000n,
          rangeEndUs: BigInt(plant.day.end) * 1000n,
        },
      ],
      equipment.map((row) => ({
        equipmentId: row.equipment_id.toString(),
        plantId: plant.plantId.toString(),
        productionLineId: row.production_line_id?.toString() ?? null,
      })),
      baseDate,
      baseDate,
    );
    const idle = new Map<bigint, EquipmentSignals['idle']>();
    for (const row of equipment) {
      const stop = stops.find((item) =>
        item.equipment_id !== null ? item.equipment_id === row.equipment_id : item.production_line_id === row.production_line_id,
      );
      if (stop !== undefined) {
        idle.set(row.equipment_id, { since: stop.planned_start_at, reasonCode: stop.stop_type_code, reasonName: stop.reason });
        continue;
      }
      const working = workingSpans(slots.filter((slot) => slot.equipmentId === row.equipment_id.toString()), plant.day);
      if (working === null || working.some((span) => span.start <= time && time < span.end)) continue;
      const ended = working.filter((span) => span.end <= time).at(-1);
      idle.set(row.equipment_id, {
        since: ended === undefined ? null : new Date(ended.end),
        reasonCode: null,
        reasonName: null,
      });
    }
    return idle;
  }
}

function workingSpans(slots: Parameters<typeof plannedSpans>[0][], day: Span): Span[] | null {
  if (slots.length === 0) return null;
  const shifts: Span[] = [];
  const holidays: Span[] = [];
  for (const slot of slots) {
    const off = plannedSpans(slot);
    if (off === null || slot.shiftStartUs === null || slot.shiftEndUs === null) return null;
    const shift = clip({ start: Number(slot.shiftStartUs / 1000n), end: Number(slot.shiftEndUs / 1000n) }, day);
    if (shift !== null) shifts.push(shift);
    holidays.push(...off.map((span) => ({ start: Number(span.startUs / 1000n), end: Number(span.endUs / 1000n) })));
  }
  return union(subtract(shifts, holidays));
}

async function codeNames(tx: Tx, groupCode: string, codes: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(codes.filter((code): code is string => code !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx.code_value.findMany({
    where: { code: { in: wanted }, code_group: { group_code: groupCode } },
    select: { code: true, code_name: true },
  });
  return new Map(rows.map((row) => [row.code, row.code_name]));
}
