# I-13 재고 이동 — 반출·도착 2단 — 6건 — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: **`docs/coverage-100/slices/I-13.md` 하나**. 저장소의 다른 파일을 고치거나 만들지 않는다. 작업 위치는 worktree
`/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i13-plan`(브랜치 `docs/coverage-100-c-i13-plan` ·
base `origin/main` **771c541** · 체크아웃 변경 금지 · **`git` 쓰기 금지** — 커밋은 통합자가 한다).
`contracts/*.json` 읽기 전용(`jq`·`python3`). ⛔ `prisma migrate reset`·`migrate dev`·`migrate diff --shadow-database-url`·`pnpm db:seed`·`contracts:update`·`contracts:check` 금지.
로컬 DB 는 **`psql` SELECT 만** — 접속은 메인 체크아웃의 `.env` 의 `DATABASE_URL`(`postgresql://omf:omf@localhost:55432/omf_mes`, `?schema=` 는 잘라서).
Bash cwd 는 호출마다 리셋되므로 **절대경로로 `cd`**.
형식 정본: **`docs/coverage-100/slices/I-24.md`**(§0-재수립 R 표는 **통합자가 나중에 붙인다** — 너는 §0(3조건)~§11 까지 쓴다) · 원장을 쓰는 슬라이스의 본보기 **`I-12.md`** · 브리프 선례 `brief-I-8.md`.
너는 **레인 C**다(`docs/coverage-100/lane-C.md`). 설계 문의 번호 대역은 **120~149**(파일은 062 까지 실재, 063~068 은 I-24 예약).

**대상 6건**(`assignment.tsv` 실측 · 계약 `contracts/logistics-01자재창고.json`)
| 오퍼레이션 | 403 | 계약 path 줄 |
|---|:-:|---|
| `GET /logistics/stock-transfers` | — | 5337 |
| `POST /logistics/stock-transfers` | 403 | 5337 |
| `GET /logistics/stock-transfers/{stockTransferId}` | — | 5532 |
| `GET /logistics/stock-transfers/{stockTransferId}/lines` | — | 5583 |
| `PUT /logistics/stock-transfers/{stockTransferId}/lines` | 403 | 5583 |
| `POST /logistics/stock-transfers/{stockTransferId}:arrive` | 403 | 5693 |

커버리지 **342 → 348**.

---

## ⭐ 이 슬라이스의 심장 — 「문서 1건 · 원장 전기 2회」

⛔ **두 «전표» 가 아니다.** 계약 `StockTransfer` 의 `x-internal-note` 가 「한 행에 `shipped_at`·`received_at` 이 둘 다 있다 — 두 문서가 아니라 **한 문서의 두 전이**」로 못 박았고, 물증은 `stock_transfer_line` 이 `issue_transaction_line_id`·`receipt_transaction_line_id` **두 칸**을 가진 것이다(`prisma/schema.prisma:1444~`).

- **반출**(`POST /logistics/stock-transfers`) — `from` = 출발 창고·위치 / `to` = {도착 창고, **`IN_TRANSIT`**}
- **도착**(`:arrive`) — `from` = {도착 창고, `IN_TRANSIT`} / `to` = {도착 창고·위치, `AVAILABLE`}
- 원장 두 번 전기의 **순서와 한 트랜잭션 경계**를 계획안에서 못 박는다.

⛔ **취소는 이 슬라이스에 없다.** 다형 취소(I-5)의 `documentTypeCode` 는 **입하·입고·출고 3종뿐**이고 `STOCK_TRANSFER` 가 빠져 있다. 코드도 이미 `cancelable: false` 로 등록했다(`src/logistics/document-progress/document-type-registry.ts:68`). **역분개를 짓지 마라** — 「미지원」을 계획안에 적고 **문의(대역 120~)로 올린다**.

⚠ 예상 설계 미정 — **`IN_TRANSIT` 행의 `location_id` 는 NOT NULL 인데 이동 중에는 위치가 없다**. `plan-integration.md:323` 의 초안 판정은 §2 2단계 기준 3 → 「도착 위치를 미리 쓴다(`to_location_id`)」. **실측으로 확인하고 §2 절차로 다시 판정**한다.

⚠ 예상 설계 미정 — **부분 도착**. 계약은 「반출한 수량 이하만」만 적는다. `plan-api.md:152` 초안 판정: 상태값을 늘리지 않고 `received_qty` 합이 담으며 **전량 도착에서만 `POSTED`**(`plan-api.md:752` 전이표와 같다). 확인·재판정한다.

