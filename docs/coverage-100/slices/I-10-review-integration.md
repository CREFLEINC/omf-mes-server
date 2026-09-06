# I-10 개별 계획안 — **통합 관점** 재검토 (`plan-integration.md` 저자 입장)

> 대상 `slices/I-10.md`(992행) · worktree `docs/coverage-100-i10-plan` · main `1729dc1` · 계약 `a6a87e1` · 실측일 2026-09-07.
> 판정 13건: ✅ 7 · ✏ 5 · ⛔ 1(M-1 근거 두 줄). **착수 전 반드시 고칠 것은 §3(긴급 W/O) · §4-1(단말 토큰 · I-11 안 반영) · §10(PR ① 예산) 셋**이다. 결론(마이그 2 · 원장 0 · 계보 0)은 셋 다 **불변**이다.
> 실측은 전부 이 저장소에서 다시 뜬 것이다(python `json` · `psql` SELECT · `grep` · Prisma 모델).

## 1. ⭐⭐ 계보 `lot_relation` 을 안 만든다(§3-9) — ✅ **유지**. 근거 하나를 바꾼다

실측 다섯이 전건 선다.
- `lot-registry.service.ts:134-166` `preIssueWithin` 이 `lotNos` 길이만큼 슬롯을 만들고 `work_order_lot_seq = index+1` 을 매긴다 ⇒ **N 개** ✅ · `:27` `PREISSUED_LIFECYCLE = 'WAITING'` ✅ · `P-02-12:70` R24 ✅ · `MaterialConsumptionCreate` 선택 11칸에 target 축 0 ✅.
- **`ck_material_usage_target` 원문 실측** — baseline `:1696-1698` `CHECK (production_result_id IS NOT NULL OR output_lot_id IS NOT NULL)`. 계획서 인용이 정확하다 ⇒ 대안 (ii) 기각 ✅.
- **04 종결점 실측** — `shipment_lot_allocation` 을 읽는 코드 0(있는 것은 `derived-permissions.ts:265` 권한 한 줄과 `goods-receipt-view.ts:97` 의 반품 칸). `lot_relation` 은 `src/`·`test/`·`prisma/seed.ts` 전부 **0건**, DB **0행**(psql).
  ⇒ ⭐ **「지금 안 써도 깨지는 소비자가 오늘 0이다」가 실측으로 선다.** 이 문장이 §3-9 에 없다 — 「본길인데 안 만든다」의 위험을 재는 유일한 실측이므로 **추가하라**.

✏ **예비안 행의 문구는 삭제한다.** 재검토가 물은 「화면 §5-4 의 1:1 이 예비안을 지지하지 않나」는 **오독이고, 계획서가 그 오독을 자초했다**. `P-02-03` §5-4 L169: ⌜1:1 스캔이면 정확, **호퍼 경유·혼합이면 근사**⌝ — 여기의 1:1 은 «자재 쪽 스캔 방식»(정확도 축)이지 «생산LOT 슬롯이 하나»가 아니다. ⇒ §3-9 예비안 행의 「화면의 「1:1 스캔」과 같은 결」을 **지운다**. 예비안 자체는 A-21 로 막아 둔 채 유지 ✅.
✏ 대안 (iii) 기각도 유지하되, 재검토가 던진 물음(⌜계약이 요구하는 것은 «등록 시점»인가 «계보의 존재»인가⌝)은 **052 본문에 한 줄로 넣는다** — 우리가 답할 물음이 아니다.
✅ `material_usage_allocation` 도 안 만든다(§3-10) — CHECK 원문이 그대로 닫는다.

## 2. ⭐⭐ 반출 원장 0(§4-4) — ✅ **확정**. 멈춤 조건 3 **미발동**이 실측으로 서 있다

