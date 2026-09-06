# I-6 재검토 — **api 관점**

> 대상 `docs/coverage-100/slices/I-6.md`(1,017줄) · 브리프 `brief-I-6-review.md` · 계약 `contracts/COMMIT.txt` = `a6a87e1` · 실측일 2026-09-06.
> 실측 수단: `jq`(계약 읽기 전용) · `grep`/`sed`(코드) · DB 접속 없음. 판정 번호는 통합자가 `R-api-N` 으로 인용한다.
> 정본: `plan-api.md` S14(`:360-385`)·§5.1-C(`:800-822`)·§5.4(`:1043`·`:1067`)·`:1103` · `contracts/production-02생산실행.json`.

---

## 1. 문의 035~039 가 정말 새 문의인가 — **✏**(신규 **5 → 4**)

- **036 ⛔ 문의가 아니다 — 계약이 이미 답했다(§2 0단계).** `jq` 실측 `LotCreate.sourceTypeCode` 의 `x-internal-note`·`description`: ⌜공유계약 A-16 … **다형 참조 판별자**다 → enum 으로 닫는다⌝ · ⌜값은 언제나 sourceId 가 «가리키는 것»을 이름한다⌝ · ⌜⚠ «응답» `Lot.sourceTypeCode` 는 열려 있다 — **서버가 만드는 원천이 더 있기 때문이다.** 자리마다 값 집합이 다르다⌝. 그리고 `?workOrderId` 는 ⌜판별자 값 목록이 아직 미확정이라 짝 필터를 열지 않았다 … **서버가 W/O 원천으로 풀어 준다**⌝ — 값을 읽는 쪽이 0이다. ⇒ 상수 `'WORK_ORDER'` 는 계약이 준 명명 규칙의 기계적 적용이라 **판정이 아니다**.
  ⇒ ⛔ **시드 1행을 빼라.** `LOT_SOURCE_TYPE` 은 설계가 등재한 그룹이고(⌜G-32 · 2026-09-02 등재⌝), 값을 더하는 것은 I-6 자신이 `LOT_HOLD_STATUS`·`material_issue_request.status_code` 두 자리에서 쓴 **「상수만 넣고 시드·판정은 안 한다」**(`lot-registry.service.ts:19-21` 선례)와 정면으로 어긋난다. 라벨 등재 요청 한 줄만 「알려둘 것」으로 내린다. ⇒ §2-7·§4-2·§9-1 #3·§9-2·§10-2 를 함께 고친다.
- **035 ✅ 셋을 한 장에 묶는 것이 맞다 · ✏ 두 줄을 반드시 보탠다.**
  ⓐ ⛔ **`omf-mes#261` 인용이 빠졌다.** `:hold`·`:resume` 의 `x-internal-note` 실측: ⌜⚠ 남은 물음은 「화면이 두 호출을 보내는가, **서버가 events 사건에서 W/O 상태를 파생하는가**」이고 그것은 사람 게이트 대상이다 — **omf-mes#261 을 닫지 않는다**⌝. ⓒ(`RELEASED`→hold→resume 비대칭)는 정확히 그 물음의 뒷면이다. 번호를 안 걸면 설계팀이 같은 이슈를 두 번 받는다.
  ⓑ ✏ **「구간 표가 없다」는 결손이 아니라 의도다** — 같은 노트가 ⌜⚠ 구간 자체는 세션 사건으로 읽힌다(`GET /production/work-sessions/{id}/events?eventTypeCode=STOP` · A-25) — 없는 것은 설비 축으로 그 구간을 «집계»할 길이다⌝ 라 적었다. 물음을 「구간을 담을 표가 없다」가 아니라 **「세션이 없는 W/O 의 중단은 어디에도 안 남는다(ⓒ와 같은 뿌리)」**로 좁혀야 계약 문자와 안 부딪힌다.
  ⓒ ✏ `held` 는 집계에 쓰인다 — description 실측 ⌜설비고장 상세처리가 `plannedEquipmentId` 와 함께 걸어 「이 설비의 W/O 중단 N건」을 **`page.total`** 로 받는다⌝. `SUSPENDED` 근사가 그 수를 바꾸므로 이 문장을 035 에 그대로 인용한다.
