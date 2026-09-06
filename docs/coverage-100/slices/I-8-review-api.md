# I-8 개별 계획안 재검토 — **api 관점**

> 대상 `docs/coverage-100/slices/I-8.md`(849줄) · 기준 worktree `i8-plan`(`e7fa784`) · 계약 사본 `a6a87e1`.
> ⚠ 로컬 PG 미기동(`psql` 연결 실패) — 계획자의 **DB 행수 실측(0행 4건)은 재확인하지 못했다.** 나머지는 전부 실측했다.

## 1. 문의 045·046 — ✏

- **045 는 새 문의가 맞다** ✅. 실측 근거 **둘을 더 붙일 수 있다**: ⓐ `numbering.service.ts:20-31` `DEFAULT_PREFIX` 에 **`PICKING_ORDER` 가 없다** — 지시를 만들려 하면 채번이 던진다(「지어내지 않는다」). ⓑ `plan-api.md:1092` ⌜피킹 `picking_order_no` … 서버 생성 경로는 계약에 없음 — **출고요청이 만든다**⌝ 가 **틀린 문장**이다(§5 실측이 뒤집는다) · `:1100` ⌜예약은 서버가 만든다⌝ 도 자리가 없다.
- **예약 시점 ⓔ 의 진단을 고친다** ✏. 04 계약 실측(`shipment-04제품출하.json` `…:pick`): ⌜서버가 이 피킹의 결과로 `inventory_reservation` 을 걸고 푼다(01 자재창고 계약 · **`M-01-08` §5-5 와 같은 규약**) … 자재 피킹의 `:pick` 과 대칭이다⌝. 그런데 `M-01-08` §5-5 원문은 ⌜**출고요청 생성 시 예약이 걸리고**, 피킹하면 `picked_qty` 로 옮겨 간다⌝ 다. ⇒ 「01 vs 04」가 아니라 **04 가 자기 근거 문서를 잘못 인용했다**가 더 정확하다. 045 ⓔ 를 그 문장으로 바꾼다.
- **멈춤 조건 ③(계약끼리 모순) 미발동** ✅ 동의 — 8 오퍼레이션 중 «구현 불가»가 0이다(예약은 조회만 · `:pick` 은 `inventory_reservation_id` NULL 갈래로 완전히 선다). 「01 쪽을 안 하는 것으로 양립」이 맞다.
- **046 은 문의가 맞다** ✅ · 다만 제목이 「계약 위반」으로 읽힌다 ✏. 실측: `MaterialIssueRequestLine.issuedQty` 는 required·`readOnly`이고 **물리 칸**(`baseline:1411 ck_material_issue_line_qty`)이라 0 을 내리는 것은 **스키마 위반이 아니다**(널이 아니다). 046 은 「**같은 「기출고」가 두 벌**」 문제다 — 제목에서 그 구분을 못박는다.
- 해소 2 ✅ 실측: `M-01-08` §8 #5 ⌜남은 것은 `picking_line.status_code`(`omf-mes#213`)⌝ · `W-02-10` §8 211행 ⌜#145⌝. 기존 인용 6 ✅. 알려둘 것 12 중 문의로 올릴 것 **0**(ⓓ 는 아래 6 에서 «닫힌다»).

## 2. 마이그 0 · 상수 정정 — ✏

- 마이그 0 ✅ — `plan.md` §0 #10 의 ⚠ 단서(⌜계약이 응답에 `required` 로 적은 자리에는 nullable 이 안 선다 … 그 자리는 상수⌝)가 두 칸에 정확히 걸린다. 두 릴리스 규칙 미해당 ✅.
- ✏ **「상수」라는 말을 고친다.** `picking_line.status_code`·`inventory_reservation.status_code` 는 서버가 쓰는 자리가 0이라 **src 에 상수를 두지 않는다**(§9-3 파일 목록에도 없다 — 일관 ✅). 남는 것은 **e2e 픽스처 리터럴 하나**뿐이다. §2-4·§10-1 #3 이 「상수」로만 적어 src 상수로 오해된다 ⇒ 「서버 코드 0 · 픽스처 리터럴뿐」으로 쓴다.
- ⛔→✏ **정정 예산이 모자란다.** `grep -rn REQUESTED src test` 실측 자리 **넷 + 주석**: `material-issue.ts:17`(값) · **`material-issue.ts:13-16` 주석**(⌜`MATERIAL_ISSUE_REQUEST_STATUS` 코드 그룹이 시드에 없고⌝ 가 **거짓이 된다** — 계약이 `LOGISTICS_DOCUMENT_STATUS` 를 지목하고 `seed.ts:1069` 에 4값이 있다) · `work-order-release.service.spec.ts:197` · `test/production-work-order.e2e-spec.ts:721`·**:1093**(둘이다). ⇒ §4-3 예산을 「값 1 + 주석 3 + spec 1 + **e2e 2**」로 고친다.
- 상수의 집 둘(정본 `logistics` + `production` 복사) ✅ — `server-architecture.md:67` 도메인 간 import 금지 · `src/core/` 승격 기각 ✅ 동의.