---

## 읽을 것 (순서대로)

1. **`docs/coverage-100/README.md`** — §0 범위 · §1-2 슬라이스 절차 · **§2 설계 미정 판정 절차(0~3단계)** · §3 멈춤 조건 · §4 모델 배분 · §5 불변 제약 · §6·§6-1 속도(구현 브리프 비테스트 예산 **350** · 한도 **400** · **코어 전용 ≤200** · **실측 부록** 의무).
2. **`docs/coverage-100/lane-C.md`** — 네 레인 규칙 전부(브랜치·PR 접두어 `[C]` · 문의 대역 120~149 · 게이트 명령 · `set -o pipefail`).
3. **`docs/coverage-100/lanes.md`** — §1-2 마이그레이션 파일 이름(**초까지**, 순서 비의존: 추가·완화만, 삭제 0, 백필 0) · §1-4 소유자가 정해진 파일(**`transitions.ts` 는 A 소유** — 키를 더해야 하면 통합자가 사용자에게 먼저 알린다) · §4 절대 금지.
4. **`CLAUDE.md`** — PR 크기 · 주석 규칙 · `business_date` 는 **클라이언트가 보낸다**(C-8) · 날짜 타임존 캐스팅 금지 · 마이그 하위 호환.
5. **`docs/coverage-100/plan.md`** — §0 #14(출하의 원장) · §1 I-13 행 · **§4 A4**(`stock_transfer_line.handling_unit_id?` · 130행) · **§5 횡단 규칙 1~12 전건**(403 게이트 · 멱등 · If-Match · ETag · `@Contract` · 에러 코드 신설 금지 · 값 없는 칸 키 생략 · **원장 판별자 4값 고정** · `X-Worker-No` 규약 · 집계는 서버가) · §6 건너뜀(I-13 은 **없다**).
6. **`docs/coverage-100/plan-api.md`** — **143~163행 S05**(쓰는 표 · 마이그 · 2단 전기 · 상태기계 · PR 3 · 설계 미정 초안 · 오퍼레이션 4축 표) · **745~755행**(`LOGISTICS_DOCUMENT_STATUS` 전이표 — `transfer-issue` (없음)→`REGISTERED` · `transfer-arrive` `REGISTERED`→`POSTED` · **부분 도착은 상태를 안 옮긴다**) · **966행**(S05 권한 미등록 2건 — `PUT …/lines` · `:arrive`. ⚠ `POST /logistics/stock-transfers` 도 계약 403 이다. 등록 필요 건수를 **실측으로 다시 센다**).
7. **`docs/coverage-100/plan-uiux.md`** — **48행 U14**(6건 · 화면 `M-01-10`·`W-04-11` · 선행 U12 · 마이그 없음 표기 ⚠ · 2단 ○ · PR 2) · **245~254행**(오퍼레이션↔화면·횡단 매핑 — ⚠ I-7 교훈: 화면 매핑의 「ETag」는 **계약 `responses.*.headers` 실측이 이긴다**) · **581행**(⭐ **창고 «내» 위치 이동을 담을 헤더가 없다** → 1단계 본길 판정 → `stock_transfer` 는 **창고 간(from ≠ to)만** 받고 위치 이동은 적치(U10)로 흡수 · 요청서) · 695행(M-01-10 이 세 슬라이스에 걸려 반쯤 열린다) · 738행 · 1145행(`PUT …/lines` 의 If-Match 는 **부모 상세 GET 의 ETag**) · **1174행**(A — `M-01-10` §8 원문).
8. **`docs/coverage-100/plan-integration.md`** — **177행**(I-13 행) · **301행**(`STOCK_TRANSFER` 판별자의 **첫 사용처가 I-13** — I-10 반출은 원장을 안 지난다) · **320~327행 §3-1 I-13**(체인 마디 · `IN_TRANSIT` 를 처음 쓴다 · 원장 2회의 from/to · 예상 설계 미정 · **취소 미지원 판정**) · **588행**(I-11 ∥ I-13 병렬 근거) · **823~830행**(§10 부록 전건 6).
9. **선행 결과물** — **`slices/I-12.md`**(적치 — 원장을 쓰는 슬라이스 형식의 본보기 · §0·§3·§9·§10·§11 · **문의 059** 「적치 원장의 판별자가 `STOCK_TRANSFER` 인데 그 표는 적치를 모른다」 ⭐ **이 문의가 I-13 의 판별자와 직접 부딪힌다 — 반드시 읽고 정합을 적는다**) · `slices/I-5.md`(다형 취소 — `STOCK_TRANSFER` 가 왜 빠졌는지 · `document-type-registry` 등록 모양) · `slices/I-4.md` §7-2·R-1(잔량 잠금 7칸 오름차순) · `slices/I-9.md` R-17(`IN_TRANSIT` 를 안 쓰고 닫힌 선례) · `slices/I-24.md`(형식 · §0-재수립 표 · §12 마감표 · **실측 부록**의 모양).
10. **실재 코어** — `src/core/inventory-posting/inventory-posting.service.ts`(**머리 주석 22~44행** 「재고를 바꾸는 유일한 길」·「유형 → 무엇을 움직인다 표를 두지 않는다 — **라인의 `from`/`to` 가 이동을 말한다**」 · `post()` 45~ · `reverse()`) · `posting.types.ts`(**`PostingEndpoint` 4칸** = 창고·위치·품질상태·재고상태 · `PostingLine.handlingUnitId` **이미 있다** · `PostingInput.businessDate`/`occurredAt`/`transactionNo`/`sourceDocumentTypeCode`/`idempotencyKey`) · `balance-lock.ts`(`lockBalancesInOrder`) · `reservation-qty.ts` · `reversal.ts` · **원장을 부르는 기존 사용처 전건**: `src/logistics/goods-receipt/receipt-posting.ts` · `src/logistics/putaway/putaway-posting.ts`(⭐ **적치가 `STOCK_TRANSFER` 판별자를 쓴다** — I-13 과 같은 판별자를 두 슬라이스가 쓰는 문제) · `src/logistics/goods-issue/issue-posting.ts` · `src/logistics/shopfloor-receipt/`.
11. **상태기계** — `src/core/document-state/transitions.ts`(`stock_transfer.status_code` 축이 **있는지 실측** · `document-state.spec.ts` 의 `toHaveLength(n)` 단언 ⚠ **A 소유 파일**) · `src/core/document-state/document-state.service.ts` · `src/logistics/document-progress/document-type-registry.ts`(`STOCK_TRANSFER` 등록 · `cancelable:false`).
12. **채번** — `src/core/numbering/numbering.service.ts`(`DEFAULT_PREFIX` 에 `STOCK_TRANSFER` 가 있는지 · `app.numbering_rule` 실측 · **채번은 `$transaction` 밖**이 선례 — I-2 R-2 · 재시도 형상은 `goods-receipt.service.ts` 참고) · `prisma/seed.ts:1335`(`STOCK_TRANSFER` 채번 규칙 실재 여부).
13. **물리** `prisma/schema.prisma` — **`stock_transfer` 1413~**(21칸 · `version_no` 있음 · `reason_code?` · `remarks?` · `from/to_business_unit_id`·`from/to_warehouse_id` · `requested_at`·`shipped_at?`·`received_at?`·`status_code`) · **`stock_transfer_line` 1444~**(`uq_stock_transfer_line(stock_transfer_id, line_no)` · `lot_id` **NOT NULL** · `from_location_id`·`to_location_id` NOT NULL · `issue_transaction_line_id?`·`receipt_transaction_line_id?` · **`handling_unit_id` 없음 = A4** · ⚠ CHECK 제약 있음 — baseline 마이그에서 원문 실측) · `inventory_balance` 484~ · `inventory_transaction` 610~ · `inventory_transaction_line` 639~ · `handling_unit` 414~ · `warehouse` 2283~ · `location`.
14. **시드** `prisma/seed.ts` — `LOGISTICS_DOCUMENT_STATUS` **1069** · `STOCK_TRANSFER_REASON` **1235** · `STOCK_TRANSFER_TYPE` **1241**(2값 · 시스템 소유) · 채번 **1335** · `INVENTORY_STATUS`/`QUALITY_STATUS` 그룹에 **`IN_TRANSIT` 가 실재하는지**(⭐ 없으면 값을 짓지 않는다 — §2 로 판정하고 문의) · `TRANSACTION_TYPE` 값 목록(`omf-mes#213` 미확정).
15. **계약** `contracts/logistics-01자재창고.json` — path 5337·5532·5583·5693 · 스키마 **`StockTransfer` 13973** · `StockTransferArrive` **14083** · `StockTransferCreate` **14141** · `StockTransferDetailResponse` **14219** · `StockTransferLine` **14237** · `StockTransferLineListResponse` **14333** · `StockTransferLineUpsert` **14347**. 각 오퍼레이션의 `parameters` **전수** · `requestBody` 칸 전수 · `responses` 코드·`headers`(ETag 실측) · `x-code-key` · **`x-internal-note` 전건 원문 인용**.
16. **화면 사본**(읽기 전용 · 메인 체크아웃 `.design-reference/omf-mes/design/wiki/screens/`) — **`01/M-01-10-재고이동불량반출.md`**(⭐ §8 「이동 자체는 기록되나 「이동 건」이라는 업무 문서가 없다」 원문 확인) · `04/` 아래 `W-04-11` 에 해당하는 실제 파일(⭐ **화면 ID 가 정본, 파일 이름은 실제 파일이 이긴다** — 없으면 「없다」고 적는다).
17. **기존 문의** `docs/design-inquiries/README.md` + **059**(적치 판별자 `STOCK_TRANSFER`) · 060 · 061 · 062. 새 번호는 **120 부터**.

