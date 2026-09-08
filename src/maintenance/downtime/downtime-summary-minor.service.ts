import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../prisma/prisma.service";
import type { SummaryPlantSource } from "./downtime-summary-source.types";

const DEFAULT_THRESHOLD = "5.000000";
const MINUTE_US = 60_000_000n;

export interface DowntimeMinorThresholds {
  readonly byPlant: ReadonlyMap<string, bigint>;
  readonly minorStopThresholdMinutes: number | null;
}

type PolicyRow = {
  operation_policy_id: bigint;
  business_unit_id: bigint | null;
  plant_id: bigint | null;
  value_numeric: string | null;
  effective_from: Date;
};

function thresholdUs(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("Invalid minor stop threshold policy");
  return (
    BigInt(match[1]) * MINUTE_US + BigInt((match[2] ?? "").padEnd(6, "0")) * 60n
  );
}

function thresholdMinutes(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Invalid minor stop threshold policy");
  return parsed;
}

function rank(row: PolicyRow): number {
  if (row.plant_id !== null) return 0;
  if (row.business_unit_id !== null) return 1;
  return 2;
}

function applies(row: PolicyRow, plant: SummaryPlantSource): boolean {
  return (
    (row.plant_id === null || row.plant_id.toString() === plant.plantId) &&
    (row.business_unit_id === null ||
      row.business_unit_id.toString() === plant.businessUnitId)
  );
}

@Injectable()
export class DowntimeSummaryMinorService {
  constructor(private readonly prisma: PrismaService) {}

  resolve(
    plants: readonly SummaryPlantSource[],
    effectiveOn: string,
  ): Promise<DowntimeMinorThresholds> {
    return this.prisma.$transaction(
      (tx) => this.resolveWithin(tx, plants, effectiveOn),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** 결정 — 통보 111·112: PLANT > BUSINESS_UNIT > ALL, 부재할 때만 5분이다. */
  async resolveWithin(
    tx: Prisma.TransactionClient,
    plants: readonly SummaryPlantSource[],
    effectiveOn: string,
  ): Promise<DowntimeMinorThresholds> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn))
      throw new Error("Invalid minor stop threshold date");
    if (!plants.length)
      return { byPlant: new Map(), minorStopThresholdMinutes: null };
    const rows = await tx.$queryRaw<PolicyRow[]>(Prisma.sql`
      SELECT operation_policy_id,business_unit_id,plant_id,
        value_numeric::text,effective_from
      FROM app.operation_policy
      WHERE policy_code='MINOR_STOP_THRESHOLD_MINUTES'
        AND item_id IS NULL AND process_id IS NULL
        AND effective_from <= ${effectiveOn}::date
        AND (effective_to IS NULL OR effective_to >= ${effectiveOn}::date)
      ORDER BY effective_from DESC,operation_policy_id DESC`);

    const values = new Map<string, { minutes: number; microseconds: bigint }>();
    for (const plant of plants) {
      const winner = rows
        .filter((row) => applies(row, plant))
        .sort(
          (left, right) =>
            rank(left) - rank(right) ||
            right.effective_from.getTime() - left.effective_from.getTime() ||
            (right.operation_policy_id > left.operation_policy_id
              ? 1
              : right.operation_policy_id < left.operation_policy_id
                ? -1
                : 0),
        )[0];
      const value =
        winner === undefined ? DEFAULT_THRESHOLD : winner.value_numeric;
      if (value === null)
        throw new Error("Invalid minor stop threshold policy");
      values.set(plant.plantId, {
        minutes: thresholdMinutes(value),
        microseconds: thresholdUs(value),
      });
    }
    const distinct = new Set(
      [...values.values()].map((value) => value.microseconds.toString()),
    );
    return {
      byPlant: new Map(
        [...values].map(([plantId, value]) => [plantId, value.microseconds]),
      ),
      minorStopThresholdMinutes:
        distinct.size === 1 ? [...values.values()][0].minutes : null,
    };
  }
}
