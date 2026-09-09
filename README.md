# OMF MES — 백엔드 API

기준정보(마스터) 관리 API. 기술 스택은 문서 저장소([CREFLEINC/omf-mes](https://github.com/CREFLEINC/omf-mes))의
`docs/research/2026-07-09-기술스택-배포모델-결정서.md` 결정 16을 따른다.

| 항목 | 선택 |
| --- | --- |
| 언어·프레임워크 | TypeScript · NestJS 11 |
| DB | PostgreSQL 16 |
| ORM | **Prisma** (결정서 §6 미결 #6 택일 — 2026-07-27 확정) |
| DB 스키마 정본 | `prisma/schema.prisma` + 순방향 마이그레이션 (v4, 논리 172·물리 174 테이블·11 스키마). 산출물: [`docs/data-model/`](docs/data-model/) |
| 패키지 매니저 | **pnpm 11** (`packageManager` 필드로 고정) |
| 빌드·테스트 변환 | **SWC** (`nest build` 빌더 + `@swc/jest`) |
| API 문서 | Swagger (`/api/docs`) |

현재 구현된 API는 실행 후 Swagger에서 확인할 수 있다. 미구현 API도 계약 문서에 함께 표시되므로
구현 여부 표시를 확인한다. 초기 재작성 배경은 [ADR 0001](docs/adr/0001-mdm-api-rewrite-on-spec.md)을 본다.

## 실행

클라이언트 팀이 처음 클론했다면 [로컬 API 실행 가이드](docs/client-local-api.md)를 따른다.
환경 변수, DB 준비, 생성 파일, 쿠키 로그인, 프런트엔드 연결과 업데이트 절차를 포함한다.

```bash
corepack enable                   # package.json의 packageManager 버전 사용
cp .env.example .env              # 최초 1회. JWT_SECRET과 ADMIN_INITIAL_PASSWORD를 채운다
pnpm install --frozen-lockfile
pnpm run prisma:generate
pnpm run contracts:generate
pnpm run build

docker compose up -d postgres     # PostgreSQL이 healthy가 될 때까지 기다린다
pnpm exec prisma migrate deploy   # 스키마 적용
pnpm run db:seed                  # 공통코드·채번규칙·역할 + admin 계정
pnpm run start:prod               # 빌드한 API 실행 (소스 변경 감지는 start:dev)
```

`JWT_SECRET` 이 32자 미만이면 서버가 기동하지 않는다 — 근거는 [ADR 0002](docs/adr/0002-self-hosted-password-auth.md).

포트 기본값은 3100이다. 로컬 3000은 Grafana 등이 점유하는 경우가 많다.

## 스키마는 백엔드가 정본이다

**정본은 `prisma/schema.prisma`와 그 위에 쌓이는 순방향 마이그레이션이다.** 설계 저장소의
물리 모델(v3)은 v4 설계의 출발점으로만 쓰였다 — 데이터 모델 소유권이 백엔드로 이관됐다
([근거](docs/data-model/00-design-basis-and-decisions.md)).

```
스키마 변경  →  schema.prisma 수정 + 순방향 마이그레이션 작성  →  prisma migrate deploy
```

기존 도메인 타입(`app.qty_t` 등)·무결성 트리거·posting 함수·파티션·스키마 간 FK는 이전
baseline 마이그레이션이 정의해 둔 것을 그대로 유지한다 — 이후 변경도 Prisma가 표현하지
못하는 것을 자동 생성으로 유실하지 않도록 스키마와 마이그레이션 SQL을 맞춰 검토한다.

v4 전체 산출물(논리 명세·전체 DDL·API 매핑·검증 리포트)은 [`docs/data-model/`](docs/data-model/)에 있다.

> `schema.prisma`에 **수동으로 이름을 바꾼 관계 필드가 있다**(자기참조 10건 — 인트로스펙션
> 기본 이름이 스칼라 컬럼과 충돌한다: `lot.parent_lot`, `defect_code.parent_defect_code` 등).

> **bigint 식별자**: PK·FK가 전부 bigint다. `JSON.stringify`가 BigInt에서 예외를 던지므로
> 직렬화 방식을 정해야 한다. 계약이 `type: integer` 를 요구하므로 `/mdm` 응답은 숫자로 내린다.

### Prisma 설정

설정은 `prisma.config.ts`에 둔다. `package.json`의 `prisma` 필드는 Prisma 7에서 제거되므로 쓰지 않는다.

> **설정 파일이 있으면 Prisma CLI가 `.env`를 자동으로 읽지 않는다** — `Prisma config detected, skipping environment variable loading`을 출력하고
> `env("DATABASE_URL")` 해석에 실패한다(P1012). 그래서 `prisma.config.ts` 상단에서 dotenv로 직접 로드한다. 이 줄을 지우면 모든 마이그레이션 명령이 깨진다.

시드 명령은 `prisma.config.ts`의 `migrations.seed` 한 곳에만 정의한다. `pnpm run db:seed`는 `prisma db seed`를 호출할 뿐이라 정의가 두 벌로 갈라지지 않는다.

## 배포 — 최소 구성 (단일 서버)

API와 PostgreSQL을 컨테이너로 함께 띄운다. 파일: `Dockerfile` · `docker-compose.prod.yml` · `.env.prod.example`.
운영 절차의 정본은 [`docs/deployment.md`](docs/deployment.md) 와 [`deploy/RELEASE.md`](deploy/RELEASE.md) 다.

### 현장 서버 최초 설치

현장 서버에 Docker와 Compose가 설치되어 있고, 이 저장소의 배포 파일을 받은 상태에서 실행한다.
`install-deploy.sh`가 환경 입력, JWT 키 생성, Registry 로그인, Compose 검증과 최초 배포를 순서대로 처리한다.

```bash
./deploy/install-deploy.sh
```

스크립트가 다음 값을 입력받는다.

- PostgreSQL 사용자·비밀번호·데이터베이스명
- 외부 API 포트 (`API_PORT`, 기본 3100)
- 배포할 릴리스 이미지 tag (`v1.2.3` 형식)
- 로그 타임존 (`LOG_TZ`, 기본 `Asia/Seoul`)
- TLS 사용 여부 (`COOKIE_SECURE`)
- 초기 관리자 비밀번호 (비워두면 1회성 무작위 값 생성)

`JWT_SECRET`은 매 설치마다 무작위로 생성되며 `.env.prod`는 권한 600으로 저장된다.
LAN IP는 환경변수로 저장하지 않는다. 설치 완료 후 `http://<서버 LAN IP>:<API_PORT>`로 접속한다.

Registry 로그인은 배포 디렉터리 전용 Docker 설정(`/opt/services/omf-mes-server/.docker`)에 저장된다.
따라서 다른 경로에 로그인하지 말고, 설치 스크립트가 안내하는 로그인 단계에서 배포용 계정을 사용한다.

### 현장 서버 수동 재배포

새 릴리스는 먼저 release tag(`v1.2.3`)로 빌드·push되어 있어야 한다. 이후 서버에서 다음처럼 버전을 지정한다.

```bash
cd /opt/services/omf-mes-server
./rollback.sh v1.2.3
```

`rollback.sh`는 이름과 달리 `.env.prod`의 `IMAGE_TAG`를 지정한 버전으로 바꾸고 `deploy.sh`를 실행한다.
배포 스크립트가 이미지 pull, Prisma migration, healthcheck, 실패 시 자동 롤백을 수행한다.

스크립트를 사용하지 않고 수동 구성해야 한다면 `.env.prod`를 직접 작성한 뒤 다음 명령을 사용한다.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 최초 1회 — 초기 공통코드 적재
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec api node_modules/.bin/prisma db seed
```

### 구성 의도

| 결정 | 이유 |
| --- | --- |
| **API·마이그레이션이 같은 이미지** | 별도 이미지를 만들 이유가 없다. `migrate` 서비스가 `prisma migrate deploy`만 실행하고 종료하며, `api`는 `service_completed_successfully`로 그 뒤에 뜬다 — 여러 인스턴스가 동시에 스키마를 건드리는 사고를 막는다 |
| **`prisma` CLI가 dependencies** | 운영 서버에서 `migrate deploy`를 돌려야 하므로 devDependency일 수 없다. `@prisma/client`와 **같은 6.x로 고정** — 메이저가 어긋나면 깨진다 |
| **`node:22-bookworm-slim` (alpine 아님)** | Prisma 쿼리 엔진이 musl/glibc로 바이너리 타깃이 갈린다. debian slim + openssl이 트러블이 적다 |
| **Postgres 포트 미노출** | 외부 노출 없이 내부 네트워크로만 접근한다. 직접 접속은 `docker compose exec postgres psql` |
| **healthcheck에 `node -e fetch`** | 이미지에 curl이 없다. Node 22 내장 fetch로 `/api/health`를 친다 |
| **시드를 `dist/seed.js`로 선컴파일** | 운영 이미지에 `ts-node`가 없다. `prisma.config.ts`가 `NODE_ENV=production`이면 컴파일본을 실행한다 |
| **시드는 수동 실행** | 자동 실행하면 재기동마다 돌아 의도치 않은 데이터 변경 위험이 있다 |

### 아직 안 된 것 (인프라 확정 후)

기술스택 결정서 **결정 15**의 잔여 사항과 맞물린다.

- **웜 스탠바이 이중화 · NAS 백업** — NAS 위치·격리가 고객사 선택 잔여라 구성 불가
- **오프라인 설치 패키지** — 현장은 운영 중 인터넷 비보장. `docker save`로 이미지 tar를 말아 반입하는 절차 필요
- **비밀 관리** — 지금은 `.env.prod` 평문. 운영은 Docker secrets 등으로 전환 검토
- **리버스 프록시·TLS** — 현재 API 포트 직접 노출

## 빌드 — SWC

`nest build`가 SWC로 트랜스파일하고, **타입 검사는 tsc가 병렬로 담당**한다(`nest-cli.json`의 `typeCheck: true`).
SWC는 타입을 보지 않으므로 이 옵션을 끄면 타입 오류가 그대로 통과한다 — 끄지 말 것.
타입 오류 시 빌드는 종료 코드 1로 실패한다(CI 안전).

### 설정에서 건드리면 안 되는 것

| 설정 | 위치 | 이유 |
| --- | --- | --- |
| `legacyDecorator` · `decoratorMetadata` | `.swcrc` | NestJS DI와 `ValidationPipe`가 `design:type` 메타데이터에 의존한다. 끄면 주입과 요청 검증이 조용히 깨진다 |
| `keepClassNames` | `.swcrc` | 예외 필터·로거가 클래스명을 쓴다 |
| `stripLeadingPaths: true` | `nest-cli.json` | 없으면 산출물이 `dist/src/main.js`로 한 단계 깊어져 `start:prod`가 깨진다. Nest는 `tsconfig`에 `rootDir`이 있으면 이 값을 자동으로 끈다 |
| `ignore: ["**/*.spec.ts"]` | `nest-cli.json` | 없으면 테스트 파일이 배포 산출물에 섞인다 |
| `tsBuildInfoFile`이 `dist/` 안 | `tsconfig.json` | `deleteOutDir`이 `dist`만 지우고 증분 정보가 밖에 남으면, tsc가 "변경 없음"으로 판단해 파일을 다시 내보내지 않는다(모듈 누락으로 기동 실패) |
| `include: ["src/**/*"]` | `tsconfig.json` | 빌더가 이 값으로 출력 루트를 정한다. `prisma/` 등 형제 디렉토리가 들어가면 산출물이 한 단계 깊어진다 |

## 검증

```bash
pnpm run build      # SWC 트랜스파일 + tsc 타입 검사
pnpm run typecheck  # src + prisma/seed.ts + test 전체 타입 검사
pnpm test           # 단위 테스트 (Prisma를 목킹한다 — SQL은 검증되지 않는다)
pnpm run test:e2e   # 실제 앱·실제 DB. 중첩 관계 필터·FK·트랜잭션은 여기서만 증명된다
```

### e2e 가 쓰는 DB 를 처음 세울 때

```bash
createdb omf_mes
pnpm exec prisma migrate deploy   # 스키마
pnpm db:seed                      # 코드 어휘·단위·역할
pnpm run test:e2e                 # 법인·사업부·공장은 여기서 알아서 채운다
```

앞의 둘이 빠져 있으면 `test/global-setup.ts` 가 **먼저 멈추고 무엇을 실행할지 알린다.**
확인만 하고 대신 실행하지는 않는다 — 검사를 돌린 «부작용»으로 스키마나 코드 어휘가
바뀌는 편이 더 놀랍다. 법인·사업부·공장만은 채운다. 마이그레이션도 시드도 만들지
않는데 열네 스위트가 있다고 전제하는 값이고, 스위트마다 만들면 서로 다른 조직이
열넷 생긴다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | 용어집 |
| [`docs/adr/`](docs/adr/) | 되돌리기 비용이 큰 결정과 근거 |
| [`docs/mdm-api-재작성-계획.md`](docs/mdm-api-재작성-계획.md) | 범위·PR 순서·미결 |
| [`docs/기존-구현-도메인-규칙.md`](docs/기존-구현-도메인-규칙.md) | 삭제 전 코드에서 건져낸 규칙 |
| [`docs/development-strategy.md`](docs/development-strategy.md) | 개발 순서 전략 |
| [`docs/deployment.md`](docs/deployment.md) | 배포 구조·서버·운영 |
| [`deploy/RELEASE.md`](deploy/RELEASE.md) | 하노이 배포 런북 |
| [`CI-CD.md`](CI-CD.md) | CI/CD 설계 배경 |