---

## 담을 것 (I-24.md 의 절 짜임을 따른다 · §0~§11)

1. **머리말 블록** — 브리프 경로 · 통합 계획서 해당 절 줄번호 · 실측 기준(worktree·base 커밋·계약 `COMMIT.txt`=`a6a87e1`·실측일·DB 행수) · 커버리지 342→348 · 「§0-재수립이 본문보다 앞선다」 한 줄.
2. **§0. README §1-2 3조건 판정** — ① 통합 계획서에 없던 표/마이그 ② 다른 슬라이스 순서 영향 ③ 새 문의. 근거를 실측으로.
3. **⭐ §0 말미에 「리뷰가 반드시 볼 자리 5개」** — 네가 ⭐ 로 표시한 갈림길 + 뒤집히면 PR 분할이 바뀌는 자리. 이것이 곧 3관점 리뷰 브리프의 판정 항목이 된다(README §1-2).
4. **§1. 계약 읽기 표 — 6건 전건** — 1-1 횡단 4축(멱등·If-Match·ETag·403) 실측 · 1-2 조회 3건의 **질의 칸 전수 ↔ 가리키는 물리 칸** · 1-3 쓰기 3건 본문 스키마 전수 · 1-4 **응답 스키마에서 채울 수 없는 칸 / 담을 데가 없는 칸** · 1-5 값 목록(계약 준 것 ↔ DB 시드에 있는 것) · 1-6 **에러 코드 — 새 코드 0건**을 증명.
5. **§2. 물리 대조 + 마이그레이션 결론** — `stock_transfer`·`stock_transfer_line` 전칸 ↔ 계약 프로퍼티 대조표 · **A4 마이그레이션 SQL 전문**(`handling_unit_id BigInt? FK` · 파일명은 `<YYYYMMDDHHMMSS>_…` 초까지 · **사전 대조 SELECT 를 주석으로** · FK 이름은 Prisma 기본형 · 추가만·삭제 0) · CHECK 제약 원문 · **드리프트 0** 확인 방법 · 두 릴리스 규칙 미해당 확인 · 더 걸지 않는 인덱스.
6. **⭐ §3. 2단 전기 — 이 슬라이스의 심장** — 반출/도착 각각의 **한 트랜잭션 순서**(번호 매긴 단계) · `PostingInput` 각 칸에 무엇을 넣는가(**`transactionTypeCode` 와 `sourceDocumentTypeCode` 값 · `transactionNo` 채번 · `businessDate` 는 클라이언트 값 · `idempotencyKey`**) · `PostingEndpoint` 4칸의 값(⭐ **`IN_TRANSIT` 이 `inventory_status_code` 인지 `quality_status_code` 인지 시드로 판정** · `location_id` NOT NULL 문제) · `issue_transaction_line_id`·`receipt_transaction_line_id` 를 **언제 어떻게 되짝짓나**(⚠ `createManyAndReturn` 순서에 기대지 않는다 — I-24 R-7 선례) · 잠금 순서(I-4 R-1) · 부분 도착 · 재도착(멱등) · 도착 초과 수량 400 · 적치(I-12)와 **같은 판별자를 쓰는 문제**(문의 059 와의 정합).
7. **§4. `POST /logistics/stock-transfers`(반출 등록)** — 본문 칸 매핑 · 창고 간만 허용(`from ≠ to`) 판정 · 라인 검증(LOT·위치·수량) · 채번 · 상태 `REGISTERED` · 403 · 멱등 · If-Match 선택(무엇의 버전인지) · ETag(계약 headers 실측) · `X-Worker-No`(§5 규칙 9 — **담을 칸이 있는가**로 가른다) · 400 갈래와 **순서**.
8. **§5. `:arrive`(도착 확정)** — `StockTransferArrive` 본문 칸 · 부분 도착 · 상태 전이 조건 · 400/404/409 갈래와 순서 · 멱등 · If-Match · 403.
9. **§6. `PUT …/lines`(라인 치환)** — 치환 의미(전량 교체) · If-Match **필수**(부모 버전) · `line_no` 재부여 · 이미 전기된 라인 치환 거부(어느 상태까지 허용하나 — §2 판정) · `version_no` 증가 규약 · 403.
10. **§7. 조회 3건** — where 전수 매핑 · 기본 정렬 · `PageMeta` · 404 · 뷰 칸 매핑 · ETag 는 **상세만**(계약 실측) · 자식 컬렉션 GET 에 ETag 안 붙임(plan.md §5-4).
11. **§8. 상태기계** — `transitions.ts` 에 `stock_transfer.status_code` 축·전이 **둘**(`transfer-issue`·`transfer-arrive`)이 필요한가 실측 판정. ⚠ **A 소유 파일**이라 필요하면 §11 인계에 「통합자가 사용자에게 먼저 알린다」를 적고, `toHaveLength(n)` 단언의 **현재 값을 실측**해 적는다.
12. **§9. 횡단 · 모듈 배치** — `src/logistics/stock-transfer/` 파일 구성(기존 `putaway/`·`goods-receipt/` 모양 복제) · `logistics.module.ts` 배선 줄 수 · **다른 도메인 service 호출 0** · 권한 `manual-permissions.ts`/`derived-permissions.ts` 등록 줄(**단독 커밋**) · 멱등 n · If-Match n · ETag n · 403 n · **새 error code 0**.
13. **§10. e2e** — 파일 이름(`test/logistics-stock-transfer.e2e-spec.ts`) · **픽스처를 어느 기존 파일에서 복제하나**(`파일:줄`) · 정리(역순 `deleteMany`) · **테스트 이름 목록 전건** · 단위 테스트 이름 목록 · 2단 전기 뒤 `inventory_balance` 세 지점(출발·`IN_TRANSIT`·도착)의 기대 수량.
14. **§11. 설계 미정 자리 — 전건 판정** — README §2 절차(0~3단계)로. 판정 요약표 + **문의 후보(제목만 · 번호 `120+n`)** + 「알려둘 것」. ⭐ 최소 후보: 취소 미지원 · `IN_TRANSIT` 위치 축 · 부분 도착 · 창고 내 위치 이동 헤더 부재(uiux 581·1174) · 적치와 판별자 공유(문의 059 정합) · `IN_TRANSIT` 값의 시드 부재 여부.
15. **§12. PR 분할** — 초안 **3**(`plan.md`·`plan-api.md` S05). 각 PR 의 파일 목록 · **비테스트 예상 diff(⭐ 예상치가 아니라 비슷한 기존 파일의 «실측»으로)** · 모델(조회 sonnet / 원장·심장 opus) · 스택 순서 · **코어 파일을 고치는 PR 은 ≤200** · 예산 350 기준. ⭐ 조회 PR ① 은 3관점 리뷰와 **나란히** 스폰 가능한지 명시(README §6-1 ③).
16. **§13. 인계 + 통합 계획서 대조표** — 후속(I-14 조정 · I-16 취급 단위가 `handling_unit_id` 를 쓴다 · I-22/I-23) 에 남기는 규약 · `plan.md`·`plan-api.md`·`plan-uiux.md`·`plan-integration.md` 에서 **고쳐야 할 줄**을 표로.
17. **⭐ 맨 끝 「실측 부록」** — 사실 + `파일:줄` 한 표(README §6-1 ①). 리뷰 브리프에 그대로 실린다.

---

## 금지

구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · **값 지어내기**(값 목록이 없으면 「없다」고 적고 §2 로 판정) · `omf-mes`·`omf-mes-client` 저장소 쓰기 · `git` 쓰기 · **새 error code** · `transitions.ts` 직접 수정 · 역분개(취소) 설계.

## 최종 응답 (5줄 이내)

README §1-2 3조건 판정 · 마이그 건수 · 문의 신설 건수(제목) · PR 분할 최종안(건수·예산) · 멈춤 조건 해당 여부.
