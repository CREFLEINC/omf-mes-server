# I-7 재검토 — **integration 관점**

> 정본: `plan-integration.md` §1-4(101~110) · §2(152) · §3 표(171) · §3-1 I-7(264~272) · §4-1(496~504) · §6-3 15(629) · §9 반박 1·3.
> 실측: worktree `docs/coverage-100-i7-plan`(HEAD `8086559` · main `d8e799d` 병합됨) · 코드는 **I-6 전건 병합본** · DB `omf_mes` psql SELECT · 계약 `contracts/COMMIT.txt`=`a6a87e1`.
> ⚠ I-7.md 머리말의 ⌜코드는 `db266ec`(I-6 PR ⑥ 병합 전)⌝ 는 낡았다 — `work-order-close.service.ts`·`work-order-cancel.service.ts` 가 **실재한다**.

---

## 1. 문의 041~044 — ✏ **4 → 3건**

- **041 ⓐ**(상신이 등급 판정 입력을 안 받는다) ✅ 새 문의. 계약 실측 그대로(`ApprovalRequestCreate.required=["reason"]` · 400 갈래 셋 중 하나가 도달 불가).
- **041 ⓑ**(승인 1건이 정정 N건을 연다) ⛔ **새 문의가 아니다 — 030 의 두 번째 자리다.** `approval.service.ts:141-165` 주석이 이미 ⌜계약이 세운 축(reasonCode)의 값이 아직 없어 **상신 흔적으로 대신 가른다** — 값이 오면 이 자리를 바꾼다(I-4.md R-4 · 문의 030)⌝ · ⌜시각 순서를 안 본다 … 재판정을 새로 만들지 않는다⌝ 라 적었다. 「승인 흔적 하나가 뒤의 실행 N 건을 연다」는 **I-4 출고에서 이미 그렇게 서 있다**. ⇒ ⓑ 를 041 에서 떼어 **030 에 갈래를 더한다**(문의 수를 안 늘린다).
- **042** ✏ 유지하되 **제목을 바꾼다.** 지금 제목은 「해석이 맞는가」인데, 실측은 **이미 병합된 코드가 반대 해석으로 서 있다**는 것이다 — `work-order-close.service.ts:137-139` ⌜정정은 상쇄 트랜잭션이라 **합이 곧 반영된 값**이다⌝ · `work-order-query.service.ts:187-189` 같은 문장. ⇒ 「I-6 이 코드 주석으로 확정한 해석(합)을 I-7 이 뒤집는다(잎만) — 어느 쪽이 정본인가」로. 뒤집는 대상이 주석 둘 + 집계 넷이라 되돌림 비용이 문의의 무게다.
- **043** ✅ 새 문의. 계약 x-internal-note 가 스스로 ⌜B-13 **미충족**⌝ 이라 적었고 `P-02-06` §8 미결 2 와 짝이다. `plan-api.md` S08 초안보다 **좁다**(칸 소유권 하나) — 같은 것이 아니다.
- **044** ✏ **042 와 한 요청서 두 갈래**로 묶는다. 답이 서로에 종속이다 — 042 가 「잎만」으로 확정되면 044 는 「LOT 축도 같은 규칙을 쓸 칸이 없다」가 되고, 042 가 「합」으로 뒤집히면 044 가 사라진다. 두 장으로 내면 회신이 갈린다.
- 「기존으로 미룬 것」 5 · 「알려둘 것」 19 ✅ — 새 번호가 필요한 것 0건. `resultSourceCode` 는 **모순이 아니다**(멈춤 조건 ③ 미해당) ✅ — 「받되 enum 검증」으로 닫힌다.
- ⇒ **신규 3건(041ⓐ · 042+044 · 043) + 030 에 갈래 1.**

## 2. 마이그 D1·D2 — ✅ (이름 2건 ✏)

