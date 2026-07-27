# OMF MES — 백엔드 API

기준정보(마스터) 관리 API. 기술 스택은 `docs/research/2026-07-09-기술스택-배포모델-결정서.md` 결정 16을 따른다.

| 항목 | 선택 |
| --- | --- |
| 언어·프레임워크 | TypeScript · NestJS 11 |
| DB | PostgreSQL 16 |
| ORM | **Prisma** (결정서 §6 미결 #6 택일 — 2026-07-27 확정) |
| DB 스키마 정본 | `docs/research/2026-07-23-데이터모델링/mes_postgresql_physical_model.sql` (v3, 129 테이블·10 스키마) |
| 패키지 매니저 | **pnpm 11** (`packageManager` 필드로 고정) |
| 빌드·테스트 변환 | **SWC** (`nest build` 빌더 + `@swc/jest`) |
| API 문서 | Swagger (`/api/docs`) |

## 실행

```bash
corepack enable            # package.json의 packageManager 버전 사용
cp .env.example .env       # 기본값: DB=localhost:5432, API=3100
pnpm install
docker compose up -d       # PostgreSQL 기동
pnpm exec prisma migrate deploy
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
prisma.config.ts     # Prisma 설정 (schema·migrations·seed 경로)
prisma/
├── schema.prisma    # 인트로스펙션 생성물 — 직접 수정하지 않는다
├── migrations/      # baseline = 물리 모델 정본 SQL
└── seed.ts          # 업무 도메인 공통코드
```

### 스키마는 DB 우선(database-first)이다

**`schema.prisma`를 손으로 고치지 않는다.** 정본은 기획 산출물의 물리 모델 SQL이다.

```
정본 SQL  →  baseline 마이그레이션  →  DB  →  prisma db pull  →  schema.prisma
```

이유: 정본 DDL에는 Prisma가 표현하지 못하는 것이 들어 있다 — 도메인 타입(`app.qty_t` 등),
무결성 트리거, posting 함수, 파티션, 스키마 간 FK. Prisma 스키마에서 마이그레이션을 생성하면
이것들이 유실된다. 그래서 DDL을 정본으로 두고 Prisma는 읽기만 한다.

스키마 변경 절차: 정본 SQL 갱신 → 후속 마이그레이션 작성 → `pnpm run db:pull`로 재생성.

> `schema.prisma`에 **수동으로 이름을 바꾼 관계 필드가 있다**(자기참조 10건 — 인트로스펙션
> 기본 이름이 스칼라 컬럼과 충돌한다: `lot.parent_lot`, `defect_code.parent_defect_code` 등).
> Prisma는 재인트로스펙션 시 관계 필드의 수동 명명을 보존하므로 `db pull`을 다시 돌려도 유지된다.

> **BigInt 응답**: 정본의 PK·FK가 전부 bigint라 JSON에서 **문자열**로 나간다(`"code_group_id": "3"`).
> `JSON.stringify`가 BigInt에서 예외를 던지므로 `main.ts`에서 `BigInt.prototype.toJSON`을 정의했다.
> number로 바꾸면 2^53 초과 시 정밀도가 깨진다.

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

테이블은 `mdm.code_group` / `mdm.code_value`. 자연키(`group_code`, `(code_group_id, code)`)로 접근하고 bigint 서로게이트 PK는 응답에만 노출한다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/master/code-groups` | 코드그룹 등록 |
| GET | `/api/master/code-groups` | 코드그룹 목록 (페이징·검색·필터) |
| GET | `/api/master/code-groups/:groupCode` | 코드그룹 단건 + 하위 코드값 |
| PATCH | `/api/master/code-groups/:groupCode` | 코드그룹 수정 |
| DELETE | `/api/master/code-groups/:groupCode` | 코드그룹 **비활성화**(is_active=false) |
| POST | `/api/master/code-groups/:groupCode/values` | 코드값 등록 |
| GET | `/api/master/code-groups/:groupCode/values` | 코드값 목록 |
| GET | `/api/master/code-groups/:groupCode/values/:code` | 코드값 단건 |
| PATCH | `/api/master/code-groups/:groupCode/values/:code` | 코드값 수정 |
| DELETE | `/api/master/code-groups/:groupCode/values/:code` | 코드값 **비활성화** |

목록 공통 쿼리: `page`(기본 1) · `size`(기본 20, 최대 200) · `keyword`(코드·명칭 부분일치) · `isActive`.
응답 봉투: `{ items, total, page, size, totalPages }`.

## 엔드포인트 — 기준정보 마스터 (mdm)

| 리소스 | 경로 | 자연키 |
| --- | --- | --- |
| 단위(UoM) | `/api/master/uoms/:uomCode` | `uom_code` (전역) |
| 법인 | `/api/master/legal-entities/:legalEntityCode` | `legal_entity_code` (전역) |
| 사업부 | `/api/master/legal-entities/:le/business-units/:businessUnitCode` | (법인, 사업부코드) |
| 공장 | `/api/master/legal-entities/:le/plants/:plantCode` | (법인, 공장코드) |
| 창고 | `/api/master/warehouses/:warehouseCode` | (공장, 창고코드) |
| 로케이션 | `/api/master/warehouses/:wh/locations/:locationCode` | (창고, 로케이션코드) |

각 리소스는 `POST`(등록) · `GET`(목록·단건) · `PATCH`(수정) · `DELETE`(비활성화)를 갖는다.
목록 공통 쿼리는 공통코드와 같다(`page`·`size`·`keyword`·`isActive`).

> **조직 계층이 함께 들어간 이유**: `mdm.warehouse`가 `plant_id`·`business_unit_id`를
> NOT NULL로 요구한다. 창고를 만들려면 법인→사업부/공장이 먼저 있어야 해서 선행 마스터로 포함했다.

> **창고코드는 전역 유니크가 아니다** — `(plant_id, warehouse_code)`가 유니크다.
> 지금은 단일 공장 전제로 코드만으로 조회하고, 같은 코드가 여러 공장에 있으면 409로 명시적으로
> 거부한다(조용히 첫 건을 고르지 않는다). 다공장 운영이 확정되면 경로에 공장을 넣어야 한다.

### DB 제약을 앱에서도 먼저 검사하는 것

정본 DDL의 CHECK 제약은 최후 방어선이고, 앱이 먼저 걸러 쓸 만한 메시지를 준다
(`3-3 §7 애플리케이션과 DB 양쪽에서 중복 검증할 항목`과 같은 취지).

| 규칙 | DDL 제약 |
| --- | --- |
| 외부창고면 거래처 필수 | `ck_external_warehouse_partner` |
| 수용량과 단위는 함께 지정 | `ck_location_capacity` |
| 유효 종료일 ≥ 시작일 | `ck_code_value_dates` |
| 소수 자릿수 0~6 | `uom.decimal_scale` CHECK |

DDL에 없어 **앱만 막는 것**: 로케이션 상위 지정의 자기참조·순환, 공장의 사업부가 같은 법인 소속인지.

### 설정형 코드 검증 (패턴 P1)

`warehouse_type_code`·`location_type_code` 등은 DDL에서 `app.code_t` 문자열일 뿐 `code_value`로
FK가 걸려 있지 않다. 관리자가 코드를 추가·변경하는 설정형 코드(확정 패턴 **P1**)이기 때문이며,
값의 유효성은 `CodeValidatorService`가 책임진다 — 해당 코드그룹에 **활성** 코드값으로 존재하는지 확인하고,
없으면 사용 가능한 코드 목록을 담아 400을 낸다.

> 코드그룹 이름(`WAREHOUSE_TYPE`·`MANAGEMENT_LEVEL`·`LOCATION_TYPE`·`QUALITY_ZONE`·`STORAGE_CONDITION`)은
> 정본 문서가 지정하지 않아 **컬럼명을 따라 정한 관례**다. 모델링 측에서 다른 이름을 쓰기로 하면 시드와 함께 바꾸면 된다.

## 적용한 도메인 규칙

정본 물리 모델의 구조를 그대로 따른다. 이후 마스터도 같은 골격을 재사용한다.

| 규칙 | 구현 |
| --- | --- |
| **삭제 = 비활성화** | 정본 모델에 소프트 삭제 컬럼이 없다. `is_active=false`가 수명주기 플래그이며, 마스터는 타 테이블이 FK로 참조하므로 물리 삭제하지 않는다 |
| **참조 무결성** | 사용중(`is_active=true`) 코드값이 남은 코드그룹은 비활성화 거부 (409) |
| **유효기간** | `code_value.effective_from/to`. DB의 `ck_code_value_dates` 제약과 같은 규칙을 앱에서 먼저 검사해 메시지를 준다 |
| **낙관적 락** | 수정 시 `version_no` 증가. 클라이언트가 기대 버전을 보내는 완전한 낙관적 락은 미구현(아래 남은 과제) |
| **감사 컬럼** | `created_at/by` · `updated_at/by`. 변경 이력 자체는 `audit.audit_event`(jsonb before/after·파티션)가 담당하며 아직 연결하지 않았다 |

### 정본 모델과 요구사항 사이의 미결 2건

| 항목 | 상태 |
| --- | --- |
| **다국어(ko/vi)** | 정본 물리 모델에 다국어 컬럼이 **없다**(`code_name` 단일). 모델링 문서 전체에 다국어 언급이 없고 `3-3 §9 명시적 범위 이연` 목록에도 없다. 그러나 REQ-PR-0012·QA #33은 "전범위 확정(UI+마스터 명칭 한/베+출력물)"이다. → 정본을 임의 변형하지 않고 그대로 두었다. 모델링 담당 확인 필요 |
| **ERP 연계 출처 마커** | 정본 `code_group`/`code_value`에 ERP/MES 출처 컬럼이 없다. "연계 원본 필드 읽기 전용"(QA #34·#35) 규칙을 걸 지점이 없어 관련 정책 코드를 제거했다. ERP 수신 파이프라인(X-ERP 트랙) 설계 시 함께 결정 필요 |

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

- **인증·인가 미적용** — `created_by`/`updated_by`(bigint, `app.app_user` FK)를 채울 주체가 없어 null로 기록된다. WBS **CORE-6**에서 연결한다.
- **변경 이력 미연결** — 정본에 `audit.audit_event`가 있으나 아직 쓰지 않는다. 확정 패턴 **P2**(현재 1행 + 이력 1:N)를 WBS **CORE-3**에서 라이브러리로 구현하며 연결한다.
- **낙관적 락 미완성** — `version_no`를 증가만 시킨다. 클라이언트가 기대 버전을 보내 충돌을 409로 거르는 부분이 남았다.
- **ERP 연계 수신 파이프라인 미구현** — X-ERP 트랙. 위 '미결 2건'의 출처 마커 결정이 선행돼야 한다.
