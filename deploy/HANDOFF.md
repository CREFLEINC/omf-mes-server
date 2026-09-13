# CI/CD 구축 인계 문서

작성: 2026-07-30 · 재점검: 2026-09-08 · 전역 규칙은 저장소 루트의 `CLAUDE.md`, 배포·운영 상세는 `docs/deployment.md` 참조.

이 문서는 **남은 작업 목록**입니다. 다 끝나면 삭제하세요.

---

## 현재 상태

```
main                 origin/main 과 일치 (2026-09-08 재점검 시점)
로컬 API             Node 22 · /api/health 200 · db=up
개발 서버 API         /api/health 200 · db=up, 그러나 OpenAPI 작업 2개인 초기 이미지
GitHub Actions       CI · Build & Push · Deploy 세 워크플로 모두 수동 비활성화
self-hosted runner   GitHub 화면에서 0 available runners
```

아래는 2026-07-30 당시 브랜치에 담겼던 변경 기록입니다
(타임존 정책 + 배포 경로 정리 + runner 전환).

```
 M docker-compose.yml                 TZ UTC 통일, postgres -c timezone
 M docker-compose.prod.yml            TZ UTC, postgres -c timezone, mes/backend
 M deploy/deploy.sh                   경로 자동 인식, docker 그룹 검사, IMAGE_TAG 오버라이드
 M deploy/rollback.sh                 경로 자동 인식
 M deploy/omf-mes-deploy.logrotate    사용자 권한용 경로/상태파일
 M .env.prod.example                  LOG_TZ 추가 (T-1)
 D deploy/omf-mes-deploy.cron         러너가 대체 (T-3)
 A .github/workflows/deploy-dev.yml   self-hosted runner 배포 (T-2)
 A deploy/RELEASE.md                  하노이 현장 배포 런북
 A deploy/RUNNER.md                   개발 서버 runner 구성 절차
 A deploy/omf-mes-deploy.crontab      러너 대안 (현재 미사용)
```

### root 취득에 따른 재구성 (2026-07-30 추가)

배포 계정 `hulk` 가 **sudo 를 쓸 수 있게 되어** 아래를 되돌렸습니다. 러너 방식 자체는 그대로입니다 — root 는 상주 방법과 디렉터리 선택만 바꿉니다.

```
 M .github/workflows/deploy-dev.yml   DEPLOY_DIR → /opt/omf-mes
 M deploy/RUNNER.md                   svc.sh 정식 설치로 전환, /opt 경로
 M deploy/RELEASE.md                  /opt 경로, cron 언급 제거
 M deploy/omf-mes-deploy.logrotate    /opt 경로, /etc/logrotate.d 설치 안내
 M deploy/omf-mes-deploy.crontab      /opt 경로
 M CLAUDE.md                          서버 표, 러너 실행 계정 주의
 D deploy/actions-runner.service      svc.sh 가 대체 (사용자 systemd 우회 불필요)
```

**개발 서버·하노이 모두 배포 디렉터리는 `/opt/omf-mes` 입니다.** 소유자를 `hulk` 로 넘기므로 일상 운영에는 sudo 가 필요 없습니다. `.env.prod`(DB 비밀번호·JWT 키)가 개인 계정 홈 수명에 묶이지 않게 하려는 것이 목적입니다.

**바꾸지 않은 것** — `deploy.sh`·`rollback.sh` 에는 여전히 `sudo` 가 없습니다. 두 서버가 같은 스크립트를 쓰고 하노이 권한 상황은 아직 모릅니다. cron 으로 되돌리지도 않았습니다(`/etc/cron.d` 가 가능해졌지만 cron 의 단점은 권한 문제가 아니었습니다).

이미 확인된 사항:

- `build-push.yml` 의 `IMAGE_NAME: mes/backend` ✅
- 개발 서버: `x86_64`, `Etc/UTC`, Docker 28.0.1 / Compose v2.33.1 ✅
- 개발 서버에서 `hub.crefle.com` 아웃바운드 가능 ✅
- 로컬 `docker build` 통과 (Prisma generate 수정 검증됨) ✅

