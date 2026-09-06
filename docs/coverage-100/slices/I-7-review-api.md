# I-7 재검토 — **api 관점**

> 정본: `plan-api.md` S16(412~441) · S08(220~238) · §5.4 에러표(1028~) · §5.5 채번(1084) · 계약 `a6a87e1`(`contracts/COMMIT.txt`).
> 실측: main 병합본(`work-order-close.service.ts` 실재) · `jq` 계약 · `prisma/schema.prisma` · `psql` 미사용(코드·계약으로 충분).

---

## 1. 문의 041~044 가 새 문의인가 — ✏

- **041 ⓐ+ⓑ 한 장 유지 ✅.** 계약 실측이 둘을 같은 결함으로 묶는다 — `ApprovalRequestCreate.required=["reason"]` 한 칸(`jq` 실측)인데 400 description 이 ⌜결재선 부재·진행 중 요청 존재·**B급이라 승인이 필요 없는 정정**⌝ 셋을 적었다. 뿌리는 「승인 축과 정정 내용이 어디서도 안 만난다」 하나다.
- ✏ **030 과 겹치지 않는다(별건 유지)** — 다만 요청서에 상호참조 한 줄을 넣는다. `approval.service.ts:135-140` 주석이 030 을 ⌜계약이 세운 축(`reasonCode`)의 값이 아직 없어 **상신 흔적**으로 대신 가른다⌝ 로 적었고, 041ⓑ 는 그 흔적이 **몇 건을 여는가**다 — 같은 함수의 다음 물음이다.
- **042 는 문의가 맞다 ✅.** x-no-code-key 전문은 「원본/정정본을 **무엇으로 판정하는가**」만 닫았고 「누계에 **어떻게 반영하는가**」는 안 닫았다. 계약이 스스로 어긋난다 — `WorkOrderProgress.goodQty` ⌜`production_result.good_qty` 의 **합**⌝ ↔ ⌜정정(상쇄)이 반영된 값⌝ ↔ `app.qty_t CHECK(≥0)`. ⛔ 다만 **멈춤 조건 ③(계약끼리 모순)에는 안 세운다** — 0단계 선례로 한 갈래가 서므로 진행하고 문의를 병행하는 I-7 의 처리가 맞다.
- ✏ **042 의 파급을 「알려둘 것」에 한 줄 더한다**: 이 판정은 **이미 병합된 `GET /production/work-orders?withProgress` 의 동작을 바꾸고**, 그 뒤 `goodQty` 는 계약 설명(⌜good_qty 의 합⌝)과 문자 그대로는 달라진다.
- **043 = `plan-api.md` S08 초안의 그 문의가 맞다 ✅** — 다만 S08 은 ⌜`:complete` 가 수명주기 축인가 품질 축인가⌝ 로 물었고 I-7 이 `P-02-06` §5-5 로 그 절반을 닫고 **칸 소유권**으로 좁혔다. 좁힌 쪽이 옳다.
- **044 를 042 와 합치지 않는다 ✅** — 042 는 W/O 축(`production_result` 합), 044 는 LOT 축(`Σ allocated_qty`)이고 답하는 주체(데이터모델 vs 계약)가 다르다.
- **`resultSourceCode` 는 「받되 검증」으로 닫힌다 ✅ · 멈춤 조건 ③ 미해당.** `jq` 실측 — `enum:["MANUAL","IOT"]` 이 스키마에 **박혀 있다**. 계약이 값을 닫아 놓고 required 로 받는다는 것 자체가 「셸이 보낸다」의 증거다.
- **「기존 5」 중 새 번호 필요 0 ✅** · **「알려둘 것 19」 중 문의로 올릴 것 0 ✅**(ⓑ 제약 이름 오기·ⓗ `note`↔`remarks` 는 계약 오기 통지로 충분).

## 2. 마이그 D1·D2 — ✏(문구 한 곳)