## 3. 코어 `pick()`·`consume()` — ✏ (셋)

- 시그니처 11칸 ✅ — `move()`(`inventory-posting.service.ts:271-284`)의 WHERE 가 정확히 그 11칸이고 `uq_inventory_balance_dim`(`baseline:1124`)이 같은 축이다. 품질·재고·소유 3칸을 코어가 받는 것이 맞다.
- ⛔ **`lockBalancesInOrder` 가 11칸을 안 준다.** `balance-lock.ts:49-58` 은 `COALESCE(lot_id,0) AS "lotKey"` 로 내려 **`lot_id` NULL 과 0 이 한 값**이 되고 `on_hand/reserved/picked` 도 안 뽑는다. §3-5 가 ⌜`dimension: row 11칸`⌝ 이라 적은 자리에 **`lotKey===0n → lotId=null` 매핑**을 명시하거나 그 SELECT 에 `lot_id` 를 더한다(코어 파일 ⇒ PR ①). 빠지면 LOT 없는 잔액에서 조용히 엉뚱한 행을 친다.
- ⛔ **Δ<0 하한이 하나 빠졌다.** `consumed_qty` 는 `app.qty_t`(`baseline:59-60` `CHECK (VALUE >= 0)`)다 ⇒ 예약 되돌림에서 **`consumed_qty ≥ −Δ`** 를 안 보면 `check_violation` → 500 이다. §3-3 표 ⓒ 에 한 줄 + 단위 테스트 이름 1개(`예약을 되돌릴 때 consumed_qty 가 모자라면 400`).
- `ck_reservation_qty` 앞당김 ✅ 실측 — `baseline:1229-1231 CHECK (released_qty + consumed_qty <= reserved_qty)` = 계획 ⓑ 식과 같다. Δ<0 은 LHS 를 줄이는 방향이라 이 CHECK 는 안 어긴다 ✅.
- **`consume()` 을 손검사 «앞»에** ✅ 강하게 동의 — `issue-posting.ts:132-137` 이 `row.available_qty.lessThan(qty)` 로 400 을 내고 `available_qty` 는 STORED 생성 컬럼이라 UPDATE 뒤 되읽기 없이는 새 값이 안 온다. 트리거(`baseline:2831~` 실측 3갈래)도 `consume`(picked↓) → `post`(on_hand↓) 순서에서 불변식이 어느 순간에도 안 깨진다. ⓐ(`post()` 에 피킹 축) 기각 ✅ · ⓑ 기각 ✅.
- ✏ `field` 를 코어가 받는 것 — 코어 선례 `reversal.ts:70-72` 는 `scope:'screen'` 이고 field 를 **안 받는다**. 받으려면 그 이탈을 §3-2 주석 한 줄로 적는다(아니면 빼고 선례를 탄다).
- 잠금 순서 ✅ 교착 없음(`consume()` 이 예약을 안 잡아 출고 경로에 예약 잠금이 0). `reverse()` 무변경 ✅ + I-5 인계 ✅. `reserve()` 안 만듦 ✅(계획 PR 이 `plan.md` 106·`plan-integration` 279 를 고치는 것으로 닫힌다).
- ✏ 정적 가드 **오탐이 실재한다** — `inventory_balance` 를 코어 밖에서 «읽는» 파일이 있다(`issue-posting.ts:288` `FROM inventory.inventory_balance … FOR UPDATE`). 정규식을 **`UPDATE`/`INSERT INTO` + 표 이름**으로 좁히고 `SELECT … FOR UPDATE` 는 통과시킨다(그 사실을 spec 주석에).
- 파일 분리·≤200 ✅ — 선례가 이미 있다: `reversal.ts` **125줄**(§3-2 가 「300줄이라」만 근거로 든다 — 선례를 인용하는 편이 낫다). `inventory-posting.service.ts` = **정확히 300줄** 실측.