- D2 필요 ✅ **실측**: `information_schema.columns` — `production` 스키마 `%reason%` 10칸 중 `production_result` 것은 `late_entry_reason_code` 하나. 형제 `material_consumption.change_reason_code` 실재.
- 칸 이름 `correct_reason_code` ✅ — 형제는 「변경(change)」이고 이쪽은 계약 오퍼레이션이 `:correct` 다. 뜻이 다르므로 베끼지 않는다. 📨 통지문에 형제 이름을 나란히 적는다(`docs/data-model/01-logical-table-spec.md:3508`).
- nullable ✅ 필수다 — `app.code_t CHECK (VALUE <> '')`(pg_constraint 실측)라 빈 문자열로 못 채운다.
- `status_code` 상수 `'CONFIRMED'` ✅ — `ProductionResult.required` 에 `statusCode` 가 실재(jq 실측)해 nullable 이 성립하지 않는다. 픽스처 선례도 실재하나 **줄 번호가 낡았다** — `test/production-work-order.e2e-spec.ts:850`(§ `result()` 도우미)·`:1414`. I-7 §2-3 의 `:1016` 을 고친다.
- 사전 대조 SELECT ✅ **돌렸다**: `production.production_result` **0행**(개발 DB) ⇒ D1 완화가 기존 행을 안 건드린다.
- ✏ 마이그 디렉터리 이름 — 최신이 `20260906500000_work_order_resource_plan_unique` 다. 실측일이 2026-09-06 이므로 `20260906600000_...` 로 낮춘다(`20260907000000` 은 미래 날짜다).
- `prisma generate` 표기 ✅ · 두 릴리스 규칙 미해당 ✅ · `--from-schema-datasource` 드리프트 검사 ✅.
- ✅ **데이터모델 산출물 재생성은 필요 없다** — I-5 PR ⑤(`2131c28`)가 `20260906400000_...` 마이그를 넣으면서 `docs/data-model/**` 을 하나도 안 건드린 선례가 있다.
- `plan.md:122` D1 한 줄 → 두 줄(D1·D2) · `plan.md:41` 「D1」 → 「D1·D2」.

## 3. 상태기계 — ✏ (빠진 것 하나 · 낡은 인계 하나)

- L1 등록 ✅ `transitions.ts:112-120` 글자 그대로. 호출 모양 ✅ `lot-lifecycle.service.ts:31-45`.
- ⛔ **빠진 실측 — `moveWithin` 이 `lot.version_no` 를 +1 한다**(`lot-lifecycle.service.ts:63-67` ⌜응답에 실리는 칸이 바뀌므로 ETag(version_no)도 올린다⌝ · I-6 §11-2 ⓒ R-29). ⇒ **실적 등록이 배분한 슬롯 LOT 의 ETag 를 움직인다.** `:complete`·`PUT /trace/lots/{lotId}` 가 같은 행의 If-Match 를 쓰므로, PR ④ M1 마디 e2e 는 실적 뒤 LOT 을 **다시 읽어** 버전을 받아야 한다. §3-1 표와 PR ④ e2e 이름에 한 줄씩.
- `VOIDED` 슬롯 400 ✅ — 코어는 `from` 밖을 **건너뛴다**(`:59-62`)라 도메인이 앞에서 막는 것이 유일한 길이다.
- W/O 상태 게이트 표 ✅ — `CLOSED` 허용이 트리거에 안 걸리는 근거 실측: `trg_work_order_closed_immutable` 은 **BEFORE UPDATE** 다(baseline:3009-3011). `changedAt=occurredAt` ✅ · 지역 상수 ✅.
- ⛔ **L2 규약 어긋남은 「I-6 PR ⑥ 이 고친다」가 아니라 «main 에 이미 있는 결함»이다.** 실측: `work-order-close.service.ts:18` `const WORK_ORDER_DOCUMENT = 'WORK_ORDER'` 를 `:114` 가 L2 의 `sourceDocumentTypeCode` 로 넘긴다. 계약 enum 은 L2=`WORK_ORDER_CLOSING`(jq 실측). ⚠ 같은 상수가 `:84` `targetTypeCode`(승인 다형 축)로도 쓰여 **거기는 `WORK_ORDER` 가 맞다** — 상수를 갈라야 한다(2~4줄 + `work-order-close.service.spec.ts`). ⇒ **I-7 PR ① 이 선행 커밋으로 고친다.** I-7 이 `GET /trace/lot-lifecycle-events` 를 여는 순간 틀린 값이 응답에 실린다(enum 안이라 500 도 안 난다 — 조용히 틀린다). §1-4ⓑ·§8-6·§8-7·§9-3 ⓡ·§11 #6 을 전부 고친다.
- `:complete` 가 어느 칸도 안 옮김 ✅ — 물리 실측: `lot.completed_at` 실재 · `lot` 에 `current_qty` 없음 · psql `LOT_LIFECYCLE_STATUS` 3값 · `LOT_LIFECYCLE_TRANSITION` 3값. 대상=`initial_qty` vs `Σ allocated_qty` ✅ · 두 번 완료 400 `STATE_LOCKED` ✅.

