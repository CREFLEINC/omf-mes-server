# 배포·운영 가이드

CLAUDE.md 에서 분리한 배포·인프라 상세입니다. 전역 규칙 요약은 CLAUDE.md, 하노이 현장 배포 절차는 `deploy/RELEASE.md`, CI/CD 를 왜 이렇게 만들었는지는 `CI-CD.md` 를 보세요.

## 배포 구조

```
개발자 ──push──▶ GitHub Actions (ubuntu-latest)
                    │ pnpm install → prisma generate → nest build → docker build
                    ▼
              hub.crefle.com/mes/backend   (Harbor)
                    │
      ┌─────────────┴──────────────┐
      ▼                            ▼
개발 서버(한국)               하노이 운영 서버
self-hosted runner 가         합의된 창에 사람이
푸시 직후 자동 배포            deploy.sh 실행
IMAGE_TAG=main                IMAGE_TAG=stable 또는 vX.Y.Z
```

사내 서버는 내부망이므로 **서버가 Harbor 에서 당겨오는(pull) 방식**입니다. GitHub 에서 서버로 들어오는 경로는 없습니다. self-hosted runner 도 GitHub 에 바깥으로 폴링합니다.

### 이미지 태그

| 이벤트 | 태그 |
|---|---|
| `main` push/merge | `:main`, `:sha-a1b2c3d` |
| `git tag v1.2.3` | `:v1.2.3`, `:stable`, `:sha-a1b2c3d` |

git 태그 문자열과 이미지 태그가 글자 그대로 일치합니다(`v` 접두사 포함). 불변 태그(`sha-`, `vX.Y.Z`)는 "무엇이었는지"를 기록하고, 가변 태그(`main`, `stable`)는 "무엇을 배포할지"를 가리킵니다.

## TLS 를 두지 않는다 — 확정 2026-09-02 (사용자)

API 는 평문 HTTP `:3100` 으로 노출한다. 인증서를 두지 않는다.
전제는 `C11` 이다 — 운영은 **사내망 전용**이고 인터넷은 설치·유지보수 시점에만 열린다.

⚠ **개발 서버는 앞에 리버스 프록시가 있다**(`mesapi.crefle.ai` → `192.168.1.72`, nginx).
외부에서 닿게 하려고 둔 것이고 **TLS 는 종단하지 않는다**(평문 HTTP 를 그대로 넘긴다).
이 외부 프록시는 호스팅 쪽 구성이다 — 저장소 compose 의 `proxy`(블루-그린 전환용, 아래)와 다른 것이다.

⭐ 그래서 **#621(TLS 전환)은 생각보다 가볍다.** 개발 서버는 인증서를 그 프록시에 붙이면 되고
컨테이너 구성은 그대로다. 남는 것은 앱 쪽 둘뿐이다 — `COOKIE_SECURE` 가 컨테이너에 닿게 하고,
교차 호스트면 `SameSite=None` 스위치를 만드는 것. 하노이는 프록시가 아직 없다.

**그래서 이렇게 돼 있다**

| | |
|---|---|
| `COOKIE_SECURE=false` | 켜면 브라우저가 세션 쿠키를 되보내지 않아 **관리웹 로그인이 통째로 안 된다.** 서버 로그에는 아무 오류도 안 남아 진단이 어렵다 |
| 남아 있는 보호 | 쿠키는 `HttpOnly`(스크립트 차단) · `SameSite=Lax`(크로스사이트 POST 차단) |

⛔ **무엇을 받아들인 결정인지 적어 둔다** — 사내망 구간에서 **로그인 비밀번호와 세션 토큰이
평문으로 흐른다.** 같은 망에 있는 누군가가 그것을 볼 수 있다. 이 결정은 「사내망은 신뢰한다」를
전제로 하며, 그 전제가 바뀌면(무선 구간 추가·외부 접속 허용) **먼저 되돌려야 하는 결정**이다.