- **037 ✅ · ⓒ 만 「판정 통지」로 표시.** ⓐⓑ 는 산식이 어디에도 없어 문의가 맞고, ⓒ(도착 위치 못 풀면 요청 없이 배포 성공)는 §2 2단계로 이미 갈린 **판정**이다 — 같은 장에 실어 통지하되 물음표를 떼야 회신이 ⓐⓑ 로 모인다.
- **038 ✅.** I-8 의 문의와 겹칠 수 없다 — `src/logistics/material-issue-request/` 가 0건이고 I-8 이 아직 열리지 않았다. §8-6 ⓔ 인계와 짝이라 지금 올리는 것이 맞다.
- **039 ✅ 「계약 자인」이 아니다.** 이월은 계약이 ⌜정해지기 전까지 **이 오퍼레이션은 만들지 않는다**⌝ 로 **서버 행동까지** 지시했고(⇒ 물을 자리 아님), 게이트 셋은 ⌜✓확정 2026-07-14 … ⚠ 서버가 단말 버퍼를 볼 수단이 계약에 없다 — **게이트를 무엇으로 판정하는지가 열려 있다**⌝ 로 **물음만 남기고 지시가 없다**(`:close` x-internal-note 실측). 두 자리는 다르다.
- §9-1 17자리의 §2 절차 적용은 #3(위 036) 하나만 어긋났고 나머지 16 은 맞다. 「기존으로 미룬 것」 여섯 중 새 번호가 필요한 것 **0**. §9-3 17건 중 문의로 올릴 것 **0** — 다만 **두 건을 더 넣어야 한다**(§8·§9 참조).

## 2. 마이그레이션 1 — **✅**

- `close_disposition_code` = `remainderDispositionCode` 칸 판정 ✅. api 근거 둘: ⓐ 계약 x-internal-note 가 그 이름을 스스로 적었다(⌜잔량 처분 컬럼(`remainder_disposition_code`)은 물리 모델에 없다 — §I-25 가 그 자리다⌝) ⓑ 응답 `WorkOrder` 프로퍼티 **39개 전수**에 `remainderDispositionCode` 가 **0건**(jq) — 되싣는 쪽이 없어 새 칸이 필요 없다.
- COALESCE **4칸** ✅. `ck_work_order_resource_target(num_nonnulls(...)=1)` 이 정확히 하나만 non-null 임을 보장하므로 4칸 접기는 계약이 이름 적은 `(work_order_id, resource_type_code, resource_id)` 와 **동치**다. `shift_id` 를 빼면 모든 `SHIFT` 행이 `(0,0,0)` 이 되어 서로 충돌하므로 넣는 것이 맞다. `COALESCE(...,0)` 의 0 은 identity 시퀀스가 1부터라 실재 id 와 안 겹친다.
- 파일명 `20260906500000_…` ✅ — 같은 날 슬롯 규약(`…100000`~`…400000`) 그대로다. `schema.prisma` 미변경 + `--from-schema-datasource` 는 I-1 `uq_approval_route_active` 선례와 **글자 그대로 같은 자리**라 게이트 원인불명과 얽히지 않는다. 사전 대조 SQL 주석 ✅.
- §11 정정 18항 중 api 행 실측: #1(S14 「예상 PR 수 4」) ✅ · #2(S14 「마이그레이션 없음」) ✅ · #4(§5.1-C 괄호 `(·IN_PROGRESS)`) ✅ · #5b(개발품 전건 적재) ✅ · #13(If-Match 필수 **4**) ✅. **#12 만 틀렸다** → §8.

## 3. 상태기계 두 축 — **✏**(`-wo` 접미 기각 · 누락 하나)