## 4. `POST /logistics/material-issue-requests` — ✏

- 순서 ✅(채번이 `runIdempotent` «밖» = tx 밖 · `plan.md` §3 채번 칸의 정정문과 같은 모양 · `release-plan.ts:79-86` 선례).
- ⛔ **`requested_by` 가 표에서 빠졌다.** 계약 `MaterialIssueRequest.requestedBy`(`["integer","null"]` · `x-source-column: requested_by`) · 자동 발행은 `work-order-release.service.ts:107` 에서 `requested_by: appUserId` 를 넣는다. 수동 `POST` 가 비우면 **같은 표에 주체가 반쪽만 남는다.** §4-1 ② 에 「`requested_by` = 세션 계정」(`plan.md` §5 규칙 9 「주체는 계정 세션」)을 더한다.
- ✏ `STATE_LOCKED` 집합 — W/O 상태 **8값** 실측(`transitions.ts:150-160`: PLANNED·CONFIRMED·RELEASED·IN_PROGRESS·SUSPENDED·COMPLETED·CLOSED·CANCELLED). {CANCELLED, CLOSED} 는 서지만 **`COMPLETED` 를 여는 근거가 없다** — 「마감 전이라 정정 출고가 설 수 있다」 한 줄을 §4-5 에 적는다.
- `plantId` 왕복 ✅(`release-plan.ts:84` 와 같은 축) · `destinationLocationId` 존재만 ✅(계약이 「도착 위치. FK 라 실재하는 위치여야 한다」만 적었다) · `line_no` 서버 부여 ✅(계약 `lineNo` ⌜서버가 부여하며 화면이 정하지 않는다⌝) · If-Match 무시 ✅ · 중복·BOM 밖 허용 ✅.
- 에러 코드 **전건 실재** ✅ — `error-codes.ts:9 REQUIRED`·`:10 RANGE`·`:17 STATE_LOCKED`·`:24 LINE_REQUIRED`·`:55 NEGATIVE_BALANCE`. 새 코드 0 ✅.

## 5. `:pick` — ✏ (계약 하한 하나 · 선례 지목 하나)

- ③ 축 ✅ — `goods_issue_line.picking_line_id`(`schema.prisma:778`) 실재 · I-4 가 이미 존재 검증(`goods-issue-rules.ts:181,210`). 취소된 출고도 막는 것이 맞다(`reverse()` 가 `picked_qty` 를 안 되돌린다 · §3-6) — 그 이유를 ③ 옆 한 줄로.
- ⛔ **계약이 하한을 준다 — 검증표에서 빠졌다.** `PickingLinePick.pickedQty` 에 **`exclusiveMinimum: 0`** 실측. ⇒ §6-1 ④ 에 `pickedQty > 0`(400 `RANGE`)을 더한다. 그리고 **피킹을 0 으로 되돌리는 경로가 계약에 없다**(`:unpick` 0건 · 0 을 못 보낸다) — 「알려둘 것」 한 줄(Δ<0 은 «줄이기»만 되고 «지우기»는 안 된다).
- ✏ 2행+ 문장을 **글자 그대로** 맞춘다 — 실측 `issue-posting.ts:126-129` ⌜재고 차원이 둘 이상이라 어느 것을 **낼지** 정할 수 없습니다.⌝ · 계획 §6-2 는 「집을지」로 적었다. 031 이 한 자리라 문자열이 같아야 한다.
- `lot_hold` 축이 출고와 반대인 것 ✅ 계약 실측(`PickingLinePick.description` ⌜보류 중인 LOT 이면 400 으로 막는다⌝ + `PickingLine.held`) · `blocks_picking` 판정문이 I-4 R-7 `blocks_issue` 와 같은 모양 ✅.
- ✏ **`X-Worker-No` — 선례를 잘못 짚었다.** 이 자리의 선례는 I-7 **§4-3**(`worker_id` NOT NULL)이 아니라 I-7 **§8-4·§9-3 ⓜ** 다 — `:complete` 가 ⌜required 인데 담을 칸이 없다 → 받아서 «거부 판정»에만 쓰고 버린다⌝ 로 **같은 결론**을 이미 냈다. ⇒ 「다른 규약」이 아니라 「같은 선례」로 고친다. 마스터 조회 안 함도 §8-4 와 같다 ✅ — 계약 ⌜없으면 거부한다⌝ 의 「없음」에 «마스터에 없음»은 안 든다(I-7 이 `INVALID` 를 낸 것은 `worker_id` 를 «푸는» 자리라서다).
- ⛔ **`plan.md` §5 규칙 9 를 함께 고쳐야 한다** — 규칙 9 의 예외가 두 오퍼레이션을 **이름으로** 열거한다(`production-results`·`lots:complete`). `:pick` 을 **셋째**로 더하는 한 줄이 §12 「함께 고칠 통합 계획서 자리」에 **없다** — 더한다.
- `picking_order.status_code` 안 옮김 ✅(`transitions.ts` 키 목록에 `picking_order`·`material_issue_request` 부재 실측) · If-Match 대상이 라인 ✅(`document-progress.controller.ts:75` 선례) · 404 두 갈래 ✅.