---

## 완료된 작업

**T-1 · T-2 · T-3 · T-4 완료** — `.env.prod.example` 에 `LOG_TZ` 추가,
`.github/workflows/deploy-dev.yml` 생성, `deploy/omf-mes-deploy.cron` 삭제,
`fix/deploy-timezone` 브랜치 커밋·푸시. 상세 내용은 아래 원문을 남겨둡니다.

남은 것은 **T-5 부터**입니다.

<details>
<summary>T-1 ~ T-4 원문 (완료)</summary>

### T-1. `.env.prod.example` 에 `LOG_TZ` 추가

현재 파일에 `REGISTRY`, `IMAGE_TAG=main` 은 있고 `LOG_TZ` 가 없습니다. 파일 끝에 아래를 추가하세요.

```
# ---- 로그 표기 타임존 ----
# 컨테이너와 DB 는 UTC 로 돈다(docker-compose.prod.yml 의 타임존 정책 참조).
# 이 값은 deploy.sh 가 찍는 배포 로그의 표기 시각에만 영향을 준다.
#   개발 서버      Asia/Seoul
#   하노이 운영    Asia/Ho_Chi_Minh
LOG_TZ=Asia/Seoul
```

`IMAGE_TAG` 주석도 서버별 용도를 적어두면 좋습니다 (`main`=개발서버, `stable`/`vX.Y.Z`=하노이).

### T-2. `.github/workflows/deploy-dev.yml` 생성

아래 내용 그대로 만드세요. 개발 서버 배포를 cron 대신 self-hosted runner 로 처리합니다.

```yaml
name: Deploy to dev server

# 개발 서버(한국) 배포. cron 을 대체한다.
#
# 트리거 두 가지:
#   1) "Build & Push to Harbor" 가 main 브랜치에서 성공하면 자동 실행
#   2) Actions 탭에서 수동 실행 (image_tag 지정 가능)
#
# 하노이 운영 서버는 이 워크플로 대상이 아니다 — deploy/RELEASE.md 절차를 따른다.
#
# 보안: 이 워크플로는 pull_request 로 트리거되지 않는다. PR 검증(ci.yml)은
# GitHub 호스팅 러너에서 돌기 때문에, 외부 기여자의 코드가 사내 서버에서
# 실행될 경로가 없다. 이 성질을 깨지 않도록 트리거를 늘릴 때 주의할 것.

on:
  workflow_run:
    workflows: ['Build & Push to Harbor']
    types: [completed]
  workflow_dispatch:
    inputs:
      image_tag:
        description: '배포할 이미지 태그 (비우면 .env.prod 의 IMAGE_TAG 사용)'
        required: false
        default: ''
        type: string

concurrency:
  group: deploy-dev
  cancel-in-progress: false

jobs:
  deploy:
    name: 개발 서버 배포
    # 자동 트리거는 main 브랜치의 성공한 빌드만 받는다.
    # 태그 push 로 만들어진 빌드는 :main 을 갱신하지 않으므로 배포할 것이 없다.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
       github.event.workflow_run.head_branch == 'main')

    runs-on: [self-hosted, omf-dev]
    environment: dev

    env:
      DEPLOY_DIR: /opt/omf-mes      # 원문은 /home/hulk/working/omf-mes — root 취득 후 변경

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: main

      - name: 사전 점검
        run: |
          set -euo pipefail
          test -d "$DEPLOY_DIR"            || { echo "::error::$DEPLOY_DIR 가 없습니다. 최초 1회는 수동으로 구성해야 합니다."; exit 1; }
          test -f "$DEPLOY_DIR/.env.prod"  || { echo "::error::$DEPLOY_DIR/.env.prod 가 없습니다."; exit 1; }
          docker info >/dev/null 2>&1      || { echo "::error::러너 사용자가 docker 그룹에 속해 있지 않습니다."; exit 1; }
          echo "점검 통과"

      - name: 배포 자산 동기화
        run: |
          set -euo pipefail
          # .env.prod 는 절대 건드리지 않는다 — 서버에만 있는 시크릿이다.
          install -m 644 docker-compose.prod.yml         "$DEPLOY_DIR/"
          install -m 644 deploy/omf-mes-deploy.logrotate "$DEPLOY_DIR/"
          install -m 755 deploy/deploy.sh                "$DEPLOY_DIR/"
          install -m 755 deploy/rollback.sh              "$DEPLOY_DIR/"
          echo "동기화 완료"

      - name: 배포
        env:
          # workflow_run 으로 들어오면 빈 문자열이 된다 → 아래에서 unset 처리.
          # 빈 값을 그대로 두면 compose 가 .env.prod 의 IMAGE_TAG 를 무시한다.
          IMAGE_TAG: ${{ inputs.image_tag }}
        run: |
          set -euo pipefail
          if [[ -z "${IMAGE_TAG:-}" ]]; then
            unset IMAGE_TAG
            echo "IMAGE_TAG 미지정 → .env.prod 값을 사용합니다"
          else
            echo "IMAGE_TAG=$IMAGE_TAG (일회성 지정, .env.prod 는 변경하지 않음)"
          fi
          cd "$DEPLOY_DIR"
          ./deploy.sh

      - name: 배포 결과 요약
        if: always()
        run: |
          {
            echo "### 개발 서버 배포 결과"
            echo ""
            echo '```'
            cat "$DEPLOY_DIR/DEPLOYED" 2>/dev/null || echo "(DEPLOYED 기록 없음 — 배포가 완료되지 않았습니다)"
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

