import { HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PrismaService } from "../../prisma/prisma.service";
import { maintenanceDateRange } from "../maintenance-calendar";
import type {
  DowntimeSummarySource,
  DowntimeSummarySourceQuery,
  SummaryDowntimeSource,
  SummarySessionSource,
} from "./downtime-summary-source.types";

type PlantRow = {
  plant_id: bigint;
  business_unit_id: bigint | null;
  timezone_code: string;
};
type EquipmentRow = {
  equipment_id: bigint;
  equipment_code: string;
  equipment_name: string;
  plant_id: bigint;
  production_line_id: bigint | null;
};
type IntervalRow = {
  source_id: bigint;
  plant_id: bigint;
  equipment_id: bigint | null;
  reason_code: string | null;
  reason_name: string | null;
  started_us: string;
  ended_us: string;
  range_start_us: string;
  range_end_us: string;
};

function epochUs(value: Date | undefined): bigint {
  if (!value) throw new Error("Missing downtime summary date boundary");
  return BigInt(value.getTime()) * 1000n;
}

function safeCount(value: bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count))
    throw new Error("Downtime summary count exceeds safe range");
  return count;
}

@Injectable()
export class DowntimeSummarySourceService {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    query: DowntimeSummarySourceQuery,
  ): Promise<DowntimeSummarySource> {
    return this.prisma.$transaction((tx) => this.readWithin(tx, query), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async readWithin(
    tx: Prisma.TransactionClient,
    query: DowntimeSummarySourceQuery,
  ): Promise<DowntimeSummarySource> {
    if (query.startedFrom > query.startedTo)
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          "startedTo",
          ERROR_CODE.RANGE,
          "비가동 집계 종료일이 시작일보다 빠릅니다.",
        ),
      ]);
    const equipmentConditions = [Prisma.sql`TRUE`];
    if (query.plantId !== undefined)
      equipmentConditions.push(Prisma.sql`e.plant_id = ${query.plantId}`);
    if (query.equipmentId !== undefined)
      equipmentConditions.push(
        Prisma.sql`e.equipment_id = ${query.equipmentId}`,
      );
    if (query.equipmentGroupId !== undefined)
      equipmentConditions.push(Prisma.sql`
        e.production_line_id IN (SELECT production_line_id FROM line_scope)`);

    // 결정 — 통보 111·112: EquipmentGroup은 production_line 계층이며 하위 그룹을 포함한다.
    const equipment = await tx.$queryRaw<EquipmentRow[]>(Prisma.sql`
      WITH RECURSIVE line_scope AS (
        SELECT production_line_id FROM mdm.production_line
        WHERE ${
          query.equipmentGroupId === undefined
            ? Prisma.sql`FALSE`
            : Prisma.sql`production_line_id = ${query.equipmentGroupId}`
        }
        UNION
        SELECT child.production_line_id FROM mdm.production_line child
        JOIN line_scope parent ON parent.production_line_id = child.parent_line_id
      )
      SELECT e.equipment_id,e.equipment_code,e.equipment_name,e.plant_id,
        e.production_line_id
      FROM mdm.equipment e
      WHERE ${Prisma.join(equipmentConditions, " AND ")}
      ORDER BY e.equipment_id`);

    const narrowed =
      query.equipmentId !== undefined || query.equipmentGroupId !== undefined;
    const plants = narrowed
      ? await this.plantsForEquipment(tx, equipment)
      : await tx.$queryRaw<PlantRow[]>(Prisma.sql`
          SELECT plant_id,business_unit_id,timezone_code FROM mdm.plant
          WHERE ${
            query.plantId === undefined
              ? Prisma.sql`TRUE`
              : Prisma.sql`plant_id = ${query.plantId}`
          }
          ORDER BY plant_id`);
    const scopedPlants = plants.map((plant) => {
      const range = maintenanceDateRange(
        query.startedFrom,
        query.startedTo,
        plant.timezone_code,
      );
      return {
        row: plant,
        rangeStart: range.gte,
        rangeEnd: range.lt,
        rangeStartUs: epochUs(range.gte),
        rangeEndUs: epochUs(range.lt),
      };
    });
    if (!scopedPlants.length)
      return {
        plants: [],
        equipment: [],
        sessions: [],
        downtimes: [],
        openIntervalCount: 0,
      };

    const ranges = Prisma.sql`(VALUES ${Prisma.join(
      scopedPlants.map(
        (plant) =>
          Prisma.sql`(${plant.row.plant_id},${plant.rangeStart},${plant.rangeEnd})`,
      ),
    )}) AS r(plant_id,range_start,range_end)`;
    const equipmentFilter = narrowed
      ? equipment.length
        ? Prisma.sql`AND source.equipment_id IN (${Prisma.join(
            equipment.map((item) => item.equipment_id),
          )})`
        : Prisma.sql`AND FALSE`
      : Prisma.empty;

    const [sessions, downtimes, openCounts] = await Promise.all([
      tx.$queryRaw<IntervalRow[]>(Prisma.sql`
        SELECT source.work_session_id AS source_id,
          COALESCE(e.plant_id,t.plant_id) AS plant_id,source.equipment_id,
          NULL::text AS reason_code,NULL::text AS reason_name,
          (extract(epoch FROM source.started_at)*1000000)::bigint::text AS started_us,
          (extract(epoch FROM source.ended_at)*1000000)::bigint::text AS ended_us,
          (extract(epoch FROM r.range_start)*1000000)::bigint::text AS range_start_us,
          (extract(epoch FROM r.range_end)*1000000)::bigint::text AS range_end_us
        FROM production.work_session source
        JOIN mdm.terminal t ON t.terminal_id=source.terminal_id
        LEFT JOIN mdm.equipment e ON e.equipment_id=source.equipment_id
        JOIN ${ranges} ON r.plant_id=COALESCE(e.plant_id,t.plant_id)
        WHERE source.ended_at IS NOT NULL ${equipmentFilter}
          AND source.started_at < r.range_end
          AND (source.ended_at > r.range_start OR
            (source.ended_at=source.started_at AND source.started_at>=r.range_start))`),
      tx.$queryRaw<IntervalRow[]>(Prisma.sql`
        SELECT source.equipment_downtime_id AS source_id,e.plant_id,
          source.equipment_id,source.reason_code,cv.code_name AS reason_name,
          (extract(epoch FROM source.started_at)*1000000)::bigint::text AS started_us,
          (extract(epoch FROM source.ended_at)*1000000)::bigint::text AS ended_us,
          (extract(epoch FROM r.range_start)*1000000)::bigint::text AS range_start_us,
          (extract(epoch FROM r.range_end)*1000000)::bigint::text AS range_end_us
        FROM maintenance.equipment_downtime source
        JOIN mdm.equipment e ON e.equipment_id=source.equipment_id
        JOIN ${ranges} ON r.plant_id=e.plant_id
        LEFT JOIN mdm.code_group cg ON cg.group_code='DOWNTIME_REASON' AND cg.is_active
        LEFT JOIN mdm.code_value cv ON cv.code_group_id=cg.code_group_id
          AND cv.code=source.reason_code AND cv.is_active
        WHERE source.ended_at IS NOT NULL ${equipmentFilter}
          AND source.started_at < r.range_end
          AND (source.ended_at > r.range_start OR
            (source.ended_at=source.started_at AND source.started_at>=r.range_start))`),
      tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
        SELECT count(*) AS total FROM maintenance.equipment_downtime source
        JOIN mdm.equipment e ON e.equipment_id=source.equipment_id
        JOIN ${ranges} ON r.plant_id=e.plant_id
        WHERE source.ended_at IS NULL ${equipmentFilter}
          AND source.started_at < r.range_end`),
    ]);
    return {
      plants: scopedPlants.map((plant) => ({
        plantId: plant.row.plant_id.toString(),
        businessUnitId: plant.row.business_unit_id?.toString() ?? null,
        timezone: plant.row.timezone_code,
        rangeStartUs: plant.rangeStartUs,
        rangeEndUs: plant.rangeEndUs,
      })),
      equipment: equipment.map((item) => ({
        equipmentId: item.equipment_id.toString(),
        equipmentCode: item.equipment_code,
        equipmentName: item.equipment_name,
        plantId: item.plant_id.toString(),
        productionLineId: item.production_line_id?.toString() ?? null,
      })),
      sessions: sessions.map((row) => this.session(row)),
      downtimes: downtimes.map((row) => this.downtime(row)),
      openIntervalCount: safeCount(openCounts[0]?.total ?? 0n),
    };
  }

  private plantsForEquipment(
    tx: Prisma.TransactionClient,
    equipment: readonly EquipmentRow[],
  ): Promise<PlantRow[]> {
    const ids = [...new Set(equipment.map((item) => item.plant_id))];
    if (!ids.length) return Promise.resolve([]);
    return tx.$queryRaw<PlantRow[]>(Prisma.sql`
      SELECT plant_id,business_unit_id,timezone_code FROM mdm.plant
      WHERE plant_id IN (${Prisma.join(ids)}) ORDER BY plant_id`);
  }

  private session(row: IntervalRow): SummarySessionSource {
    return {
      sessionId: row.source_id.toString(),
      plantId: row.plant_id.toString(),
      equipmentId: row.equipment_id?.toString() ?? null,
      startedAtUs: BigInt(row.started_us),
      endedAtUs: BigInt(row.ended_us),
      rangeStartUs: BigInt(row.range_start_us),
      rangeEndUs: BigInt(row.range_end_us),
    };
  }

  private downtime(row: IntervalRow): SummaryDowntimeSource {
    if (row.equipment_id === null)
      throw new Error("Downtime equipment is missing");
    return {
      downtimeId: row.source_id.toString(),
      plantId: row.plant_id.toString(),
      equipmentId: row.equipment_id.toString(),
      reasonCode: row.reason_code,
      reasonName: row.reason_name,
      startedAtUs: BigInt(row.started_us),
      endedAtUs: BigInt(row.ended_us),
      rangeStartUs: BigInt(row.range_start_us),
      rangeEndUs: BigInt(row.range_end_us),
    };
  }
}