## 6. `shortage` — ✏ (알려둘 것 ⓓ 가 지금 닫힌다)

- BOM 축 `production_plan.bom_id` 단일 ✅ — NOT NULL 실측 · 「스냅샷 축은 미배포 W/O 를 400 으로 막아 업무를 없앤다」 논거 ✅ 동의(I-4 §5-3 선례).
- ⛔ **ⓓ 「계획의 BOM 을 바꾸는 오퍼레이션 유무는 I-24 가 안다」는 지금 답이 있다.** 실측: **`PUT /planning/production-plans/{productionPlanId}` 가 실재하고 `ProductionPlanUpdate` 에 `bomId` 가 있다**(`production-02생산실행.json`). ⇒ ⓓ 를 「**바뀐다** — 그때 shortage 가 선발행 슬롯의 스냅샷과 갈린다」로 확정해 적는다(추측 문장을 남기지 않는다).
- ✏ `src/core/bom/requirement.ts` 이관 — 사용처 둘 ✅ 이나 **옮길 것의 자리가 계획과 다르다**: `where`/`select` 는 `material-issue.ts` 가 아니라 **`release-plan.ts:96-109`** 의 `bomComponents()` 안이고, 그 함수는 `skipsMaterialIssue`·`default_wip_location_id` 판정을 안은 **도메인 규칙**이다 ⇒ 순수한 것만 올린다(`materialRequirements`·`BomComponentRow`·`BOM_COMPONENT_SELECT`). 또 `materialRequirements()` 의 반환형이 `MaterialIssueLine`(`line_no`·`bom_component_id`)이라 shortage 가 그대로 못 쓴다 — **품목 합치기·`bomComponentId` 처리는 shortage 쪽 후처리**임을 §7-3 에 명시한다(반환형을 바꾸면 I-6 을 회귀시킨다).
- ✏ **기출고 조인 — 축이 둘인데 하나만 골랐다.** `goods_issue_line.picking_line_id` 는 **nullable** 이고 I-4 가 필수로 안 만들었다(`goods-issue-rules.ts:20` `pickingLineId?`) ⇒ 라인 축은 **피킹 라인을 안 단 출고를 빠뜨린다**. 헤더 축(`goods_issue.source_document_type_code='PICKING_ORDER'`)이 더 넓다. 계획대로 라인 축을 쓰되(그 축이 `consume()` 배선 축과 «같다»는 것이 근거다) 「빠지는 갈래가 있다」를 흔적 주석 + 알려둘 것에 적는다.
- `status_code='POSTED'` ✅(`goods-issue.service.ts:34`) · `workOrderId` 400 `REQUIRED` · **404 미선언** ✅ 실측(`shortage` responses = `200/400`).

## 7. 조회 5 — ✏ (널/생략이 계획 안에서 갈린다)

