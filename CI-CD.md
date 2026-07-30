# omf-mes-server CI/CD 적용

레포: `git@github.com:CREFLEINC/omf-mes-server.git`  
이미지: `hub.crefle.com/mes/backend`

---

## 0. 먼저 — 발견한 버그 하나

**현재 Dockerfile 은 빌드가 실패합니다.** CI/CD 와 별개로 고쳐야 하는 문제입니다.

Dockerfile 주석에 이렇게 적혀 있습니다:

> `@prisma/client`의 postinstall이 스키마를 읽어 클라이언트를 생성한다 — 설치 전에 있어야 한다.

실제로는 생성하지 않습니다. 이 프로젝트의 lockfile 로 리눅스에서 `pnpm install --frozen-lockfile` 을 돌려 확인했습니다:

```
.../node_modules/@prisma/client postinstall: warning In order to use "@prisma/client",
please install Prisma CLI. You can install it with "npm add -D prisma".
```

`@prisma/client` 의 postinstall 은 **자기 패키지 안에서** prisma CLI 를 찾습니다. `prisma` 가 앱의 dependencies 에 있어도 pnpm 의 격리 링킹(`.npmrc` 의 `node-linker=isolated`) 때문에 거기서는 안 보입니다. 그래서 경고만 남기고 조용히 건너뜁니다. 결과물은 스텁입니다 — `index.d.ts` 가 3,989 바이트(정상 생성 시 수 MB), 쿼리 엔진 바이너리 없음. `node-linker=hoisted` 로 바꿔도 동일했습니다.

**왜 로컬에서는 멀쩡한가**: `pnpm prisma:generate` 를 직접 돌려서 생성해 두셨기 때문입니다. Dockerfile 에는 그 단계가 없습니다.

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

**수정**: `deps` 와 `prod-deps` 두 단계 모두에 `RUN pnpm exec prisma generate` 를 추가했습니다.

`deps` 만으로는 부족합니다 — 런타임이 가져가는 건 `prod-deps` 쪽이기 때문입니다. `prisma` CLI 가 devDependencies 가 아니라 dependencies 에 있어서 `--prod` 설치 후에도 실행 가능한 점은 별도로 확인했습니다. `prisma.config.ts` 가 TypeScript 인데도 devDependencies 없이 로드되는 것(`Loaded Prisma config from prisma.config.ts`)까지 확인했으니, 런타임의 `migrate deploy` 도 문제없습니다.

---

## 1. 변경 파일

**수정 3개**


| 파일                        | 변경                                                              |
| ------------------------- | --------------------------------------------------------------- |
| `Dockerfile`              | `deps` · `prod-deps` 에 `prisma generate` 추가 (위 참조)              |
| `docker-compose.prod.yml` | `build:` → Harbor 이미지 참조. migrate·api 가 같은 이미지를 쓰도록 YAML 앵커로 고정 |
| `.env.prod.example`       | `REGISTRY` 추가, `IMAGE_TAG` 의 의미를 배포 채널로 변경                      |


**신규 4개**


| 파일                                          | 역할                                                        |
| ------------------------------------------- | --------------------------------------------------------- |
| `.github/workflows/ci.yml`                  | PR 검증 — lint · typecheck · unit test / docker build / e2e |
| `.github/workflows/build-push.yml`          | main·태그 push 시 Harbor 업로드                                 |
| `deploy/deploy.sh` · `rollback.sh`          | 서버 배포·롤백                                                  |
| `deploy/omf-mes-deploy.cron` · `.logrotate` | 매일 04:00 자동 배포                                            |


`deploy/` 는 레포에 함께 두고 서버로 복사해 쓰는 용도입니다. 서버에 소스를 두고 싶지 않다면 이 폴더만 따로 전달해도 됩니다.

**compose 의 이미지 앵커**

```yaml
x-api-image: &api-image ${REGISTRY:-hub.crefle.com}/mes/backend:${IMAGE_TAG:-main}
```

migrate 와 api 에 각각 이미지를 적으면 한쪽 태그만 고치는 사고가 납니다. 그러면 **구버전 코드가 신버전 스키마를 보게 되는데**, 원인 찾기가 대단히 어려운 유형입니다. 앵커로 묶어서 구조적으로 막았습니다.

---

## 2. 태그 규칙


| 이벤트              | 이미지 태그                               |
| ---------------- | ------------------------------------ |
| main push/merge  | `:main`, `:sha-a1b2c3d`              |
| `git tag v1.2.3` | `:v1.2.3`, `:stable`, `:sha-a1b2c3d` |


서버는 매일 04:00 에 `.env.prod` 의 `IMAGE_TAG`(기본 `main`)를 당겨갑니다.

---

## 3. 실행 순서

### Phase 1 — Harbor (15분)

- [ ] **1-1.** `hub.crefle.com` → Projects → `+ NEW PROJECT` → 이름 `**mes**`, Private
  ```
  이미지 경로가 `mes/backend` 이므로 프로젝트명은 반드시 `mes` 여야 합니다.
  ```

