# I-24 개별 계획안 재검토 — **integration 관점**

> 대상 `docs/coverage-100/slices/I-24.md`(777줄) · 자기 관점 `plan-integration.md`(188 · 407~411 · 516 · 548~554 · 667 · 945~956).
> 실측: worktree `.claude/worktrees/i24-plan` · main **04e3bca** · 계약 `a6a87e1` · DB `omf_mes` SELECT 만.
> 실측 확인: `planning.production_order`·`production_plan`·`production.work_order`·`integration.integration_message`·`interface_definition` **전부 0행**, P/O 3표를 «쓰는» 코드 `src/` 에 **0건**(grep) — §2-2 ⓑ 그대로.

## 판정 15

| # | 자리 | 판정 |
|:-:|---|:-:|
| 1 | A11 두 칸 | ✅ |
| 2 | 도메인 경계(planning → `production.work_order` 직접 INSERT) | ✅ / 공유 방식 ✏ |
| 3 | `work_order_dependency` = 마스터 복제 | ✅ |
| 4 | W/O 칸 채움 · **M2 마디 실측** | ✏ |
| 5 | 채번 | ✏(작다) |
| 6 | `:confirm` 순서 | ✅ / ✏(결번·순서보장) |
| 7 | 계획 CRUD | ⛔ `SUCCESSOR_EXISTS` |
| 8 | P/O 파생 칸 | ✅ |
| 9 | `:acknowledge` | ⛔ 둘 |
| 10 | `:resync` | ✅ / ✏(키 길이) |
| 11 | `transitions.ts` | ✅ |
| 12 | 권한·배치·횡단 | ✅ |
| 13 | 문의 6 | ✏(하나 누락) |
| 14 | e2e·PR | ✅ / ✏(직렬 4단) |
| 15 | 자기 관점 대조 | ✏ 셋 |

---

### 1 ✅ A11 두 칸
계약 `ProductionPlanSplitRef.reasonCode` 에 **`x-code-key: CD-PRODUCTION-PLAN-SPLIT-REASON`** 과 「값 5종 제안·시드는 omf-mes#198(**CLOSED**)」이 붙어 있다(python 실측) — 「계약이 이름만 준 사유 칸」이 I-7 D2 와 **같은 모양**임이 계약 문자로 확인된다. DB `mdm.code_group='PRODUCTION_PLAN_SPLIT_REASON'` **5값** 실재. `app.code_t` = `character varying(50)`(pg 실측)이라 Prisma `@db.VarChar(50)` 매핑이 맞다(선례 `production_order_change_field.field_code`). `production_plan` 은 오늘 `@@index` 가 **0개**라 `ix_production_plan_split_of` 는 새로 서지만 §4-3 자식 손검사가 그 축으로 도니 값을 한다. FK 이름 미기재 = Prisma 기본형 ✅.

### 2 ✅ 경계 / ✏ 공유 방식
**도메인 간 직접 INSERT 는 이미 선례가 있다** — `work-order-release.service.ts:105-124`(생산 도메인)가 `logistics.material_issue_request(_line)` 를 물류 service 없이 `tx` 로 직접 만든다(`schema.prisma` 실측 — 그 표는 `@@schema("logistics")`). `server-architecture.md:67` 이 금한 것은 **service 호출**이고 prisma 직접 쓰기가 아니다. ⇒ §3-2 ✅.
✏ 그런데 상수 공유는 계획안이 선례보다 **비싸게** 잡았다. 같은 자리의 실측 선례 `material-issue.ts:15-20` 은 「도메인 간 import 를 안 만들려 **값만 복사**해 둔다」로 끝내고 원본 파일을 안 건드린다. 그리고 계획안이 인용한 드리프트 방어 `balance-write-guard.spec.ts:1-30` 은 **`readFileSync`+정규식**이라 import 가 0이다. ⇒ `work-order-write.service.ts:45-47` 에 `export` **+2줄을 넣지 않고**(I-6 파일 무변경) 같은 텍스트 스캔 spec 으로 `INITIAL_STATUS='PLANNED'`·`DEFAULT_TYPE='NORMAL'` 을 대조한다. §10 PR ③ 파일 목록에서 `work-order-write.service.ts` 를 뺀다.

### 3 ✅ 의존 복제
0건 안전 확인 — `work-order-list-where.ts:66-72` 의 `successorOfWorkOrderId` 가 `some:` 이라 의존 0행 W/O 는 그 필터에 안 잡힐 뿐 깨지지 않는다. `uq_work_order_dependency` + `ck_work_order_dependency_self`(baseline `migration.sql:847`) 실재 — 마스터 uq 가 앞서 보장하므로 손검사 생략 ✅. `mes_managed` 는 **DB 컬럼 주석 0 · 계약 description 0 · `src/` 사용처가 Routing CRUD 뿐**(grep 실측)이라 I-6 `:release`·I-11 세션과 부딪히는 자리가 없다 ⇒ 「거르지 않는다」 ✅.

