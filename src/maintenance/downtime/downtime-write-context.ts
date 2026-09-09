import { HttpStatus, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

import { currentSession } from "../../auth/session-resolver.service";
import {
  IdempotencyContext,
  requestFingerprint,
} from "../../common/idempotency";
import { ERROR_CODE, field, one } from "../../common/errors";

export type DowntimeWriteContext = IdempotencyContext & { appUserId: number };
export type DowntimeCreateContext = DowntimeWriteContext & { workerNo: string };
export type DowntimeCloseContext = DowntimeWriteContext & { workerNo: string };

function workerProblem(code: string, message: string) {
  return one(field("X-Worker-No", code, message));
}

function workerNo(request: Request): string {
  const raw = request.headers["x-worker-no"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw workerProblem(ERROR_CODE.REQUIRED, "작업자 사번이 필요합니다.");
  }
  if (raw.length > 50) {
    throw workerProblem(
      ERROR_CODE.RANGE,
      "작업자 사번은 50자 이하여야 합니다.",
    );
  }
  return raw;
}

export function downtimeCreateContext(request: Request): DowntimeCreateContext {
  return context(request, HttpStatus.CREATED, { workerNo: workerNo(request) });
}

export function downtimeCloseContext(request: Request): DowntimeCloseContext {
  return context(request, HttpStatus.OK, { workerNo: workerNo(request) });
}

export function downtimeUpdateContext(request: Request): DowntimeWriteContext {
  return context(request, HttpStatus.OK, {});
}

function context<T extends object>(
  request: Request,
  successStatus: number,
  extra: T,
): DowntimeWriteContext & T {
  const session = currentSession(request);
  if (session === undefined)
    throw new UnauthorizedException("로그인이 필요합니다.");
  const actorUserId = session.userId;
  return {
    key: String(request.headers["idempotency-key"]),
    appUserId: actorUserId,
    successStatus,
    ...extra,
    // 전역 키이므로 실제 세션 주체와, 생성에서는 최초 귀속 사번까지 같은 요청이어야 한다.
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      actorUserId,
      ...extra,
      body: request.body,
    }),
  };
}