- `from`/`to` 다섯 전건 ✅. `:close` 의 `from` 에 `IN_PROGRESS` ✅ — jq 전수로 `COMPLETED` 로 옮기는 오퍼레이션이 **0건**이라 빼면 마감이 영영 불가하다. `:hold` 의 `from` 에 `RELEASED` 유지 ✅(계약 문장을 좁히지 않는다) · `:resume`→`IN_PROGRESS` 고정 ✅ · `conflictStatus` 400 ✅ · `transitionCode` 미사용 ✅(이력 표 없음).
- ⛔ **`-wo` 접미를 버린다.** 실측 셋이 반대 방향을 가리킨다 — ⓐ `document-state.types.ts:26` `export type ActionName = string` 이고 레지스트리가 `Record<StateColumn, Record<ActionName, …>>` 라 **칸이 먼저**다 ⓑ 같은 파일 `Transition.sourceOperation` 의 규약 주석이 ⌜액션 이름을 계약의 `:cancel` 같은 동사로만 두지 않는 이유 … **전이를 일으키는 자원과 상태 칸을 가진 자원이 다르다** … 이름은 설명적으로 두고 **계약과의 연결은 이 칸이 진다**⌝ 로 「이름 = 사건, 축 = 칸+`sourceOperation`」을 못박았다 ⓒ 두 축의 `sourceOperation` 문자열이 **글자 그대로 같다**(`POST /production/work-orders/{workOrderId}:close`) — 같은 사건이라는 증거다 ⓓ `plan-api.md` §5.1-C 가 W/O 축을 **접미 없이** 적었다(`:807-811`). ⇒ 접미를 붙이면 규약을 깨고 계획서 정정을 하나 더 만든다. 읽는 사람의 혼동은 호출부가 이미 칸 리터럴을 넘기고 `assertTransition` 오류 문구가 `${column} / ${action}` 를 찍는 것으로 닫힌다(`document-state.service.ts:44`).
- ⛔ **PR 이 CI 에서 깨진다 — 파일 하나가 빠졌다.** `document-state.spec.ts:144-157` 이 축 목록 **8개**와 `expect(service.registered()).toHaveLength(16)` 을 «수»로 못박는다. §3-1 의 「등록된 축은 여섯」은 논리 축이고 실제 `StateColumn` 키는 **여덟**이다(물류 셋이 각각 별개 키). 새 키 + 5 액션이면 **축 9 · 전이 21** 이 된다 — 그 spec 정정을 PR 파일 목록에 넣는다.
- `moveWithin()` 시그니처 ✅ · 「`from` 밖은 건너뜀」 ✅ — 계약이 두 집합을 서로 다르게 못박았고(⌜마감은 실적이 없는 슬롯만 … 취소는 선발행 슬롯 전건이다⌝) 집합을 고르는 쪽이 호출자라는 것이 그 문장에서 바로 나온다. 던질 자리가 아니다. 생성 직후 이력 미기록 ✅(`LOT_LIFECYCLE_TRANSITION` 3값에 「생성」 없음 · F-6).

## 4. `:release` 코어 — **✅**(계약 문장 하나 보강)

