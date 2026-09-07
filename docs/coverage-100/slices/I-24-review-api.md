# I-24 개별 계획안 — **api 관점** 재검토

> 대상 `slices/I-24.md`(777줄) · 자기 관점 `plan-api.md` S13(335~357)·707·829~830·900·971 · 계약 `contracts/COMMIT.txt` a6a87e1 · 코드 main **04e3bca** · 실측 2026-09-07.
> 표기 ✅ 동의 / ✏ 수정 / ⛔ 반대. **결론: 반대 2 · 수정 8 · 동의 5.**

## 1. A11 두 칸 — ✏(결론 유지 · 근거 교체)

- 저장한다는 결론 ✅. 실측: `ProductionPlanSplitRef` 에 **`required` 배열 자체가 없다**(둘 다 선택) · `reasonCode` desc ⌜값 목록은 공통코드 마스터가 갖는다 — 그룹 이름은 `PRODUCTION_PLAN_SPLIT_REASON`⌝ · 시드 `prisma/seed.ts:712` **5값 실재**.
- ✏ **I-7 D2 선례 인용이 헐겁다.** D2 는 `ProductionResultCorrect.reasonCode` 가 **계약 required** 라 README §5 ⌜물리 모델과 계약이 다르면 물리를 고친다⌝ 가 곧바로 걸린 자리다(`I-7.md:776`). 여기는 required 도 아니고 응답에도 없다. 근거를 **§2 2단계 기준 4 + 「A11 이 이미 `sourcePlanId` 를 쓰기 전용으로 받기로 했으니 한 객체의 반쪽만 저장하는 편이 더 나쁘다」** 로 바꿔 적는다. D2 는 「보조 선례」로 내린다.
- SQL 형식 ✅ — `app.code_t` 는 baseline `migration.sql:50` 의 `CREATE DOMAIN … varchar(50)` 실재 · CHECK 형제 `ck_production_order_parent`(:749)·`ck_work_order_split_self`(:827) 실재 · FK 이름 생략 → PG 기본 `production_plan_split_of_plan_id_fkey` = Prisma 기본형(메모 규칙 충족). ⚠ 같은 표에 이미 `fk_production_plan_confirmed_by`(map 지정)가 있으니 **새 FK만 기본형**임을 마이그 주석에 한 줄 남긴다.
- 인덱스 ✅ — §4-3 DELETE 손검사가 이 축으로 도는 유일한 질의라 §2-5 의 「쓰는 오퍼레이션이 설 때」에 정확히 걸린다.
- `plan.md` §4 **125행**: `split_of_plan_id?` → 「`split_of_plan_id?` · `split_reason_code?` · `ck_production_plan_split_self` · `ix_production_plan_split_of`」.

## 2. 도메인 경계 — ⛔(골격 ✅ · **상수 공유 방식 반대**)

- planning 이 `production.work_order`·`work_order_dependency` 에 직접 INSERT 하는 골격 ✅. I-6 §8-6 ⓐ 원문(`I-6.md:859`) ⌜`src/production/` 의 service 를 부르지 않는다 — 공유하는 것은 **타입**과 **상수**뿐⌝.
- ⛔ **상수 재선언 + spec 단언은 I-6 R-1 이 «반대로» 판정한 자리다.** R-1 원문(`I-6.md:31`): ⌜**상수를 새로 선언하지 않는다** — `lot-rules.ts` 의 값을 `src/core/lot/lot-source.ts` 로 옮기고 `lot-rules.ts` 가 그것을 import 한다(도메인 간 import 금지)⌝. 그 파일은 **실재한다** — `src/core/lot/lot-source.ts:7` 이 상수 **하나**를 담은 파일이고 `index.ts:5` 가 export 한다. ⇒ §3-2 의 「두 상수를 위해 코어 파일을 신설하지 않는다(기준 5 — 새 개념 수)」는 저장소 안 선례로 이미 반증됐다.
- **대안(채택 권고)**: `src/core/work-order/defaults.ts` 세 줄 — `WORK_ORDER_INITIAL_STATUS='PLANNED'` · `WORK_ORDER_DEFAULT_TYPE='NORMAL'` · `WORK_ORDER_DEFAULT_PRIORITY=100`. `work-order-write.service.ts:42-47` 은 `export` 를 붙이는 대신 **그 셋을 import**(−3/+1), planning `expand.ts` 도 코어에서 import. 드리프트 방어가 **정적 spec 이 아니라 타입**이 되고, 단위 ④(상수 대조)가 **사라진다**(8 → 7).
- 비용 비교(실측): 현안 = `work-order-write.service.ts` +2 + `expand.ts` 재선언 3 + spec 케이스 1 / 대안 = 새 파일 ≈8줄 + write.service 3줄 치환. **대안이 더 싸고 I-6 R-1 과 결이 같다.**
- ⛔ 브리프가 물은 「production 이 export 하는 순수 함수 `buildWorkOrderRows()`」 안은 **반대** — 순수 함수여도 planning 이 `src/production/` 을 import 하는 것이고, `server-architecture.md:51·67` 은 ⌜코어는 여러 도메인이 같이 쓰는 것만⌝·⌜공유가 필요하면 그것은 core⌝ 다. 공유 대상이 상수 셋뿐이라 코어행이 정확한 크기다.

