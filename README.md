# OMF MES — 백엔드 API

기준정보(마스터) 관리 API. 기술 스택은 `docs/research/2026-07-09-기술스택-배포모델-결정서.md` 결정 16을 따른다.

| 항목 | 선택 |
| --- | --- |
| 언어·프레임워크 | TypeScript · NestJS 11 |
| DB | PostgreSQL 16 |
| ORM | **Prisma** (결정서 §6 미결 #6 택일 — 2026-07-27 확정) |
| 패키지 매니저 | **pnpm 11** (`packageManager` 필드로 고정) |
| 빌드·테스트 변환 | **SWC** (`nest build` 빌더 + `@swc/jest`) |
| API 문서 | Swagger (`/api/docs`) |

## 실행

```bash
corepack enable            # package.json의 packageManager 버전 사용
cp .env.example .env       # 기본값: DB=localhost:5432, API=3100
pnpm install
docker compose up -d       # PostgreSQL 기동
pnpm exec prisma migrate dev
pnpm run db:seed           # 초기 공통코드 시드
pnpm run start:dev
```

- API: http://localhost:3100/api
- Swagger: http://localhost:3100/api/docs

> 포트 기본값이 3100인 이유: 로컬 3000은 Grafana 등이 점유하는 경우가 많다.

## 구조

```
src/
├── common/          # 공통 DTO(페이징·검색)·예외 필터
├── prisma/          # PrismaService (전역 모듈)
└── master-data/     # 기준정보 도메인 (개념모델 v2 §1)
    └── common-code/ # 공통코드 — 코드그룹 · 코드값
prisma.config.ts     # Prisma 설정 정본 (schema·migrations·seed 경로)
prisma/
├── schema.prisma    # 스키마 정본
├── migrations/      # 마이그레이션 이력
└── seed.ts          # 초기 공통코드
```

### Prisma 설정

설정은 `prisma.config.ts`에 둔다. `package.json`의 `prisma` 필드는 Prisma 7에서 제거되므로 쓰지 않는다.

> **설정 파일이 있으면 Prisma CLI가 `.env`를 자동으로 읽지 않는다** — `Prisma config detected, skipping environment variable loading`을 출력하고
> `env("DATABASE_URL")` 해석에 실패한다(P1012). 그래서 `prisma.config.ts` 상단에서 dotenv로 직접 로드한다. 이 줄을 지우면 모든 마이그레이션 명령이 깨진다.

시드 명령은 `prisma.config.ts`의 `migrations.seed` 한 곳에만 정의한다. `pnpm run db:seed`는 `prisma db seed`를 호출할 뿐이라 정의가 두 벌로 갈라지지 않는다.

## 배포 — 최소 구성 (단일 서버)

API와 PostgreSQL을 컨테이너로 함께 띄운다. 파일: `Dockerfile` · `docker-compose.prod.yml` · `.env.prod.example`.

```bash
cp .env.prod.example .env.prod        # POSTGRES_PASSWORD 반드시 교체
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# 최초 1회 — 초기 공통코드 적재
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec api node_modules/.bin/prisma db seed
```

확인·운영:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
curl http://localhost:3100/api/health          # {"status":"ok","db":"up",...}
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api
docker compose -f docker-compose.prod.yml --env-file .env.prod down   # 볼륨은 보존
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
- **오프라인 설치 패키지** — 현장은 운영 중 인터넷 비보장. `docker save`로 이미지 tar를 말아 반입하는 절차 필요. 현재 API 이미지 **556MB**라 패키징 시 슬리밍 검토 필요
- **비밀 관리** — 지금은 `.env.prod` 평문. 운영은 Docker secrets 등으로 전환 검토
- **리버스 프록시·TLS** — 현재 API 포트 직접 노출

## 엔드포인트 — 운영

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 서비스 상태 + DB 연결. 정상 200 / DB 끊김 503 |

## 엔드포인트 — 공통코드

키 구조는 개념모델 v2 §1을 따른다: **코드그룹 + 코드값**. 코드값은 코드그룹 하위 리소스로 둔다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/master/code-groups` | 코드그룹 등록 |
| GET | `/api/master/code-groups` | 코드그룹 목록 (페이징·검색·필터) |
| GET | `/api/master/code-groups/:code` | 코드그룹 단건 + 사용중 코드값 |
| PATCH | `/api/master/code-groups/:code` | 코드그룹 수정 |
| DELETE | `/api/master/code-groups/:code` | 코드그룹 삭제 (소프트) |
| POST | `/api/master/code-groups/:groupCode/values` | 코드값 등록 |
| GET | `/api/master/code-groups/:groupCode/values` | 코드값 목록 |
| GET | `/api/master/code-groups/:groupCode/values/:code` | 코드값 단건 |
| PATCH | `/api/master/code-groups/:groupCode/values/:code` | 코드값 수정 |
| DELETE | `/api/master/code-groups/:groupCode/values/:code` | 코드값 삭제 (소프트) |

목록 공통 쿼리: `page`(기본 1) · `size`(기본 20, 최대 200) · `keyword`(코드·명칭 ko/vi 부분일치) · `useYn` · `includeDeleted`.
응답 봉투: `{ items, total, page, size, totalPages }`.

## 적용한 도메인 규칙

기준정보 전반에 공통으로 적용될 규칙이라, 첫 엔티티에서 골격을 잡아 이후 마스터가 재사용하도록 했다.

| 규칙 | 구현 | 근거 |
| --- | --- | --- |
| **ERP 연계 수신본 — 원본 필드만 잠금** | `source=ERP`이면 **필드 단위**로 검사한다. 원본 필드(코드명 ko·정렬순서·사용여부) 수정은 409, **MES 확장 속성(베트남어 명칭·설명·attr)은 편집 허용**. 삭제는 전면 불가. 정책은 `src/master-data/erp-linked.policy.ts` 한 곳 | ERP-MES 수신정보 정리 §4 (QA #34·#35) · 개념모델 v2 §1 |
| **다국어 명칭 (한국어·베트남어)** | `nameKo` / `nameVi` 컬럼 병기 | REQ-PR-0012 · QA #33 |
| **소프트 삭제** | `deletedAt` — 기본 조회에서 제외, `includeDeleted=true`로 조회 | 마스터 이력 보존 |
| **참조 무결성** | 사용중 코드값이 남은 코드그룹은 삭제 거부 (409) | — |
| **자연키 재사용** | 삭제된 코드로 재등록하면 되살린다. 이때 미지정 필드는 삭제 전 값이 아닌 **기본값**으로 초기화 | 자연키 특성 |
| **감사 컬럼** | `createdAt/By` · `updatedAt/By` | 변경 이력 요구 (REQ-PR-0002·0021) |

> **원본/확장 경계의 해석 여지**: 문서는 "공통코드의 **다국어(한/베) 명칭**"을 MES 확장 속성 예시로 든다(§4).
> 한국어 명칭까지 MES 편집 대상인지 읽기 나름이라, `WF06 S1`이 ERP 측 등록 행위를 "코드명·정렬순서·사용여부 등록"으로
> 명시한 것을 근거로 **코드명(ko)=ERP 원본(잠금) / 베트남어 명칭=MES 확장(편집 가능)** 으로 잡았다.
> 고객 확인으로 뒤집히면 `erp-linked.policy.ts`의 `CODE_GROUP_MES_FIELDS`에 `nameKo`를 넣으면 된다.

> 다국어를 별도 테이블이 아닌 **컬럼 병기**로 둔 근거: 개념모델이 언어를 한/베 2종으로 고정했다(§1 비고에서 "테이블 vs 컬럼 병기"를 물리 설계 과제로 남김). 언어가 3종 이상으로 늘면 테이블 분리로 전환한다.

## 빌드 — SWC

`nest build`가 SWC로 트랜스파일하고, **타입 검사는 tsc가 병렬로 담당**한다(`nest-cli.json`의 `typeCheck: true`).
SWC는 타입을 보지 않으므로 이 옵션을 끄면 타입 오류가 그대로 통과한다 — 끄지 말 것.
타입 오류 시 빌드는 종료 코드 1로 실패한다(CI 안전).

측정값(현재 15개 파일 기준):

| 구간 | tsc | SWC |
| --- | --- | --- |
| 순수 트랜스파일 | ~1.1s | **~0.04s** |
| `pnpm test` | ~1.5s | **~0.6s** |
| `pnpm run build` 전체 | ~1.9s | ~1.9s |

> 전체 빌드 시간이 그대로인 이유: 파일이 15개뿐이라 벽시계 시간을 Nest CLI 기동과 tsc 타입 검사가 차지한다.
> 트랜스파일 자체는 이미 25배 빠르므로, 코드가 늘수록 차이가 드러난다. 지금 당장 체감되는 이득은 테스트 실행 시간이다.

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
pnpm test           # 단위 테스트
```

## 남은 과제

- **인증·인가 미적용** — `createdBy`/`updatedBy`를 채울 주체가 없어 현재 null로 기록된다. 사용자·역할·권한 마스터(개념모델 v2 §1 신규 엔티티) 작업 시 연결한다.
- **변경 이력 테이블 부재** — 감사 컬럼은 최종 상태만 남긴다. REQ-PR-0002·0021의 "변경 이력"이 이력 조회까지 요구하면 별도 이력 테이블이 필요하다.
- **ERP 연계 수신 파이프라인 미구현** — `source` 필드로 경계만 잡아 뒀다. 실제 수신(Temp Table·MS SQL 중계)은 별도 작업.