계약 전문을 다시 떴다(python).
- `MaterialReturn`·`MaterialReturnCreate`·`MaterialReturnLine` **셋 다 `description` 도 `x-internal-note` 도 없다.** 「재고를 옮긴다」·「원장」·`inventoryTransactionLineId` 문구 **0건**. `MaterialReturnLine` 응답 칸 5(`materialReturnLineId`·`itemId`·`lotId`·`returnQty`·`uomId`)에 원장 FK **없음**.
- 오퍼레이션 description 도 원장을 안 적는다(⌜W/O 잔여 자재를 창고로 반납 … 소유 화면이 정해지면 근거를 다시 적는다⌝ 가 전부).
  ⇒ **계약은 스스로 모순되지 않는다 ⇒ 멈춤 조건 3 미발동 ✅.** 계획서 판정 그대로다.
- `posting.types.ts` — `PostingEndpoint` 4칸 전부 필수 ✅ · `businessDate` 주석이 C-8 도출 금지를 이름 붙여 막는다 ⇒ 「`requested_at` 날짜를 `businessDate` 로」 대안 기각 ✅.
- `mdm.location` 17칸 전건 확인 — 기본 위치 플래그 **0** ✅(있는 것은 `allow_mixed_item`·`allow_mixed_lot`·`location_type_code`).
- `InventoryTransaction.sourceDocumentTypeCode` enum **4값** ✅(logistics 계약 · ⌜값은 «대상 테이블 이름»⌝). `app.entity_type_registry` 에 `MATERIAL_RETURN` **0행**(psql) · `MATERIAL_CONSUMPTION` 은 실재 ✅.
- ⭐ `transactionTypeCode: 'STOCK_TRANSFER'` 로 `post()` 를 부르는 코드 **0건**(`inventory-transaction.service.ts:20` 은 타입 유니온 · `document-progress/document-type-registry.ts:68` 은 등록부) ⇒ **첫 사용처는 I-13 그대로** ✅.

⚠ **경로 오기 1건** — 계획서·브리프의 `src/core/document-state/document-type-registry.ts:68` 은 실재하지 않는다. 실재는 **`src/logistics/document-progress/document-type-registry.ts:68`**. 구현 브리프에 그대로 넘어가면 탐색이 헛돈다.

## 3. ⭐ 긴급 W/O 투입 전건 400(§3-4 ⓐ · §8-3 ⓒ) — ✏ **판정은 유지, 근거와 「알려둘 것」을 고친다**

⛔ 계획서가 **하류를 상류로 오해했다.** 실측:
- `work-order-write.service.ts:117-131` — I-6 이 `productionPlanId` 를 비운 긴급 발행을 **이미 400 `REQUIRED`** 로 막았다(⌜긴급 발행 경로는 공장 컨텍스트 확정(문의 040) 뒤 연다⌝).
  ⇒ 오늘 API 로는 `work_order.production_plan_id IS NULL` 인 행이 **생기지 않는다.** I-10 의 400 은 **도달 불가 가장자리**이고, `P-02-12` 를 막고 있는 것은 I-10 이 아니라 I-6 이다.
- `P-02-12:5·6` — ⌜서버가 내부 P/O(`erpOrderNo` 없음)와 **계획**을 한 트랜잭션으로 만들어 붙인다(B-8)⌝. 그리고 `production_plan.bom_id` 는 **NOT NULL**(Prisma 실측) ⇒ 040 이 풀려 긴급 경로가 열리는 날에도 계획이 붙으므로 **BOM 3홉이 그대로 선다.**
- `work_order` 전칸 실측 — **`bom_id` 없음 · `plant_id` 없음** ⇒ 3홉이 유일 경로 ✅, 채번 `plantId` 도 계획을 지나야 풀린다 ✅.