- **D2 칸 이름 `correct_reason_code` ✅.** 형제는 `material_consumption.change_reason_code`(`schema.prisma:2622` 실측)지만 그쪽은 「변경」 축이고 이쪽은 코드 그룹이 `PRODUCTION_RESULT_CORRECT_REASON` · x-code-key `CD-PRODUCTION-RESULT-CORRECT-REASON` 다. 그룹명을 따르는 쪽이 맞다.
- **nullable ✅**(원본 행이 빈다) · **추가라 두 릴리스 규칙 미해당 ✅** · **`prisma generate` 표기 ✅**(관계가 optional 로 바뀐다) · **사전 대조 SELECT·`--from-schema-datasource` 드리프트 확인 ✅**(memory 의 섀도 DB 금지와 일치).
- **`status_code` 를 D1 에 안 얹는 판정 ✅.** `jq` 실측 — `ProductionResult.required` 에 `statusCode` 가 **들어 있다**(14개 중 하나). `plan.md` §0 #10 의 ⌜계약이 required 로 적은 자리는 nullable 이 안 선다 → 상수⌝ 가 문자 그대로 걸린다. 「응답에서만 상수를 채운다」 대안은 ⛔ — `status_code` 가 NOT NULL 이라 INSERT 가 값을 요구한다.
- ✏ **§2-3 문구**: 「I-6 e2e 픽스처 값이 §2 0단계 **선례**」는 과하다 — 그 값은 설계 자료가 아니라 **우리가 지은 값**이다. ⌜같은 칸에 두 번째 문자열을 만들지 않으려고 이미 쓴 값을 쓴다 · 값 자체는 `plan.md` §7 「x-no-code-key 처리 보고」 대상⌝ 으로 고친다(보고 의무를 선례가 지우지 않는다).

## 3. 상태기계 — ✅ / ✏(표 한 줄)

- **W/O 상태표 ✅.** `CLOSED` 허용은 `W-02-05` §5-4 규칙 3(✓확정)이고 INSERT 라 `trg_work_order_closed_immutable`(BEFORE UPDATE)에 안 걸린다 — 근거가 정확하다.
- ✏ **표 8행 대신 «기준 한 줄»을 앞에 둔다** — 실제 가름은 「**선발행 슬롯이 서 있는가**」다. 그래야 `SUSPENDED` 허용(슬롯이 산다)과 `CANCELLED` 거부(L3 로 전건 폐번)가 같은 규칙에서 나온다. 지금은 행마다 근거가 달라 기준 2 를 폈다 접었다 하는 것처럼 읽힌다.
- **`VOIDED` 슬롯 400 ✅**(skip 로 흘리면 배분만 조용히 남는다) · **`changedAt=occurredAt` ✅** · **`'PRODUCTION_RESULT'` 지역 상수 ✅**(사용처 하나 · CLAUDE.md).
- **`:complete` 가 어느 칸도 안 옮긴다 ✅ · 물리 실측 확인**: `lot.completed_at DateTime?`(`schema.prisma:3533`) **실재** · `initial_qty`(`:3515`) 실재 · `current_qty` **없다**. ⇒ 목표=`initial_qty` · 누적=`Σ allocated_qty` 가 유일하게 계산 가능한 식이다 ✅.
- **두 번 완료 = 400 `STATE_LOCKED` ✅**(같은 멱등 키면 흡수).

## 4. `POST` 코어 — ✅ / ✏(각주 문구)

- **순서 ✅**(채번 → 잠금 → 상태 → 순번 → INSERT → L1). **채번 `next(code, plantId, periodDate)` 시그니처 실측 일치**(`numbering.service.ts:63` · `plantId: bigint | null`) · `periodDate` 주석이 ⌜서버가 「오늘」로 다시 안 잡는다⌝ 로 이미 서 있다 ✅. 하노이 00–07시 전날 번호는 알려둘 것 ⓔ 로 충분 ✅.
- **`X-Worker-No` 400 `REQUIRED` ✅.** `jq` 실측 — `components.parameters.WorkerNo.required=true` · ⌜없으면 서버가 거부한다⌝. `app_user_id` 도출은 기준 4 위반이라 배제 ✅.
- ✏ **§11 #8 각주 문구를 고친다.** WorkerNo 는 **공용 컴포넌트 하나**라 41건 전부 `required:true` 다 — 「계약이 required 라서」로는 규칙 9 를 못 가른다. 또 「주체 칸의 **유일한 원천**」도 `:complete` 에는 안 맞는다(`lot`·`work_order` 어디에도 작업자 칸이 없다 · §9-3 ⓜ). ⇒ 가름을 ⌜**POP 단말만 부르는 오퍼레이션**(계약이 관리웹 전용인 `:correct`·`:request-approval` 에서 헤더를 «걷어냈다» · 2026-09-04)⌝ 로 적고, `:complete` 의 400 은 「저장은 안 하지만 계약 문자대로 거부」로 따로 적는다.
- **If-Match → `work_order.version_no` 대조 ✅.** `jq` 실측 — `POST` 실적·`:complete` 만 `IfMatchVersionOptional` 을 든다. `runVersioned` 배제(`master-write.ts` 가 `undefined` 에 throw) ✅.
- **`Σ allocatedQty` 미검사 ✅**(계약이 비교 대상조차 안 적었다) · **다섯 수량 손검사 ✅**(도메인 CHECK 는 500 으로 샌다).

