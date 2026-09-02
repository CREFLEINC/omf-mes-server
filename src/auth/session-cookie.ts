import type { Response } from 'express';

/**
 * 세션은 쿠키로 나른다. 계약이 그렇게 강제한다 — `Session` 스키마에 토큰 자리가 없고
 * 응답 헤더 선언도 없어, 클라이언트가 토큰을 받아 보관할 방법이 «없다».
 * `DELETE /app/sessions/current`(로그아웃)도 서버가 쿠키를 지우는 형태여야 뜻이 선다.
 */
export const SESSION_COOKIE = 'omf_session';

/**
 * `cookie-parser` 를 쓰지 않는다 — 쿠키 하나를 읽자고 의존성을 늘리지 않는다.
 * 값에 `=` 가 들어갈 수 있으므로 첫 `=` 에서만 가른다.
 */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

/**
 * ⛔ `secure` 는 `NODE_ENV` 가 아니라 «앞단에 TLS 가 있는가» 를 따른다.
 *
 * 운영 구성에 리버스 프록시도 TLS 도 없고 API 가 평문 HTTP `:3100` 으로 바로 노출된다
 * (`docker-compose.prod.yml` · `RELEASE.md` 의 `curl localhost:3100`). 그 상태에서
 * `secure` 를 켜면 **브라우저가 쿠키를 되보내지 않아 관리웹 로그인이 통째로 안 된다** —
 * 서버 로그에는 아무 오류도 안 남는다.
 *
 * 그래서 기본은 끔이고, TLS 를 앞에 두면 `COOKIE_SECURE=true` 로 켠다.
 */
function isSecure(): boolean {
  return process.env.COOKIE_SECURE === 'true';
}

export function setSessionCookie(response: Response, token: string, maxAgeSeconds: number): void {
  response.cookie(SESSION_COOKIE, token, {
    // 스크립트가 못 읽게 하는 것이 핵심이고, sameSite=lax 가 크로스사이트 POST 를 막는다.
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(),
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSessionCookie(response: Response): void {
  // 세울 때와 같은 속성으로 지워야 브라우저가 같은 쿠키로 알아본다.
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(),
    path: '/',
  });
}
