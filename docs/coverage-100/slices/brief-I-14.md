# I-14 재고 조정 — 등록·상신·전기 — 7건 — 개별 계획안 브리프 (계획만, 구현 금지)

산출물: **`docs/coverage-100/slices/I-14.md` 하나**. 저장소의 다른 파일을 고치거나 만들지 않는다. 작업 위치는 worktree
`/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.claude/worktrees/i14-plan`(브랜치 `docs/coverage-100-c-i14-plan` ·
base `origin/main` **771c541** · 체크아웃 변경 금지 · **`git` 쓰기 금지** — 커밋은 통합자가 한다).
`contracts/*.json` 읽기 전용(`jq`·`python3`). ⛔ `prisma migrate reset`·`migrate dev`·`migrate diff --shadow-database-url`·`pnpm db:seed`·`contracts:update`·`contracts:check` 금지.
로컬 DB 는 **`psql` SELECT 만** — `postgresql://omf:omf@localhost:55432/omf_mes`.
Bash cwd 는 호출마다 리셋되므로 **절대경로로 `cd`**.
형식 정본: **`docs/coverage-100/slices/I-24.md`**(§0-재수립 R 표는 **통합자가 나중에 붙인다** — 너는 §0(3조건)~§13 + 실측 부록까지 쓴다) · 브리프 선례 `brief-I-8.md`.
너는 **레인 C**다(`docs/coverage-100/lane-C.md`). 설계 문의 번호 대역 **120~149**(파일은 062 까지 실재 · 063~068 은 I-24 예약 · ⭐ **같은 레인의 I-13 계획안이 120 부터 먼저 쓴다 — 너는 «130» 부터 쓴다**).

**대상 7건**(`assignment.tsv` 실측 · 계약 `contracts/logistics-01자재창고.json`)
| 오퍼레이션 | 403 | 계약 path 줄 |
|---|:-:|---|
| `GET /inventory/adjustments` | — | 30 |
| `POST /inventory/adjustments` | 403 | 30 |
| `GET /inventory/adjustments/{inventoryAdjustmentId}` | — | 193 |
| `GET /inventory/adjustments/{inventoryAdjustmentId}/lines` | — | 244 |
| `PUT /inventory/adjustments/{inventoryAdjustmentId}/lines` | 403 | 244 |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:post` | 403 | 364 |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval` | 403 | 444 |

커버리지 **+7**(같은 레인의 I-13 과 병렬이라 최종 숫자는 병합 순서가 정한다 — 계획안에는 「+7」로 적는다).

---

## ⭐ 이 슬라이스의 모양 — 「출고(I-4)의 쌍둥이」

`goods_issue` 가 **이미 같은 3형상**(`:post` 원장 전기 · `:request-approval` 승인 상신 · `PUT …/lines` 라인 치환 · `approval_request_id` FK)을 구현해 놓았다. **`src/logistics/goods-issue/` 를 먼저 통째로 읽고 같은 모양으로 쓴다 — 새 규칙을 만들지 않는다.**

- 원장: **`INVENTORY_ADJUSTMENT`** 판별자(`plan.md` §5-8 「원장 판별자 4값 고정」 · `plan.md` §5-12 「승인 FK 를 쓰는 업무 승인 3종」에 `INVENTORY_ADJUSTMENT` 가 들어 있다).
- ⭐ **라인이 증/감을 함께 담는다** — `inventory_adjustment_line.adjustment_qty Decimal(20,6)` 은 부호를 갖는다(`prisma/schema.prisma:4019~`). 따라서 원장 라인이 **`to` 만 있는 것(증)과 `from` 만 있는 것(감)이 한 트랜잭션에 섞인다**. `PostingLine.from`/`to` 를 부호로 어떻게 가르는지 계획안이 못 박는다.
- **승인**: `:request-approval` → I-1 승인 코어 재사용. `:post` 는 **승인이 안 끝났으면 400**(계약). 판정 축은 `plan.md` §5-12 — 문서의 `approval_request_id` FK 는 업무 승인 하나만이고 판정은 **다형 축**(`approval_request.(target_type_code, target_id, approval_type_code)`)으로 조회한다.