### T-3. `deploy/omf-mes-deploy.cron` 삭제

`/etc/cron.d` 전용 파일인데 서버에 sudo 가 없어 쓸 수 없습니다. 사용자 crontab 버전(`omf-mes-deploy.crontab`)이 대체하고, 그마저도 runner 도입으로 현재는 대안 위치입니다.

```bash
git rm deploy/omf-mes-deploy.cron
```

### T-4. 커밋 · PR · 머지

```bash
git add -A
git commit -m "fix(deploy): 하노이 현장 대응 — UTC 통일, sudo 없는 배포, runner 전환

- 컨테이너·DB 를 UTC 로 통일 (공장 로컬 시각은 plant.timezone_code)
- postgres 는 -c timezone 으로 명시 (initdb 가 conf 에 구워버리는 문제 우회)
- 배포 경로를 스크립트 위치에서 유도 (/opt 하드코딩 제거)
- 개발 서버 배포를 cron → self-hosted runner 로 전환
- deploy/RELEASE.md: 하노이 3교대 환경 배포 런북"
git push -u origin fix/deploy-timezone
```

`deploy-dev.yml` 의 `workflow_run` 트리거는 **기본 브랜치의 파일만** 동작하므로, main 머지 전에는 자동 연쇄가 안 걸립니다. 머지 후에 확인하세요.

</details>

---

## 진행 상황

| | 상태 |
|---|---|
| T-5 Harbor · Secrets | ⚠️ 2026-07-30 성공 이력은 있으나 GitHub 결제/지출 한도로 2026-08-10부터 job 시작 실패 |
| T-6 개발 서버 초기 구성 | ⚠️ API·DB는 실행 중이나 초기 이미지(경로 2·작업 2)로 확인됨. 최신 main은 경로 351·작업 487 |
| T-7 러너 설치 | ❌ GitHub 화면에서 self-hosted runner 0개. 기존 `omf-dev-01` 복구 필요 |
| T-8 docker 그룹 | ✅ `hulk` 이미 docker·sudo 그룹 |
| T-9 브랜치 보호 | ❌ **플랜 제약으로 불가** (아래) |
| T-10 릴리스·롤백 리허설 | 미착수 |

---

## 남은 작업

### T-5. Harbor · GitHub Actions 상태 복구

2026-09-08 재점검 결과, CI·Build & Push·Deploy 워크플로가 모두 수동 비활성화돼 있습니다.
Build & Push 마지막 실행(run 31359387337)은 다음 이유로 job 시작 전에 실패했습니다.