## 5. `:correct` — ✏(자리 수 · 예산)

- **대체값 + 잎만 세기 ✅.** 차이값은 `app.qty_t CHECK(≥0)` 로 **물리적으로 불가능**하고, 원본 `status_code` 를 바꿔 거르는 대안은 x-no-code-key(⌜이 리소스는 기록 전용⌝) 정면 위반이라 배제한 것이 맞다.
- ⛔✏ **`ACTIVE_RESULT_WHERE` 자리는 «셋»이 아니라 «넷»이다** — 실측 `work-order-query.service.ts:109`·`:120`·`:191` + **`work-order-close.service.ts:141`**. §5-3 마지막 줄·§10 PR ② 파일 목록·§10-2 를 전부 「네 자리」로 고친다.
- ⛔✏ **더 큰 것: 병합된 I-6 주석이 정반대를 못박고 있다.** `work-order-close.service.ts:135-138` ⌜정정은 **상쇄 트랜잭션이라 합이 곧 반영된 값**⌝ · `work-order-query.service.ts:188-190` 같은 문장. 이 주석 둘을 함께 고쳐야 정의가 하나로 남는다. ⇒ **PR ② 예산 ~300 → ~320**(≤350 유지) · 리뷰 범위에 I-6 파일 2개를 명시한다.
- **승인 게이트를 도메인 안에 두는 것 ✅(조건부).** `assertApproved`(`approval.service.ts:141-`)의 주석이 스스로 ⌜`assertNoOpenRequest` 와 대칭이지 반대가 아니다 — 한 함수로 합치지 않는다⌝ 라 적어 코어 무변경을 뒷받침한다. ✏ 다만 도메인 판정이 그 함수의 **질의를 글자 그대로 복제**하므로, 문의 030 이 답을 주면 **두 자리**를 함께 고쳐야 한다 — §8-7 인계표에 한 행을 넣는다.
- **에러 코드 신설 0 ✅ 실측** — `error-codes.ts:17·30·36·41` 에 `STATE_LOCKED`·`ROUTE_NOT_FOUND`·`APPROVAL_IN_PROGRESS`·`APPROVAL_REQUIRED` 전부 있다. 의미 배분(`APPROVAL_REQUIRED`=올려라 / `APPROVAL_IN_PROGRESS`=기다려라)도 `plan-api.md` §5.4 와 일치 ✅.
- **A급 판정식 ✅**(승계 뒤 다섯 칸 비교) · **승계 규칙·`result_sequence` MAX+1·`note`→`remarks`·ETag 없음 ✅** · **W/O 를 먼저 잠그는 순서 ✅**.

## 6. `:request-approval` — ✏(행 둘 추가)

- **`ApprovalRequestCreate` 그대로 · 202 · `businessUnitId=null` ✅**(`jq` 실측 `required:["reason"]` · 응답 202). **채번을 코어 밖에서 ✅** — `approval.service.ts:66-68` 이 ⌜채번을 부르지 않는다 — 번호는 인자로 온다⌝ 라 못박았고 `DEFAULT_PREFIX.APPROVAL_REQUEST='AP'`(`numbering.service.ts:14`) 가 이미 있다. 존재 확인을 채번보다 앞에 둔 것도 맞다 ✅.
- ✏ **표에 두 행이 빠졌다**: ⓐ **대상이 «정정본»이어도 상신할 수 있다**(§5-4 가 정정의 정정을 열었으므로 필연) ⓑ **이미 정정된 원본에도 상신할 수 있다**(계약 침묵 · 기준 3 — 「정정됨」 축을 새로 안 만든다). 둘 다 「막지 않는다」로 한 줄씩 적고 단위 테스트 이름을 단다.