⚠ 예상 설계 미정 — **조정이 «어느 상태로» 넣는가**. `inventory_adjustment_line` 에 `quality_status_code`·`inventory_status_code` 가 **NOT NULL 로 실재한다**(`schema.prisma:4025-4026`) — 계약 `InventoryAdjustmentLineUpsert` 가 그 둘을 싣는지 **실측**하고, 안 실으면 §2 2단계 **기준 4「값을 조용히 도출하지 않는 쪽」→ 400** 이다(`plan-integration.md:337`).

⚠ **마이그레이션은 「없음」이 초안**이다(`plan-api.md:189` — 계약이 「`inventory_adjustment_line` 은 물리에 없다」고 두 곳에 적었으나 **낡았다**, 표는 실재). 실측으로 확인하고, 필요한 칸이 나오면 `plan.md` §4 에 없던 마이그이므로 §0 조건 ① 에 걸린다고 적는다.

⚠ **`inventory_count_id?` 가 실재한다**(`schema.prisma:465`) — 실사(I-15)가 뒤에 오지만 이 칸은 **지금 계약이 받는지** 실측한다. I-15 의 `:close` 판정(「조정됨」을 무엇으로 재나 · `plan-integration.md:346`)이 이 칸에 걸리므로 **인계(§13)에 반드시 적는다**.

---

## 읽을 것 (순서대로)