## 4. `POST` 코어 — ✅ (경고 하나)

- 순서 ✅ — 채번이 `$transaction` 밖인 것은 `numbering.service.ts:54-56` 의 명시 금지와 일치하고, tx 를 여는 것은 `IdempotencyService.run`(`idempotency.service.ts:66`)이다. 트랜잭션 경계가 계약 ⌜한 트랜잭션⌝(배분·L1)을 정확히 감싼다.
- `plantId=null` ✅ 실측 — `app.numbering_rule` 9행 **전부 `plant_id` NULL**, `PRODUCTION_RESULT`=`PR-{YYMMDD}-{SEQ4}`·`DAILY`. `periodDate`=UTC 날짜 ✅(하노이 00–07시 전날 번호는 「알려둘 것」 ⓔ 로 충분 — `business_date` 를 안 싣는 표라 C-8 자리가 아니다).
- `X-Worker-No` 400 `REQUIRED` ✅ — 계약 `WorkerNo.required=true` ⌜없으면 서버가 거부한다⌝ · `worker_id` NOT NULL 실측. `plan.md:152` 규칙 9 각주 ✅. ⚠ 개발 DB `mdm.worker` **0행**(실측)이라 e2e 가 반드시 심어야 한다 — §10-1 에 이미 있다.
- If-Match → `work_order.version_no` ✅ `assertVersion`(`work-order-write.service.ts:81-85`) 재사용. ⚠ 경고 한 줄: `work_order.version_no` 는 `PUT`·`:hold`·`:resume` 가 올린다 ⇒ 토큰을 실은 오프라인 큐는 그 사이 4M 배정 한 번에 409 를 받는다. 계약이 «선택»으로 둔 이유이므로 「토큰이 온 요청만 대조」를 e2e 이름에 못박는다.
- `runVersioned` 배제 ✅ 실측 — `src/common/master/master-write.ts:40-51` 이 `version===undefined` 면 `throw new Error` 다.
- `resultSourceCode` ✅ — `RESULT_SOURCE` 그룹이 DB 에 **없다**(psql) ⇒ `assertCodeValues` 를 걸 수 없고 계약 enum 가드가 정본. `Σ allocatedQty ≠ goodQty` 통과 ✅ · `late_entry_reason_code` 대조 안 걺 ✅(`LATE_ENTRY_REASON` **0행** 실측).

## 5. `:correct` — ⛔ **자리가 넷이다 · PR 배치 ✏**

