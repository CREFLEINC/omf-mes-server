import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { DowntimeSummaryCalendarService } from '../../maintenance/downtime/downtime-summary-calendar.service';
import { plannedSpans } from '../../maintenance/downtime/downtime-summary-planned';
import { Span, clip, intersect, stoppedSpans, subtract, totalLength, union } from './dashboard-intervals';

export interface DashboardPlant {
  readonly plantId: bigint;
  readonly timezone: string;
  /** 기준일의 공장 현지 하루 [start, end) — epoch ms. */
  readonly day: Span;
  /**
   * 가동률·성능률을 재는 구간 — 하루 시작 ~ min(하루 끝, 집계 시각).
   * ⛔ 오늘을 하루 전체로 재면 분모(계획)는 저녁 교대까지, 분자(실제)는 지금까지라 낮에는 늘 낮게 나온다.
   */
  readonly measured: Span;
}

interface SessionRow {
  work_session_id: bigint;
  equipment_id: bigint | null;
  production_line_id: bigint | null;
  started_at: Date;
  ended_at: Date | null;
}

interface ScopedEquipment {
  readonly equipmentId: bigint;
  readonly productionLineId: bigint | null;
}

/** 시간가동률·성능률이 함께 쓰는 설비-시간. `planned === null` 이면 근무달력을 해석하지 못한 설비가 있다. */
export interface AvailabilityFigures {
  readonly plannedMs: number | null;
  readonly actualMs: number;
  readonly equipmentCount: number;
  readonly excludedSessionCount: number;
}

/**
 * 분모에 넣을 설비 — «그날 작업세션이 있었던 설비»(omf-all-around#118 Q3 (a)).
 * ⚠ 사용자 확인 중이라 「공장 활성 설비 전부」로 바뀔 수 있다. 범위는 이 함수 한 곳에서만 정한다.
 */
function scopeEquipment(sessions: readonly SessionRow[]): ScopedEquipment[] {
  const byId = new Map<bigint, ScopedEquipment>();
  for (const row of sessions) {
    if (row.equipment_id === null) continue;
    byId.set(row.equipment_id, { equipmentId: row.equipment_id, productionLineId: row.production_line_id });
  }
  return [...byId.values()];
}

/**
 * 시간가동률(= 실제 ÷ 계획)의 두 시간을 센다.
 * - 계획 = 활성 교대 − 근무달력 휴무 구간 − 계획 정지(설비 또는 그 라인 지정) — 설비마다 센다.
 * - 실제 = 작업세션 시작~종료(진행 중이면 집계 시각) − STOP~RESUME 중단 구간.
 * ⛔ 설비 비가동 집계(`availabilityPercent`)와 정의가 다르다 — 그쪽은 분모가 세션 시간이다.
 */
@Injectable()
export class DashboardAvailabilityService {
  constructor(private readonly calendars: DowntimeSummaryCalendarService) {}

  async figures(
    tx: Prisma.TransactionClient,
    plants: readonly DashboardPlant[],
    baseDate: string,
    asOf: number,
  ): Promise<AvailabilityFigures> {
    let plannedMs: number | null = 0;
    let actualMs = 0;
    let equipmentCount = 0;
    let excludedSessionCount = 0;
    for (const plant of plants) {
      const sessions = await this.sessions(tx, plant);
      excludedSessionCount += sessions.filter((row) => row.equipment_id === null).length;
      const equipment = scopeEquipment(sessions);
      if (equipment.length === 0) continue;
      const planned = await this.planned(tx, plant, equipment, baseDate);
      plannedMs = planned === null || plannedMs === null ? null : plannedMs + sumLengths(planned);
      actualMs += await this.actual(tx, plant, sessions, asOf, planned);
      equipmentCount += equipment.length;
    }
    return { plannedMs, actualMs, equipmentCount, excludedSessionCount };
  }

  /** 공장은 설비의 공장, 설비가 없는 세션은 작업지시 라인의 공장으로 가른다. */
  private sessions(tx: Prisma.TransactionClient, plant: DashboardPlant): Promise<SessionRow[]> {
    return tx.$queryRaw<SessionRow[]>(Prisma.sql`
      SELECT ws.work_session_id, ws.equipment_id, e.production_line_id, ws.started_at, ws.ended_at
      FROM production.work_session ws
      JOIN production.work_order wo ON wo.work_order_id = ws.work_order_id
      LEFT JOIN mdm.production_line l ON l.production_line_id = wo.production_line_id
      LEFT JOIN mdm.equipment e ON e.equipment_id = ws.equipment_id
      WHERE COALESCE(e.plant_id, l.plant_id) = ${plant.plantId}
        AND ws.started_at < ${new Date(plant.day.end)}
        AND (ws.ended_at IS NULL OR ws.ended_at > ${new Date(plant.day.start)})
      ORDER BY ws.work_session_id`);
  }