```
The job was not started because recent account payments have failed or
your spending limit needs to be increased.
```

조직의 결제 상태 또는 Actions 지출 한도를 먼저 정상화하고 세 워크플로를 다시 활성화해야 합니다.
해결 전에는 활성화해도 이미지 빌드가 시작되지 않습니다.

아래는 2026-07-30 당시 정상 동작을 확인한 기록입니다.

PR #1 빌드 로그(run 30504184498)에서 확인했습니다.

```
✓ Log in to Harbor  → Login Succeeded!
✓ Build and push    → pushing manifest for hub.crefle.com/mes/backend:main
                      pushing manifest for hub.crefle.com/mes/backend:sha-8bbf5c1
```

Harbor `mes` 프로젝트, `mes/backend` 저장소, 레포 Secrets(`HARBOR_USERNAME`/`HARBOR_PASSWORD`)은 당시 정상이었습니다.
복구 후 현재 자격증명으로 다시 검증해야 합니다.

### T-6. 개발 서버 초기 구성 (수동, 1회)

⭐ **2026-09-13 갱신 — 배포처가 바뀌었습니다.** 지금 배포되는 개발 서버는
**`192.168.1.72`**(도메인 `mesapi.crefle.ai`, HTTP, 리버스 프록시로 외부 공개)이고,
배포 경로는 **`/opt/services/omf-mes-server`**, 러너 계정은 **`github-runner`** 입니다.
이 항목이 적어 온 `192.168.1.111` / `hulk` / `/opt/omf-mes` 는 **예전 서버**입니다.
정본 표는 `docs/deployment.md` 의 「서버」 절입니다.

⚠ `192.168.1.111` 은 아직 살아 있지만 **낡은 이미지가 돌고 있고 배포 대상이 아닙니다.**
거기서 확인하면 「배포했는데 안 바뀌었다」로 오해합니다.

아래는 2026-09-08 당시 기록입니다 — `http://192.168.1.111:3100/api/health` 는
`status=ok`, `db=up` 이었으나 배포된 OpenAPI 는 경로 2개·작업 2개뿐이었습니다.

SSH는 아직 호스트 키를 신뢰 목록에 넣지 않았습니다. 2026-09-08에 서버가 제시한 ED25519
지문은 `SHA256:CEgFfZucSd8x1MOwXLhuG72t4L2wsN0NtbTRMA7pZIg`입니다. 서버 콘솔이나
관리자에게 이 지문을 별도 경로로 확인한 뒤에만 `known_hosts`에 추가합니다.

`deploy/RUNNER.md` 의 1번 절 참조. 요점:

```bash
sudo mkdir -p /opt/omf-mes/logs
sudo chown -R hulk:hulk /opt/omf-mes     # 이후 운영은 sudo 없이
cd /opt/omf-mes
# 레포에서 복사: docker-compose.prod.yml, .env.prod.example,
#                deploy/deploy.sh, deploy/rollback.sh, deploy/omf-mes-deploy.logrotate
cp .env.prod.example .env.prod
vi .env.prod           # POSTGRES_PASSWORD, JWT_SECRET, IMAGE_TAG=main, LOG_TZ=Asia/Seoul
chmod 600 .env.prod
chmod +x deploy.sh rollback.sh
# 로그인은 배포 디렉터리 안으로 — ~/.docker 에 하면 deploy.sh 가 못 본다
docker --config /opt/omf-mes/.docker login hub.crefle.com -u 'robot$mes+server-pull'
chmod 700 /opt/omf-mes/.docker
./deploy.sh                      # 손으로 한 번 성공시킬 것
```

