# omf-mes-server CI/CD 적용

레포: `git@github.com:CREFLEINC/omf-mes-server.git`  
이미지: `hub.crefle.com/mes/backend`

> **이 문서의 역할** — 무엇을 왜 만들었는지의 기록과, 전체 적용 진행표입니다.
>
> **실행 명령은 여기 두지 않습니다.** 절차를 두 곳에 적으면 반드시 어긋납니다(실제로 한 번 어긋나서 이 문서를 고치고 있습니다). 각 단계는 담당 런북을 가리킵니다.
>
> | 문서 | 내용 |
> |---|---|
> | `CLAUDE.md` | 전역 규칙 요약 (개발 단위·도메인·배포 금지 목록) |
> | `docs/deployment.md` | 배포 구조, 서버 정보, 건드리면 깨지는 것들, 운영 동작 |
> | `deploy/RUNNER.md` | 개발 서버 구성 + self-hosted runner 설치 |
> | `deploy/RELEASE.md` | 하노이 현장 배포 런북 |
> | `deploy/HANDOFF.md` | 남은 작업 인계 목록 (T-5 이후) |

---

## 0. 먼저 — 발견한 버그 하나

**당시 Dockerfile 은 빌드가 실패했습니다.** CI/CD 와 별개로 고쳐야 하는 문제였고, 지금은 수정되어 있습니다. 같은 실수를 반복하지 않도록 기록을 남깁니다.

Dockerfile 주석에 이렇게 적혀 있었습니다:

> `@prisma/client`의 postinstall이 스키마를 읽어 클라이언트를 생성한다 — 설치 전에 있어야 한다.

실제로는 생성하지 않습니다. 이 프로젝트의 lockfile 로 리눅스에서 `pnpm install --frozen-lockfile` 을 돌려 확인했습니다:

```
.../node_modules/@prisma/client postinstall: warning In order to use "@prisma/client",
please install Prisma CLI. You can install it with "npm add -D prisma".
```

`@prisma/client` 의 postinstall 은 **자기 패키지 안에서** prisma CLI 를 찾습니다. `prisma` 가 앱의 dependencies 에 있어도 pnpm 의 격리 링킹(`.npmrc` 의 `node-linker=isolated`) 때문에 거기서는 안 보입니다. 그래서 경고만 남기고 조용히 건너뜁니다. 결과물은 스텁입니다 — `index.d.ts` 가 3,989 바이트(정상 생성 시 수 MB), 쿼리 엔진 바이너리 없음. `node-linker=hoisted` 로 바꿔도 동일했습니다.

**왜 로컬에서는 멀쩡한가**: `pnpm prisma:generate` 를 직접 돌려서 생성해 두었기 때문입니다. Dockerfile 에는 그 단계가 없었습니다.

**터지는 지점 두 곳**

1. **build 단계** — `nest-cli.json` 의 `typeCheck: true` 라 `nest build` 가 tsc 타입검사를 함께 돌립니다. `src` 곳곳에서 모델 타입을 이름으로 가져옵니다:
   ```ts
   import { app_user, Prisma, user_data_scope, user_role } from '@prisma/client';
   import { Prisma, production_result } from '@prisma/client';
   import { terminal, worker } from '@prisma/client';
   ```
   스텁 클라이언트에는 이 타입들이 없으므로 타입검사가 실패합니다.

2. **런타임** — `runtime` 스테이지가 `prod-deps` 의 `node_modules` 를 그대로 복사해 갑니다. 거기에도 생성물이 없으므로, 설령 빌드를 통과시켜도 첫 쿼리에서 이 에러로 죽습니다:
   ```
   @prisma/client did not initialize yet. Please run "prisma generate"
   ```

**수정**: `deps` 와 `prod-deps` 두 단계 **모두**에 `RUN pnpm exec prisma generate` 를 추가했습니다.

`deps` 만으로는 부족합니다 — 런타임이 가져가는 건 `prod-deps` 쪽이기 때문입니다. `prisma` CLI 가 devDependencies 가 아니라 dependencies 에 있어서 `--prod` 설치 후에도 실행 가능한 점은 별도로 확인했습니다. `prisma.config.ts` 가 TypeScript 인데도 devDependencies 없이 로드되는 것(`Loaded Prisma config from prisma.config.ts`)까지 확인했으니, 런타임의 `migrate deploy` 도 문제없습니다.

