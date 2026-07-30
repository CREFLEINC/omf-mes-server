# omf-mes-server

OMF MES 백엔드 API. NestJS 11 + Prisma 6 + PostgreSQL 16, pnpm 11 / SWC 빌드.

현장은 **베트남 하노이**(UTC+7, 3교대 24시간 가동), 개발 서버는 한국입니다.

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

## 건드리면 깨지는 것들

**1. `Dockerfile` 의 `prisma generate` 두 곳을 지우지 마세요**

`pnpm install` 만으로는 Prisma Client 가 생성되지 않습니다. `@prisma/client` 의 postinstall 이 자기 패키지 안에서 prisma CLI 를 못 찾아 경고만 남기고 건너뜁니다. 그래서 `deps`(빌드 타입검사용)와 `prod-deps`(런타임용) **양쪽 모두** 필요합니다. `runtime` 스테이지는 `prod-deps` 의 `node_modules` 를 복사해 가므로 `deps` 만으로는 부족합니다.

**2. 컨테이너 타임존은 UTC 입니다. `Asia/Seoul` 등으로 바꾸지 마세요**

공장 로컬 시각이 필요한 계산은 `plant.timezone_code`(IANA 이름)를 씁니다. 서버 TZ 에 의존하면 공장이 둘 이상이 되는 순간 어느 쪽에도 맞지 않습니다.

`postgres` 는 `command: postgres -c timezone=UTC -c log_timezone=UTC` 로 명시합니다 — `initdb` 가 감지한 타임존을 `postgresql.conf` 에 구워버려서 환경변수만으로는 기존 클러스터를 못 바꿉니다.

**3. `business_date` 는 타임존 캐스팅으로 구하면 안 됩니다**

`shift.crosses_midnight` 때문에 "실적이 속한 교대의 시작일"은 로컬 날짜 캐스팅으로 얻을 수 없습니다. 하노이 야간 교대(22:00~06:00)를 예로 들면, 02-02 05:30 의 실적은 `business_date` 가 02-01 이어야 하는데 로컬 캐스팅은 02-02 를 줍니다. 반대로 02-02 06:30(주간 교대 시작)은 UTC 캐스팅이 02-01 을 줘서 틀립니다. **어떤 TZ 로도 맞지 않습니다.**

```
도출 순서:
  실적 timestamptz → plant.timezone_code 로 로컬 시각 변환
  → 그 로컬 시각이 속한 shift 판정 (start_time/end_time/crosses_midnight)
  → 그 shift 가 시작된 로컬 날짜 = business_date
```

`@db.Timestamptz` 274개는 절대 시각이라 안전합니다. 위험한 건 `@db.Date` 41개입니다.

**4. `docker-compose.prod.yml` 의 이미지 YAML 앵커를 분리하지 마세요**

```yaml
x-api-image: &api-image ${REGISTRY:-hub.crefle.com}/mes/backend:${IMAGE_TAG:-main}
```

`migrate` 와 `api` 가 반드시 같은 이미지를 써야 합니다. 따로 적으면 한쪽 태그만 고치는 사고가 나고, 구버전 코드가 신버전 스키마를 보게 됩니다.

**5. 마이그레이션은 하위 호환으로 작성하세요**

`prisma migrate deploy` 는 forward-only 입니다. 되돌리는 명령이 없습니다. 컬럼·테이블 삭제는 두 릴리스로 나눕니다 — 먼저 코드에서 사용을 제거해 배포하고, 다음 릴리스에서 컬럼을 지웁니다. 한 릴리스에 둘을 합치면 그 배포는 되돌릴 수 없게 됩니다.

**6. `deploy-dev.yml` 에 `pull_request` 트리거를 추가하지 마세요**

self-hosted runner 가 사내 서버에 있습니다. PR 검증(`ci.yml`)은 GitHub 호스팅 러너에서 돌기 때문에 외부 코드가 사내 서버에서 실행될 경로가 없습니다. 이 성질을 깨면 안 됩니다. (`.github/workflows/` 수정 권한 = 그 서버의 셸 권한이므로 main 브랜치 보호가 보안 통제 역할을 합니다.)

**7. `.env.prod` 는 서버에만 존재합니다**

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

**헬스체크(`/api/health`)는 DB 까지 찌릅니다**(`SELECT 1`). Prisma 초기화 실패도 여기서 걸리고, `deploy.sh` 가 자동 롤백합니다. 다만 업무 로직 정상까지 보장하지는 않습니다.

**개발 서버 배포는 `workflow_run` 으로 연쇄됩니다.** 이 트리거는 기본 브랜치에 있는 워크플로 파일만 동작하므로, 브랜치에서 테스트해도 자동 실행은 안 걸립니다. `workflow_dispatch`(수동 버튼)로 시험하세요.

**러너가 죽으면 배포가 조용히 멈춥니다.** Actions 는 러너가 없으면 실패가 아니라 큐 대기 상태가 되어 알림이 오지 않습니다.

**러너는 `hulk` 로 돌립니다 — root 로 올리지 마세요.** 배포에 필요한 건 docker 접근뿐이고, root 로 올려도 얻는 게 없습니다. `svc.sh` 는 `run_as_user=${arg_2:-$SUDO_USER}` 라서 **root 셸에서 인자 없이** `./svc.sh install` 을 치면 러너가 root 로 뜹니다. 사용자명을 명시하고 확인하세요 — `systemctl show -p User --value 'actions.runner.*.service'`.

다만 **docker 그룹은 이미 root 와 사실상 동등합니다**(`docker run -v /:/host`). 러너를 어느 계정으로 돌리든 "`.github/workflows/` 를 고칠 수 있는 사람 = 그 서버의 root" 라는 사실은 변하지 않습니다. 이걸 실제로 끊으려면 rootless Docker 나 socket proxy 가 필요하고, 그전까지는 **main 브랜치 보호가 유일한 실질 통제**입니다.
