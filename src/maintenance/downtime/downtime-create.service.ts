import { Injectable } from "@nestjs/common";

import { parseMaintenanceInstant } from "../maintenance-instant";
import { readDowntimeWithin } from "./downtime-query.service";
import {
  assertDowntimeBreakdown,
  assertDowntimeReason,
  assertDowntimeWindow,
  assertDowntimeWorker,
  assertNoOpenDowntime,
  type DowntimeCreate,
  type DowntimeTx,
  lockDowntimeEquipment,
} from "./downtime-rules";
import type { DowntimeCreateContext } from "./downtime-write-context";
import { downtimeView, type DowntimeView } from "./downtime-view";

interface CreatedDowntime {
  downtime_id: bigint;
  started_epoch_us: string;
  ended_epoch_us: string | null;
}

@Injectable()
export class DowntimeCreateService {
  async createWithin(
    tx: DowntimeTx,
    input: DowntimeCreate,
    context: DowntimeCreateContext,
  ): Promise<DowntimeView> {
    await assertDowntimeWorker(tx, context.workerNo);
    await assertDowntimeReason(tx, input.reasonCode);
    const equipmentId = await lockDowntimeEquipment(tx, input.equipmentId);

    const started = parseMaintenanceInstant(input.startedAt, "startedAt");
    const ended =
      input.endedAt == null
        ? null
        : parseMaintenanceInstant(input.endedAt, "endedAt");
    assertDowntimeWindow(started, ended);
    if (ended === null) await assertNoOpenDowntime(tx, equipmentId);
    await assertDowntimeBreakdown(tx, input.breakdownId, equipmentId, "create");

    const actorId = BigInt(context.appUserId);
    const rows = await tx.$queryRaw<CreatedDowntime[]>`
      INSERT INTO maintenance.equipment_downtime
        (equipment_id,reason_code,started_at,ended_at,breakdown_id,remarks,
         recorded_by_worker_no,created_by,closed_by,downtime_type_code)
      VALUES (${equipmentId},${input.reasonCode}::app.code_t,
        ${started.sqlTimestamp}::timestamptz,${ended?.sqlTimestamp ?? null}::timestamptz,
        ${input.breakdownId == null ? null : BigInt(input.breakdownId)},${input.remarks ?? null},
        ${context.workerNo},${actorId},${ended === null ? null : actorId},NULL)
      RETURNING equipment_downtime_id AS downtime_id,
        (extract(epoch FROM started_at)*1000000)::bigint::text AS started_epoch_us,
        CASE WHEN ended_at IS NULL THEN NULL ELSE
          (extract(epoch FROM ended_at)*1000000)::bigint::text END AS ended_epoch_us`;
    const created = rows[0];
    if (
      !created ||
      created.started_epoch_us !== started.epochMicroseconds.toString() ||
      created.ended_epoch_us !== (ended?.epochMicroseconds.toString() ?? null)
    ) {
      throw new Error("Stored downtime instant differs from the request");
    }

    const row = await readDowntimeWithin(tx, created.downtime_id);
    if (row === null) throw new Error("Created downtime is missing");
    return downtimeView(row);
  }
}