- where 매핑 **전수 일치** ✅ — 계약 `parameters` 실측(reservations 8 · material-issue-requests 7 · shortage 1 · picking-orders 5)이 §1-2 표와 같다. 정렬 질의 0 ✅ → PK 역순 ✅.
- ⛔ **널 vs 생략이 §8-2 와 §8-3·§7-3 사이에서 갈린다.** `omitEmpty`(`src/common/http/omit-empty.ts`)는 **`undefined` 만** 거른다 — 널은 통과한다. 규칙은 §8-2 가 옳다(계약 `type:[..,"null"]` = 널 · 선례 `goods-issue-view.ts:77`). 그런데 **`pickSequenceRank`(`["integer","null"]`)와 shortage `bomComponentId`(`["integer","null"]`)를 「키 생략」이라 적었다** — 실측상 둘 다 **널**이어야 한다. 두 자리를 고친다(`plan.md` §5 규칙 7 의 「키 생략」은 널 불가 칸에 대한 말이다 — 그 단서를 §8-2 인용에 붙인다).
- ✏ FEFO/FIFO 키 — 실측 `item.shelf_life_days Int?` · **`item.fifo_policy_code String @default("FIFO")` NOT NULL**(`schema.prisma:1734,1736`). 계약은 ⌜유효기한 관리 품목은 FEFO, **나머지는 FIFO**⌝ 로 닫았다 ⇒ `fifo_policy_code==='FIFO'` 조건은 계약에 없는 갈래이고 NOT NULL DEFAULT 라 **오늘 언제나 참**이다. 조건을 빼고 계약 문자대로 간다 — 「비는 것」은 정렬 키(`expiry_date`/`manufactured_at`)가 널일 때뿐.
- `reservations` 를 `src/inventory/balance/` 안 파일 둘 ✅(I-7 R-13) · `openOnly` 원시 조각 ✅ · `pickSequenceRank` 모집단 ✅ · `held` LOT 집합 1회·다건 최신 ✅ · `statusCode` 대조 안 걺 ✅.

## 8. 횡단 · PR 분할 — ✏ (④ 를 **미리 가른다**)

- 403 1건 ✅ 실측 — `derived-permissions.ts:57` 에 `GET /logistics/picking-orders` 만 있고 `:pick` 은 **없다**(형제 `shipment-requests …:pick` 은 `:181`). `manual-permissions.ts` 에 물류 트랜잭션 선례가 이미 있다(`:177 PUT goods-issues/{id}/lines` · `:186 inbound-receipt-lines/{id}/variances`) ⇒ 파일 머리의 「마스터 소유」 문구와 안 부딪친다 ✅. 도출표 무수정 ✅.
- 멱등 2 · If-Match 선택 2 · ETag **0** ✅ — 8 오퍼레이션 `responses.*.headers` 전건 0 실측. 인계 6행 ✅.
- ⛔ **PR ④ 를 지금 가른다.** README §6 실측: ⌜비테스트 diff 예산은 **350** — 리뷰 수정분(+20~30)이 들어갈 자리를 남겨 400 맞추기 왕복을 없앤다⌝. ~385 는 리뷰 수정분을 얹으면 **한도 400 을 넘는다** — 예산의 «목적» 자체를 무너뜨린다. 계획자의 「④a 가 죽은 코드를 안는다」(I-7 R-4)는 **여기 서지 않는다**: ④a 의 `picking-view.ts` 는 `GET …/{pickingOrderId}` 가 **지금 쓰는** 코드다(호출자 없는 헬퍼가 아니다). ⇒ **④a 피킹 조회 2 + 뷰(~215) / ④b `:pick` + `consume()` 배선 + M2 마디 e2e(~175)**. PR 총 **5**.
- ⛔ 대안 「`consume()` 배선을 ①로」 **반대** — ① 은 「코어 전용 ≤200」이고 CLAUDE.md 가 「보일러플레이트와 커밋 분리」를 적었다. 도메인 파일(`issue-posting.ts`)을 코어 PR 에 넣으면 그 규칙이 깨진다. ② ~325 는 350 안 ✅ — `core/bom` 을 ①로 옮기면 ① 이 ~200 상한에 닿아 더 나쁘다.
- M2 마디 픽스처 **실측으로 선다** ✅ — `goods-issue-rules.ts:61` 이 `PICKING_ORDER` 를 `picking_order.count()` 로 검증하고 `:181,210` 이 `pickingLineId` 존재를 검증한다 ⇒ 지시·라인이 실재하면 통과. ⚠ `goods_issue_line.lot_id` 는 **NOT NULL** 이라 픽스처에 LOT 이 필수다. 회귀 무변경 ✅ — `pickingLineId` 가 optional 이라 기존 출고 e2e 라인은 `consume()` 을 안 탄다. §11-1 픽스처·cleanup 순서 ✅.