### 4 ✏ W/O 칸 채움 — M2 마디 실측
**전개 W/O 는 `:release` 를 지난다(측정됨).** `transitions.ts:151` `work-order-release.from` 에 `PLANNED` 가 있고, `release-plan.ts:11-26` 이 읽는 것은 `production_plan.bom_id`·`bom`·`production_order.plant_id` 뿐이며 `planned_start/end_at` 을 보지 않는다. 결정적 실측: `test/production-work-order.e2e-spec.ts:699-711` 이 **`default_wip_location_id: null` · `production_line_id: null`** W/O 를 `:release` 해 **200** 을 받는다.
⛔ **그런데 그 다음 마디가 끊긴다.** `release-plan.ts:101` 은 `default_wip_location_id === null` 이면 BOM 라인을 `[]` 로 돌려 **`material_issue_request` 를 만들지 않는다**(같은 e2e 가 `expect(requests).toEqual([])` 로 못 박았다). `plan.md` §2 **83행** M2 는 「`:release`(**출고요청 자동**) → 피킹 → 출고」다. ⇒ §8-6 의 마디는 **`:confirm` → `PUT /production/work-orders/{id}`(`defaultWipLocationId`·`productionLineId` — `work-order-write.service.ts:34,37` 에 칸 실재 · `released_at IS NULL` 이라 배포 전 허용) → `:release`** 세 걸음이어야 한다. 지금 문장대로 두면 M2 체인이 피킹 앞에서 빈다.
✏ 곁가지: `production_line_id NULL` 이라 `work-order-list-where.ts:80` 의 `productionLineId` 필터로는 전개분이 **한 건도 안 잡힌다** — 「알려둘 것」에 한 줄(063+3 의 실제 비용).

### 5 ✏ 채번
`PP` 추가 필요는 확정 — `numbering.service.ts:117` 의 `prefixOf()` 가 미등재 유형에서 던진다. 기간 키 `planDate` 는 같은 파일 66~69행 주석(「서버가 「오늘」로 다시 잡지 않는다」)과 정합 ✅. N건 선채번 + **전건 재채번** 재시도는 `goods-receipt.service.ts:99-121` 형태 그대로 ✅. `PRODUCTION_ORDER` 미추가는 I-6 R-6(040 보류)과 정합 ✅.
✏ `WORK_ORDER` 의 `plantId` — 형제 `work-order-write.service.ts:140` 은 **`null`** 을 준다. `app.numbering_rule` 실측 12행이 전부 `plant_id IS NULL` 이라 오늘은 같은 카운터지만, `numbering.service.ts:101-102` 가 「공장 지정본이 전역본을 이긴다」라 공장 규칙이 하나라도 등재되면 두 경로가 **카운터를 가르면서 같은 `WO-{YYYYMMDD}-{SEQ4}` 패턴**을 써 중복이 상시화된다(재시도가 같은 카운터를 다시 뽑아 `NUMBER_RETRY` 소진 → 409). ⇒ 형제와 같이 `null` 을 준다.

### 6 ✅ / ✏ `:confirm` 순서
`assertTransition(column, action, current, conflictStatus)` 4번째 인자 실재(`document-state.service.ts:27-37`), `planning.routing` 두 전이가 400 인 것도 그 주석이 직접 적었다 ✅. `LINE_REQUIRED` 실재 + 같은 뜻의 선례 `routing-revision.service.ts:38` ✅.
✏ ⓐ 선채번이 상태 검사(⑦)보다 앞이라 **확정된 계획에 `:confirm` 을 다시 쏠 때마다 W/O 번호 N개가 결번**으로 탄다 — 채번 «앞»에 `status_code` 선조회 한 줄(잠금 아님 · 최종 그물은 그대로 ⑦)이면 없앤다. ⓑ `createManyAndReturn` 의 입력 순서 보장은 **실측하지 못했다** — 지어내지 않고, 선채번한 `work_order_no` 가 유일키이므로 반환분을 번호로 되짝짓는 편이 안전하다(순서 가정 제거). 단위 spec ②가 이 짝짓기를 못 박는다.

