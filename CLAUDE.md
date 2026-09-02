# omf-mes-server

OMF MES 백엔드 API. NestJS 11 + Prisma 6 + PostgreSQL 16, pnpm 11 / SWC.
현장: 베트남 하노이(UTC+7). 개발 서버: 한국.

## 문서

| 문서 | 내용 |
|---|---|
| `docs/server-architecture.md` | 서버 내부 구조 — 코어 6건·모듈 배치. **도메인 구현 전 필독** |
| `docs/development-strategy.md` | 개발 순서 전략 |
| `docs/계약-되돌림-mdm.md` | mdm 구현 중 계약에 되돌릴 것 — 답이 필요한 5건 · 알려둘 8건 |
| `docs/deployment.md` | 배포 구조·서버·운영. 배포/인프라 파일 수정 전 필독 |
| `deploy/RELEASE.md` | 하노이 배포 런북 |
| `deploy/HANDOFF.md` | 남은 작업 인계 |
| `CI-CD.md` | CI/CD 설계 배경 + 진행표 |

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
