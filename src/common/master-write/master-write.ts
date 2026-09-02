import { HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { IdempotencyService, requestFingerprint } from '../idempotency';
import { ifMatchVersion, setEtag } from '../optimistic-lock';

/**
 * 마스터 쓰기의 공통 골격 — 멱등 흡수와 낙관적 잠금을 한 자리에 묶는다.
 *
 * 계약이 마스터 쓰기 전부에 같은 형태를 요구한다(`Idempotency-Key` 필수, 수정·전이는
 * `If-Match` 도 필수, 응답에 새 `ETag`). 컨트롤러마다 다시 쓰면 **한 곳만 빠뜨려도
 * 조용히 두 번 저장된다** — 흡수되지 않은 재전송은 오류를 내지 않는다.
 *
 * 클래스가 아니라 함수다. Nest 컨트롤러를 상속으로 묶으면 하위 클래스가
 * `IdempotencyService` 를 생성자로 넘겨줘야 해서, 배선이 오히려 늘어난다.
 */

/** 멱등 흡수. 같은 키로 다시 오면 앞의 응답을 그대로 준다. */
export async function runIdempotent<T>(
  idempotency: IdempotencyService,
  request: Request,
  successStatus: number,
  work: () => Promise<T>,
): Promise<T> {
  const session = currentSession(request);
  const outcome = await idempotency.run(
    {
      key: String(request.headers['idempotency-key']),
      fingerprint: requestFingerprint(`${request.method} ${request.path}`, request.body),
      successStatus,
      ...(session === undefined ? {} : { appUserId: session.userId }),
    },
    () => work(),
  );
  return outcome.body;
}

/** 멱등 + 낙관적 잠금. 새 `version_no` 를 ETag 로 돌려준다. */
export async function runVersioned<T, K extends string>(
  idempotency: IdempotencyService,
  request: Request,
  response: Response,
  field: K,
  work: (version: number) => Promise<{ versionNo: number } & Record<K, T>>,
): Promise<T> {
  // 가드가 이 자리들에서 If-Match 를 이미 필수로 막았다(`#107`) — 여기 오면 값이 있다.
  const version = ifMatchVersion(request);
  if (version === undefined) {
    throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
  }

  const result = await runIdempotent(idempotency, request, HttpStatus.OK, () => work(version));
  setEtag(response, result.versionNo);
  return result[field];
}