### 7 ⛔ DELETE 의 `SUCCESSOR_EXISTS`
계약 실측 — `DELETE …/{productionPlanId}` 의 409 는 `ProductionConflictResponse` 이고 그 **`code` 는 required 이며 enum 5값**(`VERSION_CONFLICT`·`DUPLICATE_KEY`·`OPEN_SESSION_EXISTS`·`BATCH_DEPENDENCY_FAILED`·`INVALID_STATE`)이다. **`SUCCESSOR_EXISTS` 는 그 안에 없다.** 게다가 서버의 기존 사용처는 전부 **400**이다(`purchase-order.service.ts:383` · `document-cancel-execute.service.ts:93` `screenError`). ⇒ 자식 분할 계획이 있는 삭제도 **409 `INVALID_STATE`** 로 내고 `message` 로 가른다(§4-3 · e2e #20 문구도 함께 고친다). 「두 업무 사유가 한 코드로 접힌다」를 **063+2 에 한 줄**로 싣는다. 나머지(확정 뒤 409 `INVALID_STATE` · POST 400 `INVALID` · PUT 잠금→토큰→상태)는 ✅ — DELETE `responses` 에 400 이 없다는 실측이 갈래를 정당화한다.

### 8 ✅ P/O 파생 칸
upsert 키 실재 — `@@unique([production_order_id, acknowledgement_type_code, received_at], map: "uq_production_order_ack")`(schema:4530)이라 Prisma 복합 upsert 가 그대로 선다 ✅. `includeChildren` 의 「`items` > `size`」는 계약상 합법 — `app-공통.json` `PageMeta` 는 `page`·`size`·`total` 세 칸뿐이고 관계 제약이 없다 ✅. `unacknowledgedOnly`·`withLastChange`·`includeChildren` 인용문은 계약 원문과 **글자까지 일치**(python 실측) ✅. `notIn` 집합의 성장은 §11 ⑥ 후속으로 남긴 처리가 맞다.

### 9 ⛔ `:acknowledge` — 둘
ⓐ **마감 W/O 가 500 을 만든다.** `trg_work_order_closed_immutable`(baseline `migration.sql:2996-3011`)은 `closed_at IS NOT NULL` 인 행의 **모든 UPDATE** 를 `RAISE EXCEPTION` 한다. §5-5 ⑤ 가 영향 W/O 를 「취소·마감으로 좁히지 않는다」로 두고 ⑦ 이 `po_mismatch` 를 (PROCEED) 전건 / (APPLY) 미조정분에 세우므로, **마감 W/O 가 하나라도 있는 P/O 의 `:acknowledge` 는 전부 500** 이고 트랜잭션이 통째로 죽는다. `src/` 에 그 예외를 잡는 자리는 0건(grep). 선례가 답을 준다 — `material-issue-request.service.ts:155` 가 「취소·마감된 작업지시입니다」를 **400 `STATE_LOCKED`** 로 앞서 막는다. ⇒ `po_mismatch` 대상에서 `closed_at IS NOT NULL` 을 빼고, 조정 항목이 그런 W/O 를 가리키면 400 `STATE_LOCKED`(field `workOrderAdjustments[i].workOrderId`). e2e 한 건 추가.
ⓑ **`PROCEED` + `reason` 누락에 400 이 없다.** DB 컬럼 주석 실측 — `production_order_acknowledgement.reason` = 「판정 사유 자유문. **강행이면 필요하다 — 값에 따라 갈리는 규칙이라 CHECK 가 아니라 서버가 건다**」. 계약 `reason` description(「강행이면 사유가 필요하다」)과 같은 말이고, **주체를 서버로 지목한 쪽은 DB 주석**이다. §1-3 이 이를 화면 책임으로 넘긴 것은 실측과 어긋난다 ⇒ 400 다섯째(`REQUIRED` · field `reason`)를 §5-5 ④ 에 더하고 e2e #17 을 다섯 갈래로.
✅ **`PROCEED` 전건 `po_mismatch` 는 계획안이 옳다 — 근거가 더 세다.** `work_order.po_mismatch` 컬럼 주석이 「서버가 **두 자리**에서 세운다 — 관리자가 「기존 유지(강행)」를 고를 때, 그리고 「변경 반영」을 골랐는데 그 작업지시를 조정하지 않았을 때」로 **직접 확정**한다(W-02-06 R09 보다 강한 실측). `version_no` 불변 · `CANCELLED` 허용 · `conflictCause` 두 값도 ✅.

### 10 ✅ / ✏ `:resync`
아웃박스 규약 충돌 **없다** — `outbox.service.ts:34-38` 의 「버전을 안 붙인다」는 **「한 W/O 는 평생 한 번 마감」을 이유로 든** 규약이라 되풀이 요청에 그대로 옮길 수 없다. 갈래를 만드는 판단이 맞다(§11 ③ 의 주석 인계도 맞다). 키가 늘 존재함도 확인 — `idempotency.guard.ts:37-54` 가 계약이 선언한 자리에서 **UUID 형식까지** 강제한다.
✏ **길이 상한을 넘을 수 있다.** `integration_message.message_key` 는 `@db.VarChar(150)`, `production_order.production_order_no` 는 `@db.VarChar(100)`(schema:391·2472). 최악 = 21+1+100+1+36 = **159 > 150**. ⇒ 문서번호 대신 `productionOrderId` 를 쓰거나(`IF-PO-RESYNC-REQUEST:{id}:{key}` ≤ 80) 상한을 명시한다. `targetTypeCode='PRODUCTION_ORDER'`(그룹 5값 밖 · I-6 `WORK_ORDER` 동일 선례) · 202 무본문 · payload ✅.

### 11 ✅ `transitions.ts`
`document-state.spec.ts:247-271` 실측 — 축 목록 **11** · `toHaveLength(27)`. ⇒ 12 · **28** 로 고친다(계획안의 「+1」을 숫자로 못 박는다). 같은 파일 235~245행이 `sourceOperation` 의 계약 실재를 검사하는데 `POST …:confirm` 은 계약에 있다 ✅. P/O 키 부재가 방어라는 주장도 맞다 — `document-state.service.ts:43-46` 이 미등록 (칸,액션)을 `Error` 로 던진다.

### 12 ✅ 권한·배치·횡단
`derived-permissions.ts` 실측 — 15(DELETE) · 225(`:acknowledge`) · 226(POST) · 227(`:confirm`) **4건**, 미등록은 `PUT` 과 `:resync` **둘** ✅. `permission.guard.ts:47-53` 이 미등록에서 `throw new Error`(=500)를 낸다 ✅. `:resync` 권한을 `W-06-10` 으로 잡은 것은 계약 x-internal-note 원문(「소관 = W-06-10 … 공유계약 B-4-1 ④ · 중복 구현 금지」)과 **일치** ✅. ⚠ 사소 — §7-5 의 「GET 4건은 등록하지 않는다」는 P/O GET 둘이 `derived-permissions.ts:107-108` 에 **이미 있다**(무해 · 문장만 고친다).

### 13 ✏ 문의 6
063+1 은 **«멈춤 조건» 아니다** — README §3 셋째는 「어느 쪽도 맞출 수 없을 때」인데, `DELETE.responses` 에 400 이 없어 **한쪽으로 맞출 수 있다**(판정 가능한 가장자리) ✅. 063+4 가 셋을 묶은 것은 뿌리가 하나(수신기 부재)라 맞다 ✅. 063+5 는 문의 14 와 겹치므로 계획안대로 **14 의 추가 행**으로 싣는 편이 맞다 ✅. 063+6 은 ⓐ 를 **빼는 게 낫다** — 계약 x-internal-note 가 「omf-mes-client#66 종결 코멘트·#436 으로 클라이언트는 이미 이 mutation 을 제거했다」로 스스로 답했다. 남길 것은 ⓒ 키 규약 · ⓓ 회신 경로다.
✏ **누락 하나** — 계약 `:confirm` description 이 「유형: 기본 양산(**개발품 판정 축은 품목 — omf-mes#215 진행 중**)」이라 적었는데 I-24.md 전문에 **`215` 가 0회**(grep)다. `work_order_type_code='NORMAL'` 고정은 그 진행 중 이슈의 답에 따라 뒤집힌다 ⇒ §9-2 「기존으로 미루는 것」에 **#215** 를 더한다(새 문의 아님).

### 14 ✅ / ✏ e2e·PR
e2e 44 는 과하지 않다 — I-6 스위트가 `test/production-work-order.e2e-spec.ts` 한 파일에 **47건**(grep)이고 오퍼레이션은 비슷하다. PR 4 도 타당 — README §6 이 비테스트 예산 **350**(한도 400)이라 ③+④ 를 한 칸에 못 넣는다. ② 에 마이그가 들어도 sonnet 은 README §1-5(「병합 전 한 줄 보고만」)로 이미 열려 있다 ✅.
✏ **직렬 4단은 과하다.** 파일 실측상 겹침은 ①③(`production-plan.controller.ts`) · ①④(`production-order.controller.ts`) 뿐이고, **②③(계획 축) ∥ ④(P/O 축)** 는 `planning.module.ts` 한 줄(`OutboxModule`)만 스친다. §11 ⑦ 이 M2 마디를 이미 통합자 몫으로 넘겼으므로 ④ 에서 그것을 빼면 ④ 는 ① 위에서 독립이다 ⇒ **①  →  {②→③} ∥ ④** (3단). 회귀는 `production-work-order`·`planning-routing-operation`·`integration-message` 셋이 맞다 — `test/integration-message.e2e-spec.ts:309` 가 범위 한정 `deleteMany` 만 쓰고 TRUNCATE 가 없어 `:resync` 행과 충돌하지 않는다(실측).

### 15 ✏ 자기 관점 대조
ⓐ **`plan-integration.md:188` 이 틀렸다** — I-24 행의 **마이그 `✕`** 는 `⭕`(A11)여야 한다(`plan.md` §4 125행이 A11 을 이미 들고 있다). 반대로 **상태기계 `⭕` 는 맞았다** — §10-1 #4 의 「코어 —」는 `plan.md` §1 47행 쪽 오류이고 integration 계획서는 처음부터 `transitions.ts` 를 예고했다. 그 문장을 대조표에 그대로 반영한다.
ⓑ **§8-6 이 `plan-integration.md` §5-3 을 오인했다** — 548~554행의 「끝점 셋」은 ①`inventory_balance` ②lot 계보 ③취소 원복이지 「`:confirm` 200 · N행 · `:release` 통과」가 아니다. I-24 가 M2 에 주는 것은 끝점이 아니라 **시작점 교체**다(오늘 `production-work-order.e2e-spec.ts:1370-1381` 이 prisma 로 심는 W/O → 실제 `:confirm`). 문장을 그렇게 고친다.
ⓒ 항목 4 의 `default_wip_location_id NULL` 때문에 `plan.md` §2 83행의 「출고요청 자동」이 전개분만으로는 성립하지 않는다 — §8-6 에 `PUT` 마디를 넣거나 83행에 단서를 단다(택일 · 앞쪽 권장).

---

재수립 결과 — **I-24.md 에 반영할 수정 8건**: ①§4-3·e2e#20 의 409 `SUCCESSOR_EXISTS`→`INVALID_STATE`(계약 enum 밖) ②§5-5 영향 W/O 에서 `closed_at IS NOT NULL` 제외(마감 트리거 500) ③§5-5 ④ 에 400 `REQUIRED`(PROCEED+`reason` 없음) 추가 ④§8-6 에 `PUT`(기본 WIP 위치) 마디 추가 + §5-3 오인 문장 교정 ⑤§3-5 `WORK_ORDER` 채번 `plantId`→`null` ⑥§3-2 의 `work-order-write.service.ts` `export` +2 를 텍스트 스캔 spec 으로 대체 ⑦§5-6 `messageKey` 를 `productionOrderId` 기반으로(150자 상한) ⑧§6 전이 수 27→28 명시 · §9-2 에 #215 추가.
**plan.md 에 반영할 것**: §4 125행 A11 = 「`split_of_plan_id?` · `split_reason_code?` · `ck_production_plan_split_self` · `ix_production_plan_split_of`」 · §1 47행 코어 「—」→`transitions.ts` · PR 3→4 · §2 83행 M2 에 「`:confirm`→`PUT`(기본 위치)→`:release`」 단서. 더해 **`plan-integration.md:188` 의 마이그 `✕`→`⭕`**.
**문의 최종 건수**: 신규 **6건 그대로**(063+1~+6 · 063+6 에서 ⓐ 삭제 · 063+2 에 「두 사유가 `INVALID_STATE` 하나로 접힌다」 한 줄 추가) + 기존 미룸에 **#215** 를 더해 040·#66·#145·문의14·#215 **다섯**.
**PR 분할·모델 최종안**: **4개 · 3단 스택** — ①(조회·뷰·권한 sonnet ≤240) → {②(A11+CRUD sonnet ≤200) → ③(`:confirm`+`transitions.ts` opus ≤240)} **∥** ④(`:acknowledge`+`:resync` opus ≤240 · M2 마디는 통합자로 이관). 겹치는 파일은 `planning.module.ts` 한 줄뿐이다.
**한 줄 판정**: 도메인 경계는 ✅ — `work-order-release.service.ts:105-124` 가 생산에서 `logistics.material_issue_request` 를 직접 쓰는 선례라 금지된 것은 service 호출뿐이고 prisma 직접 INSERT 는 규약 안이다(다만 상수 공유는 원본 파일 무변경으로). A11 두 칸도 ✅ — `reasonCode` 가 `x-code-key` + omf-mes#198(CLOSED) + 시드 5값으로 계약·DB 양쪽에서 확정돼 있어 I-7 D2 와 정확히 같은 모양이다.