- 대체값 + 잎만 ✅ — `app.qty_t CHECK (VALUE >= 0)` 실측(pg_constraint)이라 음수 상쇄 행이 물리적으로 불가능하다. `where: { corrected_by_production_results: { none: {} } }` 관계 이름 실측 ✅ `schema.prisma:2839`.
- ⛔ **`ACTIVE_RESULT_WHERE` 는 «세 자리»가 아니라 «넷»이다** — `work-order-query.service.ts:109`(목록 summary)·`:120`(목록 progressMany)·`:191`(상세 progress) + **`work-order-close.service.ts:141`**(`:close` 3분류). §5-3·§8-7·§10 PR ② 파일 목록에 close 가 **빠져 있다**. 네 자리 전부 **I-6 파일 수정**이고, 그중 둘은 반대 해석의 주석(§1 042)까지 고쳐야 한다.
- ✏ **그 변경을 PR ② 가 아니라 PR ③ 으로 옮긴다.** 근거 셋: ⓐ 정정 행은 PR ③ 이 처음 만든다 ⇒ PR ② 에서는 **동작이 0인 죽은 코드**다 ⓑ 회귀를 검증할 e2e(⌜정정 뒤 `withProgress.goodQty` 가 두 배가 아니다⌝ · `:close` 3분류)가 **PR ③ 에만 있다** ⓒ 예산이 산다 — ② ~300 → ~285, ③ ~250 → ~270. 「I-6 파일을 고치는 커밋」과 「그것을 켜는 기능」이 같은 PR 에 있어야 리뷰가 성립한다.
- A급 판정식 ✏ — §5-5 는 「본문이 «준» 칸」, §10 단위 이름은 「생략한 칸은 원본 승계(그래서 B급)」다. §5-1 순서(⑤ 승계 → ⑦ 비교)가 정답이므로 **「승계 뒤 다섯 칸 전체를 원본과 비교」** 로 문장을 통일한다(결과는 같고 구현이 하나가 된다).
- 승인 게이트를 도메인 안에 ✅ — `assertApproved`(`approval.service.ts:141-165`)는 `requests.length === 0` 이면 **return** 한다(실측). 코어를 고치는 대안 ⛔ — I-4 출고·I-5 취소가 그 「0건 통과」에 매달려 있어 뜻을 뒤집으면 두 슬라이스가 회귀한다. 뿌리는 030 과 같다(§1).
- 에러 코드 신설 0 ✅ — `error-codes.ts:36`(`APPROVAL_IN_PROGRESS`)·`:41`(`APPROVAL_REQUIRED`)·`:30`(`ROUTE_NOT_FOUND`)·`:17`(`STATE_LOCKED`) 실재.
- 잠금 순서 `work_order` → `production_result` ✅ · 승계 칸 목록 ✅ · `result_sequence` MAX+1 ✅(`uq_production_result_seq`) · `note`→`remarks` ✅.

## 6. `:request-approval` — ✅ (두 줄 ✏)

- `ApprovalRequestInput` 그대로 ✅ · `businessUnitId` null(022) ✅ · **202** 실측 ✅ · 반려 뒤 재상신 ✅(`assertNoOpenRequest` 가 `PENDING` 만 본다 · `:104-119`) · `ROUTE_NOT_FOUND` ✅ · 다형 축(FK 없음) ✅.
- ⚠ 실측 확인: `app.approval_route` **0행** ⇒ 픽스처 없이는 언제나 400. `test/approval-request.fixture.ts` 에 `seedRoute`(:11)·`seedRequest`(:47) 실재 ✅.
- ✏ §6 표에 두 줄이 없다 — ⓐ **정정본을 상신할 수 있는가**(허용 — 다형 축이라 「원본인지」를 볼 근거가 없다) ⓑ **이미 정정된 원본을 상신할 수 있는가**(허용 — 계약이 안 막았고 잎 규칙과 무관하다).

## 7. 조회 3 · `lot-lifecycle-events` — ✅ (배치 ✏)

- where 8·정렬·404·뷰 24칸 ✅ · 기간 required 를 코드로 다시 안 막는 것 ✅ — `contract-validator` 가 `parameterSchema(..., 'query')` 를 컴파일한다(실측) ⇒ 가드가 400 을 낸다.
- 배정 충돌 없음 ✅ — `assignment.tsv:59` 가 `GET /trace/lot-lifecycle-events` 를 **I-7** 로 확정했다(`plan-integration.md:358` 의 I-18 언급은 「먼저 세워도 안 깨진다」는 문장이지 배정이 아니다).
- ✏ 모듈 위치 — `src/trace/lot-lifecycle/` **신설 대신 `src/trace/lot/` 안의 파일 셋**. `src/trace/` 에는 지금 `lot/` 하나뿐이고, I-18 이 같은 축의 `lot-status-events` 를 더한다. 오퍼레이션 하나에 디렉터리를 만드는 것은 CLAUDE.md 「선제적 레이어 금지」에 걸린다 — 컨트롤러 클래스는 어차피 따로 선다.
- 알려둘 것 하나 — `:complete` 가 재사용하는 `lotView`(`src/trace/lot/lot-view.ts:84-95`)는 **널을 «값»으로 낸다**(`omitEmpty` 아님). `plan.md` §5 규칙 7 과 어긋나나 **I-6 이전에 병합된 기존 동작**이라 I-7 이 고칠 자리가 아니다. §1-4 ⓒ 에 한 줄.