⇒ 고칠 것 셋: ⓐ §3-4 ⓐ 의 근거를 「**§2 0단계 — I-6 이 같은 뿌리(040)에서 이미 400 으로 닫았다**」로 바꾼다(오늘은 1단계 가장자리+기준 2 로만 서 있다) ⓑ §8-3 ⓒ 의 ⌜그 화면의 주 시나리오가 막힌다⌝ 를 ⌜**긴급 W/O 가 오늘 발행되지 않는다(I-6·040) — I-10 이 새로 막는 것은 없다**⌝ 로 바꾼다 ⓒ 재검토가 낸 대안(`production_plan_id` NULL 이면 `bom_component_id` NULL 로 기록만)은 **⛔ 기각** — I-6 보다 넓은 문이 되어 같은 뿌리에서 두 슬라이스가 갈린다.

## 4. 마이그 2(§2-5) — ✅ · M-1 근거 순서와 M-2 일관성 한 줄

- 두 릴리스 규칙 **미해당** ✅(삭제 0 · NOT NULL 완화만 · 두 표 0행 — psql 로 재확인: `material_consumption` 0 · `material_return` 0 · `terminal` 0). `npx prisma generate` ✅.
- ⛔ **M-1 의 근거 두 줄이 틀렸다** — 「`mdm.terminal` 0행」(개발 DB 사정)과 「단말 토큰 **발급·**검증 축 0건」. 둘 다 빼고 아래로 갈아끼운다.

### 4-1. ⭐ 단말 토큰 — M-1(완화) vs I-11 안(Bearer 필수) vs 절충 · §2 판정

실측 정정 수용 + 내가 다시 뜬 것:
- **발급은 있다** — `mdm/terminal/terminal.service.ts:200-223` `issueToken()` 이 `{sub, typ:'terminal', tv}` 를 서명한다(등록 토큰 · TTL 1년 · 주석 ⌜관리웹이 **QR 로 그려** 보이고 **기기가 스캔해 읽는다 — 기기는 서버를 부르지 않는다**⌝).
- **검증은 0건** — `session-resolver.service.ts:47` 은 쿠키의 `typ:'session'` 만 본다 · `authentication.guard.ts:24-28` 이 ⌜단말 토큰은 아직 없다 … 그 도메인을 만들기 «전»에 단말 인증이 서야 한다⌝.
- ⭐ **계약 실측(내가 뜬 것) — 487 오퍼레이션 중 `security` 선언 0건 · top-level `security` 도 7벌 전부 `None`.** `securitySchemes.terminalToken` 은 `app-공통.json` 에 **정의만** 있고, 그 설명은 ⌜서버는 이 토큰의 «종류»로 **`X-Worker-No` 필수 여부를 가른다**⌝ 다.

⇒ 계약 안에서 단말 토큰은 **주체 축이 아니라 「사번을 물을지 말지」의 가름**이다. 그런데 `POST /production/material-consumptions` 는 `X-Worker-No` 를 **무조건 required** 로 선언했다(§1-1 실측) — 즉 이 오퍼레이션은 계약 스스로 **「토큰이 없을 수도 있는」 쪽**에 세워 둔 자리다.

| 안 | §2 판정 |
|---|---|
| **B. I-11 안 — Bearer 를 읽고 없으면 400 `REQUIRED`** | ⛔ **I-10 에는 못 옮긴다.** 계약이 **어느 오퍼레이션에도 `security` 를 안 걸었다** ⇒ 화면에게 「이 헤더를 보내라」고 말한 계약 문장이 0이다. 400 으로 닫으면 `P-02-03`·`P-02-11`·`P-02-12` 투입이 **전건 죽는다** — 계획안이 M-1 대안 ⓑ(400 거부)를 기각한 **바로 그 논리**이고, 값을 본문에서 헤더로 옮긴다고 달라지지 않는다(I-4 §5-3 · 기준 2 의 「거부하는 쪽」은 «업무를 없애지 않을 때»만 산다) |
| **C. 절충 — 오면 검증해 채우고 없으면 비운다** | ⭕ 방향은 맞다. **그래도 M-1 이 필요하다**(없을 때가 존재한다) ⇒ 마이그 2 · 「차이가 크다」 조건 ① **불변** |
| **A. 계획안 — 완화 + 키 생략** | ✅ **이번 PR 은 A 로 간다.** C 와 결과가 «오늘» 같고(토큰을 보내는 클라이언트가 0), 기준 5(새 개념 수 — 토큰 검증 축을 이 슬라이스가 세우지 않는다)가 가른다. A→C 는 **후속 한 줄**이고 그것은 완화다(기준 2) |