1. **`docs/coverage-100/README.md`** — §0 범위 · §1-2 절차 · **§2 판정 절차(0~3단계)** · §3 멈춤 조건 · §5 불변 제약 · §6·§6-1(예산 350 / 한도 400 / **코어 ≤200** · **실측 부록** 의무).
2. **`docs/coverage-100/lane-C.md`** · **`lanes.md`**(§1-2 마이그 이름 초까지·추가/완화만 · §1-4 소유 파일 — **`transitions.ts` 는 A 소유** · §4 절대 금지).
3. **`CLAUDE.md`** — `business_date` 는 **클라이언트가 보낸다**(C-8) · PR 크기 · 마이그 하위 호환.
4. **`docs/coverage-100/plan.md`** — §0 #14 · §1 I-14 행 · §4(**I-14 마이그 행이 없다**) · **§5 횡단 1~12 전건**(특히 **8 원장 판별자 4값 고정** · **12 승인 FK vs 다형 축** · 2 멱등 · 3 If-Match · 4 ETag · 6 에러 코드 신설 금지 · 7 값 없는 칸 키 생략) · §6 건너뜀(I-14 은 없다).
5. **`docs/coverage-100/plan-api.md`** — **184~216행 S07**(쓰는 표 · 마이그 「없음(실측)」 근거 · posting 연결 · 상태기계 `LOGISTICS_DOCUMENT_STATUS` · PR 5(그중 조정은 ④) · 오퍼레이션 4축 표 198~216) · **749행**(`document-post` 전이 — `REGISTERED`→`POSTED` · `:post` 가 원장을 부른다) · **967행**(S07 권한 미등록 — `:post`·`PUT …/lines`. ⚠ `POST /inventory/adjustments`·`:request-approval` 도 계약 403 이다. **실측으로 다시 센다**).
6. **`docs/coverage-100/plan-uiux.md`** — **51행 U17**(7건 · 화면 **W-01-12** · 선행 U16·U1 · 마이그 없음 · PR 2) · **273~283행**(오퍼레이션↔화면·헤더 매핑 — ⚠ 「ETag」는 **계약 `responses.*.headers` 실측이 이긴다**) · 623행(순서 근거 — 실사 차이를 닫는다) · 834행·1146행(`PUT …/lines` If-Match 는 **부모 상세 GET 의 ETag**).
7. **`docs/coverage-100/plan-integration.md`** — **178행**(I-14 행) · **292행**(생산창고 입고 차이는 기록만 · 재고를 맞추는 것은 I-14) · **330~337행 §3-1 I-14**(체인 마디 · 원장 판별자 · 승인 · 예상 설계 미정) · **340~346행 I-15**(⭐ 실사가 조정에 무엇을 기대하는가 — 인계) · 665행(역트랜잭션 3벌 — 조정 역분개는 **I-5 코어 재사용**이지 새로 짓지 않는다) · 823~840행 §10 부록.
8. **선행 결과물** — ⭐ **`slices/I-4.md`**(출고 — `:post`·`:request-approval`·`PUT …/lines`·원장·승인 400 판정의 **직접 선례**. §3-3 손검사 · §7-2 · R-1 잠금 7칸 오름차순 · R-7 · R-11) · **`slices/I-1.md`**(승인 코어 — `approval_request` 다형 축 · `:request-approval` 202 와 `ApprovalRequestRef`) · **`slices/I-5.md`**(다형 취소 — `posting.reverse()` · `INVENTORY_ADJUSTMENT` 가 취소 대상 유형인지 **실측**) · `slices/I-12.md`(원장 쓰는 슬라이스 형식) · `slices/I-24.md`(형식·§12 마감표·실측 부록).
9. **실재 코드 — 반드시 통독** — `src/logistics/goods-issue/` **전 파일**(`goods-issue.controller.ts`(⭐ **34행 주석** — 권한 수동표/파생표 구분 · 128행 `:request-approval` · 146행 주석 「가드가 파싱해 둔 If-Match 값을 꺼내 서비스가 비교만 한다」) · `goods-issue.service.ts` · `goods-issue-update.service.ts`(라인 치환) · `goods-issue-query.service.ts` · `goods-issue-view.ts` · `goods-issue-rules.ts` · `issue-posting.ts`(⭐ 원장 호출 자리)) · `src/logistics/purchase-order/purchase-order.controller.ts:124`(`:request-approval` 선례 둘째) · `src/core/approval/approval.service.ts` · `src/core/inventory-posting/`(`inventory-posting.service.ts` 머리 주석 22~44 · `post()` · `posting.types.ts` **`PostingEndpoint` 4칸**·`PostingLine.from/to` · `balance-lock.ts`) · `src/core/document-state/`(`transitions.ts` 에 `inventory_adjustment.status_code` 축이 **있는지 실측** · `document-state.spec.ts` 의 `toHaveLength(n)` 현재 값 — ⚠ **A 소유 파일**) · `src/core/numbering/numbering.service.ts` + `prisma/seed.ts:1378`(`INVENTORY_ADJUSTMENT` 채번 규칙 실재) · `src/common/permissions/`(`manual-permissions.ts`·`derived-permissions.ts` — 등록이 이미 있는지) · `src/common/errors/error-codes.ts`(**새 코드 금지** — 쓸 수 있는 값 목록 확인) · `src/inventory/`(모듈 배치 — `balance/`·`transaction/` 곁에 `adjustment/` 를 세우는지 `inventory.module.ts` 실측).
10. **물리** `prisma/schema.prisma` — **`inventory_adjustment` 462~**(13칸 · `inventory_count_id?` · `reason_code` **NOT NULL** · `approval_request_id?` · `status_code` · `adjusted_at?` · `version_no`) · **`inventory_adjustment_line` 4019~**(`uq_inventory_adjustment_line` · `lot_id?` **nullable** · `quality_status_code`·`inventory_status_code` **NOT NULL** · `adjustment_qty` 부호 · `reason_code` **NOT NULL** · `inventory_transaction_line_id?` · **CHECK 제약 있음 — baseline 마이그에서 원문 실측**) · `inventory_balance` 484~ · `inventory_transaction` 610~ · `_line` 639~ · `approval_request` 76~ · `inventory_count` 524~.
11. **시드** `prisma/seed.ts` — `INVENTORY_ADJUSTMENT_REASON` **596** · `LOGISTICS_DOCUMENT_STATUS` **1069** · 채번 **1378** · 승인 유형(`APPROVAL_TYPE`)에 `INVENTORY_ADJUSTMENT` 가 있는지 · `QUALITY_STATUS`·`INVENTORY_STATUS` 값 목록.
12. **계약** `contracts/logistics-01자재창고.json` — path **30·193·244·364·444** · 스키마 **`InventoryAdjustment` 9733** · `InventoryAdjustmentCreate` **9810** · `InventoryAdjustmentDetailResponse` **9853** · `InventoryAdjustmentLine` **9871** · `InventoryAdjustmentLineListResponse` **9951** · `InventoryAdjustmentLineUpsert` **9965**. `parameters` 전수 · `requestBody` 칸 전수 · `responses` 코드·`headers`(ETag) · `x-code-key` · **`x-internal-note` 원문 전건**(⭐ 「물리에 없다」가 낡았다는 증거를 인용으로 남긴다).
13. **화면 사본**(읽기 전용 · 메인 체크아웃) — `/Users/hj.cho/A-Crefle/A-Project/OmfMes/omf-mes-server/.design-reference/omf-mes/design/wiki/screens/01/W-01-12-재고조정.md`(⭐ 「실사 결과에서 불러오기」·상신·전기 버튼의 조건 · 예외 목록) · 참고 `W-01-13-물류문서진행현황취소.md`(취소가 조정을 어떻게 다루나) · `W-01-04-재고실사.md`(I-15 인계).
14. **기존 문의** `docs/design-inquiries/README.md` 전건 훑기(중복 방지). 새 번호는 **130 부터**.

