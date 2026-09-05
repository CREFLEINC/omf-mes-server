# 3관점 계획 — 공통 브리프

당신은 `omf-mes-server`(NestJS 11 + Prisma 6 + PostgreSQL 16) 의 남은 계약 오퍼레이션 **249건**을
구현하기 위한 계획서를 쓴다. 코드·계약·이슈는 **절대 수정하지 않는다** — 읽고 계획서 한 파일만 쓴다.

## 먼저 읽을 것 (순서대로)

1. `docs/coverage-100/README.md` — 이번 루틴의 규칙 정본. §0 범위(DB 안 · 대기 중 물음 15건) · §2 갈림길 판정 절차 · §1-2 「차이가 크다」기준.
2. `docs/coverage-100/uncovered.tsv` — 미커버 249건(파일 · `METHOD path` · 태그 · 요약 · 403 선언 여부).
3. `CLAUDE.md` · `docs/server-architecture.md` · `docs/development-strategy.md`(마일스톤 M1~M5) · `docs/기존-구현-도메인-규칙.md`.
4. `docs/계약-재검토-2026-09-04.md` — 최근 계약 드리프트(취소 경로 다형화 · `screenId` 생략 규칙 · `SUCCESSOR_EXISTS`).
5. `docs/계약-되돌림-mdm.md` §Z-1 ~ §Z-11 — 원장·LOT·입고를 만들며 남긴 미정 사항.
6. 계약 원문 `contracts/*.json`(읽기 전용). 오퍼레이션의 `x-*` 확장 필드·`description` 에 화면 식별자와 규칙이 적혀 있다.
7. 설계 저장소 로컬 사본(같은 커밋 a6a87e1, 읽기 전용): `/Users/rangkim/projects/crefle/omf/apps/omf-mes/design/wiki/`
   - `screens/` 화면 명세 131건 · `api-contracts/06-API-요구서-*.md` · `domain-workflow/` 워크플로·도식 · `../schema/numbering-conventions.md`(채번 규약) · `../schema/code-dictionary.md`.
8. 이미 구현된 것의 모양: `src/logistics/goods-receipt/`(전표+posting 연결의 표본) · `src/core/inventory-posting/` · `src/trace/` · `src/inventory/` · `src/app/` · `src/mdm/` 중 하나. `test/logistics-goods-receipt.e2e-spec.ts` 가 e2e 골격.
9. `prisma/schema.prisma`(4,800줄) — 오퍼레이션이 쓸 표가 이미 있는지. 대부분 있다(물리 모델은 설계 산출물에서 왔다).

## 계획서에 반드시 담을 것

파일: 지정된 경로 하나. 마크다운. **오퍼레이션 249건이 빠짐없이 어느 슬라이스엔가 속하거나 「건너뜀」 표에 사유와 함께 있어야 한다.** 머리에 세는 것이 아니라 표로 보장한다.

1. **슬라이스 목록** — 각 슬라이스마다: 이름 · 포함 오퍼레이션(`METHOD path` 전부) · 선행 슬라이스 · 쓰는 표(있음/새로 필요) · 마이그레이션 필요 여부 · posting(원장) 연결 여부 · 상태기계 여부 · 예상 PR 수(관행: 「전표 하나 + posting 연결 + e2e」 한 PR, 조회 GET 묶음 한 PR) · 예상 설계 미정 자리(§2 절차로 어떻게 정할지 초안).
2. **순서** — 번호 매긴 실행 순서와 근거. `development-strategy.md` 마일스톤 순서를 기본으로 하되 벗어나면 이유.
3. **건너뜀 표** — DB 안에서 못 끝나는 것(바이너리·외부 전송·프린터), 회신 대기 중 물음에 본길이 걸리는 것. 사유 명시.
4. **위험** — 이 관점에서 보이는 함정 상위 10개, 각각 어느 슬라이스에서 터지는지.
5. **당신 관점 고유 절** — 아래.

분량: 슬라이스 표가 핵심. 산문은 짧게. 예상치는 근거와 함께(계약을 실제로 읽은 흔적이 보여야 한다).

## 금지

- 코드·계약·스키마 수정, 이슈·PR·코멘트 생성, `contracts:update`/`check` 실행, 설계 저장소 수정.
- 다른 저장소(`omf-mes`·`omf-mes-client`)에 어떤 쓰기도 하지 않는다.