## 8. 횡단 · PR 분할 — ✏

- 403 추가 0 ✅ 실측 — `derived-permissions.ts` 에 쓰기 4건 전부 등재(`POST …production-results` · `:correct` · `:request-approval` · `lots/{lotId}:complete`). `GET …production-results` 도 등재돼 있으나 계약 미선언이라 가드가 안 본다 ✅.
- 코어 무변경 ✅(`src/core/**` diff 0 · `transitions.ts` diff 0). 다만 §8-6 표에 **「`work-order-close.service.ts` 의 L2 상수 정정」이 빠졌다** — 코어는 아니나 I-7 이 여는 diff 다.
- ✏ **인계 6행 → I-6 행을 다시 쓴다.** 「역방향 인계(I-6 PR ⑥ 이 고친다)」가 아니라 **「I-7 이 main 의 두 자리를 고친다 — L2 상수(PR ①) · 누계 where 넷(PR ③)」**. I-9·I-10·I-11·I-19·I-25·I-26 여섯 행은 ✅ 실측과 맞다(`material_usage_allocation.material_consumption_id` NOT NULL — `schema.prisma:2741` · GR 이 `sourceDocumentTypeCode` 를 그대로 저장한다 — `receipt-posting.ts:79`).
- PR 4 · 직렬 ✅. ✏ **①을 ①a/①b 로 가른다** — ①a: 마이그 선행 커밋(D1·D2) + `schema.prisma` + **L2 상수 정정** (~20줄 · **opus** · README §4 마이그 규칙) / ①b: 조회 3 + 골격 (~230 · **sonnet** 가능 — 마이그가 없고 뷰·where·정렬뿐이다). 예산·모델 배분이 둘 다 산다.
- ✏ **PR ④ 파일** — `src/trace/lot/lot.service.ts` 는 **이미 278줄**이다. +90 이면 368줄로 CLAUDE.md 「파일 ~300줄 초과는 분리 신호」에 걸린다. I-6 §11-2 ⓗ(`close-rules.ts` 분리) 선례대로 **`lot-complete.service.ts` 신설**로 적는다.
- ✏ **cleanup 근거가 틀렸다** — 자기참조 FK 는 `NO ACTION`(비지연)이고 RI 검사는 **문장 끝**에 돈다. 부모·자식을 **한 `deleteMany`** 로 지우면 통과한다(`production-work-order.e2e-spec.ts:1569-1572` 가 이미 그 모양이다). 「두 번 지운다」는 무해하나 §10-1 의 근거 문장을 고친다.
- 단위 테스트 이름이 e2e 로 못 가는 가드를 덮는가 ✅ — 상태 게이트·수량 손검사·채번 인자·승계·A급 판정이 전부 단위에 있다. 픽스처(worker·shift·uom·`approval_route`)·cleanup 순서 ✅ 실측과 맞다. M1 «마디»를 ④가 지고 «체인»은 별도 ✅(`plan.md:42`).

## 9. 자기 관점 계획서와 어긋나는 자리 — 구현에 영향 주는 것만

