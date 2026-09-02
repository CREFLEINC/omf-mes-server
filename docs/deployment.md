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

API 는 평문 HTTP `:3100` 으로 노출한다. 리버스 프록시도 인증서도 두지 않는다.
전제는 `C11` 이다 — 운영은 **사내망 전용**이고 인터넷은 설치·유지보수 시점에만 열린다.

**그래서 이렇게 돼 있다**

| | |
|---|---|
| `COOKIE_SECURE=false` | 켜면 브라우저가 세션 쿠키를 되보내지 않아 **관리웹 로그인이 통째로 안 된다.** 서버 로그에는 아무 오류도 안 남아 진단이 어렵다 |
| 남아 있는 보호 | 쿠키는 `HttpOnly`(스크립트 차단) · `SameSite=Lax`(크로스사이트 POST 차단) |

⛔ **무엇을 받아들인 결정인지 적어 둔다** — 사내망 구간에서 **로그인 비밀번호와 세션 토큰이
평문으로 흐른다.** 같은 망에 있는 누군가가 그것을 볼 수 있다. 이 결정은 「사내망은 신뢰한다」를
전제로 하며, 그 전제가 바뀌면(무선 구간 추가·외부 접속 허용) **먼저 되돌려야 하는 결정**이다.

**되돌리는 방법** — 앞단에 TLS 를 두고 `.env.prod` 에 `COOKIE_SECURE=true` 를 넣는다.
코드는 그것만 보므로 다른 변경은 필요 없다.

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

`migrate` 와 `api` 가 반드시 같은 이미지를 써야 합니다. 따로 적으면 한쪽 태그만 고치는 사고가 나고, 구버전 코드가 신버전 스키마를 보게 됩니다.

**4. `deploy-dev.yml` 에 `pull_request` 트리거를 추가하지 마세요**

self-hosted runner 가 사내 서버에 있습니다. PR 검증(`ci.yml`)은 GitHub 호스팅 러너에서 돌기 때문에 외부 코드가 사내 서버에서 실행될 경로가 없습니다. 이 성질을 깨면 안 됩니다. (`.github/workflows/` 수정 권한 = 그 서버의 셸 권한이므로 main 브랜치 보호가 보안 통제 역할을 합니다.)

**5. `.env.prod` 는 서버에만 존재합니다**

커밋하지 않습니다. 배포 워크플로도 이 파일을 건드리지 않습니다. 템플릿은 `.env.prod.example` 입니다.

## 서버

| | 개발 서버 (한국) | 하노이 운영 서버 |
|---|---|---|
| 배포 경로 | `/opt/omf-mes` | `/opt/omf-mes` (미구성) |
| 계정 | `hulk` — docker 그룹, sudo 가능 | |
| 서버 TZ | `Etc/UTC` | |
| `IMAGE_TAG` | `main` | `stable` / `vX.Y.Z` |
| `LOG_TZ` | `Asia/Seoul` | `Asia/Ho_Chi_Minh` |
| 배포 | runner 자동 + 수동 버튼 | `deploy.sh` 수동 |

배포 디렉터리는 `/opt/omf-mes` 이고, 소유자를 배포 계정으로 넘겨 **일상 운영에는 sudo 가 필요 없습니다.**

```bash
sudo mkdir -p /opt/omf-mes/logs
sudo chown -R hulk:hulk /opt/omf-mes
```

`sudo` 가 필요한 것은 최초 디렉터리 생성과 러너 서비스 등록(`svc.sh install`) 두 번뿐입니다. `deploy.sh`·`rollback.sh` 에는 `sudo` 를 넣지 마세요 — **두 서버가 같은 스크립트를 쓰고**, 스크립트는 **자신이 놓인 위치를 배포 디렉터리로 인식**하므로 경로 하드코딩도 없습니다.

## 파일 지도