⇒ ⭐ **M-1 의 결정적 근거는 이것이다: 세 안 중 어느 것을 골라도 「토큰 없이 오는 호출」을 400 으로 죽이지 않는 한 `terminal_id` 는 nullable 이어야 한다.** 「0행」·「축 0건」보다 훨씬 세다 — §2-5 M-1 과 §8-1 #1 을 이 문장으로 갈아끼워라.

**순서·스택(README §1-2 조건 ②)** — ✅ **미발동으로 유지한다.** `src/auth/terminal-token.ts` 는 **I-11 이 만든다**: `work_session.terminal_id` 는 NOT NULL 이고 `WorkSession.terminalId` 는 계약 required 라 I-11 은 「토큰을 풀거나 마이그하거나」 둘 중 하나가 절박한 반면, **I-10 은 없어도 선다**(M-1 이 이미 그 자리를 연다). ⛔ **I-10 이 그 파일을 만들지도 쓰지도 않는다** — 만들면 I-11 이 I-10 PR ①·② 병합을 기다려 `plan.md` 45행의 `∥ I-11` 이 **직렬로 바뀐다**. §9 I-11 인계 행에 「헬퍼는 I-11 것 · I-10 은 헬퍼가 서면 후속 한 줄로 C 가 된다」를 적어라.

**게이팅** — `terminal_process.can_input_material` 안 건다 ✅ 유지. 토큰이 «오는 호출에서만» 걸리면 반쪽 게이트라 A-21 에 걸린다. 덤 실측: 같은 표에 **`can_return_material` 칸이 실재한다** ⇒ 반출 게이팅도 같은 이유로 안 건다 — §8-3 ⓘ 에 한 줄 더한다.
**덤(I-6·040 하류)** — `mdm.terminal.plant_id` 는 **NOT NULL** 이다. 토큰 검증이 서는 날 **공장 컨텍스트가 풀린다** ⇒ 문의 040(긴급 발행이 내부 P/O 의 `plant_id` 를 못 푼다)의 답 후보가 생긴다. §9 I-11 행에 한 줄.
- ✏ **M-2 vs 상수 셋의 일관성을 한 줄로 명시하라.** 지금은 독자가 자의로 읽는다. 실측 가름: 상수 셋은 계약이 **`x-no-code-key`+「서버가 정한다」로 판정 주체를 넘긴 칸**이고, `return_quality_status_code` 는 **요청·응답 어디에도 칸이 없다**(python 실측 — `MaterialReturnLine` 5칸 전건). 「주체를 넘겨받은 칸은 상수, 칸조차 없는 것은 완화」가 그 가름이다. §2-5 M-2 와 §8-1 #2 에 넣어라.

## 5. 상수 셋(ⓚ · 문의 053) — ✅ 조건부. **053 을 두 칸으로 갈라라**

`consumptionTypeCode` 의 `x-no-code-key` 실측: ⌜셋 중 둘이 이미 다른 축으로 빠져 남는 것이 **「정상」 하나**. 값이 하나뿐인 축은 축이 아니다⌝ + `x-internal-note` 가 「재생재」→품목 축, 「대체」→`replacedConsumptionId` 로 실제로 빼냈다.
⇒ `NORMAL` 은 **뜻을 계약이 주고 문자열만 서버가 골랐다**(I-9 `REGISTERED` 보다 한 칸 아래, 지어내기보다 한 칸 위). `RECORDED`·`REQUESTED` 는 **뜻조차 없는 이름**이다.
✏ 053 이 셋을 한 등급으로 묶으면 회신이 「알아서 하라」로 온다 — **「뜻 있음(1) / 이름뿐(2) / 칸 없음(1·M-2)」 세 칸**으로 갈라 적어라.
⛔ `status_code` 를 nullable 로 완화하는 대안은 기각 — 두 `statusCode` 는 **계약 응답 required** 다(M-2 와 자리가 다르다).

