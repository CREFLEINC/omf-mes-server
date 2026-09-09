import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { currentSession } from "../../auth/session-resolver.service";
import { ERROR_CODE, field, one } from "../../common/errors";
import {
  IdempotencyContext,
  requestFingerprint,
} from "../../common/idempotency";

export type ToolUsageWriteContext = IdempotencyContext & {
  appUserId: number;
  workerNo: string;
};

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
  const session = currentSession(request);
  if (session === undefined)
    throw new UnauthorizedException("로그인이 필요합니다.");
  const appUserId = session.userId;
  return {
    key: String(request.headers["idempotency-key"]),
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      actorUserId: appUserId,
      workerNo,
      body: request.body,
    }),
    appUserId,
    workerNo,
    successStatus: HttpStatus.CREATED,
  };
}