## 3. `work_order_dependency` = `routing_operation_dependency` 복제 — ✅(근거 보강)

- `W-02-02` v0.2(:282) 원문은 ⌜계획 확정 + Routing 공정별 W/O 생성 + **공정 의존 생성**⌝ 뿐 — **어느 쪽인지 안 가른다**. 계약 `:confirm` desc 도 ⌜공정 의존(work_order_dependency) 생성까지가 안⌝ 까지다. 화면은 답을 주지 않는다.
- 0단계 선례 셋 전부 실측 확인 ⇒ ⓑ 마스터 복제가 맞다: `routing-operation.service.ts:147-183 replaceDependencies()` 실재 · `routing-revision.service.ts:125-135` 가 Rev 를 뜰 때 의존을 짝 대응표(`moved`)로 복제 · **`W-02-02` §4-C 가 `work_order_dependency` 를 화면 필드표에 두고 두 기본값을 「모델이 앞섬」으로 적었다**. §3 목업 「선행 10번·20번」은 선형 Routing 의 «결과»이지 도출 규칙이 아니다.
- 0건이면 0건 성공 ✅ — `work-order-list-where.ts:66-71` 의 `successorOfWorkOrderId` 는 `some:` 이라 0건이면 빈 목록이고, 계약이 ⌜후속이 없으면 빈 목록이고 화면은 「다음 공정이 없습니다」를 그린다⌝ 로 그 상태를 정상으로 적었다.
- ✏ `mes_managed`: 뜻이 어디에도 없다(계약 `RoutingOperation.mesManaged.description` = **null** 실측 · `schema.prisma:2566` 은 `@default(true)` 뿐). 「거르지 않는다」는 기준 4로 옳지만 결과가 **영원히 `PLANNED` 로 남는 W/O** 이고 그것이 §5-1 두 파생 칸과 후속 체인에 그대로 실린다 ⇒ 「알려둘 것 ⓒ」를 **063+3 의 한 줄로 올린다**(「전개가 어느 공정까지 만드나」는 같은 물음이다).

## 4. W/O 칸 채움 — ✏(한 자리 · M2 마디에 영향)