- [ ] **1-2.** `mes` → Robot Accounts → `github-actions` 생성, **Push + Pull** 권한
  ```
  **생성 직후 토큰을 즉시 복사하세요. 다시 볼 수 없습니다.**
  계정명은 `robot$mes+github-actions` 형태 — `$` 와 `+` 포함 전체를 복사.
  ```

- [ ] **1-3.** 같은 화면에서 `server-pull` 생성, **Pull 만**

### Phase 2 — GitHub (10분)

- [ ] **2-1.** 레포 → Settings → Secrets and variables → Actions
  ```
  | Name | Secret |
  |---|---|
  | `HARBOR_USERNAME` | `robot$mes+github-actions` |
  | `HARBOR_PASSWORD` | 1-2 의 토큰 |
  ```

### Phase 3 — 파이프라인 검증 (40분)

- [ ] **3-1.** 브랜치 확인
  ```
  ```bash
  cd ~/work/omf-mes-server
  git switch chore/ci-cd      # 변경사항이 이 브랜치에 커밋되어 있습니다
  git show --stat HEAD
  ```
  ```
  
  ```

- [ ] **3-2.** 로컬에서 Docker 빌드가 통과하는지 먼저 확인
  ```
  Actions 를 기다리는 것보다 훨씬 빠릅니다. Prisma 수정이 실제로 먹는지 여기서 판가름납니다.
  
  ```bash
  docker build --target runtime -t omf-mes-server:test .
  ```

  **확인**: 성공. 실패하면 로그의 `prisma generate` 단계를 보세요.
  ```

- [ ] **3-3.** push → PR 생성
  ```
  ```bash
  git push -u origin chore/ci-cd
  ```

  **확인**: `verify`, `Docker build`, `E2E` 세 job 이 모두 초록.
  > `E2E` job 은 postgres 서비스 컨테이너를 띄우고 `migrate deploy` → `db:seed` → `test:e2e` 를 돌립니다. 시드 데이터나 타임아웃 문제로 처음에 실패할 수 있습니다. **다른 두 job 이 통과했다면 e2e job 만 잠시 주석 처리하고 진행하세요** — 파이프라인 전체를 막을 이유는 없습니다.
  >
  > ```
  >
  > ```

- [ ] **3-4.** main 에 머지
  ```
  **확인**: Actions 의 `Build & Push to Harbor` 초록.
  ```

- [ ] **3-5.** Harbor 확인
  ```
  `mes` → `mes/backend` → Artifacts 에 `main`, `sha-xxxxxxx` 태그.
  ```

### Phase 4 — 서버 배포 (40분)

- [ ] **4-1.** 서버에서 Harbor 아웃바운드 확인
  ```
  ```bash
  curl -sI https://hub.crefle.com/api/v2.0/ping     # 200 이어야 함
  ```

  막혀 있으면 인프라팀 요청부터. 이게 안 되면 이후가 전부 무의미합니다.
  ```

- [ ] **4-2.** Docker 설치 확인
  ```
  ```bash
  docker --version && docker compose version
  ```
  ```
  
  ```

- [ ] **4-3.** 배포 디렉터리 구성
  ```
  ```bash
  sudo mkdir -p /opt/omf-mes && cd /opt/omf-mes
  # 레포에서 아래 파일들을 복사
  #   docker-compose.prod.yml
  #   .env.prod.example
  #   deploy/deploy.sh  deploy/rollback.sh
  #   deploy/omf-mes-deploy.cron  deploy/omf-mes-deploy.logrotate
  sudo chmod +x deploy.sh rollback.sh
  ```
  ```
  
  ```

- [ ] **4-4.** `.env.prod` 작성
  ```
  ```bash
  sudo cp .env.prod.example .env.prod
  sudo vi .env.prod
  sudo chmod 600 .env.prod
  ```

  `POSTGRES_PASSWORD` 교체, `JWT_SECRET` 생성(`openssl rand -base64 48`), `IMAGE_TAG=main` 확인.

  **확인**: `반드시_교체할_것` 문자열이 남아 있지 않을 것.
  ```

- [ ] **4-5.** Harbor 로그인
  ```
  ```bash
  sudo docker login hub.crefle.com
  #   Username: robot$mes+server-pull
  #   Password: <1-3 의 토큰>
  ```

  **확인**: `Login Succeeded`. `$` 가 셸에서 해석되지 않도록 프롬프트에 직접 붙여넣으세요.
  ```

- [ ] **4-6.** pull 단독 테스트
  ```
  ```bash
  sudo docker pull hub.crefle.com/mes/backend:main
  ```

  배포 스크립트를 돌리기 전에 인증·네트워크만 따로 확인합니다.
  ```

- [ ] **4-7.** 첫 배포
  ```
  ```bash
  sudo /opt/omf-mes/deploy.sh
  ```

  최초 실행에서는 `migrate deploy` 가 4개 마이그레이션을 전부 적용하므로 시간이 걸립니다(baseline SQL 이 173KB).

  **확인**: 마지막 줄 `===== 배포 완료 =====`
  ```