## 7. 조회 3 · `lot-lifecycle-events` — ✅

- **where 8 매핑·정렬·404·뷰 22칸(`omitEmpty`) ✅.** `jq` 실측 — 목록 GET 질의 8개가 표와 정확히 같고 단건은 200/404 뿐이다.
- **기간 강제 400 `REQUIRED` 를 가드가 낸다 ✅ 실측 2단**: `contract-validator.ts:113·121` 이 query 파라미터의 `required` 를 스키마에 싣고, `validation-error.mapper.ts:25` 가 `keyword==='required'` → `ERROR_CODE.REQUIRED` 로 옮긴다. 코드로 다시 막지 않는 판정이 맞다.
- **모듈 위치 `src/trace/lot-lifecycle/` 신설 ✅**(경로가 `trace/lots/{lotId}/…` 가 아니라 최상위다) · **쪽 나눔 없음·`transitionCode` 3값·`fromLifecycleStatusCode` 생략·403 없음 ✅**.

## 8. 횡단 · PR 분할 — ✏(대조 문장 · 예산)

- **403 추가 0 ✅ 실측** — `derived-permissions.ts` 에 `POST …production-results`·`:correct`·`:request-approval`·`:complete` 네 줄이 이미 있고 `GET …production-results` 도 등재돼 있다(계약이 403 미선언이라 가드가 안 본다).
- **코어 무변경 ✅**(§5 의 단서 제외) · **인계 6행 ✅**.
- ⛔✏ **L2 규약이 「I-6 PR ⑥ 이 고친다」로 안 닫힌다 — 그 PR 은 병합됐다.** 실측 `work-order-close.service.ts:114` 가 `WORK_ORDER_DOCUMENT` 를 넘긴다(계약 enum 은 L2 = `WORK_ORDER_CLOSING`). **I-7 이 그 칸을 처음 «내보이는» 슬라이스**(`GET /trace/lot-lifecycle-events`)이므로 **PR ① 이 상수 한 줄을 고친다**(+2줄). §8-7 I-6 행·§11 #6·§9-3 ⓡ 를 그렇게 고친다.
- ✏ **§11 #9 의 대조가 어긋난다** — `plan-api.md` S16 의 「PR 5」는 **19 오퍼레이션**(소비·반납·인계·사전점검·수리 포함)의 수다. I-7 은 그중 7건뿐이라 4 와 5 를 나란히 두면 안 된다. ⌜S16 중 **I-7 배정 7건 = PR 4** · 나머지 12건은 I-10·I-25⌝ 로 고친다.
- **PR 4 · 전부 opus · ① 을 sonnet 으로 안 내린다 ✅.** ①은 마이그 둘 + 새 모듈 둘 + 뷰 22칸 매퍼 + 위 L2 정정까지 **판단이 넷**이다. ①a/①b 분리도 ⛔ — 마이그가 4줄이라 PR 하나를 세울 크기가 아니고, 스택만 길어진다.
- **단위/e2e 이름이 가드를 덮는다 ✅** · **픽스처(`seedRoute`)·자기참조 FK 두 번 삭제 ✅**(정정본 먼저) · **M1 «마디»만 ④ 가 진다 ✅**.

## 9. plan-api ↔ I-7.md — 구현에 영향 주는 어긋남