- `production_line_id` 미복사 ✅ 기준 4. 계약 `:confirm` 원문에 라인 언급 **0**(⌜기본 위치: 생성 후 `W-02-03`·`W-02-04` 의 PUT 으로 채운다⌝ 만). `item_id` = P/O 것 ✅.
- **`planned_start/end_at NULL` 은 `:release` 를 막지 않는다** — `work-order-release.service.ts:57-73` 실측: 잠금 → `assertVersion` → `assertTransition` → UPDATE 이고 시각·라인을 **안 본다**. `release-plan.ts:54-87` 도 `order_qty`·`item_id`·`uom_id`·`production_plan.bom_id` 만 읽는다. ⇒ **M2 마디 ⓒ(그중 하나가 `:release` 를 지난다)는 통과한다.**
- ✏ ⚠ **부수효과가 조용히 죽는다** — `work-order-release.service.ts:93-95` 는 `default_wip_location_id !== null` 일 때만 출고요청을 만든다. `:confirm` 이 위치 3칸을 NULL 로 두므로 `plan.md` §2 83행의 M2 두 번째 마디 「`:release`(**출고요청 자동**)」가 **요청 0건으로 성립한다**. ⇒ §8-6·§11 ⑦ 에 「체인 e2e 는 `:release` 앞에 `W-02-03` PUT 으로 WIP 위치를 채운다」 한 줄을 넣는다.
- `operation_settings_snapshot` 안 씀 ✅ **+ 근거 보강**: `replaceDependencies()` 가 `assertDraft(routingId)`(`routing-operation.service.ts:151`)로 막혀 **확정 Routing 의 공정·의존 행은 in-place 로 바뀌지 않는다** ⇒ confirm→release 사이 소급 창이 **없고** `W-02-02` §5-4 규칙 2(「전개 후 개정돼도 안 바뀐다」)의 실질 결과가 지켜진다. 「알려둘 것 ⓐ」는 이 실측을 근거로 달아 유지.

## 5. 채번 — ⛔(W/O 의 `plantId` 축)

- `PP` 기간 키 = `planDate` ✅ — `numbering.service.ts:64-66` 주석 ⌜서버가 「오늘」로 다시 잡지 않는다 — 호출자가 이미 가진 날짜를 그대로 준다⌝.
- N 건 선채번 재시도 형상 ✅ — `goods-receipt.service.ts:100-113` 이 `for(attempt)` **안에서** 헤더 1 + 라인 N 을 전부 다시 뽑는다(하나만 중복이어도 전건 재채번 · 결번 허용). 그대로 복제하면 된다.
- ⛔ **W/O 채번에 `plantId = production_order.plant_id` 를 주는 것.** `numbering.service.ts:93-103` 은 `OR:[{plant_id},{plant_id:null}]` 로 찾고 **공장 지정본이 전역본을 이긴다**. 오늘은 `WORK_ORDER` 전역 규칙 1행뿐이라 결과가 같지만, 공장 규칙이 **한 줄 등재되는 순간** `POST /production/work-orders`(`work-order-write.service.ts:140` — `null`)와 `:confirm` 이 **다른 규칙·다른 카운터**를 타고, 패턴이 같으면 번호가 겹쳐 `work_order_no @unique` 재시도 루프로 샌다. §3-5 는 기간 키에 대해 「형제와 같은 축이어야 한 유형의 카운터가 갈리지 않는다」라 적고 **공장 축만 가른다 — 자기모순**이다. ⇒ **`null` 로 통일**하고 「공장 규칙이 등재되면 두 자리를 함께 옮긴다」를 §11 ⑥ 에 남긴다. `release-plan.ts:84` 는 선례가 아니다 — 거기는 `MATERIAL_ISSUE_REQUEST` 로 **부르는 자리가 하나뿐인** 유형이다.
- `PRODUCTION_ORDER` 접두어를 안 더하는 것 ✅(부를 자리 0 · 기준 3·5).

## 6. `:confirm` 순서 — ✏(`createManyAndReturn` 순서 의존)

- `LINE_REQUIRED` 실재·뜻 ✅ — `error-codes.ts:23-24` ⌜계약이 이름 붙인 값 — 「라인이 1건 이상이어야 한다」(Routing Rev 확정)⌝ · `routing-revision.service.ts:38` 이 같은 조건을 400 으로 이미 쓴다. 공정 0건에 재사용은 결이 같다. tx 밖이라 `STATE_LOCKED` 보다 앞서는 것 ✅(e2e 26 이 못 박는다).
- ✏ ⛔ **`createManyAndReturn` 의 반환 순서에 기대지 않는다** — 저장소 사용처 **0건**(grep 실측: `balance-write-guard.spec.ts:15` 주석뿐)이라 선례가 없고, Prisma 6 은 반환 «순서»를 약속하지 않는다. ⇒ 돌려받은 행의 **`routing_operation_id` → `work_order_id` Map** 을 세워 ⑨ 가 그 map 으로 짝짓는다(§3-4 의 짝짓기와 같은 자료구조). 단위 ② 를 「id 순서가 아니라 map 으로 짝짓는다」로 고쳐 적는다.
- 멱등 재전송 ✅(`runIdempotent` 가 work() 를 안 돈다) · `confirmed_at = now()` ✅ — `business_date` 를 실은 표는 3개뿐(CLAUDE.md)이고 이 계약 파일에 `businessDate` 프로퍼티 0건.