## 6. 주체·멱등·409(§3-7·§3-12) — ✅ · `plan.md` 고칠 자리 하나가 빠졌다

- `terminalId` 키 생략 ✅ — `plan.md` §5 규칙 7(⌜값 없는 칸 — 키 생략(널 금지)⌝) 그대로. ✏ 근거 문장만 §4-1 로 갈아끼운다(「토큰 축 0건」 ✕ → 「**검증 0건 + 계약 `security` 선언 0건**」).
- `resolveWorker` 둘째는 사본, `assertWorkerNo` 넷째는 공용화 ✅ — I-9 가 «셋째까지 기다린다»로 세운 기준과 일관된다(임의 아님).
- 멱등 둘 다 ✅ — 303행은 `work_session`(전역 UNIQUE) 문장이 맞다. 409 `code` 누락은 코어라 미룸 ✅(`idempotency.service.ts:115·121` 두 자리 · `ConflictException` 이 `code` 를 안 싣는 것 실측).
- ✏ **빠진 자리** — `plan.md` §5 규칙 9 의 «예외 목록»(오늘 4건)에 **`POST /production/material-consumptions` 를 더해야 한다.** §10 말미의 「함께 고칠 통합 계획서 자리」 10개에 이 행이 없다 ⇒ **11번째**로 넣어라.

## 7. 반출 권한 `P-02-03` 임시 등록(§4-1) — ✅ · **선례를 인용하면 «임의»가 «0단계»가 된다**

`manual-permissions.ts` 전문 실측 — **같은 형상이 이미 셋 있다**:
`PUT /logistics/goods-issues/{id}/lines`(⌜부르는 화면이 실제로 0건이나 `PermissionGuard` 가 등록을 요구한다(미등록이면 500)⌝) · `PUT /logistics/inbound-receipts/{id}`·`/lines`(⌜두 PUT 을 부르는 화면이 26장에 없다(문의 026) — 화면이 정해지기 전까지 등록 화면으로 **잠정 등록**⌝).
⇒ 「그 화면이 마스터를 소유한다」 규약에는 **이미 «500 회피 + 잠정» 예외가 둘** 있고 I-10 은 셋째다. §4-1 에 이 두 줄을 인용하라 — 「가장 좁은 문」이 지어낸 정책이 아니라 **선례 답습**이 된다.
⛔ 대안(가드를 고쳐 403 선언 오퍼레이션을 통과시킨다)은 기각 — 인가를 «넓히는» 코어 변경이라 §2 기준 2 정면 위반이고, `permission.guard.ts:47-53` 의 던지는 문구가 그 자리를 이미 「등록하라」로 못박았다.

## 8. 수령 라인 귀속(§3-5) — ✅ · 인덱스 사실을 하나 더 적어라

상한 ✕ 유지 ✅(I-9 §9 의 ⌜누계를 못 센다⌝ + A-21). `shopfloor_receipt_line` 에 `item_id`·`lot_id` 실재 ✅ ⇒ 귀속 축이 선다.
✏ 실측 보강 — **`shopfloor_receipt_line` 에는 인덱스가 하나도 없다**(Prisma 모델 `@@index` 0 · PG 는 FK 에 인덱스를 안 만든다). 즉 상한 «집계»뿐 아니라 **귀속 조회 자체가 풀스캔**이다. 판정은 그대로 두되 §2-6 과 §8-3 ⓖ 의 후속 마이그 후보에 **`shopfloor_receipt_line(lot_id, item_id)`** 한 줄을 더한다.

