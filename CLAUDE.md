# omf-mes-server

OMF MES 백엔드 API. NestJS 11 + Prisma 6 + PostgreSQL 16, pnpm 11 / SWC.
현장: 베트남 하노이(UTC+7). 개발 서버: 한국.

## 문서

| 문서 | 내용 |
|---|---|
| `docs/server-architecture.md` | 서버 내부 구조 — 코어 6건·모듈 배치. **도메인 구현 전 필독** |
| `docs/development-strategy.md` | 개발 순서 전략 |
| `docs/계약-되돌림-mdm.md` | mdm 구현 중 계약에 되돌릴 것 — 답이 필요한 5건 · 알려둘 8건 |
| `docs/계약-선행-수정항목.md` | ⭐ `contracts:update` **전에 필독** — 서버가 계약보다 앞서 나간 자리. 계속 쌓는 «열린» 장부 |
| `docs/coverage-100/계약-사본-당길-때.md` | `contracts:update` 전에 함께 읽는다 — 마감된 루틴(2026-09-10)이 남긴 목록. ⛔ 여기 «덧붙이지» 않는다 |
| `docs/deployment.md` | 배포 구조·서버·운영. 배포/인프라 파일 수정 전 필독 |
| `deploy/RELEASE.md` | 하노이 배포 런북 |
| `deploy/HANDOFF.md` | 남은 작업 인계 |
| `CI-CD.md` | CI/CD 설계 배경 + 진행표 |
| `multi-agent-team-workflow-v3.md` | 멀티 에이전트 팀 워크플로 정본 — 설계팀 우선주의·직접 소통 금지·설계 자료 고정. 이 저장소에서의 운영은 `docs/agents/team-protocol.md` |

## 개발 단위

- 구현 전 계약(인터페이스·DTO·마이그레이션 SQL·테스트 이름 목록) 제시 → 승인 후 구현.
- PR diff ≤ 400줄. 초과 예상 시 분할 계획 먼저. 분할 단위: 전표 하나 + posting 연결 + e2e.
- 코어(재고 posting, lot 계보, 전표 상태기계)는 전용 PR, diff ≤ 200줄. 보일러플레이트와 커밋 분리.
- 마이그레이션은 별도 선행 커밋.

## 코드 작성

- 주석은 코드에서 유추 불가한 것만: 도메인 제약, 반직관적 선택의 이유.
- 사용처 하나뿐인 추상화·선제적 레이어 금지. CRUD 는 기존 모듈 패턴 복제.
- 함수 ~50줄 / 파일 ~300줄 초과는 분리 검토 신호.

## 도메인

- `business_date` 는 **클라이언트가 보낸다. 서버가 수신 시각으로 다시 잡지 않는다** (공유계약 C-8 — 자정을 넘긴 오프라인 재전송이 이중 전기가 된다). 실린 표는 3개뿐(`inventory_transaction`·그 파티션·`inventory_transaction_line`). ⚠ 도출 규칙(야간조 경계)은 **설계 미정**이라 도출 함수를 만들지 않는다. 상세: `docs/server-architecture.md` C-3.
- 날짜 타임존 캐스팅 금지 (`shift.crosses_midnight`). 공장 로컬은 `plant.timezone_code` 로만 푼다. `@db.Date` 49자리.
- 서버·컨테이너·DB TZ = UTC 고정. 공장 로컬 시각은 `plant.timezone_code` 사용.
- id 는 물리 **756개 전부 `BigInt`(int8)** 이고 계약도 그 자리 1456곳을 `format: int64` 로 적었다. ⚠ 그러나 **서버가 넘길 수 있는 구간은 int64 구간이 «아니다»** — Prisma 가 `|v| >= 2 ** 63` 을 ⌜Expected BigInt, provided Float⌝ 로 던져, 하한이 닫힌 `[-2^63, 2^63-1]` 이 아니라 **양쪽이 열린 `(-2^63, 2^63)`** 이다(실측 · PostgreSQL 자체는 `-2^63` 을 받으므로 DB 가 아니라 Prisma 층의 제약). ⇒ `-(2^63)` 은 유효한 int64 인데도 400 이다. 범위 검사는 `contract-validator.ts` 의 `INT64_FORMAT` **한 곳**이고 **경로·질의에만** 건다(본문은 I-28 이 자기 `RANGE` 로 막는다 — 통보 210).
- 마이그레이션은 하위 호환(forward-only). 컬럼·테이블 삭제는 두 릴리스로 분리: 사용 제거 배포 → 다음 릴리스에서 삭제.

## 배포·인프라 금지 (상세: `docs/deployment.md`)

- `Dockerfile` 의 `prisma generate` 두 곳(`deps`/`prod-deps`) 삭제 금지.
- `docker-compose.prod.yml` 이미지 YAML 앵커(`x-api-image`) 분리 금지.
- `deploy-dev.yml` 에 `pull_request` 트리거 금지.
- `.env.prod` 커밋 금지. 템플릿: `.env.prod.example`.
- `deploy.sh`·`rollback.sh` 에 `sudo` 금지.

## Agent skills

### Issue tracker

GitHub Issues (`gh` CLI). 상세: `docs/agents/issue-tracker.md`.

### Triage labels

기본 5종 라벨 그대로 사용. 상세: `docs/agents/triage-labels.md`.

### Domain docs

단일 컨텍스트 — 루트 `CONTEXT.md` + `docs/adr/`. 상세: `docs/agents/domain.md`.

### Team workflow

설계팀·클라이언트 개발팀과의 소통은 `multi-agent-team-workflow-v3.md`를 따른다 — 직접 소통
금지(예외: 설계팀이 여는 "설계 변동 공지"), 요청은 자료로 만들어 사용자를 통해 전달. 이 저장소의
구체적 운영(라벨·요청 절차·설계 고정 커밋)은 `docs/agents/team-protocol.md`. 로컬 상태 확인/갱신:
`pnpm workflow:bootstrap`.