## 7. 계획 CRUD — ⛔(`SUCCESSOR_EXISTS` 봉투)

- DELETE = **409**, PUT = **400** 갈래 ✅. 실측: DELETE `responses` = `['204','403','404','409']`(400 부재) · x-internal-note ⌜404 가 아니라 409 로 막는다⌝ · `ProductionPlan.statusCode` desc ⌜수정·삭제가 막힌다(400 STATE_LOCKED)⌝. **오퍼레이션의 `responses` 와 그 note 가 서로 일치**하므로 산문보다 그쪽이 이긴다.
- ⛔ **자식 분할 계획을 409 `SUCCESSOR_EXISTS` 로 낼 수 없다.** `ProductionConflictResponse.code` 는 **required 이고 enum 5값**(`VERSION_CONFLICT`·`DUPLICATE_KEY`·`OPEN_SESSION_EXISTS`·`BATCH_DEPENDENCY_FAILED`·`INVALID_STATE`)인데 `SUCCESSOR_EXISTS` 가 **그 안에 없다**(실측). 저장소에서도 이 코드는 **400 `ErrorResponse` 에서만** 쓰였다(`purchase-order.service.ts:383` · `document-cancel-execute.service.ts:93`). ⇒ **409 `INVALID_STATE` 로 내고 message 로 가른다**(「분할 계획이 매달려 있습니다」). e2e 20 의 기대값을 고친다. 이대로 두면 §1-6 「새 error code 0」 주장도 함께 깨진다.
- POST 없는 P/O → 400 `INVALID` ✅(404 미선언 실측) · PUT 순서(잠금→토큰→상태) ✅(I-12 R-6) · 정렬 ✅(계약에 `sort` 칸 0) · 합계 검증 없음 ✅(`W-02-02` §5-2 + §6 ⌜계획 합 > P/O 수량 → ⚠ 경고⌝ 가 화면 몫) · 다른 P/O 의 원본 허용 ✅.

## 8. P/O 파생 칸 — ✏(upsert 키 전제)

- `plannedWorkOrderCount` 정의 ✅ — 계약 원문 ⌜계획 전건이 전개되면 생기는 W/O 총수(계획별 Routing 공정 수의 합) … 0 이면 계획이 아직 없다⌝ ⇒ **DRAFT 계획도 센다**(§5-1 SQL 이 맞다).
- `unacknowledgedOnly` SQL ✅(계약 ⓐ∨ⓑ 의 여집합 · `work-order-list-where.ts` 의 「후보를 좁힌 뒤 id 필터」 선례). `includeChildren` 페이지 형상 ✅ — `app-공통.json` `PageMeta.required` 는 `page·size·total` 셋뿐이고 `items.length ≤ size` 를 요구하는 문장이 없다. `lastChange.changedFields` 고정순 ✅(계약이 순서를 직접 적었다).
- ✏ **upsert 가 「수신기가 서면 저절로 UPDATE 로 바뀐다」(§2-3·§11 ④)는 보장되지 않는다** — uq 3칸 중 `acknowledgement_type_code` 를 `:acknowledge` 가 `'PO_CHANGE'` 로 **지어** 넣으므로, 수신기가 다른 type 코드를 쓰면 같은 `received_at` 에 **두 행**이 선다. 그 문장을 「수신기가 같은 type 코드를 쓰기로 정해지면」으로 조건화하고, **「그 값을 누가 정하나」를 063+4 의 물음에 명시**한다.

## 9. `:acknowledge` — ✏(**결론 ✅ · 계약 근거가 실제로 있다**)

