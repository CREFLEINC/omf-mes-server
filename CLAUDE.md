# omf-mes-server

OMF MES 백엔드 API. NestJS 11 + Prisma 6 + PostgreSQL 16, pnpm 11 / SWC.
현장: 베트남 하노이(UTC+7). 개발 서버: 한국.

## 문서

| 문서 | 내용 |
|---|---|
| `docs/server-architecture.md` | 서버 내부 구조 — 코어 6건·모듈 배치. **도메인 구현 전 필독** |
| `docs/development-strategy.md` | 개발 순서 전략 |
| `docs/계약-되돌림-mdm.md` | mdm 구현 중 계약에 되돌릴 것 — 답이 필요한 5건 · 알려둘 8건 |
| `docs/계약-선행-수정항목.md` | ⭐ `contracts:update` **전에 필독** — 서버가 계약보다 앞서 나간 자리. 계속 쌓는 «열린» 장부. ⛔ `contracts/` 는 읽기 전용이다 — 고치지 말고 여기 적는다(`pnpm contracts:drift` 로 확인) |
| `docs/coverage-100/계약-사본-당길-때.md` | `contracts:update` 전에 함께 읽는다 — 마감된 루틴(2026-09-10)이 남긴 목록. ⛔ 여기 «덧붙이지» 않는다 |
| `docs/deployment.md` | 배포 구조·서버·운영. 배포/인프라 파일 수정 전 필독 |
| `deploy/RELEASE.md` | 하노이 배포 런북 |
| `deploy/HANDOFF.md` | 남은 작업 인계 |
| `CI-CD.md` | CI/CD 설계 배경 + 진행표 |

## 도메인

- `business_date` 는 **클라이언트가 보낸다. 서버가 수신 시각으로 다시 잡지 않는다** (공유계약 C-8 — 자정을 넘긴 오프라인 재전송이 이중 전기가 된다). 실린 표는 3개뿐(`inventory_transaction`·그 파티션·`inventory_transaction_line`). ⚠ 도출 규칙(야간조 경계)은 **설계 미정**이라 도출 함수를 만들지 않는다. 상세: `docs/server-architecture.md` C-3.
- 날짜 타임존 캐스팅 금지 (`shift.crosses_midnight`). 공장 로컬은 `plant.timezone_code` 로만 푼다. `@db.Date` 49자리.
- 서버·컨테이너·DB TZ = UTC 고정. 공장 로컬 시각은 `plant.timezone_code` 사용.
- id 는 물리 **756개 전부 `BigInt`(int8)** 이고 계약도 그 자리 1456곳을 `format: int64` 로 적었다. ⚠ 그러나 **서버가 넘길 수 있는 구간은 int64 구간이 «아니다»** — Prisma 가 `|v| >= 2 ** 63` 을 ⌜Expected BigInt, provided Float⌝ 로 던져, 하한이 닫힌 `[-2^63, 2^63-1]` 이 아니라 **양쪽이 열린 `(-2^63, 2^63)`** 이다(실측 · PostgreSQL 자체는 `-2^63` 을 받으므로 DB 가 아니라 Prisma 층의 제약). ⇒ `-(2^63)` 은 유효한 int64 인데도 400 이다. 범위 검사는 `contract-validator.ts` 의 `INT64_FORMAT` **한 곳**이고 **경로·질의에만** 건다(본문은 I-28 이 자기 `RANGE` 로 막는다 — 통보 210).
- 마이그레이션은 하위 호환(forward-only). 컬럼·테이블 삭제는 두 릴리스로 분리: 사용 제거 배포 → 다음 릴리스에서 삭제. 컬럼 이름 변경·기본값 없는 `NOT NULL` 추가도 나눈다 — 블루-그린이라 배포 중 수십 초 옛 코드가 새 스키마를 본다.

## 배포·인프라 금지 (상세: `docs/deployment.md`)

- `Dockerfile` 의 `prisma generate` 두 곳(`deps`/`prod-deps`) 삭제 금지.
- `docker-compose.prod.yml` 이미지 YAML 앵커(`x-api-image`) 분리 금지.
- `deploy-dev.yml` 에 `pull_request` 트리거 금지.
- `.env.prod` 커밋 금지. 템플릿: `.env.prod.example`.
- `deploy.sh`·`rollback.sh` 에 `sudo` 금지.
- `docker-compose.prod.yml` 의 `x-api.environment`(api-blue·api-green 공통)에서 `CORS_ORIGINS` 제거 금지 — `--env-file` 은 `${}` 치환용이라 여기 없으면 컨테이너가 못 본다(#612).
- 배포는 블루-그린이다(proxy 가 3100). 서버에서 맨손 `docker compose up -d` 금지 — 두 쪽이 다 뜨고 켜진 쪽이 재생성된다. `deploy.sh` 로 한다.