## 9. 반출 기타(ⓙ) — ✅ · 한 줄만 흔적을 남겨라

`line_no` 서버 1..N ✅(`uq_material_return_line(material_return_id, line_no)` 실측) · `(item,lot)` 중복 400 ✅ · 잔량 대조 ✕ ✅(라인에 잔액 차원 칸 0 — I-4 문의 031 과 같은 자리) · `requested_at = now()` ✅ 대기 15 누적 **11** ✅ · 목록 `lines` 실음 ✅ · 멱등 `runIdempotent` 만 ✅(`material_return` 에 `idempotency_key` 칸 없음 — Prisma 실측).
✏ **같은 공장 검사(§4-2 ⓒ)만 계약 근거가 0이다.** `warehouse.plant_id` 1홉이라 기준 5 로 서지만, 이것이 **이 슬라이스가 계약 없이 더한 유일한 거부**다 — §8-3 에 한 줄(오늘 ⓝ 은 «안 하는 것»만 적었다). 「거부는 완화가 싸다」(기준 2)를 근거로 붙여 두면 회신이 왔을 때 지우기 쉽다.

## 10. e2e·PR·모델(§7·§11) — ✏ **공용화 둘을 PR ① 에서 뗀다**(모델은 그대로)

- PR ① ~332 는 브리프 예산 350 에 **18** 밖에 안 남는다. `worker-no.ts`·`query-cast.ts` 는 **남의 도메인 파일 6개**(`lot-complete`·`picking-pick`·`shopfloor-receipt` + query 3벌)를 건드려 리뷰 면과 **회귀 e2e 면**을 함께 늘린다 — I-9 는 ⌜자리가 굳은 뒤⌝ 라 적었을 뿐 ⌜I-10 PR ① 에서⌝ 라 적지 않았다.
  ⇒ **처음부터 후속 소형 PR(순수 이동) 로 뗀다.** PR ① 은 «마이그 2 + 조회 4» ~322 가 되고 파일이 전부 신설이라 충돌 면이 0 이 된다. 계획서의 「초과 위험이 실측되면 뗀다」는 판단을 구현 중으로 미루는 것이라 늦다.
- ⛔ **PR ① 모델을 sonnet 으로 낮추지 않는다.** README §4 표가 「구현 — 코어(원장 쓰기·상태기계·posting·**마이그레이션**)= opus」로 못박았다. 슬라이스마다 「이 ALTER 는 가볍다」로 재해석하면 표가 무의미해진다 ⇒ **① ② ③ 전부 opus 유지** ✅. 스택 ①→(②∥③) ✅ — 겹치는 파일이 `numbering.service.ts`·`production.module.ts` 각 한 줄뿐인 것 실측 확인.
- e2e: DB 직접 단언 셋 ✅ · `TRUNCATE` 금지 ✅(원장 0건이라 필요 없음) · ⭐ **체인 ⑩ 이 서는 근거를 §9 통합자 행에 적어라** — `:release` 가 `requirement.ts:41-53` 으로 **BOM 소요에서** 출고요청 라인을 만들므로 M2 체인에 흐르는 자재는 반드시 `bom_component` 다 ⇒ 투입의 BOM 3축이 체인에서 통과한다. 이것이 픽스처 이야기가 아니라 «체인이 왜 서는가»의 유일한 근거다.

## 11. 문의 6건(§8-2) — ✅ · 054 에 승격 표시