**되돌리는 방법** — 앞단에 TLS 를 두고 `.env.prod` 에 `COOKIE_SECURE=true` 를 넣는다.
다만 **환경변수 하나로 끝나지 않는다.** 실제로 필요한 것은 넷이다(#621).

| 필요 | 성격 |
|---|---|
| 앞단에 TLS 종단기 | 인프라 — 앱 변경 없음 |
| `COOKIE_SECURE=true` 가 **컨테이너에 닿게** | ⚠ `docker-compose.prod.yml` 의 `x-api.environment` 에 이 변수가 **없다.** 지금은 의도값이 `false` = 코드 기본값이라 증상이 없지만, 켜는 날 조용히 무시된다 |
| `CORS_ORIGINS` 를 `https://…` 로 교체 | `http` 와 `https` 는 **다른 오리진**이다. 안 바꾸면 관리웹이 CORS 에서 막힌다 |
| `SameSite=None` | ⚠ `session-cookie.ts:45`·`:56` 에 `'lax'` 가 **하드코딩**이라 코드 변경이 필요하다. 관리웹이 다른 **호스트**에 있을 때만 해당 — 포트만 다른 것은 같은 사이트라 지금도 쿠키가 간다 |

## CORS — 브라우저가 다른 오리진에서 부를 수 있게 여는 목록

`.env.prod` 의 `CORS_ORIGINS` 하나로 정한다. **운영 기본값은 `*` — 어떤 오리진이든 연다.**
현장 셸(PDA)이 보내는 오리진이 플랫폼·설정에 따라 갈려 미리 적을 수 없기 때문이다(#612).

| | |
|---|---|
| `*` | 받은 `Origin` 을 **그대로 반사**한다. 응답에 글자 `*` 를 쓰지는 않는다 — `credentials` 를 켠 응답에 `*` 가 오면 브라우저가 통째로 거절한다 |
| 목록 | 값의 형태는 **오리진** — 스킴+호스트+포트. 끝에 `/` 없음, 여러 개면 쉼표. 글자 그대로 일치이고 서브도메인 패턴·포트 생략이 없다 |
| 빈 값 | **꺼진다**(`src/common/http/cors.ts`). 빈 값은 기본이 아니다 |
| 확인 | 기동 로그 끝이 `CORS 꺼짐` 인지 `CORS <목록>` 인지(`src/main.ts`) |

⛔⛔ **`SameSite` 를 `None` 으로 바꾸기 «전에» `*` 를 목록으로 좁혀라**(#621). 지금 `*` 가 안전한
이유는 CORS 가 아니라 **쿠키**다 — 세션 쿠키가 `SameSite=Lax` 라 브라우저가 교차 사이트 요청에
그것을 **안 싣는다**. 그래서 남의 사이트가 CORS 를 통과해도 사용자 세션으로는 아무것도 못 한다.
`None` 이 되는 순간 그 방어가 사라지고, `*` 가 남아 있으면 **아무 사이트나 로그인된 사용자의
세션으로 이 API 를 부른다.** 두 설정이 다른 파일에 있어 한쪽만 바꾸기 쉽다 —
`src/auth/session-cookie.ts` 에도 같은 경고를 달아 두었다.

⛔ **꺼진 상태의 증상이 원인을 가린다.** `enableCors` 를 안 부르면 NestJS 가 `OPTIONS` 핸들러를
달지 않아 preflight 가 **404** 로 떨어진다. 브라우저 콘솔에는 CORS 오류로만 보이고 서버 로그에는
아무것도 안 남는다 — 하노이에서 실제로 이렇게 막혔다(#612).

```bash
# 운영에서 확인
curl -i -X OPTIONS http://<서버>:3100/api/mdm/workers \
  -H 'Origin: http://<관리웹 오리진>' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization'
# 204 + Access-Control-Allow-Origin 이 나와야 한다. 404 면 CORS 가 꺼진 것이다.
# `*` 로 열려 있으면 보낸 Origin 이 «그대로» 되돌아온다.
```

허용 요청 헤더는 `cors.ts` 가 **명시 목록**으로 가진다(`Authorization`·`Content-Type`·
`Idempotency-Key`·`If-Match`·`X-Worker-No`). 명시하면 cors 패키지가 요청 헤더를 반사하지 않으므로,
서버가 새 요청 헤더를 읽기 시작하면 **이 목록에도 더해야** 한다.

## 건드리면 깨지는 것들

**1. `Dockerfile` 의 `prisma generate` 두 곳을 지우지 마세요**

`pnpm install` 만으로는 Prisma Client 가 생성되지 않습니다. `@prisma/client` 의 postinstall 이 자기 패키지 안에서 prisma CLI 를 못 찾아 경고만 남기고 건너뜁니다. 그래서 `deps`(빌드 타입검사용)와 `prod-deps`(런타임용) **양쪽 모두** 필요합니다. `runtime` 스테이지는 `prod-deps` 의 `node_modules` 를 복사해 가므로 `deps` 만으로는 부족합니다.

**2. 컨테이너 타임존은 UTC 입니다. `Asia/Seoul` 등으로 바꾸지 마세요**

공장 로컬 시각이 필요한 계산은 `plant.timezone_code`(IANA 이름)를 씁니다. 서버 TZ 에 의존하면 공장이 둘 이상이 되는 순간 어느 쪽에도 맞지 않습니다.

`postgres` 는 `command: postgres -c timezone=UTC -c log_timezone=UTC` 로 명시합니다 — `initdb` 가 감지한 타임존을 `postgresql.conf` 에 구워버려서 환경변수만으로는 기존 클러스터를 못 바꿉니다.

**3. `docker-compose.prod.yml` 의 이미지 YAML 앵커를 분리하지 마세요**

```yaml
x-api-image: &api-image ${REGISTRY:-hub.crefle.com}/mes/backend:${IMAGE_TAG:-main}
```

`migrate` 와 `api-blue`·`api-green` 이 반드시 같은 이미지를 써야 합니다. 따로 적으면 한쪽 태그만 고치는 사고가 나고, 구버전 코드가 신버전 스키마를 보게 됩니다.

**4. `deploy-dev.yml` 에 `pull_request` 트리거를 추가하지 마세요**

self-hosted runner 가 사내 서버에 있습니다. PR 검증(`ci.yml`)은 GitHub 호스팅 러너에서 돌기 때문에 외부 코드가 사내 서버에서 실행될 경로가 없습니다. 이 성질을 깨면 안 됩니다. (`.github/workflows/` 수정 권한 = 그 서버의 셸 권한이므로 main 브랜치 보호가 보안 통제 역할을 합니다.)

**5. `.env.prod` 는 서버에만 존재합니다**

커밋하지 않습니다. 배포 워크플로도 이 파일을 건드리지 않습니다. 템플릿은 `.env.prod.example` 입니다.

**6. `docker-compose.prod.yml` 의 `x-api.environment` 에서 `CORS_ORIGINS` 를 빼지 마세요**

`docker compose --env-file` 은 **compose 파일의 `${}` 치환용**이지 컨테이너 주입이 아닙니다.
`x-api.environment`(api-blue·api-green 공통)에 적힌 변수만 컨테이너가 봅니다 — 빼면 `.env.prod` 에 아무리 적어도 CORS 가
꺼진 채 뜨고, 증상은 브라우저 쪽 CORS 오류로만 나타납니다(#612). 새 환경변수를 늘릴 때도 같습니다.

**7. `x-api` 의 `attachments` 볼륨·`ATTACHMENT_STORAGE_ROOT` 를 빼지 마세요**

첨부 파일은 이름 있는 볼륨 `omf-mes_attachments` 에 있고, 두 api 가 같은 경로(`x-attachment-root` 앵커)에 겁니다.
환경변수가 빠지면 첨부 업로드·내려받기가 503, 한쪽 api 에서 볼륨이 빠지면 그쪽이 켜졌을 때 올린 파일이 404 가 됩니다.
볼륨 소유권은 이미지가 만든 디렉터리(`Dockerfile` 의 `install -d -o node`)에서 **처음 한 번** 복사됩니다 — 이미지의
node uid(1000)가 바뀌면 기존 볼륨과 어긋납니다.

## 서버

| | 개발 서버 (한국) | 하노이 운영 서버 |
|---|---|---|
| 주소 | **`192.168.1.72`** | (미구성) |
| 도메인 | **`mesapi.crefle.ai`** — 리버스 프록시로 외부 공개 | |
| 프로토콜 | **HTTP** (TLS 없음 — 아래 참조) | |
| 배포 경로 | **`/opt/services/omf-mes-server`** | `install-deploy.sh` 기본값과 같음 |
| 러너 계정 | **`github-runner`** | (러너 없음) |
| 러너 이름 | `captain-System-Product-Name` · 라벨 `self-hosted,Linux,X64,omf-mes-server` | |
| `IMAGE_TAG` | `vX.Y.Z` — 워크플로가 형식을 강제합니다 | `stable` / `vX.Y.Z` |
| `LOG_TZ` | `Asia/Seoul` | `Asia/Ho_Chi_Minh` |
| 배포 | Actions 수동 실행(`deploy-dev.yml`) | `deploy.sh` 수동 (`RELEASE.md`) |

⚠ **`192.168.1.111` 은 예전 개발 서버입니다.** 아직 살아 있고 `/api/health` 도 200 을 주지만
**배포 대상이 아니라 낡은 이미지가 그대로 돌고 있습니다.** 확인할 때 이쪽을 보면 「배포했는데
안 바뀌었다」로 오해합니다 — 현재 배포처는 `192.168.1.72` / `mesapi.crefle.ai` 입니다.

배포 디렉터리 소유자를 배포 계정으로 넘겨 **일상 운영에는 sudo 가 필요 없습니다.**

```bash
sudo mkdir -p /opt/services/omf-mes-server/logs
sudo chown -R github-runner:github-runner /opt/services/omf-mes-server
```

`sudo` 가 필요한 것은 최초 디렉터리 생성과 러너 서비스 등록(`svc.sh install`) 두 번뿐입니다. `deploy.sh`·`rollback.sh` 에는 `sudo` 를 넣지 마세요 — **두 서버가 같은 스크립트를 쓰고**, 스크립트는 **자신이 놓인 위치를 배포 디렉터리로 인식**하므로 경로 하드코딩도 없습니다.

## 블루-그린 배포 — 2026-09-14

배포 중에도 3100 이 끊기지 않게 한다. 전에는 api 를 멈춘 뒤 migrate·재기동을 해 **30~60초** 응답이 없었다.

```
외부 nginx(mesapi.crefle.ai) ─┐
사내망 클라이언트 ────────────┴─▶ :3100 proxy(nginx 컨테이너) ─▶ api-blue  ┐ 평소엔
                                                              └▶ api-green ┘ 한쪽만 뜬다
```

| | |
|---|---|
| 켜진 쪽 | `proxy/active/upstream.conf` 한 줄(`server api-blue:3100 resolve;`). `deploy.sh` 만 쓴다. `DEPLOYED` 의 `active_color` 도 같은 값 |
| 고정 설정 | `proxy/conf.d/omf-api.conf` ← 저장소 `deploy/proxy/omf-api.conf`(배포 때 동기화) |
| 전환 | 반대쪽을 새 이미지로 띄워 healthy → upstream 교체·`nginx -s reload` → proxy 를 거쳐 `/api/health` → 15초 드레인 → 이전 쪽 `stop`(지우지 않음) |
| 실패 | migrate·새 쪽 헬스체크·`nginx -t` 에서 실패하면 **전환하지 않는다**(켜진 쪽이 계속 받는다). 전환 뒤 proxy 경유 헬스체크가 실패하면 이전 쪽으로 되돌린다 |
| 첫 전환 | 옛 단일 `api` 컨테이너가 있으면 새 쪽이 healthy 가 된 뒤 그것을 멈추고 proxy 가 3100 을 넘겨받는다 |

**실측** — 2026-09-14. 로컬 리허설은 실제 `v0.1.7`·`v0.1.8` 이미지에 동시 10 연결로 헬스체크·세션 조회를
계속 부르며 배포했고, 개발 서버는 `mesapi.crefle.ai`·`192.168.1.72:3100` 에 대상마다 2 연결·50ms 간격으로 불렀다.

| 시험 | 결과 |
|---|---|
| 평소 전환 — 개발 서버(v0.1.8 blue→green) | 16,330건 중 실패 **0** · 최대 지연 60ms |
| 평소 전환 — 리허설 | 약 15만 건 중 실패 **1**(reload 순간 keep-alive 연결 경합) · 최대 지연 128ms |
| 첫 전환 — 개발 서버(v0.1.7 단일 api → v0.1.8) | 약 **6초** 끊김(실패 도메인 224·LAN 96). 옛 api 를 멈춘 **뒤** 서버에 없던 nginx 이미지를 받아서다 — 지금은 pull 단계에서 미리 받는다 |
| 첫 전환 — 리허설(nginx 이미지 없음, 미리 받게 고친 뒤) | 실패 40건이 **95ms** 안에 몰림 · 최대 지연 1.1초 |
| migrate 실패 · 새 쪽 헬스체크 실패 · nginx 설정 오류 | 세 번 모두 전환 안 함 · 그동안 실패 0 |
| 켜진 api 컨테이너 재생성(IP 바뀜) | 부팅하는 5.8초만 502, reload 없이 복구 |
| 옛 compose·`deploy.sh` 로 되돌려 배포 | proxy·api-blue·api-green 을 지우고 api 가 3100 을 다시 잡는다 |

**그래서 지켜야 하는 것**

- ⛔ **서버에서 맨손 `docker compose up -d` 금지.** 두 쪽이 다 뜨고 켜진 쪽이 재생성되며 끊긴다. 재기동도 `deploy.sh` 로 한다.
- ⚠ **옛 코드가 새 스키마 위에서 수십 초 돈다**(새 쪽 기동~드레인). 컬럼 이름 변경·기본값 없는 `NOT NULL` 추가도 두 릴리스로 나눈다 — `deploy/RELEASE.md` 「마이그레이션 작성 규칙」.
- ⚠ **proxy 정의(이미지·포트·마운트)를 바꾼 배포는 proxy 가 재생성되며 잠깐 끊긴다.** `omf-api.conf` 내용만 바꾼 것은 reload 로 들어가 끊기지 않는다.
- `client_max_body_size 12m` 를 앱 업로드 상한(10MB) 아래로 줄이지 않는다 — nginx 기본은 1MB 다.
- 첨부 파일은 두 쪽이 함께 거는 이름 있는 볼륨 `omf-mes_attachments` 에 있다 — 전환해도 올린 파일이 그대로다. `pg_dump` 에는 들지 않아 백업은 `deploy/RELEASE.md` 3번의 볼륨 백업을 함께 뜬다.
- 로그는 `logs api-blue api-green proxy`. 앱이 보는 접속 IP 는 proxy 다(지금 코드는 IP 를 쓰지 않는다).

**급할 때 이전 쪽으로 되돌리기** — 보통은 `./rollback.sh <이전 태그>` 로 충분하다(같은 방식으로 끊김 없이 다시 전환, 1분 안팎). 그것도 못 기다릴 때만, 멈춰 있는 이전 쪽을 켜서 넘긴다:

```bash
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
$C start api-blue                                   # DEPLOYED 의 active_color 반대편
docker ps --filter name=api-blue                    # (healthy) 확인
printf 'server api-blue:3100 resolve;\n' > proxy/active/upstream.conf
$C exec proxy nginx -t && $C exec proxy nginx -s reload
```

⚠ 이렇게 넘기면 `.env.prod`·`DEPLOYED` 가 실제와 달라진다. 뒤이어 `./rollback.sh <그 태그>` 로 맞춰 둔다.

## 파일 지도

| 파일 | 역할 |
|---|---|
| `Dockerfile` | 4단계 멀티스테이지. `deps`/`prod-deps` 에 `prisma generate` |
| `docker-compose.prod.yml` | 배포용. Harbor 이미지 + postgres + migrate + api-blue·api-green + proxy(nginx) |
| `docker-compose.yml` | 로컬 개발 DB 만 |
| `.env.prod.example` | 배포 환경변수 템플릿 |
| `.github/workflows/ci.yml` | PR 검증 — lint·typecheck·unit / docker build / e2e |
| `.github/workflows/build-push.yml` | main·태그 push → Harbor 업로드 |
| `.github/workflows/deploy-dev.yml` | 개발 서버 배포 (self-hosted runner) |
| `deploy/deploy.sh` | 블루-그린: pull → migrate → 반대쪽 api → 전환 → 이전 쪽 중지 |
| `deploy/proxy/omf-api.conf` | proxy(nginx) 고정 설정 — 서버의 `proxy/conf.d/` 로 동기화 |
| `deploy/rollback.sh` | `IMAGE_TAG` 를 바꾸고 배포 (릴리스 적용에도 사용) |
| `deploy/RUNNER.md` | 개발 서버 runner 구성 절차 |
| `deploy/RELEASE.md` | 하노이 현장 배포 런북 |
| `deploy/HANDOFF.md` | 남은 작업 인계 (T-5 이후) |
| `deploy/omf-mes-deploy.crontab` | 러너를 못 쓸 때의 대안 (현재 미사용) |
| `CI-CD.md` | 무엇을 왜 만들었는지의 기록 + 적용 진행표 |

## 알아둘 동작

**`docker compose` 는 셸 환경변수를 `--env-file` 보다 우선합니다.** `deploy.sh` 도 같은 규칙을 따르게 맞춰뒀습니다(`IMAGE_TAG_OVERRIDE`). 두 쪽이 어긋나면 `DEPLOYED` 의 `image_tag` 가 실제로 뜬 이미지와 달라집니다.

```bash
IMAGE_TAG=v1.2.0 ./deploy.sh    # 일회성, .env.prod 는 그대로
./rollback.sh v1.2.0            # .env.prod 를 영구히 변경
```

⛔ **자동 배포(`deploy-dev.yml`)는 «영구» 쪽을 씁니다** — `./rollback.sh "$IMAGE_TAG"`.

일회성으로 부르면 배포한 태그가 `.env.prod` 에 남지 않아, 나중에 누가 서버에서 맨손으로
`./deploy.sh` 를 한 번만 돌려도 **옛 태그로 조용히 되돌아갑니다.** 증상이 「배포는 성공했는데
코드가 옛날」이라 원인을 짚기 어렵습니다 — 실제로 그렇게 됐습니다(#628).

⚠ 하노이에서 같은 일이 나면 더 나쁩니다. Prisma 마이그레이션은 forward-only 라
**구버전 코드가 신버전 스키마를 보게 됩니다.**

워크플로에 「배포 확인」 단계를 두어 `DEPLOYED` 의 `image_tag`(이번에 뜬 것)와 `.env.prod` 의
`IMAGE_TAG`(다음에 뜰 것)가 **둘 다** 요청값인지 검사합니다. 하나라도 어긋나면 실패합니다.

**Harbor 자격증명은 `~/.docker` 가 아니라 배포 디렉터리 안(`$APP_DIR/.docker`)입니다.** 디렉터리마다 다른 로봇 계정을 쓸 수 있게 한 것입니다. 로그인도 같은 경로로 해야 합니다.

```bash
docker --config /opt/omf-mes/.docker login hub.crefle.com -u 'robot$mes+server-pull'
```

`deploy.sh` 는 이걸 **`DOCKER_CONFIG` 환경변수로** 겁니다. `docker --config` 플래그로 바꾸지 마세요 — 플래그는 compose 플러그인에 **인자로만** 전달되고 `DOCKER_CONFIG` 를 설정하지 않아서, 같은 스크립트의 `docker inspect`·`tag`·`prune` 이 각자 `~/.docker` 를 보게 됩니다.

**"서버에 뭐가 돌고 있나"는 태그로 답할 수 없습니다.** `:main` 은 가변 태그라 배포 당시의 main 과 지금의 main 이 다릅니다. `DEPLOYED` 의 `git_revision`(이미지에 박힌 커밋 해시)으로 대조하세요.

```bash
grep git_revision /opt/omf-mes/DEPLOYED     # 서버
git rev-parse origin/main                   # 로컬 — 같아야 함
```

`api_image_id` 는 **config blob digest** 이고 Harbor·빌드 로그가 보여주는 것은 **manifest digest** 입니다. 같은 이미지인데도 값이 달라서 서로 대조하면 안 됩니다. Harbor 와 맞춰볼 값은 `image_digest` 입니다.

**헬스체크(`/api/health`)는 DB 까지 찌릅니다**(`SELECT 1`). Prisma 초기화 실패도 여기서 걸리고, 새 쪽이 걸리면 `deploy.sh` 는 전환하지 않습니다. 다만 업무 로직 정상까지 보장하지는 않습니다.

**개발 서버 배포는 `workflow_run` 으로 연쇄됩니다.** 이 트리거는 기본 브랜치에 있는 워크플로 파일만 동작하므로, 브랜치에서 테스트해도 자동 실행은 안 걸립니다. `workflow_dispatch`(수동 버튼)로 시험하세요.

**러너가 죽으면 배포가 조용히 멈춥니다.** Actions 는 러너가 없으면 실패가 아니라 큐 대기 상태가 되어 알림이 오지 않습니다.

**러너는 `hulk` 로 돌립니다 — root 로 올리지 마세요.** 배포에 필요한 건 docker 접근뿐이고, root 로 올려도 얻는 게 없습니다. `svc.sh` 는 `run_as_user=${arg_2:-$SUDO_USER}` 라서 **root 셸에서 인자 없이** `./svc.sh install` 을 치면 러너가 root 로 뜹니다. 사용자명을 명시하고 확인하세요 — `systemctl show -p User --value 'actions.runner.*.service'`.

다만 **docker 그룹은 이미 root 와 사실상 동등합니다**(`docker run -v /:/host`). 러너를 어느 계정으로 돌리든 "`.github/workflows/` 를 고칠 수 있는 사람 = 그 서버의 root" 라는 사실은 변하지 않습니다.

**그리고 그 통제가 지금 비어 있습니다.** 조직이 GitHub Free 라 private 레포에 브랜치 보호도 Ruleset 도 걸리지 않습니다(API 가 `403 Upgrade to GitHub Pro`). 개발 서버에는 다른 팀 서비스가 30개 넘게 함께 돌고, 이 레포 쓰기 권한자는 8명입니다. 미결 사항이며 선택지는 `deploy/HANDOFF.md` T-9 에 정리해 두었습니다 — 플랜 업그레이드, 러너 격리(rootless Docker·socket proxy·전용 호스트), 쓰기 권한 축소.

**개발 서버에는 러너가 둘입니다.** `~/actions-runner` 는 `CREFLEINC/reports` 용이고 `~/actions-runner-omf` 가 우리 것입니다. 앞의 디렉터리에서 `config.sh` 를 돌리면 남의 러너 등록이 날아갑니다.