---

## 담을 것 (I-24.md 의 절 짜임)

1. **머리말 블록** — 브리프 경로 · 통합 계획서 해당 절 줄번호 · 실측 기준(worktree·base 커밋·계약 `COMMIT.txt`=`a6a87e1`·실측일·DB 행수) · 커버리지 +7 · 「§0-재수립이 본문보다 앞선다」.
2. **§0. README §1-2 3조건 판정** + ⭐ **「리뷰가 반드시 볼 자리 5개」**(네가 ⭐ 로 표시한 갈림길 + 뒤집히면 PR 분할이 바뀌는 자리).
3. **§1. 계약 읽기 표 — 7건 전건** — 횡단 4축 실측 · 조회 3건 질의 칸 전수 ↔ 물리 칸 · 쓰기 4건 본문 스키마 전수 · 응답에서 **채울 수 없는 칸 / 담을 데 없는 칸** · 값 목록(계약 ↔ 시드) · **에러 코드 새 코드 0건** 증명.
4. **§2. 물리 대조 + 마이그레이션 결론** — 전칸 대조표 · 결론이 「0건」이면 그 근거를(계약 노트가 낡았다는 인용 + 실측) · 필요하면 **SQL 전문 + 사전 대조 SELECT 주석** · CHECK 원문 · 두 릴리스 규칙 미해당.
5. **⭐ §3. `:post` — 이 슬라이스의 심장** — 한 트랜잭션 순서(번호 매긴 단계) · **승인 완료 판정을 다형 축으로 조회**(`plan.md` §5-12) · 미승인 400 의 코드·필드 · `PostingInput` 각 칸(`transactionTypeCode`·`sourceDocumentTypeCode`·`transactionNo` 채번·`businessDate` **클라이언트 값**·`idempotencyKey`) · ⭐ **부호 → `from`/`to` 가름** · `inventory_transaction_line_id` 되짝짓기(⚠ `createManyAndReturn` 순서에 기대지 않는다 — I-24 R-7) · 잠금 순서(I-4 R-1) · 음수 잔량 400(`NEGATIVE_BALANCE` 기존 코드) · 상태 전이 `REGISTERED`→`POSTED` · `adjusted_at` · 멱등·재전기 · If-Match **필수**.
6. **§4. `:request-approval`** — I-1 코어 호출 · 202 와 `ApprovalRequestRef` · `approval_request_id` FK 를 채우는가(§5-12 판정과 정합) · 재상신 · 상태를 **옮기지 않는다**(`plan-api.md:755` 마지막 줄) · 400 갈래.
7. **§5. `POST /inventory/adjustments`(등록)** — 본문 칸 매핑 · `reason_code` NOT NULL 원천 · 채번(`$transaction` 밖 · 재시도 형상) · 상태 `REGISTERED` · `inventory_count_id` 를 받는가 · 라인 동시 등록 여부 · 400 갈래와 **순서** · `X-Worker-No`(§5-9 — 담을 칸으로 가른다).
8. **§6. `PUT …/lines`(치환)** — 전량 교체 의미 · If-Match **필수**(부모 버전) · `line_no` 재부여 · **전기된 뒤 치환 거부**(어느 상태까지 허용 — §2 판정) · `version_no` 증가 규약.
9. **§7. 조회 3건** — where 전수 · 기본 정렬 · `PageMeta` · 404 · 뷰 칸 매핑 · ETag 는 **상세만**(계약 실측) · 자식 컬렉션 GET 에 ETag 안 붙임.
10. **§8. 상태기계** — `transitions.ts` 축·전이 필요 여부를 **실측 판정**. 필요하면 ⚠ **A 소유 파일**이라 §13 인계에 「통합자가 사용자에게 먼저 알린다」 + `toHaveLength(n)` 현재 값.
11. **§9. 횡단 · 모듈 배치** — `src/inventory/adjustment/` 파일 구성(`goods-issue/` 모양 복제 · 파일별 예상 줄 수는 **기존 파일 실측**으로) · `inventory.module.ts` 배선 · **다른 도메인 service 호출 0** · 권한 등록 줄(**단독 커밋**) · 멱등/If-Match/ETag/403 건수 · **새 error code 0**.
12. **§10. e2e** — 파일 이름(`test/inventory-adjustment.e2e-spec.ts`) · **픽스처를 어느 기존 파일에서 복제**(`파일:줄` · `test/logistics-goods-issue.e2e-spec.ts` 유력) · 정리 역순 · **테스트 이름 목록 전건** · 단위 테스트 이름 목록 · 전기 뒤 `inventory_balance` 증/감 기대값.
13. **§11. 설계 미정 자리 — 전건 판정**(README §2 0~3단계) — 판정 요약표 + **문의 후보(제목만 · 번호 `130+n`)** + 「알려둘 것」. 최소 후보: 라인의 두 상태 코드 원천 · 승인 미완 전기 400 의 코드 · 조정 취소/역분개 지원 여부 · `inventory_count_id` 를 누가 채우나.
14. **§12. PR 분할** — 초안 **3**(`plan.md` I-14 행). 각 PR 파일 목록 · **비테스트 예상 diff(기존 파일 «실측» 기준)** · 모델(조회 sonnet / 원장·심장 opus) · 스택 순서 · 코어 파일 고치면 ≤200 · 예산 350. ⭐ 조회 PR ① 을 3관점 리뷰와 나란히 스폰 가능한지 명시.
15. **§13. 인계 + 통합 계획서 대조표** — ⭐ **I-15 실사**(`inventory_count_id` · 「조정됨」 판정 축 · 실사는 원장을 안 쓴다) · I-9 생산창고 차이 · I-5 취소. `plan.md`·`plan-api.md`·`plan-uiux.md`·`plan-integration.md` 에서 **고쳐야 할 줄**을 표로.
16. **⭐ 맨 끝 「실측 부록」** — 사실 + `파일:줄` 한 표(README §6-1 ①).

---

## 금지

구현 코드 작성 · 계약 파일 수정 · 다른 문서 수정 · **값 지어내기** · `omf-mes`·`omf-mes-client` 저장소 쓰기 · `git` 쓰기 · **새 error code** · `transitions.ts` 직접 수정 · 문의 번호 130 미만 사용.

## 최종 응답 (5줄 이내)

README §1-2 3조건 판정 · 마이그 건수 · 문의 신설 건수(제목) · PR 분할 최종안(건수·예산) · 멈춤 조건 해당 여부.
