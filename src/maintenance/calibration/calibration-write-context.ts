import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { currentSession } from "../../auth/session-resolver.service";
import { IdempotencyContext, requestFingerprint } from "../../common/idempotency";

export type CalibrationWriteContext = IdempotencyContext & { appUserId: number };

export function calibrationWriteContext(
  request: Request,
  successStatus: HttpStatus.CREATED | HttpStatus.OK,
): CalibrationWriteContext {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException("로그인이 필요합니다.");
  const appUserId = session.userId;
  return {
    key: String(request.headers["idempotency-key"]),
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      actorUserId: appUserId,
      body: request.body,
    }),
    appUserId,
    successStatus,
  };
}