- ⭐ **PROCEED 전건은 계약이 직접 적었다.** `WorkOrder.poMismatch` description 실측: ⌜서버가 **두 자리**에서 세운다 — ⓐ 관리자가 「기존 유지(**강행**)」를 고를 때 ⓑ 「변경 반영」을 골랐는데 그 W/O 를 `workOrderAdjustments` 로 조정하지 않았을 때⌝. ⇒ §5-5 ⑦·§9-1 #8 의 「계약은 `APPLY` 빈 배열만 적었다」는 **틀렸다**. 근거를 `W-02-06` R09 에서 이 계약 문장으로 바꾸고 **「알려둘 것 ⓗ」를 지운다**(통지할 어긋남이 아니다).
- P/O `version_no` 불변 ✅ — `:acknowledge` desc 에 상태·버전 갱신 문장 0(실측) · `plan-api.md` 830행. 「같은 토큰으로 두 번 확인」은 알려둘 것 ⓖ 로 유지.
- `conflictCause` 두 값 ✅ — `ProductionConflictResponse.conflictCause` enum 3값 실재 + ⌜`code=VERSION_CONFLICT` 일 때 함께 내린다⌝ · `conflict.exception.ts:33-39` 가 `extra.code` 를 이미 받는다(I-6 R-8). `last_change_received_at IS NULL` → 400 ✅(기준 2) · `CANCELLED` 허용 ✅.
- ✏ I-6 과의 충돌: `released_at IS NULL` 자물쇠는 `PUT` 경로의 것이라 **막지 않는다**. 다만 **`RELEASED` 뒤 `order_qty` 를 바꾸면 선발행 슬롯 합(`release-plan.ts:69 slotQtys`)과 어긋난다** — 계약이 막지 않으므로 그대로 두되 **「알려둘 것」에 한 줄을 새로 더한다**(현 12건에 없다).

## 10. `:resync` — ✏(규약을 헬퍼 «밖»에)

- 멱등키를 키에 붙이는 판단 ✅ — `outbox.service.ts:34-38` 주석이 「버전을 안 붙인다」의 이유를 ⌜한 W/O 는 평생 한 번만 적재된다⌝ 로 못 박아 재요청 축은 그 규약 밖이다. 안 붙이면 둘째 요청이 `outbox.service.ts:57-63` 의 선조회에서 `alreadyQueued` 로 사라진다(`message_key @unique`).
- ✏ **`outboxMessageKey()` 의 «안»을 고치지 않는다** — 호출부에서 `outboxMessageKey(IF,poNo) + ':' + key` 로 잇고, 두 갈래가 생겼다는 사실만 `outbox.service.ts:34-38` 주석에 더한다(I-23 이 I-6 규약을 그대로 쓰므로 헬퍼를 바꾸면 그쪽이 조용히 따라 움직인다). §11 ③ 의 「구현자 몫」을 PR ④ 체크리스트 항목으로 올린다.
- `interfaceCode`·`targetTypeCode`·payload·202 본문 없음·404 순서 ✅(계약 202 에 content 0 실측 · I-6 `WORK_ORDER` 선례). `direction_code` 는 `OUTBOX_DIRECTION` 상수라 고를 여지가 없다 — 알려둘 것 ⓚ 유지.

## 11. `transitions.ts` — ✅(숫자 하나 보완)

- 키 신설 1 · 전이 1 ✅. `document-state.spec.ts:252-267` 축 목록 **11** 실측 → **12**. ✏ I-24 는 「전이 수 주석 `+1`」만 적었는데 **단언값이 `toHaveLength(27)`**(`:270`)이다 ⇒ **28** 로 고친다고 브리프에 숫자를 적는다.
- P/O 키 부재가 방어 ✅ — 등록 안 된 (칸, 액션)을 `assertTransition` 이 던진다. 코어 단독 커밋 ✅(CLAUDE.md ≤200 · 실제 +16).

## 12. 권한·배치·횡단 — ✅(문장 하나 정정)