| 자리 | 실측 | 고칠 것 |
|---|---|---|
| S16 「posting **있음**」 | `production_result` 에 원장 FK 0칸 · `ProductionResultCreate` 에 `businessDate` 0칸(`jq`) | **없음** 으로 — I-7 §11 #2 대로 ✅ |
| S16 「마이그 **없음**」 | D1+D2 | **2** 로 — §11 #3 ✅ |
| S16 「`status_code` 칸 불필요」 | 칸 NOT NULL 실재 + 응답 required | 상수 `'CONFIRMED'` — §11 #4 ✅ |
| S16 「PR 5」 | 범위가 19건 | ✏ 위 §8 대로 문장을 고친다(§11 #9 수정) |
| **S08 「`:complete` 는 그 셋 밖의 «새 전이»」** | 전이 0건 · `lot_lifecycle_history` 를 **안 쓴다**(§3-3) | ✏ **§11 #7 에 이 행을 더한다** — 안 고치면 구현자가 전이 등록을 시도한다 |
| S08 「posting — LOT **상태**와 W/O 사유만」 | 상태 칸을 안 옮긴다 | ✏ 「`lot.completed_at` 과 W/O 사유」로 |
| **§5.4 `APPROVAL_REQUIRED` 슬라이스 = S04·S07** | I-7 `:correct` 가 같은 코드를 쓴다 | ✏ **S16 을 더한다** — §11 에 새 행 |
| §5.5 채번 표 「생산 실적 ✅ S16」 | 규칙 등재본 유일 · `DEFAULT_PREFIX` diff 0 | 슬라이스명만 I-7 — §11 #17 ✅ |
| #15 「I-6 행이 없다 / PR ⑥ 병합 전」 | main 76733fc 전건 병합 | ✏ §0 머리말·§2-4·§8-7·§11 #6·#15 를 **전건 갱신**(「I-6 이 전건 병합된 뒤 시작」은 이미 충족) |

---

**재수립 결과 — api 관점**
1. **I-7.md 수정 12건**: ⓐ I-6 전건 병합 반영(머리말·§2-4·§8-7·§11 #6·#15) ⓑ `ACTIVE_RESULT_WHERE` **3→4자리**(+`close.service.ts:141`) ⓒ 병합된 I-6 주석 2곳(⌜정정은 상쇄라 합이 곧 반영값⌝)이 정반대라 함께 고침 → **PR ② ~300→~320** ⓓ **L2 `WORK_ORDER_CLOSING` 정정을 PR ① 이 진다**(`close.service.ts:114` 실측) ⓔ §11 #9 의 「S16 PR 5」 대조 문장 ⓕ 규칙 9 각주를 「POP 단말이 부르는 자리」로 ⓖ §2-3 「e2e 픽스처가 선례」 완화 ⓗ §3-2 표 앞에 기준 한 줄(「선발행 슬롯이 서 있는가」) ⓘ §6 에 상신 대상 행 둘 ⓙ §8-7 에 「030 이 답하면 두 자리를 함께 고친다」 ⓚ §9-3 에 `POST` 실적 404 미선언 항 추가(19→20) ⓛ 042 파급(병합된 `withProgress` 동작 변경) 한 줄.
2. **plan-api.md 반영**: S16 4행(posting 없음 · 마이그 2 · `status_code` 상수 · PR 수 문장) · S08 3행(상태기계 「전이 0건」 · posting 문구 · 두 건 I-7 이관) · **§5.4 `APPROVAL_REQUIRED` 슬라이스에 S16 추가**.
3. **plan.md 반영**: §4 D1→D1·D2 · §1 41행(마이그 D1·D2 / PR 3→4) · §5 규칙 9 각주 · §3 `assertApproved` 한 줄(「`:correct` 는 안 쓴다」) · §8 진행표 I-6 행.
4. **문의 최종 4건(041~044) — 신규·기존 배분 그대로 ✅.** 041 은 ⓐⓑ 한 장 유지하되 030 상호참조, 042 는 문의 유지(선례로 갈래는 서지만 계약 자체가 어긋난다), 043 은 칸 소유권으로 좁힌 것이 맞고, 044 는 042 와 분리 유지. 멈춤 조건 ③ 미발동.
5. **PR 분할 최종 = 4 · 전부 opus · 직렬** ①(마이그 2 + 골격 + 조회 3 + **L2 상수 정정**) ~255 → ②(`POST`+배분+L1+누계 **4자리**+I-6 주석 2) **~320** → ③(`:correct`+`:request-approval`) ~250 → ④(`:complete`+M1 마디) ~200. ①의 sonnet 하향·①a/①b 분리 둘 다 반대.
