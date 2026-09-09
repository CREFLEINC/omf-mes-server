import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { IdempotencyContext, requestFingerprint } from '../../common/idempotency';

export function notificationWriteContext(
  request: Request,
  successStatus: number,
): IdempotencyContext & { appUserId: number } {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');
  return {
    key: String(request.headers['idempotency-key']),
    appUserId: session.userId,
    successStatus,
    // 멱등 키는 전역이므로 다른 사용자의 저장 응답을 재생하지 않는다(I-28 R-6).
    fingerprint: requestFingerprint(`${request.method} ${request.path}`, {
      actorUserId: session.userId,
      body: request.body,
      query: request.query,
    }),
  };
}
