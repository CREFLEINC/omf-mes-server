import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import type {
  SummaryEquipmentSource,
  SummaryPlantSource,
} from "./downtime-summary-source.types";

export interface DowntimeSummaryMaintenanceCounts {
  readonly correctiveMaintenanceCount: number;
  readonly preventiveMaintenanceCount: number;
  readonly breakdownsClosedWithoutOrderCount: number;
}

type CountRow = {
  corrective_count: bigint;
  preventive_count: bigint;
  breakdown_without_order_count: bigint;
};

const EMPTY: DowntimeSummaryMaintenanceCounts = {
  correctiveMaintenanceCount: 0,
  preventiveMaintenanceCount: 0,
  breakdownsClosedWithoutOrderCount: 0,
};

function count(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted))
    throw new Error("Downtime summary maintenance count exceeds safe range");
  return converted;
}

@Injectable()
export class DowntimeSummaryMaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  resolve(
    plants: readonly SummaryPlantSource[],
    equipment: readonly SummaryEquipmentSource[],
    narrowedToEquipment: boolean,
  ): Promise<DowntimeSummaryMaintenanceCounts> {
    return this.prisma.$transaction(
      (tx) => this.resolveWithin(tx, plants, equipment, narrowedToEquipment),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 결정 — 통보 111·112: 실적 max 완료시각과 지시 흔적 양쪽을 기준으로 센다. */
  async resolveWithin(
    tx: Prisma.TransactionClient,
    plants: readonly SummaryPlantSource[],
    equipment: readonly SummaryEquipmentSource[],
    narrowedToEquipment: boolean,
  ): Promise<DowntimeSummaryMaintenanceCounts> {
    if (!plants.length) return EMPTY;
    const ranges = Prisma.sql`(VALUES ${Prisma.join(
      plants.map(
        (plant) =>
          Prisma.sql`(${BigInt(plant.plantId)}::bigint,
            ${plant.rangeStartUs}::bigint,${plant.rangeEndUs}::bigint)`,
      ),
    )}) AS scope(plant_id,range_start_us,range_end_us)`;
    const equipmentIds = equipment.map((item) => BigInt(item.equipmentId));
    const equipmentCondition = equipmentIds.length
      ? Prisma.sql`equipment.equipment_id IN (${Prisma.join(equipmentIds)})`
      : Prisma.sql`FALSE`;
    const rows = await tx.$queryRaw<CountRow[]>(Prisma.sql`
      WITH completed_orders AS (
        SELECT orders.maintenance_order_id,orders.target_type_code,
          orders.equipment_id,orders.mold_id,orders.order_type_code,
          (extract(epoch FROM max(result.completed_at))*1000000)::bigint completed_us
        FROM maintenance.maintenance_order orders
        JOIN maintenance.maintenance_result result
          ON result.maintenance_order_id=orders.maintenance_order_id
        WHERE orders.status_code='DONE'
        GROUP BY orders.maintenance_order_id
      ), scoped_orders AS (
        SELECT completed.maintenance_order_id,completed.order_type_code
        FROM completed_orders completed
        LEFT JOIN mdm.equipment equipment
          ON equipment.equipment_id=completed.equipment_id
        LEFT JOIN mdm.mold mold ON mold.mold_id=completed.mold_id
        JOIN ${ranges} ON scope.plant_id=CASE
          WHEN completed.target_type_code='EQUIPMENT' THEN equipment.plant_id
          WHEN completed.target_type_code='MOLD' THEN mold.plant_id END
        WHERE completed.completed_us>=scope.range_start_us
          AND completed.completed_us<scope.range_end_us
          AND ((completed.target_type_code='EQUIPMENT' AND ${equipmentCondition})
            OR (completed.target_type_code='MOLD' AND ${!narrowedToEquipment}))
      ), unlinked_breakdowns AS (
        SELECT breakdown.breakdown_id
        FROM maintenance.breakdown breakdown
        JOIN mdm.equipment equipment
          ON equipment.equipment_id=breakdown.equipment_id
        JOIN ${ranges} ON scope.plant_id=equipment.plant_id
        WHERE breakdown.status_code='DONE' AND breakdown.completed_at IS NOT NULL
          AND (extract(epoch FROM breakdown.completed_at)*1000000)::bigint
            >=scope.range_start_us
          AND (extract(epoch FROM breakdown.completed_at)*1000000)::bigint
            <scope.range_end_us
          AND ${equipmentCondition}
          AND NOT EXISTS (SELECT 1 FROM maintenance.maintenance_order orders
            WHERE orders.breakdown_id=breakdown.breakdown_id)
          AND NOT EXISTS (SELECT 1 FROM maintenance.maintenance_order_trigger trigger
            WHERE trigger.trigger_type_code='BREAKDOWN'
              AND trigger.source_id=breakdown.breakdown_id)
      )
      SELECT count(*) FILTER (WHERE order_type_code='CORRECTIVE') corrective_count,
        count(*) FILTER (WHERE order_type_code='PREVENTIVE') preventive_count,
        (SELECT count(*) FROM unlinked_breakdowns) breakdown_without_order_count
      FROM scoped_orders`);
    const row = rows[0];
    if (!row) throw new Error("Missing downtime summary maintenance counts");
    return {
      correctiveMaintenanceCount: count(row.corrective_count),
      preventiveMaintenanceCount: count(row.preventive_count),
      breakdownsClosedWithoutOrderCount: count(
        row.breakdown_without_order_count,
      ),
    };
  }
}
