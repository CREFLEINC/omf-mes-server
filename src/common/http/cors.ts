import { INestApplication } from '@nestjs/common';

/**
 * 브라우저가 «다른 오리진»에서 이 API 를 부를 수 있게 연다.
 *
 * ⛔ 기본은 꺼짐이다. `CORS_ORIGINS` 에 오리진을 적은 환경에서만 켜진다 — 목록 없이
 * 여는 것은 「아무 사이트나 사용자의 쿠키로 이 API 를 부를 수 있다」와 같다.
 *
 * ⛔ `origin: '*'` 를 쓸 수 없다. 인증이 **쿠키**라 `credentials` 를 켜야 하고, 그때
 * 브라우저는 와일드카드를 거절한다 — 정확한 오리진을 돌려줘야 한다.
 *
 * ⚠ **`ETag` 를 노출 목록에 넣는 것이 핵심이다.** 계약은 낙관적 잠금 토큰을 `ETag`
 * 응답 헤더로 나르는데(공유계약 `A-4`·`B-1`), 브라우저는 노출을 선언하지 않은 응답
 * 헤더를 스크립트에 **주지 않는다**. 빠뜨리면 화면이 토큰을 못 읽어 모든 수정이
 * `If-Match` 없이 나가고, 가드가 그것을 400 으로 막는다 — CORS 설정 한 줄이 도메인
 * 전체의 편집을 죽인다.
 *
 * ⚠ 쿠키는 `SameSite=Lax` 다. 「사이트」는 스킴+등록가능도메인이라 **포트가 다른 것은
 * 같은 사이트**다(`:5173` → `:3100` 은 쿠키가 간다). 그러나 **호스트가 다르면** 교차
 * 사이트라 Lax 가 쿠키를 막는다 — 그때는 화면 쪽 개발 서버에 프록시를 두어 같은 오리진으로
 * 만들거나, TLS 를 세우고 `SameSite=None; Secure` 로 가야 한다(`COOKIE_SECURE=true`).
 */
export function corsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function configureCors(app: INestApplication, raw: string | undefined): string[] {
  const origins = corsOrigins(raw);
  if (origins.length === 0) return origins;

  app.enableCors({
    origin: origins,
    credentials: true,
    // 계약이 쓰는 요청 헤더 셋. 빠뜨리면 그 헤더를 단 요청이 preflight 에서 막힌다.
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'If-Match'],
    // ⛔ 이것이 없으면 화면이 낙관적 잠금 토큰을 못 읽는다.
    exposedHeaders: ['ETag'],
  });
  return origins;
}
