import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import {
  DowntimeCalendarSlot,
  summarizePlannedDowntime,
} from "./downtime-summary-planned";
import type {
  SummaryEquipmentSource,
  SummaryPlantSource,
} from "./downtime-summary-source.types";

type CalendarRow = {
  equipment_id: bigint;
  calendar_date: string;
  calendar_active: boolean | null;
  day_type: string | null;
  shift_id: bigint | null;
  shift_valid: boolean | null;
  shift_start_us: string | null;
  shift_end_us: string | null;
  partial_valid: boolean | null;
  partial_start_us: string | null;
  partial_end_us: string | null;
  range_start_us: bigint;
  range_end_us: bigint;
};

function instant(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

@Injectable()
export class DowntimeSummaryCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  resolve(
    plants: readonly SummaryPlantSource[],
    equipment: readonly SummaryEquipmentSource[],
    startedFrom: string,
    startedTo: string,
  ): Promise<bigint | null> {
    return this.prisma.$transaction(
      (tx) => this.resolveWithin(tx, plants, equipment, startedFrom, startedTo),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async resolveWithin(
    tx: Prisma.TransactionClient,
    plants: readonly SummaryPlantSource[],
    equipment: readonly SummaryEquipmentSource[],
    startedFrom: string,
    startedTo: string,
  ): Promise<bigint | null> {
    if (!equipment.length) return 0n;
    if (startedFrom > startedTo)
      throw new Error("Invalid planned downtime date range");
    const plantById = new Map(plants.map((plant) => [plant.plantId, plant]));
    const values = equipment.map((item) => {
      const plant = plantById.get(item.plantId);
      if (!plant) throw new Error("Missing planned downtime plant");
      return Prisma.sql`(${BigInt(item.equipmentId)}::bigint,
        ${BigInt(item.plantId)}::bigint,
        ${item.productionLineId === null ? null : BigInt(item.productionLineId)}::bigint,
        ${plant.timezone}::text,${plant.rangeStartUs}::bigint,
        ${plant.rangeEndUs}::bigint)`;
    });
    const rows = await tx.$queryRaw<CalendarRow[]>(Prisma.sql`
      WITH RECURSIVE scoped_equipment
        (equipment_id,plant_id,line_id,timezone,range_start_us,range_end_us) AS
        (VALUES ${Prisma.join(values)}),
      line_ancestors(equipment_id,line_id,depth,path) AS (
        SELECT equipment_id,line_id,0,ARRAY[line_id]
        FROM scoped_equipment WHERE line_id IS NOT NULL
        UNION ALL
        SELECT a.equipment_id,line.parent_line_id,a.depth+1,
          a.path||line.parent_line_id
        FROM line_ancestors a
        JOIN mdm.production_line line ON line.production_line_id=a.line_id
        WHERE line.parent_line_id IS NOT NULL
          AND NOT line.parent_line_id=ANY(a.path)
      ),
      date_scope AS (
        SELECT source.*,day::date AS calendar_date,
          day::date < ${startedFrom}::date AS carryover
        FROM scoped_equipment source
        CROSS JOIN generate_series(${startedFrom}::date-INTERVAL '1 day',
          ${startedTo}::date,INTERVAL '1 day') day
      )
      SELECT scope.equipment_id,to_char(scope.calendar_date,'YYYY-MM-DD') calendar_date,
        calendar.is_active AS calendar_active,day.day_type_code AS day_type,
        shift.shift_id,
        CASE WHEN shift.shift_id IS NULL THEN NULL
          WHEN shift.crosses_midnight THEN shift.end_time<=shift.start_time
          ELSE shift.end_time>shift.start_time END AS shift_valid,
        CASE WHEN shift.shift_id IS NULL THEN NULL ELSE
          (extract(epoch FROM ((scope.calendar_date+shift.start_time)
            AT TIME ZONE scope.timezone))*1000000)::bigint::text END shift_start_us,
        CASE WHEN shift.shift_id IS NULL THEN NULL ELSE
          (extract(epoch FROM ((scope.calendar_date+shift.end_time+
            CASE WHEN shift.crosses_midnight THEN INTERVAL '1 day'
              ELSE INTERVAL '0 day' END) AT TIME ZONE scope.timezone))
            *1000000)::bigint::text END shift_end_us,
        CASE WHEN day.day_type_code='PARTIAL' THEN
          day.work_start_time IS NOT NULL AND day.work_end_time IS NOT NULL
          AND day.work_end_time>day.work_start_time ELSE TRUE END partial_valid,
        CASE WHEN day.work_start_time IS NULL THEN NULL ELSE
          (extract(epoch FROM ((scope.calendar_date+day.work_start_time)
            AT TIME ZONE scope.timezone))*1000000)::bigint::text END partial_start_us,
        CASE WHEN day.work_end_time IS NULL THEN NULL ELSE
          (extract(epoch FROM ((scope.calendar_date+day.work_end_time)
            AT TIME ZONE scope.timezone))*1000000)::bigint::text END partial_end_us,
        scope.range_start_us,scope.range_end_us
      FROM date_scope scope
      LEFT JOIN LATERAL (
        SELECT candidate.work_calendar_id
        FROM (
          SELECT application.*,0 scope_rank,ancestor.depth
          FROM mdm.work_calendar_application application
          JOIN line_ancestors ancestor
            ON ancestor.equipment_id=scope.equipment_id
            AND ancestor.line_id=application.target_id
          WHERE application.target_type_code='EQUIPMENT_GROUP'
          UNION ALL
          SELECT application.*,1 scope_rank,0 depth
          FROM mdm.work_calendar_application application
          WHERE application.target_type_code='PLANT'
            AND application.target_id=scope.plant_id
        ) candidate
        WHERE candidate.effective_from<=scope.calendar_date
          AND (candidate.effective_to IS NULL OR
            candidate.effective_to>=scope.calendar_date)
        ORDER BY candidate.scope_rank,candidate.depth,
          candidate.effective_from DESC,
          candidate.work_calendar_application_id DESC LIMIT 1
      ) selected ON TRUE
      LEFT JOIN mdm.work_calendar calendar
        ON calendar.work_calendar_id=selected.work_calendar_id
      LEFT JOIN mdm.work_calendar_day day
        ON day.work_calendar_id=selected.work_calendar_id
        AND day.calendar_date=scope.calendar_date
      LEFT JOIN mdm.shift shift ON shift.plant_id=scope.plant_id AND shift.is_active
        AND (NOT scope.carryover OR shift.crosses_midnight)
      WHERE NOT scope.carryover OR shift.shift_id IS NOT NULL
      ORDER BY scope.equipment_id,scope.calendar_date,shift.shift_id`);
    return summarizePlannedDowntime(rows.map((row) => this.slot(row)));
  }

  private slot(row: CalendarRow): DowntimeCalendarSlot {
    return {
      equipmentId: row.equipment_id.toString(),
      calendarDate: row.calendar_date,
      calendarActive: row.calendar_active,
      dayType: row.day_type,
      shiftId: row.shift_id?.toString() ?? null,
      shiftValid: row.shift_valid,
      shiftStartUs: instant(row.shift_start_us),
      shiftEndUs: instant(row.shift_end_us),
      partialValid: row.partial_valid,
      partialStartUs: instant(row.partial_start_us),
      partialEndUs: instant(row.partial_end_us),
      rangeStartUs: row.range_start_us,
      rangeEndUs: row.range_end_us,
    };
  }
}
