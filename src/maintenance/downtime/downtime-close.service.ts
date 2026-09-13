import { HttpStatus, Injectable } from "@nestjs/common";
import { recordTerminalWorkerAudit } from "../../audit/terminal-worker-audit";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { assertWorkerNoExists } from "../../common/master";
import { assertUpdated } from "../../common/optimistic-lock";
import { maintenanceInstantFromEpoch } from "../maintenance-instant";
import { readDowntimeWithin } from "./downtime-query.service";
import {
  assertDowntimeVersion,
  assertDowntimeWindow,
  lockDowntimeForUpdate,
  type DowntimeTx,
} from "./downtime-rules";
import { downtimeView, type DowntimeView } from "./downtime-view";
import type { DowntimeCloseContext } from "./downtime-write-context";

interface ServerInstant {
  epoch_us: string;
}

interface ClosedDowntime {
  downtime_id: bigint;
  version_no: number;
  ended_epoch_us: string;
}

@Injectable()
export class DowntimeCloseService {
  async closeWithin(
    tx: DowntimeTx,
    downtimeId: number,
    version: number | undefined,
    context: DowntimeCloseContext,
  ): Promise<DowntimeView> {
    if (!Number.isSafeInteger(downtimeId) || downtimeId <= 0) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field("downtimeId", ERROR_CODE.RANGE, "안전한 양의 정수여야 합니다."),
      ]);
    }

    await assertWorkerNoExists(tx, context.workerNo);
    const locked = await lockDowntimeForUpdate(tx, downtimeId);
    if (version !== undefined) assertDowntimeVersion(locked, version);
    if (locked.ended_epoch_us !== null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          "downtimeId",
          ERROR_CODE.STATE_LOCKED,
          "이미 종료된 비가동입니다.",
        ),
      ]);
    }

    const instants = await tx.$queryRaw<ServerInstant[]>`
      SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint::text AS epoch_us`;
    const serverInstant = instants[0];
    if (!serverInstant)
      throw new Error("Server clock did not return an instant");
    const ended = maintenanceInstantFromEpoch(serverInstant.epoch_us);
    assertDowntimeWindow(
      maintenanceInstantFromEpoch(locked.started_epoch_us),
      ended,
    );

    const rows = await tx.$queryRaw<ClosedDowntime[]>`
      UPDATE maintenance.equipment_downtime
      SET ended_at=${ended.sqlTimestamp}::timestamptz,
        closed_by=${context.appUserId === undefined ? null : BigInt(context.appUserId)},
        closed_by_worker_no=${context.workerNo},
        version_no=version_no+1
      WHERE equipment_downtime_id=${locked.downtime_id}
        AND version_no=${locked.version_no} AND ended_at IS NULL
      RETURNING equipment_downtime_id AS downtime_id,version_no,
        (extract(epoch FROM ended_at)*1000000)::bigint::text AS ended_epoch_us`;
    assertUpdated(rows.length, "user");
    const closed = rows[0];
    if (
      closed.downtime_id !== locked.downtime_id ||
      closed.version_no !== locked.version_no + 1 ||
      closed.ended_epoch_us !== ended.epochMicroseconds.toString()
    ) {
      throw new Error("Stored downtime close differs from the server instant");
    }

    if (context.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
      actor: context.terminalAudit, targetTypeCode: 'EQUIPMENT_DOWNTIME',
      targetId: closed.downtime_id, eventTypeCode: 'CLOSED',
    });

    const row = await readDowntimeWithin(tx, closed.downtime_id);
    if (row === null) throw new Error("Closed downtime is missing");
    return downtimeView(row);
  }
}