`docs/design-inquiries/` 최신이 **049** ⇒ 050~055 ✅. 052 는 계보+`material_usage_allocation`+상한 셋을 묶는데 **한 뿌리(투입 시점에 target 축이 없다)**라 묶어 두는 것이 맞다(분리하면 회신 셋이 서로를 기다린다) ✅.
✏ **054 는 새 번호가 맞다** — 다만 I-7 이 같은 벽을 «알려둘 것»으로 이미 보고했다(`design-inquiries/README.md:61` ⌜`terminal_id` 영원히 NULL(단말 토큰 없음 · 게이팅 2플래그 미검사)⌝). 054 첫 줄에 그 인용을 넣어 **재보고가 아니라 「마이그레이션까지 낳아 번호로 승격」**임을 밝혀라.
⛔ **054 의 전제 한 줄을 반드시 고쳐라**(§4-1) — ⌜발급·검증 축이 0건⌝ ✕ → ⌜**발급은 있다**(`terminal.service.ts:200-223` · 등록 토큰 JWT · TTL 1년) · **검증이 0건** · 그리고 계약이 **487 오퍼레이션 어디에도 `security` 를 걸지 않아** 어느 호출이 단말 토큰을 실어야 하는지 계약만으로 못 가른다⌝. 이 정정이 문의를 **약하게 하지 않고 강하게 한다** — 물음이 「단말이 없다」가 아니라 **「스킴을 정의만 하고 어느 오퍼레이션에도 걸지 않았다 — 어디에 걸 것인가」**가 되고, 그것이 설계팀만 답할 수 있는 물음이다. 054 에 이 물음을 명시하고, I-11(`WorkSession.terminalId` required · `work_session.terminal_id` NOT NULL)이 같은 벽에 서 있음을 함께 적어라.
051 ↔ 대기 15 ✅(누적 11 · 반대 방향 첫 사례) · 055 는 `plan.md` 212 가 이미 지목 ✅ · 문의 14 표에 2행 ✅.

## 12. 통합 계획서와 어긋나는 자리 중 **구현에 영향 주는 것**

| `plan-integration.md` | 실측 | 처리 |
|---|---|---|
| **300행** 「반출만 ⭐ 원장 `STOCK_TRANSFER`」 | ⛔ 근거는 nullable 칸 하나뿐 — 계약이 날짜·목적 위치·판별자·도착을 다 안 준다 | **✕ 로 고친다**(§10 #2 ✅) |
| **301행** 「그래도 서버는 써야 한다」 | ⛔ target 축이 계약·물리·화면 어디에도 없다 | **「쓰지 않는다 + 052」**(§10 #4 ✅) |
| **302행** `EXACT`/`DIRECT` 상수 제안 | ⛔ 두 문자열이 계약·화면·시드 어디에도 없다(코드 그룹 6종 psql 0행) | **삭제**(§10 #5 ✅) |
| **270행**(I-7 절) 「`material_usage_allocation` 은 I-10 이 쓴다」 | ⛔ CHECK 원문이 막는다 | **「주인이 없다 + 052」**(§10 #6 ✅) |
| **174행 표** I-10 행 | 마이그 ✕→**2** · 원장 「반출만 ⭐」→**✕** · **계보 「있음(`lot_relation`)」→「있음 · 이 슬라이스는 쓰지 않는다」** | ✏ 계획서가 앞 둘만 적었다 — **셋째 칸을 더한다** |
| **107행** 「투입은 원장을 안 지난다」 | ✅ 실측 셋으로 재확인 | 무변경 · `plan-api.md` 418 을 지우는 것 ✅ |
| **303행** 「멱등 한쪽만」 | ✅ `work_session` 문장 | 무변경(§10 #17 ✅) |
| **660행** 유혹 1 | ✅ `MATERIAL_RETURN` 도 안 늘렸다 | 「덤으로 반출도」 한 줄 추가 |
| 36~44행 체인 ⑩⑪ | ⑩ ✅ · **⑪(`lot_relation`)은 오늘 안 이어진다** | ⑪ 에 「052 회신 뒤」 표시 |

**멈춤 조건 판정 — 셋 다 미발동** ✅. ① 물리 수정 2건은 **삭제가 아니라 NOT NULL 완화** ② 게이트 미실행 ③ **계약끼리 모순 0** — `MaterialReturn` 3스키마에 `description`·`x-internal-note` 가 전무하다는 실측이 이 판정을 닫는다.