그다음 최초 시드 1회:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm -e NODE_ENV=production api node dist/seed.js
```

관리자 초기 비밀번호가 **이때 한 번만** 출력됩니다.

### T-7. self-hosted runner 복구

2026-09-08 GitHub `Settings → Actions → Runners → Self-hosted`에는 사용 가능한 러너가
0개입니다. 서버의 사용자 systemd 서비스와 러너 등록을 확인해 `omf-dev-01`을 다시
`online`으로 만들고 `self-hosted, Linux, X64, omf-dev` 라벨을 확인합니다.

아래는 2026-07-30 당시 설치 기록입니다.

**문서와 다르게 설치했습니다** — 서버 실태에 맞춘 것이니 다음 사람은 `RUNNER.md` 2·3번 절을 그대로 따르면 됩니다.

- 디렉터리: `~/actions-runner-omf` — `~/actions-runner` 는 **`CREFLEINC/reports` 러너가 쓰고 있습니다.** 거기서 `config.sh` 를 돌리면 그쪽 등록이 날아갑니다
- 상주: `svc.sh` 가 아니라 **사용자 systemd** (`~/.config/systemd/user/gh-runner-omf.service`). 같은 서버의 `gh-runner-reports.service` 와 방식을 맞췄고, `Linger=yes` 가 이미 켜져 있으며, `hulk` 의 sudo 가 비밀번호를 요구해 `svc.sh` 는 매번 대화형이 됩니다

### ~~T-8. docker 그룹~~ ✅ 완료

`hulk` 는 이미 `docker`·`sudo` 그룹입니다 (`hulk adm cdrom sudo dip plugdev lxd docker`).

### T-9. main 브랜치 보호 — ❌ 현재 플랜에서 불가

**시도하기 전에 읽으세요. 지금은 설정할 수 없습니다.**

```
$ gh api repos/CREFLEINC/omf-mes-server/rulesets
403  "Upgrade to GitHub Pro or make this repository public to enable this feature."
$ gh api repos/CREFLEINC/omf-mes-server/branches/main/protection
403  같은 메시지

조직 CREFLEINC 플랜: free
```

GitHub Free 조직의 **private 레포에는 브랜치 보호도 Ruleset 도 걸리지 않습니다.** `Settings → Rules` 에 들어가도 업그레이드 안내만 나옵니다. (구 `Settings → Branches` 는 Ruleset 으로 대체되는 중입니다 — 새로 설정한다면 Rules 쪽이 맞습니다.)

**왜 필요한가**

러너를 붙이면서 생긴 등식입니다.

```
.github/workflows/ 수정 권한  →  main 의 워크플로가 omf-dev 러너에서 실행
                             →  hulk 로 임의 셸 명령  →  docker 그룹 = root
                             →  개발 서버(당시 192.168.1.111)의 root
                             →  cvat · reporter · homepage · oapm · traefik 등 30여 개 서비스가 함께 있는 서버