> 이 두 `prisma generate` 는 지우면 조용히 깨집니다. `docs/deployment.md` 의 "건드리면 깨지는 것들" 1번에도 적어두었습니다.

---

## 1. 구성 파일

**수정**

| 파일 | 변경 |
|---|---|
| `Dockerfile` | `deps` · `prod-deps` 에 `prisma generate` 추가 (위 참조) |
| `docker-compose.prod.yml` | `build:` → Harbor 이미지 참조. migrate·api 가 같은 이미지를 쓰도록 YAML 앵커로 고정. TZ·postgres 타임존 UTC 명시 |
| `docker-compose.yml` | 로컬 개발 DB. TZ·postgres 타임존 UTC 명시 |
| `.env.prod.example` | `REGISTRY`·`LOG_TZ` 추가, `IMAGE_TAG` 의 의미를 배포 채널로 변경 |

**신규**

| 파일 | 역할 |
|---|---|
| `.github/workflows/ci.yml` | PR 검증 — lint · typecheck · unit test / docker build / e2e |
| `.github/workflows/build-push.yml` | main·태그 push 시 Harbor 업로드 |
| `.github/workflows/deploy-dev.yml` | 개발 서버 배포 (self-hosted runner) |
| `deploy/deploy.sh` · `rollback.sh` | 서버 배포·롤백 |
| `deploy/omf-mes-deploy.logrotate` | 수동 배포 로그 로테이션 |
| `deploy/omf-mes-deploy.crontab` | 러너를 못 쓸 때의 대안 (현재 미사용) |
| `deploy/RUNNER.md` · `RELEASE.md` · `HANDOFF.md` | 런북·인계 |

`deploy/` 는 레포에 함께 두고 서버로 복사해 쓰는 용도입니다. 러너가 붙은 뒤에는 워크플로가 자동으로 동기화합니다.

**compose 의 이미지 앵커**

```yaml
x-api-image: &api-image ${REGISTRY:-hub.crefle.com}/mes/backend:${IMAGE_TAG:-main}
```

migrate 와 api 에 각각 이미지를 적으면 한쪽 태그만 고치는 사고가 납니다. 그러면 **구버전 코드가 신버전 스키마를 보게 되는데**, 원인 찾기가 대단히 어려운 유형입니다. 앵커로 묶어서 구조적으로 막았습니다.

---

## 2. 태그 규칙

| 이벤트 | 이미지 태그 |
|---|---|
| main push/merge | `:main`, `:sha-a1b2c3d` |
| `git tag v1.2.3` | `:v1.2.3`, `:stable`, `:sha-a1b2c3d` |

개발 서버는 `:main` 을, 하노이 운영 서버는 `:stable` 또는 `:vX.Y.Z` 를 씁니다. 서버가 어느 태그를 당길지는 각자의 `.env.prod` 의 `IMAGE_TAG` 가 정합니다.

**개발 서버 배포는 시각이 아니라 이벤트에 걸립니다.** main 머지 → `Build & Push to Harbor` 성공 → `Deploy to dev server` 자동 실행. 수 분 내에 반영됩니다.

---

## 3. 적용 진행표

명령은 각 런북에 있습니다. 여기서는 **무엇이 끝났고 무엇이 남았는지**만 봅니다.

### Phase 1 — Harbor

- [ ] **1-1.** `hub.crefle.com` → Projects → `+ NEW PROJECT` → 이름 `mes`, Private
  - 이미지 경로가 `mes/backend` 이므로 프로젝트명은 반드시 `mes` 여야 합니다
- [ ] **1-2.** `mes` → Robot Accounts → `github-actions` 생성, **Push + Pull**
  - **생성 직후 토큰을 즉시 복사하세요. 다시 볼 수 없습니다**
  - 계정명은 `robot$mes+github-actions` 형태 — `$` 와 `+` 포함 전체를 복사
- [ ] **1-3.** 같은 화면에서 `server-pull` 생성, **Pull 만**

### Phase 2 — GitHub Secrets

