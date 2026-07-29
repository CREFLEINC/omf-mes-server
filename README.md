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

처음이라면 아래를 위에서부터 그대로 따라 하면 된다. **마지막 `pnpm run postman`이 통과하면
환경이 다 선 것이다** — 서버가 뜬 것에 그치지 않고, 현장 흐름(사번 입력 → 작업지시 선택 →
작업 시작 → 실적 등록)이 실제로 도는 것까지 확인된다.

```bash
git clone git@github.com:CREFLEINC/omf-mes.git
cd omf-mes/apps/api

corepack enable                   # package.json의 packageManager 버전 사용
cp .env.example .env              # ① JWT_SECRET을 채운다: openssl rand -base64 48
pnpm install

docker compose up -d              # PostgreSQL 기동
pnpm exec prisma migrate deploy   # 스키마 적용
pnpm run db:seed                  # 공통코드·채번규칙·역할 + admin 계정

pnpm run fixtures:pop             # 배포된 W/O·단말·작업자 한 벌 (없으면 POP 화면이 빈다)
pnpm run fixtures:postman-admin   # 검증용 계정 — 비밀번호를 1회 출력한다

cp test/postman/local.postman_environment.example.json \
   test/postman/local.postman_environment.json
                                  # ② 위에서 출력된 비밀번호를 adminPassword에 넣는다

pnpm run start:dev                # ③ 다른 터미널에서 — 서버는 띄워 둔 채로
pnpm run postman                  # 21요청 · 58단언이 모두 통과하면 정상
```

손이 가는 곳은 위 셋뿐이다.

| | 무엇을 | 안 하면 |
| --- | --- | --- |
| ① | `.env`의 `JWT_SECRET` (32자 이상) | 서버가 기동하지 않는다 |
| ② | 환경 파일의 `adminPassword` | `adminPassword가 비어 있습니다` 로 즉시 멈춘다 |
| ③ | 서버를 띄운 채로 다음 명령 | `ECONNREFUSED` |

> **3100을 이미 뭔가 쓰고 있으면** 서버가 조용히 죽고(`EADDRINUSE`) 요청이 엉뚱한 곳으로 간다 —
> 앞서 띄워 둔 서버가 남아 있는 경우가 흔하다. `lsof -ti:3100`으로 확인하고 정리한다.

- API: http://localhost:3100/api
- Swagger: http://localhost:3100/api/docs

> 포트 기본값이 3100인 이유: 로컬 3000은 Grafana 등이 점유하는 경우가 많다.
> `PORT`를 바꾸면 Postman 환경 파일의 `baseUrl`도 함께 고쳐야 한다.