- 미등록 2건 ✅ 실측 — `derived-permissions.ts:15·225·226·227` 넷 + **GET 2(`:107`·`:108`)** · `manual-permissions.ts` 에 이 경로 **0건** ⇒ 빈 것은 `PUT`·`:resync` 둘(= `plan-api.md` 971행). 화면 코드 `W-02-02`·`W-06-10` ✅(계약 x-internal-note 가 소관을 직접 적었다).
- ✏ §7-5 의 「GET 4건은 등록하지 않는다」 → **「새로 등록하지 않는다」**. P/O GET 2 는 derived 에 **이미 있다**.
- `planning.module.ts:18` imports 셋 ✅ · `NumberingModule`·`OutboxModule` 추가 ✅ · `production.module.ts` 0줄 ✅ · `assertWorkerNo` 0 ✅(파라미터 `WorkerNo` `$ref` 0건).
- 새 error code 0 ✅ — **단 판정 7 의 정정이 들어가야 실제로 0 이 된다**(`SUCCESSOR_EXISTS` 는 있는 코드지만 409 봉투에 못 들어간다).

## 13. 문의 6 — ✏(6 유지 · 번호와 경계 조정)

- **063+1 은 «멈춤 조건» 아니다** ✅ — README §3 은 ⌜어느 쪽도 맞출 수 없을 때⌝ 인데, DELETE 의 `responses`(400 부재·409 존재)와 그 x-internal-note 가 **서로 일치**하고 스키마 산문만 어긋난다. 판정 가능한 가장자리 ⇒ 구현하고 문의. 제목·질문 정확.
- 063+4 가 셋을 묶는 것 ✅ — 뿌리가 하나(수신기 0건)라 갈라 보내면 답이 서로를 가리킨다. **판정 8 의 「type 코드를 누가 정하나」를 물음에 명시**.
- ✏ **063+5 는 문의 14 와 겹치는 부분을 뗀다** — `plan_no` 형식 요청은 「문의 14 표에 한 행 추가」로 빼고(I-6 이 `work_order_no`·`issue_request_no` 를 그렇게 보냈다 — `design-inquiries/README.md` (I-6) 항), 새 문의의 몸통은 **「`PO` 접두어 충돌 + P/O 를 만드는 오퍼레이션 0건」** 으로 좁힌다.
- 063+6 vs **#66** ✅ — 겹치는 것은 ⓑ 한 줄뿐이고 몸통(키 규약·회신 경로)이 새롭다. 063+2·063+3 ✅.
- ✏ **번호**: `docs/design-inquiries/` 마지막이 **062** 다(실측) ⇒ 다음 빈 번호는 **063**. 「063+n」 표기는 064~069 로 읽혀 063 이 결번이 된다 — **063~068** 로 확정한다.
- 「알려둘 것」 **12 → 12**(ⓗ 삭제 · 판정 9 / 「`RELEASED` 뒤 `order_qty` 조정이 선발행 슬롯 합과 어긋난다」 추가).

## 14. e2e·PR — ✏(스택 4단 → 3단 가능)

- e2e 44 + 단위 8 ✅ 과하지 않다(오퍼 10 · 파생 3칸 · 400 넷 · 토큰 둘 · 페이지 형상 둘). **단위는 판정 2 채택 시 8 → 7**(상수 대조 ④ 소멸).
- PR **4** 결론 ✅ 지지 — 규모 비교 실측: `work-order-write.service.ts` **237줄** · `goods-receipt.service.ts` **274줄** · `work-order.controller.ts` **264줄**. `:confirm` 전개 서비스와 `:acknowledge` 서비스가 각각 그 급이라 한 PR 에 못 든다. ✏ 다만 §10 의 조각별 숫자(110/70/150/45/60/16)는 **예상치**이지 실측이 아니므로 PR 본문에 그렇게 표기한다.
- ✏ **①을 가르면 스택이 3단이 된다** — 파일 겹침 실측: ① 이 만드는 6파일 중 `production-plan.*` 3 은 ②③ 이, `production-order.*` 3 은 ④ 가 쓴다. **①a(계획 조회+뷰) / ①b(P/O 조회+뷰+권한 2줄)** 로 가르면 **①a→②→③** 과 **①b→④** 가 파일이 안 겹쳐 **병렬**이 된다(공유는 `planning.module.ts` 한 뭉치뿐 — 충돌이 얕다). 채택하면 대기 한 칸이 준다. 안 하면 4단 직렬 그대로 ✅.
- ② 를 sonnet 에 ✅ — 마이그가 추가 2칸+CHECK+인덱스뿐이고 README §1-5 「병합 전 한 줄 보고」가 붙는다. 회귀 3스위트 ✅(`integration-message.e2e-spec.ts` 존재는 구현자가 확인).