- [ ] **2-1.** 레포 → Settings → Secrets and variables → Actions

  | Name | Secret |
  |---|---|
  | `HARBOR_USERNAME` | `robot$mes+github-actions` |
  | `HARBOR_PASSWORD` | 1-2 의 토큰 |

> Phase 1·2 의 완료 여부를 아직 확인하지 못했습니다 — `HANDOFF.md` T-5 참조. `Build & Push to Harbor` 가 실패했다면 대부분 `Log in to Harbor` 단계이고, 원인은 Secret 오타 또는 Harbor 프로젝트 부재입니다.

### Phase 3 — 파이프라인 검증

- [x] **3-1.** 로컬 `docker build --target runtime` 통과 — Prisma 수정이 실제로 먹는지 여기서 판가름납니다
- [x] **3-2.** PR 생성 → `verify` · `Docker build` · `E2E` 세 job 초록
- [x] **3-3.** main 머지 (PR #1, `8bbf5c1`)
- [ ] **3-4.** Harbor `mes/backend` → Artifacts 에 `main`, `sha-xxxxxxx` 태그 확인

### Phase 4 — 개발 서버 구성

절차: **`deploy/RUNNER.md` 1번 절**

- [x] **4-1.** 서버에서 Harbor 아웃바운드 확인
- [x] **4-2.** Docker 설치 확인 — x86_64, `Etc/UTC`, Docker 28.0.1 / Compose v2.33.1
- [ ] **4-3.** `sudo usermod -aG docker hulk` — **재로그인해야 반영됩니다**
- [ ] **4-4.** 배포 디렉터리 `/opt/omf-mes` 생성, 소유자를 배포 계정으로
- [ ] **4-5.** `.env.prod` 작성 — `반드시_교체할_것` 문자열이 남아 있지 않을 것
- [ ] **4-6.** Harbor 로그인 — **배포 디렉터리 안으로** (`~/.docker` 아님)
  - `docker --config /opt/omf-mes/.docker login hub.crefle.com -u 'robot$mes+server-pull'`
  - 사용자명은 작은따옴표 필수 — 안 감싸면 셸이 `$mes` 를 변수로 먹습니다
  - `chmod 700` — `config.json` 은 암호화가 아니라 base64 입니다
- [ ] **4-7.** `./deploy.sh` 를 **손으로 한 번 성공시킬 것** — 러너를 붙이기 전에 배포 자체가 되는지 확인하는 게 순서입니다
- [ ] **4-8.** 초기 시드 1회

`deploy.sh` 는 마이그레이션만 돌리고 시드는 돌리지 않습니다 — 자동 실행되면 안 되는 작업이라 분리했습니다. 관리자 초기 비밀번호는 **이때 한 번만** 출력됩니다.

### Phase 5 — 자동 배포 (self-hosted runner)

절차: **`deploy/RUNNER.md` 2~5번 절**

- [x] **5-1.** 러너 등록 — `omf-dev-01`, 라벨 `omf-dev`, `~/actions-runner-omf`
  - **`~/actions-runner` 는 `CREFLEINC/reports` 러너입니다.** 거기서 `config.sh` 를 돌리면 그쪽이 날아갑니다
- [x] **5-2.** 상주 — `gh-runner-omf.service` (사용자 systemd, `Restart=always`)
- [ ] **5-3.** 수동 실행(`workflow_dispatch`) 으로 4개 스텝 초록 확인
- [ ] **5-4.** main 에 커밋 하나 머지해서 자동 연쇄 확인
- [ ] **5-5.** (선택) logrotate 등록 — 수동 배포가 잦은 경우에만

> cron 은 쓰지 않습니다. `/etc/cron.d` 가 가능해졌지만 cron 의 단점(최대 24시간 지연, 빌드 완료와 무관, 실패 알림 없음, 이력 없음)은 애초에 권한 문제가 아니었습니다. `omf-mes-deploy.crontab` 은 러너를 못 쓰게 될 때의 대안으로만 남겨둡니다.

### Phase 6 — 보호와 리허설

- [ ] ~~**6-1.** main 브랜치 보호~~ — **현재 플랜에서 불가.** `HANDOFF.md` T-9 참조
- [ ] **6-2.** 릴리스 태그 리허설 — `git tag v0.1.0` → Harbor 에 `v0.1.0`, `stable` 생성 확인
- [ ] **6-3.** 롤백 리허설 — `./rollback.sh v0.1.0` → 헬스체크 → `./rollback.sh main` 으로 **반드시 되돌리기**

`rollback.sh` 는 `.env.prod` 의 `IMAGE_TAG` 를 영구히 바꿉니다. 고정한 채 잊으면 그 뒤로 계속 같은 버전만 배포됩니다.

**6-1 은 원래 5-2(러너 설치)보다 먼저 해야 했습니다.** 러너를 붙이면 `.github/workflows/` 수정 권한이 곧 그 서버의 root 권한이 되기 때문입니다(docker 그룹 = root). 그런데 조직이 GitHub Free 라 private 레포에는 브랜치 보호도 Ruleset 도 걸리지 않습니다 — API 가 `403 Upgrade to GitHub Pro` 를 반환합니다.

**즉 러너는 붙었는데 그 관문은 비어 있는 상태입니다.** 미룰 문제가 아니라 결정할 문제입니다: 플랜 업그레이드 / 러너 격리(rootless Docker·socket proxy·전용 호스트) / 쓰기 권한 축소 중 하나. 상세한 위협 모델과 선택지는 `HANDOFF.md` T-9 에 정리해 두었습니다.

---

## 4. 마이그레이션 — 알고 계셔야 할 것

"자동 적용, 백업 없이"로 구성했습니다. 배포마다 `migrate deploy` 가 돌고, 새 마이그레이션이 있으면 스키마가 자동으로 바뀝니다.

`prisma migrate deploy` 는 **forward-only** 입니다. 되돌리는 명령이 없습니다. 그래서 다음 상황이 가능합니다:

> 스키마를 바꾼 배포 → 마이그레이션 성공 → api 헬스체크 실패 → `deploy.sh` 가 api 를 구버전 이미지로 롤백 → **구버전 코드가 신버전 스키마 위에서 돕니다.**

`deploy.sh` 는 이 상황을 로그에 명시적으로 경고합니다. 컬럼 추가 정도면 대개 무사하지만, 컬럼 삭제·타입 변경·NOT NULL 추가는 구버전 코드를 깨뜨립니다.

**비용이 거의 없는 대비책 두 가지**

1. **마이그레이션을 하위 호환으로 작성한다.** 컬럼 삭제는 두 번의 릴리스로 나눕니다 — 먼저 코드에서 사용을 제거해 배포하고, 다음 릴리스에서 컬럼을 지웁니다. 규칙 하나 정하는 것으로 위 시나리오의 대부분이 사라집니다.
2. **스키마를 바꾸는 릴리스 전에는 백업을 뜬다.** `pg_dump -Fc` 한 줄이고, 절차는 `deploy/RELEASE.md` 3번 절에 있습니다. 하노이는 이게 특히 중요합니다 — 3교대라 되돌릴 창이 없습니다.

## 5. 이 구성에 아직 없는 것

- **배포 알림** — 개발 서버는 Actions 가 실패를 알려주지만, **러너가 죽으면 조용합니다.** 러너가 없으면 잡이 실패가 아니라 큐 대기 상태가 되어 알림이 오지 않습니다. Settings → Actions → Runners 를 가끔 보거나 큐 대기 시간에 알림을 거세요.
- **로봇 계정 토큰 만료** — 365일로 만들었다면 달력에 적어두세요. 만료되면 어느 날 갑자기 배포가 조용히 실패합니다.
- **러너의 권한 격리** — 위 6-1 참조. rootless Docker 나 socket proxy 없이는 "워크플로 수정 권한 = 서버 root" 등식이 남습니다. 백엔드 안정화 후 별건으로 다룰 일입니다.
- **하노이 서버** — 아직 구성 전입니다. Harbor 직접 접속은 가능하다고 확인됐습니다.
- **frontend** — 같은 패턴으로 `hub.crefle.com/mes/web` 을 추가하고, compose 에 nginx 서비스를 붙이면 됩니다. backend 가 안정화된 뒤에 하세요.