> **두 번째 실행부터는** 시나리오가 남긴 상태를 되돌린다 — `pnpm run fixtures:pop:reset`.
> 자세한 내용은 [시나리오 검증 (Postman)](#시나리오-검증-postman).

문서가 길다. 필요한 곳으로 바로 간다:

| 하려는 일 | 어디로 |
| --- | --- |
| 처음 세팅하고 동작까지 확인 | 위 명령 → [시나리오 검증 (Postman)](#시나리오-검증-postman) |
| 어떤 API가 있는지 | [엔드포인트 — 기준정보](#엔드포인트--기준정보-마스터-mdm) · [POP 현장 단말](#엔드포인트--pop-현장-단말) |
| 토큰이 어떻게 도는지 | [인증](#인증) |
| 스키마를 고쳐야 할 때 | [스키마는 DB 우선](#스키마는-db-우선database-first이다) |
| 테스트를 돌릴 때 | [검증](#검증) |

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
| 공정 | `/api/master/processes/:processCode` | `process_code` (전역) |
| 생산라인 | `/api/master/production-lines/:lineCode` | (공장, 라인코드) |
| 설비 | `/api/master/equipments/:equipmentCode` | (공장, 설비코드) |
| 툴·금형 | `/api/master/molds/:moldCode` | (공장, 금형코드) |
| 부서 | `/api/master/departments/:departmentCode` | `department_code` (전역) |
| 작업자 | `/api/master/workers/:workerNo` | `worker_no` **사번** (전역) |
| └ 자격 | `/api/master/workers/:w/qualifications/:id` | (작업자, 유형, 공정, 시작일) |
| 작업조 | `/api/master/shifts/:shiftCode` | (공장, 작업조코드) |
| 단말 | `/api/master/terminals/:terminalCode` | `terminal_code` (전역) |
| └ 공정 기능 | `/api/master/terminals/:t/processes/:processCode` | (단말, 공정) |

**`mdm` 스키마의 마스터는 이것으로 전부 구현했다.**

## 엔드포인트 — 접근권한 (app)

| 리소스 | 경로 |
| --- | --- |
| 역할 | `/api/access/roles/:roleCode` |
| └ 기능권한 | `/api/access/roles/:r/permissions/:permissionCode` |
| 사용자 | `/api/access/users/:loginId` |
| ├ 역할 배정 | `/api/access/users/:u/roles/:roleCode` |
| ├ 유효 권한 | `GET /api/access/users/:u/permissions` (역할 경유 집계·중복 제거) |
| └ 데이터 접근범위 | `/api/access/users/:u/data-scopes/:id` |

## 엔드포인트 — POP 현장 단말

생산실행(WF02) S5~S7. **사람 토큰이 아니라 단말 토큰으로 인증한다** — 사번(`X-Worker-No`)은
인증이 아니라 실적 귀속 정보다(REQ-PR-0023).

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/pop/context` | 단말 부팅 — 내 공정·허용 행위, 사번을 주면 자격까지 |
| GET | `/api/pop/work-orders` | 시작 가능한 작업지시 목록 (배포됨 + 이 단말이 시작 가능한 공정) |
| POST | `/api/pop/work-orders/:id/start` | 작업 시작 — 작업 세션을 연다 |
| POST | `/api/pop/work-sessions/:id/results` | 생산실적 등록 (양품 수량) |

- **쓰기에는 `Idempotency-Key` 헤더가 필수다**(결정서 §160). 같은 키로 다시 보내면 새로 만들지
  않고 처음 만든 것을 돌려준다(응답 `replayed: true`) — 오프라인 구간 재전송용이다.
- 4M(작업자·근무조·설비·금형)은 작업지시·세션에서 승계한다. 계획과 다를 때만 본문에 넣는다.
- 자격 강제 수준은 운영정책 `WORKER_QUALIFICATION_ENFORCEMENT`(BLOCK·WARN·OFF)가 정한다.

흐름 전체를 실제로 돌려 보려면 → [시나리오 검증 (Postman)](#시나리오-검증-postman)

## 인증

**자체 비밀번호 인증**을 쓴다(2026-07-28 확정). 정본 물리 모델에는 자격증명 저장소가 없었고 —
요구사항 `1-2 사용자·권한 관리`가 권한만 다루고 로그인 수단을 언급하지 않아 설계에서 빠졌다 —
`app.user_credential`을 **후속 마이그레이션으로 보완**했다.

> ⚠ `app.user_credential`은 **OMF-MES 구현 측 추가분**이다. 모델링 정본 SQL에 역반영이 필요하다.
> `app_user`에 컬럼을 더하지 않고 별도 테이블로 둔 이유: 자격증명의 수명주기가 계정 정보와 다르고,
> 정본 테이블 형태를 건드리지 않아 모델링 측 갱신과 충돌이 적으며, 나중에 LDAP/AD로 전환하면
> 이 테이블만 걷어내면 된다.

| 엔드포인트 | 설명 |
| --- | --- |
| `POST /api/auth/login` | 로그인 → 액세스 토큰(JWT) |
| `GET /api/auth/me` | 내 정보·유효 기능권한·비밀번호 변경 필요 여부 |
| `POST /api/auth/password` | 내 비밀번호 변경 |
| `PUT /api/access/users/:loginId/password` | 관리자의 비밀번호 발급·재발급 |

### 보호 방식

**`@Public()`이 붙지 않은 모든 엔드포인트가 토큰을 요구한다** — 화이트리스트라 새 엔드포인트를
만들며 보호를 깜빡해도 막힌 상태로 시작한다. 현재 공개는 `POST /auth/login`과 `GET /health`뿐이다
(헬스체크는 컨테이너가 토큰 없이 호출한다).

**기능권한도 강제한다.** 매핑 규칙은 단순하다:

| 대상 | GET | POST·PATCH·PUT | DELETE |
| --- | --- | --- | --- |
| 기준정보(`/master/**`) | `MASTER_READ` | `MASTER_WRITE` | `MASTER_DEACTIVATE` |
| 접근권한(`/access/**`) | `ACCESS_READ` | `ACCESS_WRITE` | `ACCESS_WRITE` |

`/auth/me`·`/auth/password`는 권한을 요구하지 않는다 — 인증된 사용자라면 누구나 자기 정보를 보고
자기 비밀번호를 바꿀 수 있어야 한다.

### 설계 판단

| 항목 | 선택 | 이유 |
| --- | --- | --- |
| 해시 | **Node 내장 `scrypt`** (N=2^15·r=8·p=1) | argon2id가 최신 권고지만 npm 구현이 네이티브 빌드를 요구한다. 배포가 **오프라인 설치 패키지**(결정 15)라 빌드 툴체인 의존을 늘리지 않는 편이 낫다. scrypt도 메모리 하드 KDF다 |
| `maxmem` 명시 | 필수 | `128*N*r`=32MB가 Node 기본 maxmem과 같아 지정하지 않으면 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`로 **해싱이 통째로 실패**한다 |
| 해시 저장 형식 | `scrypt$N$r$p$salt$hash` | 자기서술적이라 파라미터·알고리즘을 바꿔도 옛 해시를 읽으며 점진 재해싱할 수 있다 |
| 실패 응답 | 사유를 구분하지 않음 | 없는 계정 / 틀린 비밀번호 / 자격증명 미발급이 **같은 메시지**다. 계정 존재 여부가 새어나가면 열거 공격의 출발점이 된다. 없는 계정도 해시 검증에 준하는 시간을 쓴다 |
| 계정 잠금 | 연속 5회 실패 → 15분 | 잠금만은 별도로 안내한다(사용자가 원인을 알아야 한다) |
| 토큰 검증 | 매 요청 계정 재확인 | 토큰 발급 뒤 계정이 정지·해지될 수 있다 |
| `JWT_SECRET` | 없거나 32자 미만이면 **기동 실패** | 기본값을 두면 약한 키로 조용히 운영에 올라간다 |
| 최초 관리자 | 시드가 `admin` 생성. 비밀번호는 `ADMIN_INITIAL_PASSWORD` 또는 **무작위 생성 후 1회 출력** | 하드코딩된 기본 비밀번호는 운영까지 살아남는다. 어느 경우든 첫 로그인에서 변경을 강제한다 |

### 아직 안 된 것

| 항목 | 상태 |
| --- | --- |
| 계정·역할·권한·접근범위 관리 | ✅ |
| 로그인·토큰·비밀번호 변경·잠금 | ✅ |
| **엔드포인트별 권한 강제** | ✅ 118개 핸들러 전부 |
| **데이터 접근범위 적용**(RLS 등) | ❌ 범위를 저장할 뿐 조회를 걸러내지 않는다 |
| 토큰 무효화(로그아웃·강제 만료) | ❌ JWT라 만료 전까지 유효하다. 계정 정지는 매 요청 확인으로 즉시 반영된다 |
| POP 사번 경량 인증 | ❌ 별도 경로. `worker_no` 기반이며 관리 화면 계정과 이원화된다(REQ-PR-0023) |

## 적용한 도메인 규칙

정본 물리 모델의 구조를 그대로 따른다. 이후 마스터도 같은 골격을 재사용한다.

| 규칙 | 구현 |
| --- | --- |
| **삭제 = 비활성화** | 정본 모델에 소프트 삭제 컬럼이 없다. `is_active=false`가 수명주기 플래그이며, 마스터는 타 테이블이 FK로 참조하므로 물리 삭제하지 않는다 |
| **참조 무결성** | 사용중(`is_active=true`) 코드값이 남은 코드그룹은 비활성화 거부 (409) |
| **유효기간** | `code_value.effective_from/to`. DB의 `ck_code_value_dates` 제약과 같은 규칙을 앱에서 먼저 검사해 메시지를 준다 |
| **낙관적 락** | 수정 시 `version_no` 증가. 클라이언트가 기대 버전을 보내는 완전한 낙관적 락은 미구현(아래 남은 과제) |
| **감사 컬럼** | `created_at/by` · `updated_at/by`에 **인증된 주체의 `app_user_id`가 기록된다**. 변경 이력 자체는 `audit.audit_event`(jsonb before/after·파티션)가 담당하며 아직 연결하지 않았다 |

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
pnpm test           # 단위 테스트 (Prisma를 목킹한다 — SQL은 검증되지 않는다)
pnpm run test:e2e   # 실제 앱·실제 DB. 중첩 관계 필터·FK·트랜잭션은 여기서만 증명된다
```

### 시나리오 검증 (Postman)

단위·e2e가 엔드포인트를 하나씩 본다면, 이쪽은 **현장 순서대로 이어지는지**를 본다 —
사번 입력 → 작업지시 선택 → 작업 시작 → 실적 등록. 컬렉션은 `test/postman/`에 있다.

준비와 실행 명령은 [실행](#실행)에 있다. 여기서는 그 뒤에 알아야 할 것만 적는다.

폴더는 5개이고 순서대로 돈다.

| 폴더 | 내용 |
| --- | --- |
| 0. 준비 | 관리자 로그인 → 단말 토큰 발급 (실제로는 단말 설치 시 1회) |
| 1. 단말 부팅 | 컨텍스트 조회 — 내 공정·허용 행위·작업자 자격 |
| 2. 작업 시작 | 목록 → 시작 → 같은 키 재전송(멱등) → 다른 키 재시작(409) |
| 3. 생산실적 | 등록 → 재전송(멱등) → 2회차 → 지시수량 초과 |
| 4. 거부 | 사람 토큰·사번 없음·멱등 키 없음·불량 수량·없는 세션·못 하는 공정 |

앞 단계가 실패하면 뒤는 의미가 없으므로 `--bail`로 첫 실패에서 멈춘다.

**두 번째 실행부터는 출발선을 되돌린다.** 시나리오가 세션과 실적을 남기므로, 그대로 다시
돌리면 「이미 진행 중」 409로 막힌다(단언 2건 실패).

```bash
pnpm run fixtures:pop:reset
```

실 환경 파일(`local.postman_environment.json`)은 비밀번호가 들어가므로 `.gitignore` 대상이다.
커밋되는 건 `*.example.json`뿐이다.

### Postman 앱에서 보기

응답을 눈으로 확인하거나 값을 바꿔 가며 실험할 때는 앱이 편하다. newman으로 돌리는 것과
같은 파일을 쓴다.

1. **Import** → `test/postman/`의 파일 2개를 함께 넣는다.
   - `omf-mes-pop.postman_collection.json` (컬렉션)
   - `local.postman_environment.json` (환경 — [실행](#실행)에서 만든, 비밀번호를 채운 쪽)
2. 우측 상단 환경 선택기에서 **OMF MES — 로컬**을 고른다. 이걸 빠뜨리면 `{{baseUrl}}`이
   풀리지 않아 요청이 나가지 않는다.
3. 컬렉션 우클릭 → **Run collection** → Run. 폴더 0부터 순서대로 돌며 단언 결과가 함께 나온다.

**요청을 하나씩 눌러 볼 때는 순서를 지켜야 한다.** 토큰·작업지시 ID·세션 ID를 앞 요청의
테스트 스크립트가 뒤 요청에 넘겨주기 때문이다. `0 → 1 → 2 → 3` 순으로 누르면 되고, 중간부터
누르면 `{{workSessionId}}`가 비어 404가 난다.

- **재실행 전에는** 터미널에서 `pnpm run fixtures:pop:reset`. 앱에는 리셋 기능이 없다.
- **Runner의 「Stop run if an error occurs」를 켜 두면** newman의 `--bail`과 같아진다.
- 이미 단말 토큰이 있다면 환경의 `terminalToken`만 채우고 `1`번 폴더부터 실행해도 된다.
- 앱에서 채운 비밀번호를 파일로 **Export하면 실 환경 파일에 평문으로 남는다.** 그 파일은
  `.gitignore` 대상이라 커밋되지 않지만, 예시본(`*.example.json`)에 덮어쓰지 않도록 주의한다.

### 검증 전용 계정을 따로 두는 이유

단말 토큰 발급은 `ACCESS_WRITE`를 요구하는데, 시드가 만드는 `admin`의 초기 비밀번호는
**1회만 출력되고 다시 볼 수 없다.** 그 값을 놓치면 컬렉션의 `0`번 폴더를 돌릴 방법이 없다.
`fixtures:postman-admin`은 `postman-tester` 계정을 따로 만들어 `admin` 자격증명을 건드리지
않으며, 여러 번 돌려 비밀번호를 다시 받을 수 있다. `NODE_ENV=production`에서는 만들지 않는다.

> 이미 쓸 수 있는 관리자 계정이 있다면 이 픽스처 대신 `PUT /api/access/users/:loginId/password`로
> 비밀번호를 재발급해도 된다. 픽스처는 **쓸 수 있는 관리자가 하나도 없는 상태**를 푸는 용도다.

## 남은 과제

- **물리 삭제 행위자 미기록** — 매핑·이력 테이블(품목 환산·외부코드·사업부매핑, 거래처 역할,
  단말-공정, 작업자 자격, 역할 권한·배정, 접근범위)은 물리 삭제라 감사 컬럼이 없다.
  DDL에 기록할 자리가 없어 "누가 지웠나"가 남지 않는다 — `audit.audit_event` 연동(CORE-3) 시 함께 다룬다.
- **트랜잭션 참조 검사 미적용** — 금형·작업자·거래처는 참조처가 대부분 트랜잭션이라
  '미결 작업지시/발주가 쓰면 막는다'를 지금 판정할 수 없다. 단순 존재 검사를 걸면 한 번이라도
  쓰인 마스터가 영영 비활성화되지 않으므로, 해당 모듈의 상태 의미가 정해질 때 함께 붙인다.
- **변경 이력 미연결** — 정본에 `audit.audit_event`가 있으나 아직 쓰지 않는다. 확정 패턴 **P2**(현재 1행 + 이력 1:N)를 WBS **CORE-3**에서 라이브러리로 구현하며 연결한다.
- **낙관적 락 미완성** — `version_no`를 증가만 시킨다. 클라이언트가 기대 버전을 보내 충돌을 409로 거르는 부분이 남았다.
- **ERP 연계 수신 파이프라인 미구현** — X-ERP 트랙. 위 '미결 2건'의 출처 마커 결정이 선행돼야 한다.
