# I-6 개별 계획안 3관점 재검토 — **integration 관점**

> 대상 `docs/coverage-100/slices/I-6.md`(1,017줄) · 브랜치 `docs/coverage-100-i6-plan` · 실측일 2026-09-06.
> 실측 수단: `psql` SELECT(로컬 `omf_mes`) · `jq`(계약 읽기 전용) · 코드·마이그 SQL 직접 읽기 · `prisma migrate diff --from-schema-datasource`(⛔ `--shadow-database-url` 미사용). 구현·쓰기 0건.

## 1. 문의 035~039 가 새 문의인가 — ✏

- **035 ✏ — 셋을 한 장에 묶는 것은 맞으나 ⓓ 의 근거가 한 칸 어긋난다.** ⓐⓑⓒ 는 뿌리가 하나(중단 구간 표 부재)라 갈면 회신이 갈린다 — 묶음 유지 ✅. 다만 `WORK_ORDER_HOLD_REASON` 은 **`isSystemOwned` 가 아니다**(`seed.ts:1259` — `LOT_SOURCE_TYPE:1082` 는 `true`). 이 저장소에서 `values: []` 인 그룹은 **10건**이고 그것들은 「시드가 비운 것」이 아니라 **고객이 MDM 화면으로 채우는 축**이다. ⇒ 물을 것은 「값이 왜 없나」가 아니라 **「초기 값 목록을 설계가 주나, 고객 운영으로 넘기나」**. 그리고 대조를 영구히 안 거는 대신 **「그룹에 값이 서면 대조를 켠다」를 되돌림 한 줄로** 남길 것(지금 문장은 영구 미검증으로 읽힌다).
- **036 ✅ 새 문의다 — 근거가 실측으로 더 강해진다.** `'WORK_ORDER'` 는 **이미 이 저장소에 박혀 있다**: `src/trace/lot/lot-rules.ts:73-75` `workOrderWhere()` 가 `source_type_code: 'WORK_ORDER'` 를 상수로 쓴다(구현·병합 완료). ⇒ 「권고안 구현」이 아니라 **이미 구현된 값에 시드가 못 따라온 것**이고, 성격이 대기 중 문의 **13**(`LOT_HOLD_STATUS` 시드)과 같다. 036 본문에 그 선례를 싣고, I-6 은 상수를 **새로 짓지 말고 `lot-rules.ts` 의 것을 코어로 올려 공유**할 것(§4-2 가 `WORK_ORDER_SOURCE` 를 새로 선언한다 — 두 벌이 된다).
- **037 ✏ — ⓒ 는 문의가 아니라 판정이고, 대신 «넷째 갈래»가 빠졌다.** 도착 위치 미해결은 §2 2단계 기준 1 로 이미 닫혔다(배포를 막지 않는다) ⇒ 「알려둘 것」 급. 빠진 것은 실측 하나 — `planning.bom_component` 에 **`actual_use_process_id`(nullable)** 가 `routing_operation_id` 와 **따로** 있다(`\d` 실측 17칸). 「어느 공정 축으로 BOM 라인을 고르나」는 둘 중 하나를 고르는 문제이지 「공정 축을 보나」가 아니다 — 037 ⓐ 를 그렇게 고쳐 적을 것.
- **038 ✅**(I-8 문의와 겹치지 않는다 — I-8 은 요청의 «상태 축», 038 은 「취소 전파를 하나」). **039 ✅**(계약 자인이 아니다 — 계약은 게이트를 ⌜✓확정⌝ 이라 적고 판정 수단만 비웠다. 이월(§9-1 #11)과 성격이 다르다).
- 「기존으로 미룬 것」 중 새 번호가 필요한 것: **없다** ✅. 「알려둘 것」 17건 중 문의로 올릴 것: **ⓓ 하나**(`ix_work_order_dispatch` 가 무는 죽은 값 셋은 **DB 인덱스 정의와 코드값 표의 어긋남**이라 다음 물리 정리에 실릴 자리다 — 「고치지 않는다」로 끝내면 아무도 안 본다). §9-1 17자리의 §2 절차 적용은 단계·기준 인용까지 타당하다 ✅.

## 2. 마이그레이션 1 — ✅ (SQL 한 자리 ✏)

- ✅ **`close_disposition_code` = `remainderDispositionCode` 칸** 실측 확인 — `20260826000000_data_model_v4:70-73` 이 같은 `ALTER` 에서 `production_plan_id` NOT NULL 해제 + `close_disposition_code` + `cancellation_reason_code` 셋을 넣었다. 「긴급 W/O 를 위해 계획을 풀면서 마감·취소 흔적 칸을 함께 넣었다」는 한 덩이의 의도가 읽힌다. 마이그 0 ✅.
- ✅ **유일 인덱스 결손 실측** — `\d production.work_order_resource_assignment`: 인덱스 둘(PK · `ix_work_order_resource_assignment`)뿐, 유일 제약 0. `ck_work_order_resource_target CHECK (num_nonnulls(...) = 1)` 실재. ✅ `COALESCE(x, 0)` 의 0 은 네 FK 대상이 전부 `GENERATED ALWAYS AS IDENTITY`(1 시작)라 **실재 id 와 겹치지 않는다**.
- ✏ **4칸을 접느니 «한 칸으로» 접는 편이 계약과 정확히 같아진다.** `ck_…_target` 이 넷 중 정확히 하나를 보장하므로 `COALESCE(equipment_id, mold_id, worker_id, shift_id)` **한 식**이 곧 `resource_id` 다 ⇒ `(work_order_id, resource_type_code, COALESCE(...))` 3칸이 계약이 이름까지 적은 `uq_work_order_resource_plan(work_order_id, resource_type_code, resource_id)` **와 글자 그대로 같다**. `shift_id` 도 그 체인에 들어가므로 §2-6 이 4칸을 고른 이유(「`SHIFT` 행이 조용히 통과」)도 함께 닫힌다. 4칸 안이 틀린 것은 아니나(같은 유형에 다른 칸이 찬 «잘못 쓴 행» 쌍을 허용할 뿐) 계약 대조가 안 서므로 3칸으로 줄일 것.
- ✅ **드리프트 실측 — 게이트 원인불명 3회와 얽히지 않는다.** DB 에 `COALESCE` 식 유일 인덱스가 **이미 10건**(`uq_numbering_rule`·`uq_approval_route_active`·`uq_operation_policy`·`uq_user_data_scope`·`uq_inventory_balance_dim`·`uq_putaway_rule`·`uq_shipment_lot_allocation`·`uq_item_external_code`·`uq_worker_qualification`·`uq_lot_external_identifier`) 있는 상태에서 `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` = **`-- This is an empty migration.`** ⇒ Prisma 는 표현 못 하는 인덱스를 **양방향으로 무시한다**. 열한 번째를 더해도 드리프트 0. 「I-1 선례로 넘긴다」가 아니라 **이 실측 문장**을 §2-6 과 PR ① 본문에 싣을 것(선례 인용보다 재현 가능한 명령이 낫다). ✅ `schema.prisma` 미수정도 맞다 — `///` 표현식 주석은 `db pull` 산물이고 현재 9모델에만 있으며 `approval_route`(I-1)는 **주석 없이** 서 있다.
- ✅ 사전 대조 SQL 주석 · 하위 호환(추가만) 동의.
- ✏ §11 정정 18항은 자기 관점 행이 맞으나 **integration 쪽 4자리가 빠졌다** — 아래 9.

## 3. 상태기계 두 축 — ✏

- ✅ `transitions.ts` 실측 그대로다(192줄 · 축 6 · `production.work_order.status_code` **없음**). LOT 축 `'work-order-close'`(L2)·`'work-order-cancel'`(L3)가 `:112-140` 에 실재하므로 **`-wo` 접미**는 필요하다 ✅(대안 「두 축을 같은 이름으로」는 한 요청이 두 축을 부르는 `:close`·`:cancel` 에서 읽는 사람이 갈린다 — 기각 타당). `conflictStatus` 400 · `transitionCode` 미사용 · `POST` 를 표 밖에 두는 것(`postImmediately` 선례) 전건 동의.
- ✅ `:close` 의 `from` 에 `IN_PROGRESS` — 계약에 `COMPLETED` 로 옮기는 오퍼레이션 0건을 `jq` 로 재확인(경로 10 · 오퍼레이션 13 전수). 빼면 마감이 도달 불가다. 괄호를 떼는 판정 ✅. `:hold` 의 `RELEASED` 유지 · `:resume` → `IN_PROGRESS` 고정도 계약 문자 그대로 ✅.
- ✏ **`moveWithin()` 의 반환을 `{ movedLotIds, skippedLotIds }` 로 넓힐 것.** 「`from` 밖은 건너뛴다」는 `:close`·`:cancel`(호출자가 `WHERE` 로 좁힌다)에서는 옳지만, **I-7 의 L1 은 사정이 다르다** — 실적이 붙는 슬롯은 «지목»이라 이미 `ACTIVE` 인 것을 건너뛰면 **이중 기록이 조용히 통과**한다. 코어를 두 갈래로 가르지 말고 건너뛴 것을 돌려주면 I-7 이 `skippedLotIds.length === 0` 을 단언할 수 있다(≈3줄). 이 자리는 §8-6 이 I-7 에 「그대로 부른다」로 못박는 규약이라 지금 넓히지 않으면 I-7 이 코어를 고친다.
- ✅ 생성 직후 이력 미기록 — `LOT_LIFECYCLE_TRANSITION` 3값에 「생성」이 없고 `ck_lot_lifecycle_history_transition` 이 `transition_code` 를 요구한다는 실측과 맞다(F-6).
- ✅ `moveWithin` 이 `assertTransition(column, action, current, 400)` 을 태우는 형태는 실측 시그니처와 일치(`document-state.service.ts:29-36`).

## 4. `:release` 코어 — ✏

- ✅ **`preIssueWithin()` 자매 함수**에 동의. 실측 3근거 전건 확인 — `createWithin` 이 `lot_hold` 를 **무조건** 만들고(`lot-registry.service.ts:78-86`) `LotRegisterInput` 12칸에 `lifecycle_status_code`·`work_order_lot_seq`·`bom_id` 가 없으며 `status_code` 를 `INITIAL_LOT_STATUS` 로 고정한다. 옵션 확장은 사용처 둘 중 하나에서만 켜지는 분기 셋을 코어에 남긴다 ⇒ 자매 함수가 낫다.
- ✅ `lot-number.ts` 코어 이관 — 참조는 **둘뿐**(`src/trace/lot/lot.service.ts:16` · `test/trace-lot.e2e-spec.ts:21`)이라 재수출 3줄로 닫힌다. ⚠ 한 줄 보탤 것: `mesLotNo` 의 셋째 인자 `todaySeq` 는 `lot.service.ts:232-238` 이 **`count()+1` 로 뽑는다**(주석: 연속 보장 없음). 슬롯 N 개를 한 번에 만들 때 **`used + 1 … used + N`** 으로 밀어야 한다 — 같은 값을 N 번 쓰면 사람이 읽는 순번이 다 같아진다(충돌은 난수가 막는다).
- ✏ **`plant_id` 도출 순서는 맞으나 사업부는 창고에서 푸는 편이 안전하다** — `plant.business_unit_id` 는 **nullable**, `mdm.warehouse.business_unit_id` 는 **NOT NULL**(실측). §7-1 의 내부 P/O `business_unit_id` NOT NULL 을 「공장의 사업부」로 풀면 nullable 을 타고, 같은 WIP 위치 경로가 `location → warehouse` 로 **둘 다** 준다.
- ✅ `INSPECTION_PENDING` + `lot_hold` 미적용 · `bom_id`/`bom_version` 짝(`production_plan.bom_id` NOT NULL 실측) · 경계 5 · 채번 tx 밖 · `handoverNote` 버림 동의.
- ✅ **출고요청 직접 INSERT 는 선례 §9 #8 과 «같은 자리»다.** `server-architecture.md:67`(도메인 간 service 호출 금지) + `:60`(코어는 여러 도메인이 같이 쓰는 것만) 하에서, 사용처가 **하나**(I-6)뿐인 출고요청 쓰기를 코어로 올리는 것은 CLAUDE.md 금지에 걸린다 ⇒ 직접 INSERT + §8-6 규약 승계가 맞다. 표 실측도 맞다(`material_issue_request` 14칸 · `reason_code` nullable · `destination_location_id` NOT NULL). ⚠ 다만 규약 6에 **한 줄이 빠졌다** — `bom.base_qty` 는 `scrap_rate`(NOT NULL · DEFAULT 0)와 «같은 표»에 있으므로 I-8 의 `shortage` 가 스크랩률을 곱하기 시작하면 두 식이 갈린다. ⓓ 를 「스크랩률 미적용 — 037 회신 전까지 **양쪽 다** 곱하지 않는다」로 못박을 것.

## 5. `:close` 코어 — ⛔ (봉투 하나가 계약 required 를 못 채운다)

- ⛔ **`ProductionConflictResponse.required = ["code","message"]` 인데 이 저장소의 409 는 `code` 를 «못 낸다».** `ConflictException` 은 `{ conflictCause, message }` 만 담고(`conflict.exception.ts:16-28`) `ErrorResponseFilter` 가 그것을 **그대로 직렬화**한다(`error.filter.ts:36-39`). ⇒ `OPEN_SESSION_EXISTS` 뿐 아니라 **이 슬라이스의 409 전건**(If-Match `assertUpdated` → `VERSION_CONFLICT` · 멱등 `IdempotencyService:115·121` → `DUPLICATE_KEY`)이 계약 필수 칸을 빠뜨린다. 응답 검증이 런타임에 없어 **e2e 도 안 잡는다** — 화면만 조용히 갈린다. §5-5 의 「`error-codes.ts` 에 상수를 더한다」로는 **봉투 모양이 안 바뀐다.** 이 슬라이스가 `ProductionConflictResponse` 의 **첫 사용처**이고 I-7·I-11·I-19·I-23 이 그대로 벤다 ⇒ `ConflictException` 에 선택 `code`(+`currentVersion`)를 더하고(≈8줄) 생산 경로 셋을 매핑하는 것을 **PR ④에 명시**할 것. 이 자리를 안 닫으면 계약 미준수가 슬라이스 다섯으로 번진다.
- ✅ 순서(If-Match 대조 → 열린 세션 → 3분류 → 전이)는 선례와 정합 — `document-cancel.service.ts:75-78` 이 「잠금 → 버전 대조 → 업무 판정」 그대로다.
- ✅ **`ended_at IS NULL` 정의** — `work_session.ended_at` nullable 실측 + 계약 ⌜ended_at 이 빈 채⌝ + `lot_hold`(`released_at IS NULL`) 선례. `STOPPED` 포함 ✅.
- ✅ 3분류 입력(`good_qty` 합 · 상태 필터 없음 · 슬롯 합 불사용) · 허용 오차 상수 0. **`app.operation_policy` 0행**·`interface_definition` 0행 psql 재확인. 「없는 키를 지어 읽는 것이 조용한 도출」이라는 논거 ✅.
- ✅ **「한 번의 UPDATE」는 선택이 아니라 강제다** — 트리거 함수 실측: `IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION` (조건 없이 모든 UPDATE). 단위 테스트로 못박는 판정 ✅.
- ✅ L2 = `WAITING` ∧ `NOT EXISTS production_result_lot_allocation`(표·`lot_id` 칸 실재) · `withResultCount` 와 같은 `EXISTS` ✅.
- ✅ `enqueue()` 시그니처·`message_key` `{INTERFACE_CODE}:{문서번호}`·버전 없음·`alreadyQueued` 동의. 길이 안전 실측: `message_key varchar(150)` ≥ `IF-WO-CLOSE-SEND:`(17) + `work_order_no varchar(100)`. `interface_code varchar(50)` ✅. 서비스 주석(`:110`)이 ⌜`message_key` 가 UNIQUE 라 재처리는 중복 전송이 아니다⌝ 로 규약을 이미 뒷받침한다.
- ✏ **`enqueue()` 의 «자리»가 §9 #8 과 어긋난다.** `src/integration/message` 에 두면 `src/production/` 이 **다른 도메인의 service 를 부른다**(`server-architecture.md:67`) — §4-3 이 출고요청을 직접 INSERT 로 판정한 바로 그 근거의 반대쪽이다. 사용처가 **둘(I-6 생산 · I-23 출하)**이라 `:60`(여러 도메인이 같이 쓰는 것 = core)의 조건을 정확히 만족한다 ⇒ **`src/core/outbox/`** 로 옮길 것(`src/core/lot/` 이 같은 이유로 코어인 선례 · `plan.md` §3 「LOT 등록」 행이 `:67` 을 명시 인용). ⚠ 파일 경로도 틀렸다 — **`src/integration/message/integration-message.module.ts` 는 없다**(모듈은 `src/integration/integration.module.ts` 하나). PR ⑥ 파일 목록 정정.
- ✅ 승인 게이트 없음(`plan-integration.md` §2 승인 9자리에 W/O 0건) · 개발품 전건 적재 · `erpSendItems` 무해석 · 게이트 셋 미구현(039) 동의.

## 6. `:cancel` · `:hold` · `:resume` — ✅ (한 자리 ✏)

- ✅ `document_cancellation` 미사용 — I-5 가 `CD-CANCELABLE-DOCUMENT-TYPE` 3값으로 닫은 축이고 W/O 는 사유 칸을 **자기가** 갖는다. 축이 다르다는 판정 정확.
- ✅ L3 집합(`WAITING`·`ACTIVE`) · `note` 버림 · 기발행 출고요청 방치(2단계 기준 1) · 세션 불변 e2e.
- ✅ **코드값 대조를 안 거는 것**은 실측이 강제한다 — `assertCodeValues`(`code-reference.ts:33-51`)는 그룹이 비면 **전건 400** 이다(조건 분기 없음). 「계약 required 를 형식만 본다」가 §2 1단계 본길 처리로 맞다.
- ✏ `held=` 근사는 유지하되, `status_code='SUSPENDED'` 근사가 **`released=`·`open=` 과 축이 다르다**(그 둘은 시각 칸)는 사실을 §7-5 단위 테스트 이름에 남길 것 — 계약이 ⌜상태 코드 문자열을 몰라도 판정된다⌝ 로 갈라 둔 자리를 우리만 문자열로 판정하는 유일한 필터다.

## 7. 생성·수정·4M·조회 — ⛔ (내부 계획 생성에 값 둘이 비어 있다)

- ⛔ **기본 BOM 선별 조건의 `status_code 확정` 이 F-6 위반이다.** 코드 그룹 **`BOM_STATUS` 가 없다**(psql: `%BOM%` 그룹 0건 · `src/planning/` 에 `bom.status_code` 참조 0건). 지금 문장대로 구현하면 `'CONFIRMED'` 류 **문자열을 지어내 WHERE 에 박는다** — `plan-integration.md` §9 #9 가 I-6 을 지목해 경고한 바로 그 함정이다. ⇒ 선별을 **`is_default` + `effective_from/to`** 로만 세우고(둘 다 실재) 상태 조건을 빼거나, 037/신규 문의에 「BOM 확정 상태 값 목록」을 함께 실을 것.
- ⛔ **`production_plan` 의 NOT NULL 두 칸에 값이 안 정해졌다** — 실측 18칸 중 `status_code`·`plan_date` 가 NOT NULL 인데 §7-1 은 `production_order.status_code='RECEIVED'` 만 정하고 계획 쪽은 비웠다. `PRODUCTION_PLAN_STATUS` 는 **2값(`DRAFT`·`CONFIRMED`)** 이고, 이 경로는 W/O 가 이미 선 상태이므로 `'CONFIRMED'` + `plan_date = 오늘` + `planned_qty = orderQty` 를 §2 3단계 흔적(주석)과 함께 못박을 것. 안 적으면 구현자가 둘 중 하나를 임의로 고른다(I-24 의 `:confirm` 과 값이 갈리면 되돌리기 비싸다).
- ✅ `plan_no`/`production_order_no` 접두어를 `DEFAULT_PREFIX` 에 더해 I-24 승계 — `prefixOf()` 가 모르는 유형을 **던진다**(`numbering.service.ts:142-149`) 실측 확인. 400 을 안 내고 구현하는 판정 ✅.
- ✅ `PUT` 자물쇠 `released_at IS NULL` · null/undefined 7칸 · `resource-plans` 409 봉투 `ErrorResponse`(jq 실측 — 다른 여섯과 다름) · `validation` 규칙 6(두 배정 축 합집합) · 목록 23 where 매핑 · `withSummary` required 둘.
- ✅ **①② sonnet 배분**은 README §4(조회 GET·뷰·컨트롤러 = sonnet)와 맞다 — 단 ① 은 아래 8 참조.

## 8. 횡단 · PR 분할 — ✏

- ✅ **403 추가 0 실측** — `derived-permissions.ts:115`(validation)·`:237-242`(POST·cancel·close·hold·release·resume)·`:279`(PUT) = **8** 전건 실재, `manual-permissions.ts` W/O 0건. 목록·상세 GET 은 `:113-114` 에 «등록돼 있으나» 가드가 **계약 403 선언 여부를 먼저 본다**(`permission.guard.ts:37-40`) ⇒ 403 이 안 난다 — §8-1 의 결론은 맞고, 「등록 0건」이 아니라 **「등록은 있으나 가드가 안 켠다」**로 적어야 §9-3 ⓖ 가 정확해진다.
- ✅ `runVersioned` 불사용 근거 실측 확인 — `master-write.ts`(경로는 `src/common/master/`)의 `runVersioned` 는 성공 상태를 **`HttpStatus.OK` 로 못박고** `setEtag` 를 부르며 `version === undefined` 면 던진다(:47-50). 200 에 ETag 미선언 6건 + 201 에 If-Match 없는 `POST` ⇒ 쓸 자리가 없다 ✅. If-Match 필수 **4**/선택 **2** 를 `jq` 로 13 오퍼레이션 전수 재확인(브리프의 「5」가 오기 ✅).
- ✅ 409 셋 + 4M 중복 · 404 미선언 3건에서도 냄 · `src/production/` 신설(`src/` 에 없음 실측) · 인계 표 6행 동의.
- ✏ **PR ① 의 모델이 규칙과 어긋난다** — README §4 는 「구현 — 코어(… **마이그레이션**) = opus」인데 ① 이 마이그 선행 커밋을 지고 **sonnet** 이다. ⓐ 마이그 커밋만 떼어 opus 로 돌리거나 ⓑ ① 전체를 opus 로 올릴 것. (② 는 순수 조회라 sonnet 유지 ✅. 「e2e — 코어 슬라이스는 opus」 단서는 코어를 만지는 ⑤a·⑤b·⑥ 이 이미 opus 라 충족.)
- ✅ **예산 350 은 이제 실재한다** — README 는 91줄이고 **§6 ②**(「비테스트 diff 예산은 구현 브리프에 350 … 한도 400 자체는 그대로」)가 실재한다. I-5 재수립 R-7 의 「저장소에 없다」는 그 뒤 갱신으로 **뒤집혔다** — I-6 의 인용이 맞다. 7분할 전건 ≤350 ✅ · ⑤a 185 ≤200 ✅. 위 5의 `ConflictException` 보강(+8)과 위 4의 순번 보정(+2)을 얹어도 ④ ~330 · ⑤b ~212 로 예산 안.
- ✏ **②③ 를 ① 위에 «병렬» 스택하면 충돌한다** — 둘 다 `work-order.controller.ts` 를 만진다(② 는 목록 핸들러, ③ 은 +~40). 스택은 ①→②→③ **직렬**로 두고, 병렬을 원하면 ③ 의 컨트롤러 추가분을 ④ 로 미룰 것.
- ✅ 단위 테스트가 e2e 로 못 가는 가드를 덮는다(경계 5 · 한 번의 UPDATE · L2/L3 집합 · `alreadyQueued` · `ended_at` 정의) ✅. 알파벳 시퀀서 실측 — `production-work-order` 는 `planning-*`·`permission-gate` **뒤**, `quality-*`·`trace-lot` **앞**이라 픽스처 베끼기 대상(`planning-bom`·`planning-routing-operation`)이 먼저 돈다 ✅.
- ✏ **e2e 픽스처 표에 NOT NULL 두 칸이 빠졌다** — `work_session` 직접 INSERT 에는 `session_no`·**`idempotency_key`** 가 NOT NULL 이다(실측 18칸). cleanup 순서는 FK 역순으로 맞다 ✅(트리거는 `BEFORE UPDATE` 라 DELETE 를 안 막는다는 판정도 함수 본문 실측과 일치).
- ✅ **M1 「마디」 e2e 를 ⑥ 이 지는 것**은 맞다 — `plan.md` §1 은 **M1 체인 e2e** 를 I-7 뒤 별도 행(fable 통합)으로 두었고 `plan-integration.md` §9 #10 이 ⌜체인 e2e 는 끝점 셋만 단언⌝ 이라 적었다. ⑥ 의 것은 슬라이스 스위트의 마디 단언이므로 겹치지 않는다. §10 에 「체인 e2e 는 I-7 뒤 별도」 한 줄만 덧댈 것.

## 9. `plan-integration.md` 와 어긋나는 자리 (구현에 영향 주는 것만) — ✏

- ✅ §11 대조표의 integration 행 실측 확인: #3(§6-3 599행·§3-1 262행) · #5(282행 — `work_order` 에 `bom_id` **없음** psql 재확인 · I-8 `shortage` 문장 동반 수정) · #6(256행) · #7(259~263행 「예상 4」) · #8(170행 표 열) · #15(`plan.md` 103행) · #16(`plan.md` 104행) · #18(§4-1 M1).
- ✏ **§11 이 빠뜨린 integration 4자리**: ⓐ **258행** — 유일 제약 SQL 을 「`COALESCE` **3칸** 부분 인덱스」로 적었다(§2-6 은 `WHERE` 없는 식 인덱스). #3 은 262행만 짚었다 ⓑ **170행 마이그 열** ⌜⭕ 유일 제약 + `remainder_disposition_code`(§I-25)⌝ — 뒤 절반 삭제(#1·#8 은 PR 열·표 열만 짚었다) ⓒ **151행** ⌜`src/integration/message` … «적재 함수 하나»만 붙이면 된다⌝ — 위 5의 코어 이관 + 모듈 파일 부재 ⓓ **152행** ⌜생명주기는 I-6·I-7 에서(이미 등록돼 있다 — 코드를 안 쓰고 있을 뿐)⌝ — `moveWithin()` 신설이 필요하다는 #16 과 **같은 문장이 두 자리**다.
- ✅ §6-2 「I-6 ∥ I-19 는 I-7 뒤」(583행) · 665행 #7(I-24 를 뒤에) · 667행 #9(지어낸 상태값 방어) 전건 정합 — 다만 #9 는 위 7의 `BOM_STATUS` 자리에서 **실제로 걸렸다**(방어가 작동한 사례로 §9-1 에 남길 것).

---

## 재수립 결과 — 5줄 요약

1. **I-6.md 수정 9건** — ⓐ §2-6 SQL 을 **`COALESCE` 한 식 3칸**(계약 이름과 글자 그대로 일치)으로 줄이고 드리프트 근거를 「I-1 선례」 대신 **`migrate diff` 실측(식 인덱스 10건 · 결과 빈 마이그)**으로 교체 ⓑ §3-2 `moveWithin()` 반환을 `{ movedLotIds, **skippedLotIds** }` 로(I-7 L1 의 이중 기록 방지) ⓒ **§5-5·§8-4 에 `ConflictException` 확장**(`ProductionConflictResponse.code` 가 required — 409 전건이 지금은 계약 미준수) ⓓ §5-6 `enqueue()` 를 **`src/core/outbox/`** 로(§9 #8 과 정합) + `integration-message.module.ts` 부재 정정 ⓔ §7-1 기본 BOM 선별에서 **`status_code 확정` 삭제**(`BOM_STATUS` 그룹 0건 — F-6) ⓕ §7-1 에 `production_plan.status_code='CONFIRMED'`·`plan_date`·`planned_qty` 명시 ⓖ §7-1 사업부를 **`warehouse.business_unit_id`(NOT NULL)** 로(공장 것은 nullable) ⓗ §4-2 에 `mesLotNo` 순번을 `used+1 … used+N` 으로 · `'WORK_ORDER'` 상수를 `lot-rules.ts:74` 것과 공유 ⓘ §10-1 픽스처에 `work_session.session_no`·`idempotency_key`.
2. **`plan.md` 에 반영할 것** — §1 40행 PR **4 → 7**·모델 「opus(①만 마이그 때문에 opus · ② sonnet)」 · §3 **103행**(아웃박스 자리 `src/integration/message` → **`src/core/outbox/`** · 규약 못박기) · §3 **104행**(「호출만」 → `moveWithin()` 신설) · §4 **M-d**(「부분 유일 인덱스 + `remainder_disposition_code?`」 → 「식 유일 인덱스 1건」) · §7 문의표에 I-6 행 5개. ⚠ README §6 ② 예산 350 은 **실재**하므로 I-5 R-7 의 반대 문장은 이 슬라이스에 적용하지 않는다.
3. **`plan-integration.md` 에 반영할 것 — §11 이 빠뜨린 4자리 포함**: 151행(아웃박스 자리·모듈 파일) · 152행(생명주기 코어 신설) · 170행 마이그 열 · 258행 유일 인덱스 SQL · 그리고 이미 §11 이 든 262·282·599행.
4. **문의 최종 5건 유지(035~039)** — 035 는 ⓓ 의 물음을 「값이 왜 없나」에서 **「초기 목록을 설계가 주나, 고객 MDM 운영인가(그룹이 `isSystemOwned` 가 아니다)」**로 바꾸고 「값이 서면 대조를 켠다」 되돌림 한 줄을 붙인다 · 036 은 **`lot-rules.ts:74` 가 이미 그 값을 쓰고 있다**는 실측을 근거로 싣는다(대기 문의 13 과 같은 성격) · 037 ⓐ 를 「`routing_operation_id` vs **`actual_use_process_id`** 둘 중 어느 축인가」로 고치고 ⓒ 는 「알려둘 것」으로 내린다 · 038·039 그대로. 「알려둘 것」 17건 중 ⓓ(`ix_work_order_dispatch` 죽은 값 셋)만 물리 정리 목록으로 올린다.
5. **PR 분할 최종안 — 7개 유지 · 직렬 스택**(① 마이그+골격+상세 ~250 **opus**(마이그 때문) · ② 목록 ~300 sonnet · ③ validation+4M 쓰기 ~240 opus · ④ POST/PUT+전이 키+hold/resume+**`ConflictException` 확장** ~330 opus · ⑤a 코어 ~188 ≤200 opus · ⑤b `:release` ~212 opus · ⑥ `:close`/`:cancel`+`src/core/outbox/` ~330 opus · 합 ~1,850 · 마이그 선행 커밋 1 · 시드 1행). ②③ 병렬 스택은 컨트롤러 충돌로 **하지 않는다**. M1 **체인** e2e 는 I-7 뒤 fable 몫이고 ⑥ 은 마디 단언만 진다.