| 파일 | 역할 |
|---|---|
| `Dockerfile` | 4단계 멀티스테이지. `deps`/`prod-deps` 에 `prisma generate` |
| `docker-compose.prod.yml` | 배포용. Harbor 이미지 + postgres + migrate + api |
| `docker-compose.yml` | 로컬 개발 DB 만 |
| `.env.prod.example` | 배포 환경변수 템플릿 |
| `.github/workflows/ci.yml` | PR 검증 — lint·typecheck·unit / docker build / e2e |
| `.github/workflows/build-push.yml` | main·태그 push → Harbor 업로드 |
| `.github/workflows/deploy-dev.yml` | 개발 서버 배포 (self-hosted runner) |
| `deploy/deploy.sh` | pull → migrate → api → 헬스체크 → 실패 시 자동 롤백 |
| `deploy/rollback.sh` | `IMAGE_TAG` 를 바꾸고 배포 (릴리스 적용에도 사용) |
| `deploy/RUNNER.md` | 개발 서버 runner 구성 절차 |
| `deploy/RELEASE.md` | 하노이 현장 배포 런북 |
| `deploy/HANDOFF.md` | 남은 작업 인계 (T-5 이후) |
| `deploy/omf-mes-deploy.crontab` | 러너를 못 쓸 때의 대안 (현재 미사용) |
| `CI-CD.md` | 무엇을 왜 만들었는지의 기록 + 적용 진행표 |

## 알아둘 동작

**`docker compose` 는 셸 환경변수를 `--env-file` 보다 우선합니다.** `deploy.sh` 도 같은 규칙을 따르게 맞춰뒀습니다(`IMAGE_TAG_OVERRIDE`). 두 쪽이 어긋나면 롤백 시 엉뚱한 태그에 이미지를 붙입니다.

```bash
IMAGE_TAG=v1.2.0 ./deploy.sh    # 일회성, .env.prod 는 그대로
./rollback.sh v1.2.0            # .env.prod 를 영구히 변경
```

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

**헬스체크(`/api/health`)는 DB 까지 찌릅니다**(`SELECT 1`). Prisma 초기화 실패도 여기서 걸리고, `deploy.sh` 가 자동 롤백합니다. 다만 업무 로직 정상까지 보장하지는 않습니다.

**개발 서버 배포는 `workflow_run` 으로 연쇄됩니다.** 이 트리거는 기본 브랜치에 있는 워크플로 파일만 동작하므로, 브랜치에서 테스트해도 자동 실행은 안 걸립니다. `workflow_dispatch`(수동 버튼)로 시험하세요.

**러너가 죽으면 배포가 조용히 멈춥니다.** Actions 는 러너가 없으면 실패가 아니라 큐 대기 상태가 되어 알림이 오지 않습니다.

**러너는 `hulk` 로 돌립니다 — root 로 올리지 마세요.** 배포에 필요한 건 docker 접근뿐이고, root 로 올려도 얻는 게 없습니다. `svc.sh` 는 `run_as_user=${arg_2:-$SUDO_USER}` 라서 **root 셸에서 인자 없이** `./svc.sh install` 을 치면 러너가 root 로 뜹니다. 사용자명을 명시하고 확인하세요 — `systemctl show -p User --value 'actions.runner.*.service'`.

다만 **docker 그룹은 이미 root 와 사실상 동등합니다**(`docker run -v /:/host`). 러너를 어느 계정으로 돌리든 "`.github/workflows/` 를 고칠 수 있는 사람 = 그 서버의 root" 라는 사실은 변하지 않습니다.

**그리고 그 통제가 지금 비어 있습니다.** 조직이 GitHub Free 라 private 레포에 브랜치 보호도 Ruleset 도 걸리지 않습니다(API 가 `403 Upgrade to GitHub Pro`). 개발 서버에는 다른 팀 서비스가 30개 넘게 함께 돌고, 이 레포 쓰기 권한자는 8명입니다. 미결 사항이며 선택지는 `deploy/HANDOFF.md` T-9 에 정리해 두었습니다 — 플랜 업그레이드, 러너 격리(rootless Docker·socket proxy·전용 호스트), 쓰기 권한 축소.

**개발 서버에는 러너가 둘입니다.** `~/actions-runner` 는 `CREFLEINC/reports` 용이고 `~/actions-runner-omf` 가 우리 것입니다. 앞의 디렉터리에서 `config.sh` 를 돌리면 남의 러너 등록이 날아갑니다.