```

**이 레포 쓰기 권한 8명** (2026-07-30 기준, admin 3명 포함): `jgkim0787`·`wooju-shin`·`wglee8320`(admin), `ys-ryu`·`seungyeon-ha`·`MyungJoongJeon`·`HyunjinCho010919`·`jisooshin01`.

두 번째 이유는 마이그레이션입니다. `prisma migrate deploy` 는 forward-only 라, 리뷰 없이 main 에 들어간 마이그레이션이 몇 분 뒤 개발 DB 에 자동 적용되고 되돌릴 수 없습니다. `deploy.sh` 의 자동 롤백은 이미지만 되돌립니다.

**러너를 붙이기 전에는 사람이 손으로 배포하는 것이 관문이었습니다. 자동화가 그 사람을 없앴고, T-9 이 그 자리를 메우기로 되어 있었는데 지금 비어 있습니다.**

**대안 (우선순위 순)**

1. **조직을 GitHub Team 으로 업그레이드** — Ruleset·환경 보호 규칙이 열립니다. 유료 결정
2. **러너의 폭발 반경 축소** — 플랜과 무관하고 사실 이게 근본 해법입니다. 러너 전용 호스트로 분리하거나, rootless Docker / docker socket proxy 로 데몬 접근을 우리 프로젝트에 한정
3. **쓰기 권한 인원 축소** — 8명이 다 필요한지 검토

`dev` 환경은 존재하지만 `protection_rules: []` 입니다. required reviewer 도 private 레포에서는 유료이고, **main 에 푸시할 수 있는 사람은 워크플로에서 `environment: dev` 줄을 지우면 그만이라 악의적 사용자에겐 통제가 못 됩니다** — 사고 방지용일 뿐입니다.

**업그레이드하고 설정할 때의 함정** — 필수 상태 검사 이름은 잡 **id** 가 아니라 `name:` 값입니다.

| 잡 id | 체크 이름 (이걸 지정해야 함) |
|---|---|
| `verify` | `Lint · Typecheck · Unit test` |
| `docker` | `Docker build` |
| `e2e` | `E2E (실제 DB)` |

`verify` 로 걸면 영영 충족되지 않아 PR 이 머지 불가 상태가 됩니다.

### T-10. 릴리스·롤백 리허설

```bash
git tag v0.1.0 && git push origin v0.1.0     # Harbor 에 v0.1.0, stable 확인
# 개발 서버에서
./rollback.sh v0.1.0 && curl -s localhost:3100/api/health
./rollback.sh main                            # 반드시 되돌리기
```

### 복구 실행 순서 (2026-09-08)

1. GitHub 조직 결제 상태 또는 Actions 지출 한도를 정상화합니다.
2. 개발 서버의 SSH ED25519 지문을 별도 경로로 확인하고 안전하게 접속합니다.
3. `gh-runner-omf.service`와 러너 등록을 복구해 `omf-dev-01`을 online으로 만듭니다.
4. CI → Build & Push to Harbor → Deploy to dev server 순으로 워크플로를 활성화합니다.
5. 현재 `main`으로 CI와 이미지 빌드를 성공시키고 Harbor의 `:main`, `:sha-<커밋>`을 확인합니다.
6. 개발 서버에 배포한 뒤 `DEPLOYED.git_revision`, `/api/health`, OpenAPI 작업 수를 대조합니다.
7. T-10의 버전 태그 배포·롤백·`main` 복귀 리허설을 수행합니다.

2026-08-07 마지막으로 실제 실행된 개발 배포(run 31151698278)는 새 이미지에서
`Cannot find module 'express'`로 헬스체크에 실패해 직전 이미지로 자동 롤백됐습니다.
현재 Dockerfile과 의존성으로 새 이미지를 빌드해 이 오류가 재현되지 않는지 5번에서 반드시 확인합니다.

---

## 미결 사항 (현장 확인 필요)

**POP 단말의 재시도 동작** — 배포 시 30~60초 단절이 발생합니다. 마이그레이션 이력에 `work_session_idempotency_key` 가 있어 재시도 안전성은 고려된 설계로 보이지만, 단말이 실제로 재시도하는지 확인해야 합니다. 재시도가 없으면 그 사이 실적이 유실됩니다.

**하노이 고정 배포 슬롯** — 3교대 24시간이라 무중단 창이 없습니다. 교대 전환 시점 중 하나를 고정 슬롯으로 정해두세요(예: 격주 목요일 22:00 전환). 매번 협의하면 배포가 미뤄지고, 미뤄진 변경이 쌓여 한 번에 큰 배포가 됩니다.

**하노이 서버 자체** — 아직 구성 전입니다. Harbor 직접 접속은 가능하다고 확인됐습니다. 나중에 러너를 붙일 경우 라벨은 `omf-hanoi`, GitHub Environment 에 required reviewer 를 걸면 승인 기록이 남는 배포가 됩니다.

**`business_date` 로직** — 아직 미구현입니다(`src` 에 참조 없음). `CLAUDE.md` 의 "도메인" 절 business_date 규칙을 반드시 읽고 착수하세요. 타임존 캐스팅으로 구하면 야간 교대 실적이 하루 밀립니다.

**프론트엔드** — 아직 없습니다. 같은 패턴으로 `hub.crefle.com/mes/web` 을 추가하고 compose 에 nginx 서비스를 붙이면 됩니다. 백엔드 안정화 후에 하세요.