| plan-integration | 적힌 것 | 실측 | 고칠 것 |
|---|---|---|---|
| **171행**(§3 표 I-7) | 마이그 ✕ · 상태기계 「⭐ L1·L2·L3」 · PR 3 | 마이그 **2** · I-7 은 **L1 만** 쓴다(L2·L3 는 I-6 이 이미 병합) · PR **4** | 세 칸 다 고친다 |
| **267행**(§3-1 I-7) | `material_usage_allocation` 이 실적과 같은 트랜잭션 | `material_consumption_id` **NOT NULL**(`schema.prisma:2741`) — I-7 은 행을 만들 수 없다 | 목록에서 빼고 I-10 으로(I-7 §11 #5 ✅) |
| **§9 반박 3** | 역트랜잭션 4벌 — 「I-5 → **I-7** → I-14 → I-23」 | 정정은 «새 행»이고 `posting.reverse()` 를 안 부른다(실적은 원장을 안 지난다) | I-7 을 목록에서 뺀다 ✅ |
| **§9 반박 1** | 원장 판별자를 늘리고 싶어진다 — I-7 | ✅ 안 걸린다(§1-4 표대로 실적은 제품 입고가 잡는다 · `receipt-posting.ts:79` 가 값을 그대로 받는다) | 그대로 |
| **629행**(대기 15) | 6 오퍼레이션 | ✅ `lots:complete` 가 이미 그 6 안이다 | 건수 유지 · 「I-7 이 실행」만 적는다 |
| **§4-1 M1** | 실적(L1) → 제품 입고(기존) | ✅ 일치. `:complete` 는 체인 밖의 «마디»다 | 그대로 |
| **§2 코어 표(152행)** | 생명주기는 I-6·I-7 에서 | ✅ 일치 — I-7 은 `moveWithin` 호출만, 코어 PR 0 | 그대로 |

⚠ §11 대조표 19행 중 integration 행(#5·#13·#18·#19)은 **#5·#13·#18·#19 전부 실측과 맞다.** #15(진행표)는 낡았다 — main 병합으로 이미 해소됐다.

---

**재수립 결과 — 5줄 요약**

1. **I-7.md 수정 8건**: ⓐ 「I-6 PR ⑥ 병합 전」 전제 철거(머리말·§2-4·§8-6·§8-7·§9-3ⓡ·§11 #6·#15) ⓑ **L2 상수 정정을 I-7 PR ①a 가 진다**(`work-order-close.service.ts:18·114` — `:84` 와 상수를 가른다) ⓒ `ACTIVE_RESULT_WHERE` **세 자리 → 넷**(`work-order-close.service.ts:141` 추가) ⓓ 그 변경을 **PR ② → PR ③** 으로 이동 ⓔ `moveWithin` 이 `lot.version_no` 를 올린다는 실측을 §3-1·PR ④ e2e 에 반영 ⓕ 마이그 디렉터리 `20260907…` → `20260906600000…` · 픽스처 인용 `:1016` → `:850` ⓖ `lot-lifecycle-events` 를 `src/trace/lot/` 안에 · PR ④ 는 `lot-complete.service.ts` 신설 ⓗ A급 판정식을 「승계 뒤 전체 비교」로 통일 · §6 에 상신 두 갈래 추가 · §10-1 cleanup 근거 정정.
2. **`plan.md` 반영**: §4 D1 → **D1·D2** 두 줄(122행) · §1 41행 「D1」→「D1·D2」·「PR 3」→「**4**」 · §5 규칙 9(152행)에 각주(주체 칸의 유일 원천은 예외 — `POST production-results`·`lots:complete`) · §3 승인 표에 ⌜`:correct` 는 `assertApproved` 를 안 쓴다⌝ 한 줄.
3. **`plan-integration.md` 반영**: 171행 세 칸(마이그 2 · **L1 만** · PR 4) · 267행에서 `material_usage_allocation` 제거 → I-10 · §9 반박 3 목록에서 I-7 제거 · 629행 건수 유지.
4. **문의 최종 3건**(041ⓐ 상신 등급 입력 없음 · 042+044 정정 누계 W/O·LOT 두 축 한 장 · 043 LOT 미달 사유 칸 소유권) **+ 기존 030 에 갈래 1**(승인 1건이 실행 N 건을 연다 — I-4 출고와 같은 뿌리). 신규 4 → **3**.
5. **PR 분할 최종안 5개**: ①a 마이그(D1·D2)+`schema.prisma`+L2 상수 정정 ~20 **opus**(선행 커밋) → ①b 조회 3 + 골격 ~230 **sonnet** → ② `POST`+배분+L1 ~285 opus → ③ `:correct`+`:request-approval`+**누계 정정(I-6 파일 4자리)** ~270 opus → ④ `:complete`(`lot-complete.service.ts` 신설)+M1 마디 e2e ~200 opus. 전건 ≤350 · 코어 PR 0 · 직렬.