  private async planned(
    tx: Prisma.TransactionClient,
    plant: DashboardPlant,
    equipment: readonly ScopedEquipment[],
    baseDate: string,
  ): Promise<Map<bigint, Span[]> | null> {
    const source = {
      plantId: plant.plantId.toString(),
      businessUnitId: null,
      timezone: plant.timezone,
      rangeStartUs: BigInt(plant.day.start) * 1000n,
      rangeEndUs: BigInt(plant.day.end) * 1000n,
    };
    const slots = await this.calendars.slotsWithin(
      tx,
      [source],
      equipment.map((item) => ({
        equipmentId: item.equipmentId.toString(),
        plantId: source.plantId,
        productionLineId: item.productionLineId?.toString() ?? null,
      })),
      baseDate,
      baseDate,
    );
    const stops = await this.plannedStops(tx, plant, equipment);
    const byEquipment = new Map<bigint, Span[]>();
    for (const item of equipment) {
      const shifts: Span[] = [];
      const cuts: Span[] = [...(stops.get(item.equipmentId) ?? [])];
      for (const slot of slots.filter((row) => row.equipmentId === item.equipmentId.toString())) {
        const holidays = plannedSpans(slot);
        if (holidays === null || slot.shiftStartUs === null || slot.shiftEndUs === null) return null;
        shifts.push({ start: Number(slot.shiftStartUs / 1000n), end: Number(slot.shiftEndUs / 1000n) });
        cuts.push(...holidays.map((span) => ({ start: Number(span.startUs / 1000n), end: Number(span.endUs / 1000n) })));
      }
      const inDay = shifts.map((span) => clip(span, plant.measured)).filter((span): span is Span => span !== null);
      byEquipment.set(item.equipmentId, subtract(inDay, cuts));
    }
    return byEquipment;
  }

  private async plannedStops(
    tx: Prisma.TransactionClient,
    plant: DashboardPlant,
    equipment: readonly ScopedEquipment[],
  ): Promise<Map<bigint, Span[]>> {
    const rows = await tx.planned_stop.findMany({
      where: {
        OR: [
          { equipment_id: { in: equipment.map((item) => item.equipmentId) } },
          { production_line_id: { in: equipment.flatMap((item) => item.productionLineId ?? []) } },
        ],
        planned_start_at: { lt: new Date(plant.day.end) },
        planned_end_at: { gt: new Date(plant.day.start) },
      },
      select: { equipment_id: true, production_line_id: true, planned_start_at: true, planned_end_at: true },
    });
    const byEquipment = new Map<bigint, Span[]>();
    for (const item of equipment) {
      const spans = rows
        .filter((row) =>
          row.equipment_id !== null
            ? row.equipment_id === item.equipmentId
            : row.production_line_id !== null && row.production_line_id === item.productionLineId,
        )
        .map((row) => ({ start: row.planned_start_at.getTime(), end: row.planned_end_at.getTime() }));
      byEquipment.set(item.equipmentId, spans);
    }
    return byEquipment;
  }

  /**
   * 설비가 있는 세션만 센다 — 설비 없는 세션은 분모(설비 범위)에 없으니 분자에도 넣지 않는다.
   * 분자는 분모와 같은 구간(그 설비의 계획 가동 구간)으로 자른다 — 근무 시간 밖 작업이 가동률을
   * 100% 넘게 올리지 않는다(사용자 결정 2026-10-19 · 장부 P-59). 근무달력을 못 풀면(`planned === null`)
   * 가동률은 NOT_YET 이고 이 값은 성능률 분모로만 쓰여 자르지 않는다.
   */
  private async actual(
    tx: Prisma.TransactionClient,
    plant: DashboardPlant,
    sessions: readonly SessionRow[],
    asOf: number,
    planned: ReadonlyMap<bigint, Span[]> | null,
  ): Promise<number> {
    const scoped = sessions.filter((row) => row.equipment_id !== null);
    const events = await tx.work_session_event.findMany({
      where: {
        work_session_id: { in: scoped.map((row) => row.work_session_id) },
        event_type_code: { in: ['STOP', 'RESUME'] },
      },
      select: { work_session_id: true, event_type_code: true, occurred_at: true },
    });
    const byEquipment = new Map<bigint, Span[]>();
    for (const row of scoped) {
      const end = row.ended_at?.getTime() ?? asOf;
      const running = subtract(
        [{ start: row.started_at.getTime(), end }],
        stoppedSpans(
          events
            .filter((event) => event.work_session_id === row.work_session_id)
            .map((event) => ({ eventTypeCode: event.event_type_code, occurredAt: event.occurred_at.getTime() })),
          end,
        ),
      );
      const key = row.equipment_id as bigint;
      byEquipment.set(key, [...(byEquipment.get(key) ?? []), ...running]);
    }
    // 같은 설비에 겹친 세션은 한 번만 센다 — 설비-시간이다.
    let total = 0;
    for (const [equipmentId, spans] of byEquipment) {
      const measured = union(spans).flatMap((span) => clip(span, plant.measured) ?? []);
      total += totalLength(planned === null ? measured : intersect(measured, planned.get(equipmentId) ?? []));
    }
    return total;
  }
}

function sumLengths(byEquipment: ReadonlyMap<bigint, Span[]>): number {
  return [...byEquipment.values()].reduce((sum, spans) => sum + totalLength(spans), 0);
}
