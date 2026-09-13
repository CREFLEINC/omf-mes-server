import { HttpStatus } from "@nestjs/common";
import type { Request } from "express";

import { maintenanceWriteActorOf, type MaintenanceWriteActor } from "../terminal-maintenance-actor";
import { ERROR_CODE, field, one } from "../../common/errors";
import {
  IdempotencyContext,
  requestFingerprint,
} from "../../common/idempotency";

export type ToolUsageWriteContext = IdempotencyContext & MaintenanceWriteActor & { workerNo: string };

export function toolUsageWriteContext(request: Request): ToolUsageWriteContext {
  const workerNo = request.headers["x-worker-no"];
  if (typeof workerNo !== "string" || workerNo.trim() === "") {
    throw one(
      field("X-Worker-No", ERROR_CODE.REQUIRED, "작업자 사번이 필요합니다."),
    );
  }
  if (workerNo.length > 50) {
    throw one(
      field(
        "X-Worker-No",
        ERROR_CODE.RANGE,
        "작업자 사번은 50자 이하여야 합니다.",
      ),
    );
  }
  const actor = maintenanceWriteActorOf(request, 'POST /maintenance/tool-usages');
  return {
    key: String(request.headers["idempotency-key"]),
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      ...(actor.appUserId === undefined
        ? { actorWorkerId: actor.terminalAudit.workerId.toString(), terminalId: actor.terminalAudit.terminalId.toString() }
        : { actorUserId: actor.appUserId }),
      workerNo,
      body: request.body,
    }),
    ...actor,
    workerNo,
    successStatus: HttpStatus.CREATED,
  };
}
