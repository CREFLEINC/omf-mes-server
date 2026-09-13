import { INestApplication } from '@nestjs/common';

/**
 * 브라우저가 «다른 오리진»에서 이 API 를 부를 수 있게 연다.
 *
 * ⛔ 기본은 꺼짐이다. `CORS_ORIGINS` 에 오리진을 적은 환경에서만 켜진다.
 *
 * ⭐ **`CORS_ORIGINS=*` 는 「어떤 오리진이든」이다** — 받은 `Origin` 을 그대로 반사한다.
 * 현장 셸(PDA)이 보내는 오리진이 플랫폼·설정에 따라 갈려 미리 적을 수 없어 열어 둔 길이고
 * (#612), **설정 값 하나라 주소가 확정되면 재배포 없이 목록으로 좁힐 수 있다.**
 *
 * ⛔⛔ **`SameSite` 를 `None` 으로 바꾸기 «전에» `*` 를 반드시 목록으로 좁혀라**(#621).
 * 지금 `*` 가 안전한 이유는 CORS 가 아니라 쿠키다 — `SameSite=Lax` 라 브라우저가 교차
 * 사이트 `fetch` 에 세션 쿠키를 **안 싣는다**(아래 참조). 그래서 남의 사이트가 CORS 를
 * 통과해도 사용자 세션으로는 아무것도 못 한다. `None` 이 되는 순간 그 방어가 사라지고,
 * 그때 `*` 가 남아 있으면 **아무 사이트나 로그인된 사용자의 세션으로 이 API 를 부른다.**
 * 두 설정은 서로 다른 파일에 있어 한쪽만 바꾸기 쉽다 — 그래서 양쪽에 적어 둔다.
 *
 * ⚠ **컨테이너에서는 `docker-compose.prod.yml` 의 `api.environment` 가 이 변수를 넘겨야
 * 한다.** `docker compose --env-file` 은 compose 파일의 `${}` 치환용이지 컨테이너 주입이
 * 아니다 — 거기 없으면 `.env.prod` 에 아무리 적어도 서버는 빈 값을 본다. 꺼진 상태에서는
 * `enableCors` 가 안 불려 NestJS 가 `OPTIONS` 핸들러를 달지 않으므로 preflight 가
 * **404** 로 떨어진다(#612 실측).
 *
 * ⛔ 응답 헤더에 글자 `*` 를 쓸 수 없다. 인증이 **쿠키**라 `credentials` 를 켜야 하고,
 * 그때 브라우저는 와일드카드를 거절한다 — 받은 오리진을 «반사»해 정확한 값을 돌려줘야
 * 한다. 그래서 `CORS_ORIGINS=*` 는 `origin: '*'` 가 아니라 `origin: true`(반사)로 푼다.
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
/** 목록 자리에 이 하나만 서면 「어떤 오리진이든」이다. */
export const ANY_ORIGIN = '*';

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
    // ⛔ `true` 는 「아무나」가 아니라 「받은 오리진을 반사한다」는 뜻이다. cors 패키지가
    //    `Access-Control-Allow-Origin` 에 요청의 `Origin` 을 그대로 넣고 `Vary: Origin` 을
    //    붙인다 — 글자 `*` 를 쓰면 `credentials` 와 함께 브라우저가 거절한다.
    origin: origins.includes(ANY_ORIGIN) ? true : origins,
    credentials: true,
    // 계약이 쓰는 요청 헤더 전부.
    //
    // ⛔ 이 목록을 «명시»하면 cors 패키지는 `Access-Control-Request-Headers` 를 반사하지
    // 않고 이 값만 돌려준다 — 여기 없는 헤더를 단 요청은 preflight 에서 막힌다. 그래서
    // 서버가 실제로 읽는 헤더를 모두 적어 둔다(실측: `idempotency-key`·`if-match`·`x-worker-no`).
    //
    // `X-Worker-No` 는 계약 7벌 중 6벌이 header 파라미터로 선언한다(`mdm` 만 안 쓴다).
    // `Authorization` 은 단말 토큰의 운반 수단이다(`auth/terminal-token.ts`) — 다만 이것을
    // 여는 것으로 PDA 가 통하지는 않는다. 가드가 쿠키만 보므로 본 요청은 여전히 401 이다(#611).
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Worker-No',
    ],
    // ⛔ 이것이 없으면 화면이 낙관적 잠금 토큰을 못 읽는다.
    exposedHeaders: ['ETag'],
  });
  return origins;
}