## 9. api 계획서와의 어긋남 — 구현에 영향 주는 것만 ✏

- §12 #6(ETag) ✅ **정확** — `plan-api.md` S04 6축 표(`:128-139`)는 이미 두 쓰기에 ETag 「—」다. 고칠 것은 uiux U11 쪽뿐이다.
- ✏ **§12 「함께 고칠 자리」에 api 쪽 3행이 빠졌다**: ⓐ `plan-api.md:546`(S22 에 ⌜`:pick` 이 `inventory_reservation` 을 걸고 푼다⌝ — S04 `:118` 과 **같은 문장이 한 벌 더 있다**) ⓑ `plan-api.md:1092`(⌜피킹 지시는 **출고요청이 만든다**⌝ — 틀린 문장) ⓒ `plan-api.md:1061`(`NEGATIVE_BALANCE` 「S06」 — I-8 이 둘째 사용처).
- §12 #5 ✅ 실측(`plan-api.md:118`) · #11 ✅ 실측(`:119` ⌜피킹 라인 상태는 「칸 불필요」⌝ = 계약 `x-no-code-key` 문장과 같다) · #7(PR 3→4) ✏ → **3→5**(위 8).

---

## 5줄 요약

1. **I-8.md 에 반영할 수정 12건** — ⓐ §3-5 에 `lockBalancesInOrder` 의 `lotKey`(=`COALESCE(lot_id,0)`) → `lotId` 매핑 명시 ⓑ §3-3 ⓒ 에 `consumed_qty ≥ −Δ` 하한 추가(+단위 테스트 1) ⓒ §3-8 가드 정규식을 `UPDATE`/`INSERT` 로 좁힘(`issue-posting.ts:288` 오탐) ⓓ §4-1 에 `requested_by = 세션 계정` ⓔ §6-1 ④ 에 `pickedQty > 0`(계약 `exclusiveMinimum: 0`) ⓕ §8-3·§7-3 의 「키 생략」을 **널**로 정정 ⓖ §8-3 FEFO/FIFO 에서 `fifo_policy_code` 조건 제거 ⓗ §7-3 이관 범위를 순수 함수로 한정 + 반환형 주의 ⓘ §7-4 라인 축의 누락 갈래 흔적 ⓙ §6-7 선례를 I-7 §8-4 로 정정 ⓚ §4-3 예산 4자리+주석 ⓛ 알려둘 것 ⓓ 를 실측으로 확정(`PUT /planning/production-plans` 에 `bomId` 실재).
2. **`plan.md` 에 반영할 것 2건** — §5 **규칙 9 예외에 `:pick` 을 셋째로** 추가(계획서 §12 목록에 빠져 있다) · §1 43행 PR **3 → 5**. (§3 106행 감지 수단·`reserve()` 는 계획자 안 ✅.)
3. **`plan-api.md` 에 반영할 것 4자리** — `:118`(S04 예약 문장) · **`:546`**(S22 같은 문장 · 계획서가 놓쳤다) · **`:1092`**(「출고요청이 지시를 만든다」 — 틀린 문장) · `:1061`(`NEGATIVE_BALANCE` 사용처에 I-8).
4. **문의 최종 2건 유지**(045·046) · 해소 보고 2(#145·#213) ✅ · 알려둘 것 **12 → 13**(「`:pick` 으로 피킹을 0 으로 되돌릴 수 없다 — `exclusiveMinimum: 0` · `:unpick` 0건」 추가) · 알려둘 것 ⓓ 는 추측을 걷고 확정 문장으로.
5. **PR 분할 최종안 5개** — ① 코어 ~150 · ② 조회 3 + `core/bom` ~325 · ③ `POST` + `reservations` ~275 · **④a 피킹 조회 2 + 뷰 ~215** · **④b `:pick` + `consume()` 배선 + M2 마디 ~175**. ④ 는 **미리 가른다**(README §6 예산 350 의 목적이 리뷰 수정분 여유이고 ~385 는 그 여유를 없앤다 · 「죽은 코드」 논거는 ④a 의 뷰가 `GET …/{id}` 의 현역 코드라 서지 않는다). `consume()` 배선을 ①로 옮기는 대안은 **반대**(코어 전용 ≤200 규칙).
