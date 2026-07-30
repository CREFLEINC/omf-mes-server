# CI/CD 구축 인계 문서

작성: 2026-07-30 · 전체 배경과 규칙은 저장소 루트의 `CLAUDE.md` 참조.

이 문서는 **남은 작업 목록**입니다. 다 끝나면 삭제하세요.

---

## 현재 상태

```
main            8bbf5c1  Merge PR #1 (chore/ci-cd)      ← Harbor 파이프라인 반영 완료
현재 브랜치      fix/deploy-timezone                     ← T-1~T-4 커밋·푸시 완료
```

브랜치에 담긴 변경 (타임존 정책 + sudo 없는 환경 + runner 전환):

```
 M docker-compose.yml                 TZ UTC 통일, postgres -c timezone
 M docker-compose.prod.yml            TZ UTC, postgres -c timezone, mes/backend
 M deploy/deploy.sh                   경로 자동 인식, docker 그룹 검사, IMAGE_TAG 오버라이드
 M deploy/rollback.sh                 경로 자동 인식
 M deploy/omf-mes-deploy.logrotate    사용자 권한용 경로/상태파일
 M .env.prod.example                  LOG_TZ 추가 (T-1)
 D deploy/omf-mes-deploy.cron         /etc/cron.d 전용 — sudo 없어 사용 불가 (T-3)
 A .github/workflows/deploy-dev.yml   self-hosted runner 배포 (T-2)
 A deploy/RELEASE.md                  하노이 현장 배포 런북
 A deploy/RUNNER.md                   개발 서버 runner 구성 절차
 A deploy/actions-runner.service      root 없이 러너 상주
 A deploy/omf-mes-deploy.crontab      러너 대안 (현재 미사용)
```

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
      DEPLOY_DIR: /home/hulk/working/omf-mes

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

## 남은 작업

### T-5. Harbor · GitHub Secrets 상태 확인

PR #1 머지 시 `Build & Push to Harbor` 가 돌았을 텐데 결과를 확인하지 못했습니다. 아래를 점검하세요.

- Harbor 에 `mes` 프로젝트가 있는지, `mes/backend` 에 `main`·`sha-xxxxxxx` 태그가 있는지
- 레포 Secrets 에 `HARBOR_USERNAME`(`robot$mes+github-actions`), `HARBOR_PASSWORD` 가 있는지
- 없으면 `deploy/RUNNER.md` 가 아니라 프로젝트 문서의 Phase C·D 를 먼저 수행

실패했다면 대부분 `Log in to Harbor` 단계이고, 원인은 Secret 오타 또는 Harbor 프로젝트 부재입니다.

### T-6. 개발 서버 초기 구성 (수동, 1회)

`deploy/RUNNER.md` 의 1번 절 참조. 요점:

```bash
mkdir -p /home/hulk/working/omf-mes/logs
cd /home/hulk/working/omf-mes
# 레포에서 복사: docker-compose.prod.yml, .env.prod.example,
#                deploy/deploy.sh, deploy/rollback.sh, deploy/omf-mes-deploy.logrotate
cp .env.prod.example .env.prod
vi .env.prod           # POSTGRES_PASSWORD, JWT_SECRET, IMAGE_TAG=main, LOG_TZ=Asia/Seoul
chmod 600 .env.prod
chmod +x deploy.sh rollback.sh
docker login hub.crefle.com      # robot$mes+server-pull
./deploy.sh                      # 손으로 한 번 성공시킬 것
```

그다음 최초 시드 1회:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm -e NODE_ENV=production api node dist/seed.js
```

관리자 초기 비밀번호가 **이때 한 번만** 출력됩니다.

### T-7. self-hosted runner 설치

`deploy/RUNNER.md` 전체 참조. 라벨은 `omf-dev` 여야 워크플로의 `runs-on: [self-hosted, omf-dev]` 와 맞습니다.

### T-8. 인프라 담당자 요청 (T-6·T-7 의 선행 조건일 수 있음)

```
usermod -aG docker hulk        # docker 접근 — 없으면 배포 자체가 불가
loginctl enable-linger hulk    # 러너 상주 (또는 ./svc.sh install 을 root 로 1회)
```

현재 `hulk` 가 docker 그룹인지 확인:

```bash
id -nG | tr ' ' '\n' | grep -qx docker && echo OK || echo "docker 그룹 필요"
```

### T-9. main 브랜치 보호

Settings → Branches → `main` → Require PR + Require status checks(`verify`).

self-hosted runner 를 붙인 뒤에는 이게 **보안 통제**가 됩니다 — `.github/workflows/` 를 고칠 수 있는 사람은 사내 서버에서 임의 명령을 실행할 수 있습니다.

### T-10. 릴리스·롤백 리허설

```bash
git tag v0.1.0 && git push origin v0.1.0     # Harbor 에 v0.1.0, stable 확인
# 개발 서버에서
./rollback.sh v0.1.0 && curl -s localhost:3100/api/health
./rollback.sh main                            # 반드시 되돌리기
```

---

## 미결 사항 (현장 확인 필요)

**POP 단말의 재시도 동작** — 배포 시 30~60초 단절이 발생합니다. 마이그레이션 이력에 `work_session_idempotency_key` 가 있어 재시도 안전성은 고려된 설계로 보이지만, 단말이 실제로 재시도하는지 확인해야 합니다. 재시도가 없으면 그 사이 실적이 유실됩니다.

**하노이 고정 배포 슬롯** — 3교대 24시간이라 무중단 창이 없습니다. 교대 전환 시점 중 하나를 고정 슬롯으로 정해두세요(예: 격주 목요일 22:00 전환). 매번 협의하면 배포가 미뤄지고, 미뤄진 변경이 쌓여 한 번에 큰 배포가 됩니다.

**하노이 서버 자체** — 아직 구성 전입니다. Harbor 직접 접속은 가능하다고 확인됐습니다. 나중에 러너를 붙일 경우 라벨은 `omf-hanoi`, GitHub Environment 에 required reviewer 를 걸면 승인 기록이 남는 배포가 됩니다.

**`business_date` 로직** — 아직 미구현입니다(`src` 에 참조 없음). `CLAUDE.md` 의 3번 항목을 반드시 읽고 착수하세요. 타임존 캐스팅으로 구하면 야간 교대 실적이 하루 밀립니다.

**프론트엔드** — 아직 없습니다. 같은 패턴으로 `hub.crefle.com/mes/web` 을 추가하고 compose 에 nginx 서비스를 붙이면 됩니다. 백엔드 안정화 후에 하세요.