- `preIssueWithin()` 자매 함수 ✅ — `createWithin` 은 `lot_hold` 를 강제하고(`:78-86`) `lifecycle_status_code`·`work_order_lot_seq`·`bom_id` 를 받는 자리가 없다. 옵션 확장이면 「입하 등록에는 언제나 거는 보류」를 옵션으로 푸는 것이라 기존 사용처의 불변식이 약해진다. 사용처 둘(I-7·I-10) ✅.
- If-Match 필수 + **`POST` 201 ETag 재사용** ✅ — 계약이 201 헤더 description 에 직접 적었다(jq): ⌜⭐ 발행 직후 `:release` 를 부르는 화면(W-02-07)이 이 토큰을 그대로 쓴다 — 토큰을 받으려고 상세를 다시 조회하지 않는다⌝. `:release` description 도 같은 문장을 갖는다. e2e ⌜201 ETag 가 `:release` 에 그대로 통한다⌝ ✅.
- 채번 N+1 을 tx 밖 ✅(`numbering.service.ts:47-58` · I-2 R-2) · `plant_id` 라인→WIP 순서 ✅(`goods-issue-rules.ts:78` 선례) · `INSPECTION_PENDING` + `lot_hold` 미적용 ✅ · `bom_id` 짝 ✅ · 경계 5 ✅ · `handoverNote` 버림 ✅.
- ✏ **§4-2 에 계약 문장 한 줄이 빠졌다.** `:release` description 실측: ⌜⭐ 두 화면의 `lotSize` 출처가 다르다 — W-02-04 는 사용자 입력이고, **W-02-07 은 지시수량 전량을 한 슬롯으로 보낸다**(§5-7). 어느 쪽이든 화면이 «명시적으로» 싣는다 — **비우면 서버가 채우는 기본값을 두지 않는다**(omf-mes#206 정정)⌝. ⇒ 경계 목록에 ⌜`lotSize` 를 생략하면 400 이고 **서버 기본값을 두지 않는다**⌝ 한 줄. `WorkOrderRelease.required=["lotSize"]` 라 가드가 낸다(jq).
- 출고요청 **직접 INSERT** ✅ — `plan-integration.md` §9 #8(⌜shipment 가 `goods_issue` 행을 자기가 만든다 · 공유하는 것은 타입뿐⌝)과 같은 자리다. 인계 규약 6(ⓐ~ⓕ)이 I-8 이 승계하기에 충분하다. `routing_operation_id` 일치 라인만 · 0건이면 헤더 없음 ✅.

## 5. `:close` 코어 — **✅**(계획서 정정 대상만 ✏)

- 순서(`OPEN_SESSION_EXISTS` 가 전이보다 먼저) ✅ — 계약이 그 자리에 **봉투를 지정**했고(`:close` 409 = `ProductionConflictResponse` · `code` enum 에 `OPEN_SESSION_EXISTS` 실재 · jq) 전이 400 이 먼저 나면 계약이 못박은 409 가 영영 안 나온다.
- `ended_at IS NULL`(`STOPPED` 포함) ✅ — `:hold` 가 ⌜중단해도 세션은 열려 있다(**ended_at 이 빈 채**)⌝ 로 「열림」을 그 칸으로 정의했다. 3분류 입력 = `SUM(good_qty)` · 상태 필터 없음 · 슬롯 합 불사용 ✅(계약이 판정 입력으로 센 것은 둘뿐).
- 허용 오차 **0** ✅ — `operation_policy` 14값에 미달 경계 키가 없고 계약이 ⌜**미달의 경계만** 움직인다⌝ 라 적었으니 `OVERPRODUCTION_ALLOWANCE_PCT` 는 축이 다르다. 없는 키를 지어 읽는 쪽이 「조용한 도출」이다 — 기준 4 와 충돌 없다.
- 4규칙 → 에러 상수 3 ✅. 계약이 두 칸을 **조건부 필수**로 적었고(⌜미달 판정일 때만 보낸다(조건부 필수)⌝ · ⌜미달·초과일 때 조건부 필수⌝) `required` 를 비운 이유까지 스스로 적었다 ⇒ 서버 대조가 정본. 규칙 3 에 기존 `REQUIRED` 를 쓰는 것 ✅.
- 한 번의 UPDATE ✅ · L2 집합이 `withResultCount` 와 같은 `EXISTS` ✅ · `enqueue()`·`message_key`·버전 없음·`alreadyQueued` ✅ · payload 무해석 ✅ · 승인 게이트 없음 ✅(`approval` 문자열 0건 · `plan-integration.md` §2 승인 9자리에 W/O 없음) · 게이트 셋 미구현 ✅(039).
- ✏ **§11 #12 의 「고칠 것」이 성립하지 않는다** — `plan-api.md` §5.4 는 **이미 셋을 다 갖는다**: 첫 표 `:1043` 「`OPEN_SESSION_EXISTS` | **409** | 같은 W/O 에 열린 작업 세션이 있는데 `:close` | S14」 · 둘째 표 `:1067` 「`REMAINDER_DISPOSITION_REQUIRED` / `_NOT_ALLOWED` | 400 | W/O `:close` 3분류 대조 4규칙 | S14」. ⇒ 계획서 정정 **0**, 할 일은 `error-codes.ts` 에 상수 3 신설뿐이다. #12 행 문구를 그렇게 바꾼다.

## 6. `:cancel` · `:hold` · `:resume` — **✅**(035 보강은 §1)

- `document_cancellation` 안 씀 ✅ — I-5 가 `CD-CANCELABLE-DOCUMENT-TYPE` **3값**으로 닫은 축이고 W/O 는 그 목록 밖이다. 사유 칸이 W/O 자신에게 있어 축이 다르다는 설명도 정확하다. `note` 버림 ✅ · L3 전건 ✅ · 기발행 출고요청 방치 ✅(기준 1).
- **`:hold` 셋 저장 안 함 + 코드값 대조 안 걺 = 「계약 문자 그대로」가 맞다** ✅. `WorkOrderHold.required=["reasonCode","occurredAt"]`(jq)는 **본문 형식** 요구이고, 값 목록은 계약이 ⌜값 목록은 `GET /mdm/code-values?codeGroupCode=…` 로 받는다⌝ 로 코드값 표에 넘겼다. 그 표가 0행인데 대조를 걸면 **계약이 required 로 요구한 오퍼레이션 전건이 400** 이 된다 — 계약을 지키는 쪽이 대조를 안 거는 쪽이다. 비어 있지 않은 문자열 + `assertInstant` ✅.
- `held=` 근사 ✅(다른 길이 없다) · 세션 불변 e2e ✅(계약이 두 번 못박았다).

## 7. 생성·수정·4M·조회 — **✏**(자기모순 1 · 계약 수치 3)

- 내부 P/O+계획 생성 ✅ · 기본 BOM 정확히 1 아니면 400 ✅ · `PUT` 자물쇠 `released_at IS NULL` ✅(계약이 상태값을 안 셌고 목록 질의 넷이 시각 축을 반복해 썼다) · `resource-plans` 409 봉투 `ErrorResponse` ✅(jq — 이 자리만 다르다) · `validation` 규칙 6 ✅ · 목록 23 where ✅ · `withSummary` required **둘** ✅(jq).
- ⛔ **§7-1 안이 자기모순이다.** ⌜긴급 경로도 이 슬라이스가 `plan_no` 를 짓지 않는다⌝ 라 적고 두 줄 아래에서 접두어를 `DEFAULT_PREFIX` 에 더해 **짓는다**. 앞 문장을 지우고 「I-24 가 규칙을 등재할 때 승계한다」만 남긴다(§8-6 ⓒ 와 같은 말). `plan-api.md:1102` 이 `plan_no` 를 **S13** 행으로 두었으므로 인계 문장이 있어야 축이 안 갈린다.
- ✏ **`DEFAULT_PREFIX` 수가 두 곳에서 다르다** — §2-7 표는 2줄(`WO`·`MIR`)인데 §10 PR ④ 와 §10-2 는 **4줄**이다. 표에 `PRODUCTION_PLAN`·`PRODUCTION_ORDER` 두 행을 더한다.
- ✏ **계약 수치 셋이 틀렸다**(jq 전수): `WorkOrderCreate` 는 프로퍼티 11 · required 4 ⇒ 선택 **7**(§1-3 「선택 8」) · `WorkOrderUpdate` 는 **13칸**(§1-3 「12칸」) · 명시적 null 해제 칸은 `type:[…,"null"]` 실측 **8칸**(§1-3 「일곱 칸」 — 괄호 안 나열은 8개로 맞다). §7-2 의 「생략=유지만」 5칸(`orderQty`·`priorityNo`·기본위치 3)과 합쳐 13 이 된다.

## 8. 횡단 · PR 분할 — **✏**(중요 4)

- ⛔ **§8-1·§9-3 ⓖ 의 403 문장이 사실과 다르다.** `DERIVED_PERMISSIONS` 실측 — `'GET /production/work-orders'`(**`:113`**)와 `'GET /production/work-orders/{workOrderId}'`(**`:114`**)가 **이미 등재돼 있다.** 「등록하지 않는다」가 아니라 **이미 등록돼 있다**. 결론(403 추가 0 · 두 GET 이 403 을 안 냄)은 그대로 선다 — `permission.guard.ts:41` 이 ⌜계약이 403 을 선언한 자리에서만 본다⌝ 로 먼저 걸러 계약 미선언 키는 아예 보지 않기 때문이다. **문장을 「이미 등재돼 있으나 가드가 계약 미선언이라 보지 않는다(`permission.guard.ts:41`)」로 고치고 「알려둘 것」에 한 줄 올린다** — 나중에 계약이 그 GET 에 403 을 더하면 코드 변경 없이 게이트가 켜지는 자리다. `resource-plans` 3건은 실제로 0건(grep) · `manual-permissions.ts` W/O 0건 ✅. 표의 줄 번호 8개(`:115`·`:237`~`:242`·`:279`) 전건 일치 ✅.
- `runVersioned` 불사용 ✅ — `master-write.ts` 실측(`:39-56`): `ifMatchVersion` 이 `undefined` 면 `throw new Error`(`:49-51`) · `HttpStatus.OK` 고정 · `setEtag` 고정. 선택 둘이 `undefined` 로 정상인 이 슬라이스에서는 500 경로다. ⚠ **경로 오기** — `src/common/http/master-write.ts` 가 아니라 **`src/common/master/master-write.ts`** 다(브리프도 같은 오기 · I-5 R-api-7 이 `derived-permissions` 에서 같은 종류를 잡았다). 인용 `:48-54` → **`:39-56`**.
- ⚠ **`error-codes.ts` 줄 번호 셋이 틀렸다**(§1-6 표): `INVALID` `:11`→**`:13`** · `UNIQUE_VIOLATION` `:13`→**`:15`** · `PERMISSION_DENIED` `:14`→**`:16`**. `REQUIRED` `:9` · `STATE_LOCKED` `:17` 은 맞다.
- **409 셋 ✅ · 봉투 수 ✏.** `ProductionConflictResponse` 를 쓰는 409 는 **일곱**이다(POST·PUT·`:release`·`:hold`·`:resume`·`:close`·`:cancel` — jq). §7-3·§9-3 ⓕ 의 「나머지 여섯」을 **일곱**으로. `INVALID_STATE` 미사용 ✅(enum 다섯 중 설명이 붙은 것은 둘뿐). `x-internal-note` 오퍼레이션도 **여섯**이다(§1-1 의 「넷」은 오기 · 괄호 안이 맞다).
- **404 미선언 ✅** — jq 전수로 404 를 안 적은 것은 셋(목록 GET · `GET resource-plans` · `POST resource-plans`)이고 그중 W/O 부재로 404 를 낼 자리는 **둘**이다. §8-4 의 괄호가 그렇게 읽히나 문장을 「셋 중 둘」로 못박는 편이 낫다.
- ⛔ **PR ④ 가 예산을 넘길 자세다 — 둘로 가른다.** ④ 파일 목록 합이 **30+120+80+4+60+50 = 344** 로 스스로 적은 `~320` 과 다르고, 여기에 §3 의 `document-state.spec.ts` 정정과 null/undefined 매퍼가 아직 안 들어 있다(README §6 ② 350 이 코앞이다). ⇒ **④a** `POST`/`PUT` + 내부 P/O·계획 + `DEFAULT_PREFIX` 4(~250 · opus) / **④b** `transitions.ts` 새 키 + `:hold`/`:resume` + spec 정정(~110 · opus). ⇒ **PR 8**. 부수 이득이 크다 — ⑤b·⑥ 이 기다리는 것이 얇은 ④b 하나가 되어 스택이 짧아진다. ②③ 를 ① 위에 **병렬로** 올리는 것은 가능하다(②는 `work-order-query.service.ts` 를 늘리고 ③은 새 파일 둘 + 컨트롤러라 겹치는 면이 컨트롤러 한 곳뿐).
- 단위 테스트가 e2e 로 못 가는 가드를 덮는가: 경계 5(⑤a) ✅ · 한 번의 UPDATE(⑥) ✅ · L2/L3 집합(⑥) ✅ · `alreadyQueued`(⑥) ✅ · **`ended_at` 정의 ⛔ 안 덮인다** — ⑥ 에 e2e ⌜열린 세션이 있으면 409⌝ 하나뿐이라 「`STOPPED` 도 열림」이 어디서도 안 못박힌다. ⑥ 단위에 ⌜마감 — `STOPPED` 세션도 `ended_at` 이 비면 «열린» 것이다⌝ 한 줄을 더한다. §10-1 픽스처·cleanup 순서·M1 을 ⑥ 이 지는 것: api 관점 이견 없다 ✅.

## 9. 자기 관점 계획서와의 어긋남 — **✅ + 「알려둘 것」 2건 추가**

- S14(`:360-385`) 실측: 「마이그레이션 없음」·「예상 PR 수 4」·If-Match 표(필수 `PUT`·`:cancel`·`:close`·`:release` **넷** / 선택 `:hold`·`:resume`) · ETag 둘 · 403 여덟 — **전건 I-6 실측과 일치**하고 정정 방향(①②⑬)이 옳다.
- §5.1-C(`:800-822`) 괄호 `(·IN_PROGRESS)` 실재 ✅ — 괄호를 떼는 판정 옳다. 다만 그 표가 W/O 축 액션을 **접미 없이** 적었으므로 §3 의 `-wo` 기각과 묶으면 이 자리 정정은 **한 줄**로 끝난다.
- §5.4 → §5 · `:1103` 채번 표(「작업지시 `work_order_no` ❌ · S14」) ✅.
- **「알려둘 것」 +2** — ⓢ 다섯 액션과 `PUT` 의 **200 본문이 `WorkOrder` 이고 `versionNo` 를 싣는다**(jq 전수) ⇒ ETag 헤더 미선언이 화면 왕복을 만들지 않는다. ⓐ 의 「상세 GET 을 다시 부른다」는 과한 표현이라 이 한 줄을 붙인다. ⓣ 목록·상세 GET 이 **이미 `DERIVED_PERMISSIONS` 에 있다**(§8).

---

**재수립 결과** — I-6.md 에 반영할 수정 **14건**: ① 036 을 문의에서 내리고 `LOT_SOURCE_TYPE` 시드 1행 삭제(상수만) ② 035 에 `omf-mes#261` 인용 + ⓑ 물음 좁힘 + `held` 집계 문장 ③ `-wo` 접미 제거(두 축 같은 이름) ④ `document-state.spec.ts` 축 8→9·전이 16→21 정정을 PR 목록에 추가(§3-1 「축 여섯」→「`StateColumn` 키 여덟」) ⑤ §7-1 자기모순 문장 삭제 ⑥ §2-7 `DEFAULT_PREFIX` 표 2행→4행 ⑦ 계약 수치 3 정정(선택 7 · 13칸 · null 8칸) ⑧ §8-1·§9-3 ⓖ 403 문장 정정 ⑨ 경로·줄 오기 4(`common/master/master-write.ts` · `error-codes` 3줄) ⑩ 409 봉투 「여섯」→「일곱」·x-internal-note 「넷」→「여섯」 ⑪ §11 #12 를 「계획서 정정 0 · `error-codes.ts` 상수 3」으로 ⑫ §4-2 에 `lotSize` 계약 문장(서버 기본값 없음 · W-02-07 전량 1슬롯) ⑬ PR ④ → ④a/④b ⑭ ⑥ 단위에 `STOPPED` 한 줄 · 「알려둘 것」 +2.
**plan.md 에 반영할 것** — §4 M-d 를 「`work_order_resource_assignment` **식** 유일 인덱스 1(COALESCE 4칸)」로 줄이고 `remainder_disposition_code` 줄 삭제 · §3 104행에 `LotLifecycleService.moveWithin()` 신설 · §7 문의 후보표에 I-6 **4행** · §5 규칙 1 에 각주(「계약 미선언인데 `DERIVED_PERMISSIONS` 에 이미 있는 자리는 가드가 보지 않는다 — `permission.guard.ts:41`」) · §8 진행표에 I-5·I-6 행.
**문의 최종 건수** — 신규 **4**(035 · 037 · 038 · 039) + 기존 인용 4(허용 오차 `W-02-05` §8-1 · `#145` · `#66` · 이월 계약 자인) + 문의 **14** 채번 표에 4행(`work_order_no`·`issue_request_no`·`plan_no`·`production_order_no`). 036 은 「알려둘 것」(라벨 등재 요청)으로 내린다.
**PR 분할 최종안** — **8**(① 마이그+골격+상세 ~250 sonnet → ② 목록 ~300 sonnet → ③ `validation`+`resource-plans` 쓰기 ~240 opus → **④a `POST`/`PUT`+내부 P/O·계획+채번 ~250** → **④b 전이 키+`:hold`/`:resume`+spec 정정 ~110** → ⑤a 코어 ~185(≤200) → ⑤b `:release`+출고요청 ~210 → ⑥ `:close`/`:cancel`+아웃박스+M1 ~330). 전건 ≤350 · 코어 ≤200 · 합 ~1,875. ②③ 은 ① 위 병렬 스택 가능.
