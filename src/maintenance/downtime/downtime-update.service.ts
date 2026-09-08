import { Injectable } from "@nestjs/common";

import { assertUpdated } from "../../common/optimistic-lock";
import {
  maintenanceInstantFromEpoch,
  parseMaintenanceInstant,
} from "../maintenance-instant";
import { readDowntimeWithin } from "./downtime-query.service";
import {
  assertDowntimeBreakdown,
  assertDowntimeNotReopened,
  assertDowntimeReason,
  assertDowntimeVersion,
  assertDowntimeWindow,
  lockDowntimeForUpdate,
  type DowntimeTx,
  type DowntimeUpdate,
} from "./downtime-rules";
import { downtimeView, type DowntimeView } from "./downtime-view";
import type { DowntimeWriteContext } from "./downtime-write-context";

interface UpdatedDowntime {
  downtime_id: bigint;
  version_no: number;
  started_epoch_us: string;
  ended_epoch_us: string | null;
}

const has = (input: DowntimeUpdate, name: keyof DowntimeUpdate): boolean =>
  Object.prototype.hasOwnProperty.call(input, name);

@Injectable()
export class DowntimeUpdateService {
  async updateWithin(
    tx: DowntimeTx,
    downtimeId: number,
    version: number,
    input: DowntimeUpdate,
    context: DowntimeWriteContext,
  ): Promise<DowntimeView> {
    const locked = await lockDowntimeForUpdate(tx, downtimeId);
    assertDowntimeVersion(locked, version);

    const reasonPresent = has(input, "reasonCode");
    const endedPresent = has(input, "endedAt");
    const breakdownPresent = has(input, "breakdownId");
    const remarksPresent = has(input, "remarks");
    const reasonCode = input.reasonCode;
    if (reasonPresent) {
      if (reasonCode === undefined)
        throw new Error("Validated downtime reason is missing");
      await assertDowntimeReason(tx, reasonCode);
    }
    assertDowntimeNotReopened(locked, input.endedAt);

    const ended =
      input.endedAt == null
        ? null
        : parseMaintenanceInstant(input.endedAt, "endedAt");
    if (endedPresent && ended !== null) {
      assertDowntimeWindow(
        maintenanceInstantFromEpoch(locked.started_epoch_us),
        ended,
      );
    }
    if (breakdownPresent) {
      await assertDowntimeBreakdown(
        tx,
        input.breakdownId,
        locked.equipment_id,
        "update",
      );
    }

    const endedSql = ended?.sqlTimestamp ?? null;
    const breakdownId =
      input.breakdownId == null ? null : BigInt(input.breakdownId);
    const actorId = BigInt(context.appUserId);
    const rows = await tx.$queryRaw<UpdatedDowntime[]>`
      UPDATE maintenance.equipment_downtime
      SET reason_code=CASE WHEN ${reasonPresent} THEN ${reasonCode ?? null}::app.code_t ELSE reason_code END,
        ended_at=CASE WHEN ${endedPresent} THEN ${endedSql}::timestamptz ELSE ended_at END,
        breakdown_id=CASE WHEN ${breakdownPresent} THEN ${breakdownId}::bigint ELSE breakdown_id END,
        remarks=CASE WHEN ${remarksPresent} THEN ${input.remarks ?? null}::text ELSE remarks END,
        closed_by=CASE WHEN ${endedPresent} AND ${endedSql}::timestamptz IS NOT NULL
          AND ended_at IS DISTINCT FROM ${endedSql}::timestamptz THEN ${actorId} ELSE closed_by END,
        version_no=version_no+1
      WHERE equipment_downtime_id=${locked.downtime_id} AND version_no=${version}
      RETURNING equipment_downtime_id AS downtime_id,version_no,
        (extract(epoch FROM started_at)*1000000)::bigint::text AS started_epoch_us,
        CASE WHEN ended_at IS NULL THEN NULL ELSE
          (extract(epoch FROM ended_at)*1000000)::bigint::text END AS ended_epoch_us`;
    assertUpdated(rows.length, "user");
    const updated = rows[0];
    const expectedEnded = endedPresent
      ? (ended?.epochMicroseconds.toString() ?? null)
      : locked.ended_epoch_us;
    if (
      updated.downtime_id !== locked.downtime_id ||
      updated.version_no !== version + 1 ||
      updated.started_epoch_us !== locked.started_epoch_us ||
      updated.ended_epoch_us !== expectedEnded
    ) {
      throw new Error("Stored downtime update differs from the request");
    }

    const row = await readDowntimeWithin(tx, updated.downtime_id);
    if (row === null) throw new Error("Updated downtime is missing");
    return downtimeView(row);
  }
}
