import type { Request, Response } from 'express';

import { ConflictCause, ConflictException } from '../errors';

export const IF_MATCH_HEADER = 'if-match';
export const ETAG_HEADER = 'ETag';
/** 가드가 파싱해 둔 값을 핸들러가 읽는 자리. */
const PARSED = Symbol('if-match-version');

/**
 * ETag 는 그 행의 `version_no` 다.
 *
 * ⛔ **본문 필드로 내리지 않는다** — 공유계약 `A-4`(`version_no` 는 화면에 노출하지 않는다).
 * 그래서 응답 본문에서 도출할 수 없고 핸들러가 명시로 싣는다. 계약도 그렇게 적었다:
 * 「표시하지 않되 전달한다」.
 *
 * 값은 따옴표 없이 그대로 낸다 — 계약이 「다음 쓰기의 If-Match 에 **그대로** 담는다」라 했고,
 * 운영에 리버스 프록시가 없어(`docs/deployment.md`) 중간에서 고쳐 쓸 자리가 없다.
 */
export function setEtag(response: Response, versionNo: number | bigint): void {
  response.setHeader(ETAG_HEADER, String(versionNo));
}

/**
 * `5` · `"5"` · `W/"5"` 를 받는다. 클라이언트·프록시가 따옴표를 붙일 수 있다.
 * ⛔ 따옴표는 **짝이 맞을 때만** 벗긴다 — `"5` 를 받아 주면 클라이언트가 값을 잘못 만드는
 * 실수를 서버가 가려 준다.
 */
export function parseIfMatch(raw: string): number | null {
  const trimmed = raw.trim().replace(/^W\//i, '');
  const match = /^(?:"(\d+)"|(\d+))$/.exec(trimmed);
  if (!match) return null;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** 가드가 통과시킨 값. 없으면 `undefined` — 오프라인 완화(C-9) 자리다. */
export function ifMatchVersion(request: Request): number | undefined {
  return (request as Request & { [PARSED]?: number })[PARSED];
}

export function rememberIfMatch(request: Request, version: number): void {
  (request as Request & { [PARSED]?: number })[PARSED] = version;
}

/**
 * 조건부 UPDATE 가 0행이면 그 사이 누가 고친 것이다.
 *
 * ⛔ 상태 때문에 막힌 것과 구분해야 화면이 「다시 불러오세요」와 「할 수 없습니다」를
 * 가른다(공유계약 G-1). 이것은 **재로드하면 풀리는** 저장 충돌이다.
 *
 * ⛔ 봉투는 `ConflictResponse` 다 — `{ errors: [...] }` 가 아니다. 화면이 `conflictCause`
 * 로 문구를 고르므로 원인을 함께 싣는다. 기본은 사람이고, ERP 재동기화 배치가 같은 행을
 * 덮을 수 있는 자리(수신본 마스터)는 호출자가 `erpSync` 를 준다.
 */
export function assertUpdated(affectedRows: number, cause: ConflictCause = 'user'): void {
  if (affectedRows === 0) {
    throw new ConflictException(cause, MESSAGE[cause]);
  }
}

const MESSAGE: Record<ConflictCause, string> = {
  user: '다른 사용자가 먼저 저장했습니다. 다시 불러온 뒤 저장하세요.',
  erpSync: '기간계 재동기화가 같은 자료를 갱신했습니다. 다시 불러온 뒤 저장하세요.',
  workerLease: '같은 자료를 처리 중입니다. 잠시 뒤 다시 확인하세요.',
};