- [ ] **4-8.** 동작 확인
  ```
  ```bash
  curl -s localhost:3100/api/health
  curl -s localhost:3100/api/docs -o /dev/null -w '%{http_code}\n'
  ```
  ```
  
  ```

- [ ] **4-9.** 초기 시드
  ```
  `deploy.sh` 는 마이그레이션만 돌리고 시드는 돌리지 않습니다 — 매일 자동 실행되면 안 되는 작업이라 분리했습니다. 최초 1회만 수동으로:
  
  ```bash
  cd /opt/omf-mes
  sudo docker compose -f docker-compose.prod.yml --env-file .env.prod \
    run --rm -e NODE_ENV=production api node dist/seed.js
  ```

  **확인**: 관리자 초기 비밀번호가 출력되면 즉시 안전한 곳에 보관하세요. `.env.prod` 에 `ADMIN_INITIAL_PASSWORD` 를 지정하지 않았다면 무작위 생성되어 **이때 한 번만** 출력됩니다.
  ```

### Phase 5 — 자동화 (15분)

- [ ] **5-1.** cron 등록
  ```
  ```bash
  sudo cp /opt/omf-mes/omf-mes-deploy.cron /etc/cron.d/omf-mes-deploy
  sudo chmod 644 /etc/cron.d/omf-mes-deploy
  sudo systemctl restart cron
  timedatectl | grep "Time zone"    # KST 아니면 시간 재계산
  ```
  ```
  
  ```

- [ ] **5-2.** logrotate 등록
  ```
  ```bash
  sudo cp /opt/omf-mes/omf-mes-deploy.logrotate /etc/logrotate.d/omf-mes-deploy
  ```
  ```
  
  ```

- [ ] **5-3.** 다음 날 아침 확인 ← 여기까지 해야 끝
  ```
  ```bash
  tail -30 /var/log/omf-mes-deploy.log
  cat /opt/omf-mes/DEPLOYED
  ```
  ```
  
  ```

### Phase 6 — 릴리스·롤백 리허설 (20분)

- [ ] **6-1.** 태그 한 번 달아보기
  ```
  ```bash
  git switch main && git pull
  git tag v0.1.0 && git push origin v0.1.0
  ```

  **확인**: Harbor 에 `v0.1.0`, `stable` 생성.
  ```

- [ ] **6-2.** 롤백 리허설
  ```
  ```bash
  sudo /opt/omf-mes/rollback.sh v0.1.0
  curl -s localhost:3100/api/health
  sudo /opt/omf-mes/rollback.sh main       # 반드시 되돌리기
  ```

  `rollback.sh` 는 `.env.prod` 의 `IMAGE_TAG` 를 바꿉니다. 고정한 채 잊으면 **그 뒤로 매일 같은 버전만 배포됩니다.**
  ```

- [ ] **6-3.** main 브랜치 보호
  ```
  Settings → Branches → `main` → Require PR + Require status checks → `verify` 선택.
  
  이걸 걸어야 CI 가 의미를 갖습니다. 안 그러면 깨진 코드가 main 에 직접 push 되어 Harbor 에 올라가고 다음 날 아침 자동 배포됩니다.
  ```

---

## 4. 마이그레이션 — 알고 계셔야 할 것

"자동 적용, 백업 없이"로 구성했습니다. 매일 04:00 에 `migrate deploy` 가 돌고, 새 마이그레이션이 있으면 스키마가 자동으로 바뀝니다.

`prisma migrate deploy` 는 **forward-only** 입니다. 되돌리는 명령이 없습니다. 그래서 다음 상황이 가능합니다:

> 스키마를 바꾼 배포 → 마이그레이션 성공 → api 헬스체크 실패 → `deploy.sh` 가 api 를 구버전 이미지로 롤백 → **구버전 코드가 신버전 스키마 위에서 돕니다.**

`deploy.sh` 는 이 상황을 로그에 명시적으로 경고합니다. 컬럼 추가 정도면 대개 무사하지만, 컬럼 삭제·타입 변경·NOT NULL 추가는 구버전 코드를 깨뜨립니다.

**비용이 거의 없는 대비책 두 가지**

1. **마이그레이션을 하위 호환으로 작성한다.** 컬럼 삭제는 두 번의 릴리스로 나눕니다 — 먼저 코드에서 사용을 제거해 배포하고, 다음 릴리스에서 컬럼을 지웁니다. 규칙 하나 정하는 것으로 위 시나리오의 대부분이 사라집니다.
2. **백업이 필요해지면** `deploy.sh` 의 3줄 주석을 해제하세요. `migrate` 직전에 `pg_dump -Fc` 를 뜹니다. 스키마를 크게 바꾸는 릴리스 전날에만 켜도 됩니다.

## 5. 이 구성에 아직 없는 것

- **배포 알림** — 실패를 다음 날 아침에 알게 됩니다. `deploy.sh` 끝에 Slack webhook `curl` 한 줄이면 해결됩니다.
- **로봇 계정 토큰 만료** — 365일로 만들었다면 달력에 적어두세요. 만료되면 어느 날 갑자기 배포가 조용히 실패합니다.
- **frontend** — 같은 패턴으로 `hub.crefle.com/mes/web` 을 추가하고, compose 에 nginx 서비스를 붙이면 됩니다. backend 가 안정화된 뒤에 하세요.