## 15. `plan-api.md` 와 어긋나는 자리 — 구현에 영향 주는 것만

- S13(335~344) 실측 재확인: 「예상 PR 수 **3**」·「쓰는 표 **4**」·「설계 미정 = `:resync` 하나」·「마이그 = `split_of_plan_id`(nullable self FK)」 ⇒ §10-1 #1·#2·#3·#6 대로 고친다 ✅.
- ✏ **#6 은 6표가 아니라 7표** — `production.work_order`·`work_order_dependency` 에 더해 **`integration.integration_message`**(`:resync`)도 S13 「쓰는 표」에 없다.
- 900행 A11 = 한 칸 → 두 칸 ✅ · 971행 미등록 2건 ✅ 일치 · 829~830 D 표 ✅ 일치 · 707행(`:resync` 부분 건너뜀) ✅ 일치.
- §10-1 #5(`plan-uiux.md` 의 ETag 표 오류)는 계약 실측이 이긴다 ✅ — api 관점에서 추가 이견 없다.

---

**재수립 결과 — 5줄 요약**
1. **I-24.md 수정 9건**: ⓐ A11 근거를 D2 → 기준 4 로 교체(§0·§2-4) ⓑ 상수 공유를 **`src/core/work-order/defaults.ts`** 로(§3-2 · 단위 8→7) ⓒ W/O 채번 `plantId` → **`null`**(§3-5) ⓓ `createManyAndReturn` 순서 의존 → **`routing_operation_id` map**(§3-1 ⑧⑨) ⓔ DELETE 자식 계획 409 `SUCCESSOR_EXISTS` → **409 `INVALID_STATE`**(§4-3 · e2e 20) ⓕ `:acknowledge` PROCEED 근거를 **계약 `WorkOrder.poMismatch`** 로 바꾸고 알려둘 것 ⓗ 삭제 ⓖ M2 마디에 「`:release` 앞 WIP 위치 PUT」 한 줄(§8-6·§11 ⑦) ⓗ upsert 「저절로 UPDATE」 조건화(§2-3·§11 ④) ⓘ `document-state.spec` 단언 **27→28** 명시(§6).
2. **`plan.md` 반영**: §4 **125행** A11 = 두 칸 + `ck_production_plan_split_self` + `ix_production_plan_split_of` · §1 **47행** PR 3→**4**, 코어 「—」→**`transitions.ts`**. `plan-api.md` 는 S13 PR 3→4 · 쓰는 표 4→**7** · 「설계 미정」 1건→6건 · 900행 A11 두 칸.
3. **문의 최종 6건 — 번호 `063`~`068`**(마지막이 062 실측). 063+5 는 `plan_no` 형식 요청을 문의 14 로 떼고 「`PO` 충돌 + P/O 생성 오퍼 0」으로 좁힌다. 「알려둘 것」 12(ⓗ 삭제 · `RELEASED` 뒤 수량 조정 1건 추가).
4. **PR·모델**: 4 유지 — ①a 조회(계획)+②마이그·CRUD sonnet / ①b 조회(P/O)+권한 sonnet / ③ `:confirm`+`transitions.ts` opus / ④ `:acknowledge`+`:resync` opus. **①을 a/b 로 가르면 두 축이 병렬**이라 스택 4단→3단. 예산 ≤240·≤200·≤240·≤240 그대로.
5. **한 줄 판정**: 도메인 경계 — planning 직접 INSERT는 옳으나 **상수는 재선언이 아니라 `src/core/` 로 올린다**(I-6 R-1·`lot-source.ts` 선례가 반대편을 이미 못 박았다). A11 두 칸 — **찬성**하되 근거는 D2 가 아니라 「객체의 반쪽만 저장하지 않는다」(기준 4)다.
