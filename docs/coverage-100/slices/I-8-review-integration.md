# I-8 개별 계획안 재검토 — **integration 관점**

> 브리프: `brief-I-8-review.md`. 실측 기준 worktree `i8-plan`(main `e7fa784`) · 계약 사본 `a6a87e1` · 2026-09-07.
> 판정 9항 각 ✅ 동의 / ✏ 수정 / ⛔ 반대. **파일:줄**은 전부 이 worktree 실측이다. 결론은 §끝 5줄.

## 1. 문의 045·046 · 해소 2 — **✏**(046 의 근거 문장 하나를 고친다)

- **045 ✅.** 계약 `/logistics/picking-orders*` 경로가 목록·상세·`:pick` 셋뿐인 것 실측 확인. 예약 시점 01↔04 를 045 에 묶는 것도 ✅ —
  01 쪽 문장(`InventoryBalance.reservedQty` ⌜출고요청 생성 시 걸리는 예약분⌝)은 **오퍼레이션이 아니라 칸의 뜻**이라 「안 하는 것」으로 양립한다.
  ⇒ 멈춤 조건 ③(계약끼리 모순) **미발동** 판정에 동의한다. 어느 쪽도 «맞출 수 없는» 자리가 아니다.
- **046 ✏.** 계약 실측: `MaterialIssueRequestLine.issuedQty` 에 **`readOnly` 가 없다**(속성은 `x-source-column: issued_qty` 뿐).
  ⇒ 「required·readOnly 칸을 0 으로 내리면 계약 위반」이라는 §10-2 의 논거는 안 선다. **문의는 유지하되 본문을 바꾼다** —
  진짜 내용은 「같은 «기출고»가 두 벌(`issued_qty` 칸 ↔ `goods_issue_line` 합계)이 되고 `ck_material_issue_line_qty`(baseline:1411)가 무의미해진다」다.
- 알려둘 것 ⓓ 는 **가정이 아니라 실측된 위험**이다 — `PUT /planning/production-plans/{productionPlanId}` 가 계약에 실재한다(`production-02생산실행.json`).
  배포 뒤 계획 BOM 이 바뀔 «수 있다»가 확인됐으므로 ⓓ 문장에서 「…있는지는 I-24 가 안다」를 「있다(실측) — 갈리는 폭은 I-24 가 안다」로 고친다.
- 해소 2(#145·#213) ✅ — `x-no-code-key` 원문 둘 다 실측(`InventoryReservation.statusCode`·`PickingLine.statusCode`).

## 2. 마이그 0 · 상수 정정 — **✏**(정정 범위는 3줄로 실측 확인 · 「상수」의 집만 좁힌다)

- `'REQUESTED'` 정정이 닿는 자리 **정확히 3곳**: `src/production/work-order/material-issue.ts:17`(선언) ·
  `work-order-release.service.ts:110`(사용) · `work-order-release.service.spec.ts:197`(단언). e2e 에는 `REQUESTED` 문자열이 없다. ⇒ §4-3 예산 3줄 ✅.
- ✏ **`picking_line.status_code`·`inventory_reservation.status_code` 상수를 `src/` 에 만들지 않는다.** 서버가 그 두 칸을 쓰는 자리가 0 이면
  사용처가 e2e 픽스처뿐이고, `src` 상수는 CLAUDE.md 「사용처 하나뿐인 추상화 금지」에 걸린다. §11-1 대로 **픽스처 안 리터럴 + 주석 한 줄**로 끝낸다.
  §2-4 표의 「⇒ **상수**」를 「⇒ 서버가 안 쓴다(픽스처만)」로 고친다. 마이그 0 결론 자체는 ✅.

## 3. 코어 `pick()`/`consume()` — **✏**(막는 구멍 하나 + 배선 예산 재산정 · 순서·교착은 ✅)

- ✅ **`consume()` 을 `post()` 앞에 두는 순서가 트리거를 지킨다.** 실측 `inventory.check_balance_qty()`(baseline:2830~2860)는
  `on_hand ≥ reserved+picked+blocked` 를 **문장마다** 본다. `picked` 를 먼저 내리고 그 뒤 `on_hand` 를 내리면 매 문장에서 부등식이 유지된다.
  반대 순서면 `check_violation` → `prisma-error.ts` 를 지나 **500**. ⇒ ⓒ 채택 ✅. 손검사식에 소진량을 더하는 것도 ✅
  (`available_qty` 는 STORED 생성 컬럼 — `issue-posting.ts:139` 이 읽은 값은 잠금 시점 값이고, 우리가 내린 만큼만 커진다).
- ⛔→✏ **하한 검사가 하나 빠졌다.** §3-3 의 Δ<0 갈래는 `picked_qty ≥ −Δ` 만 적었는데 예약 행도 `consumed_qty −= |Δ|` 를 한다.
  `app.qty_t` = `numeric(20,6) CHECK (VALUE >= 0)`(baseline:59-60) 이므로 예약의 `consumed_qty < |Δ|` 면 **CHECK 위반 → 500** 이다.
  ⇒ 예약 UPDATE 의 `WHERE` 에 **`consumed_qty >= ${-Δ}`** 를 넣어 0행 → 400 `NEGATIVE_BALANCE` 로 떨어뜨린다. 단위 테스트 이름 1개 추가.
- ✏ **`consume()` 배선은 「손검사 앞 삽입 ~25줄」보다 넓다** — 실측:
  ⓐ `GoodsIssueLineWriteInput`(`issue-posting.ts:37-45`)에 `pickingLineId` 가 **없다** ·
  ⓑ `:post` 경로의 `select`(`goods-issue.service.ts:245-255`)가 `picking_line_id` 를 안 읽는다 ·
  ⓒ 등록 경로(`goods-issue.service.ts:130-142`)도 `lines.push` 에 안 싣는다 ·
  ⓓ I-23 이 이 인터페이스를 `import type` 한다(`issue-posting.ts:18-19`) ⇒ 새 칸은 **선택**이어야 한다 ·
  ⓔ 0행/2행+ 판정과 손검사가 **한 루프**(`issue-posting.ts:116-146`)라 「판정 → consume → 손검사」로 루프를 가른다.
  ⇒ 예산 **~25 → ~35**. ④ 총량에 반영한다(§8).
- ✏ **소진 대상 판정 축을 라인이 아니라 «헤더»로 잡는다.** 계약 `GoodsIssueLineUpsert` required 5 에 `pickingLineId` 가 **없다**(선택) ⇒
  정식 경로 출고인데 화면이 그 칸을 비우면 `consume()` 이 안 돌고, 그 뒤 손검사가 `available`(피킹분 제외)로 재어 **정상 출고가 400** 이다 —
  §3-5 가 막으려던 바로 그 사고가 다른 문으로 들어온다. ⇒ `GoodsIssueHeaderWriteInput` 에 `sourceDocumentTypeCode` 를 실어
  **`'PICKING_ORDER'` 인 출고의 라인 전건**을 소진 대상으로 본다(라인 `pickingLineId` 는 되짚기용으로 계속 저장). 단위 테스트로 못 박는다.
- ✅ **교착 없음.** 출고 경로는 잔액만 잡고(`issue-posting.ts:102`), `:pick` 은 `picking_line → balance → reservation` 이며
  **잔액을 잡은 뒤 `picking_line` 을 잡는 경로가 하나도 없다**(전 소스 실측). `consume()` 이 예약을 안 잡는 것도 ✅.
  ✏ 다만 §3-4 의 인용이 틀렸다 — 출고 경로는 `balance-lock.ts:39` 를 **안 쓴다**. `issue-posting.ts:57-79·264-286` 에 **같은 코드가 한 벌 더** 있다
  (I-4 가 남긴 중복). §3-4 문장을 「호출자가 잠근 뒤 UPDATE 한다 — `:pick` 은 `lockBalancesInOrder()`, 출고는 `issue-posting.ts` 의 사본」으로 고치고,
  ⛔ **그 중복을 I-8 에서 합치지 않는다**(코어 PR 예산·「원장 코어를 고치는 두 슬라이스」 경고).
- ✏ **정적 가드 정규식**을 파일 단위 낱말 매칭으로 쓰면 오탐한다. 실측 오탐원: `issue-posting.ts`(`inventory_balance` SELECT + `tx.goods_issue_line.update`) ·
  `src/inventory/balance/balance-query.ts:106`(SELECT) · `src/mdm/logistics/warehouse.service.ts:25`·`location.service.ts:17`(표 이름 문자열) ·
  `goods-receipt/receipt-posting.ts:26·108`(주석). ⇒ 패턴을 **`UPDATE\s+inventory\.inventory_balance` · `INSERT\s+INTO\s+inventory\.inventory_balance` ·
  `\.inventory_balance\.(update|updateMany|create|createMany|upsert|delete)`** 셋으로 못 박고 spec 이름에 그 셋을 적는다.
- ✅ 시그니처(11칸 `BalanceDimension` · `field`) — 잠근 행이 이미 4칸을 싣고 있어(`balance-lock.ts:15-21`) 코어가 받는 것이 맞다. `reserve()` 미제작 ✅.

## 4. `POST /material-issue-requests` — **✅**(코드·상태 집합 실측 통과)

- `LINE_REQUIRED`(`error-codes.ts:24`) · `RANGE`(:10) · `REQUIRED`(:9) · `STATE_LOCKED`(:17) · `NEGATIVE_BALANCE`(:55) 전부 실재 ✅ — 새 코드 0 ✅.
- W/O 상태 8값 실측(`transitions.ts:150-161`): PLANNED·CONFIRMED·RELEASED·IN_PROGRESS·SUSPENDED·COMPLETED·CLOSED·CANCELLED.
  `{CANCELLED, CLOSED}` 선택 ✅(`COMPLETED` 는 마감 전이라 `:close` 로 닫히기 전까지 추가 불출이 업무상 성립한다 — 거부하면 업무를 없앤다).
  ✏ 단위 테스트 이름에 `COMPLETED 인 W/O 에는 요청이 선다` 를 넣어 이 선택을 못 박는다.

## 5. `:pick` — **✏**(③ 「이미 출고된 라인」의 판정 축)

- ⛔ **`goods_issue_line` 존재만으로 막으면 과차단이다.** 실측: 등록 경로가 `picking_line_id` 를 **전기 전에** 저장하고
  (`goods-issue.service.ts:122`) 헤더는 `REGISTERED` 로 선다(:104) — `postImmediately=false` 로 등록만 해 두면 그 피킹 라인이 **영구히 잠긴다**.
  취소된 출고도 라인이 남아 같은 결과다. ⇒ 판정을 **`goods_issue_line ⋈ goods_issue WHERE status_code <> 'REGISTERED'`** 로 좁힌다
  (`consume()` 이 실제로 돈 것은 전기된 건뿐이다). 취소 뒤 재정정이 400 인 것은 §3-6 「알려둘 것 ⓒ」 그대로 남는다.
- ✅ 나머지(Δ 대체 · 2행+ 400 `INVALID` · `lot_hold.released_at IS NULL`(schema:3616) · `judgment_type_control.blocks_picking`(schema:4704) ·
  `picking_order.status_code` 안 옮김 · If-Match 를 라인 `version_no` 에 거는 것 · 404 두 갈래) 전건 동의.

## 6. `shortage` 기출고 조인 — **✏**(체인은 물리에 서지만 «헤더 축»으로 바꾼다)

- ✅ 체인 자체는 성립한다: `goods_issue_line.picking_line_id → picking_line`(baseline FK) · `picking_line.picking_order_id → picking_order` ·
  `picking_order.source_document_id`(다형·FK 없음) → `material_issue_request.work_order_id`(schema:960). `status_code='POSTED'` ✅.
- ✏ **`goods_issue.source_document_type_code='PICKING_ORDER' AND source_document_id = picking_order_id` 로 묶는다.** 근거 셋:
  ⓐ `pickingLineId` 가 계약 선택 칸이라 라인 축은 **샐 수 있다**(§3 의 같은 뿌리) ·
  ⓑ **인덱스가 그쪽에만 있다** — `ix_goods_issue_source(source_document_type_code, source_document_id, issued_at desc)`(schema:767)은 실재하고,
     `goods_issue_line.picking_line_id`(schema:797-798)와 `picking_order.(source_document_type_code, source_document_id)`(schema:1052 — `warehouse_id` 뿐)에는 **없다** ·
  ⓒ `plan-integration.md` §1-1 ⑧ 이 체인을 원래 그렇게 그렸다. ⇒ 한 출고 헤더는 원천 문서가 하나라 품목별 합산에 손실이 없다.
- ✅ BOM 축 `production_plan.bom_id`(schema:2511 NOT NULL) 단일화 · 폴백 없음 · `src/core/bom/requirement.ts` 이관(사용처 둘) · `scrap_rate` ✕ · 정렬.

## 7. 조회 5 — **✅ + ✏ 하나**(e2e 오염)

- 매핑·정렬 PK 역순·널 vs 생략·`openOnly` 수량식(`InventoryReservation` required 12 실측)·`reservations` 를 `src/inventory/balance/` 에 두는 것 ✅.
- ✏ **`GET /logistics/picking-orders` e2e 는 반드시 자기 `warehouseId` 로 걸러 부른다.** 실측: `test/logistics-document-progress.e2e-spec.ts:885-896` 이
  `picking_type_code='STANDARD'` · `source_document_type_code='GOODS_ISSUE'` 인 행을 심는데, 계약 `PickingOrder.sourceDocumentTypeCode` 는
  **enum 2값**(`MATERIAL_ISSUE_REQUEST`·`SHIPMENT_REQUEST`)이라 그 행이 한 페이지에 섞이면 **AJV 가 응답 전체를 떨어뜨린다**.
  `maxWorkers:1`+알파벳 시퀀서(`test/jest-e2e.json`)로 평소엔 안 만나지만, 앞 spec 이 중간에 죽으면 남는다.

## 8. 횡단 · PR 분할 — **✏**(④ 를 «미리» 가른다)

- ✅ 403 1건(`manual-permissions.ts`) — `derived-permissions.ts:57` 에 `GET /logistics/picking-orders` 가 이미 있고 `:181` 에 형제 `:pick` 이 있어 도출표는 안 건드린다.
- ✏ **④ 를 처음부터 ④a/④b 로 가른다.** ③ 의 근거 재산정으로 ④ 는 ~385 가 아니라 **~395**(배선 25→35)이고, 리뷰 수정분 +20~30 이 들어가면 **한도 400 을 넘는다**.
  「가르면 ④a 가 죽은 코드를 안는다(I-7 R-4)」는 **여기 서지 않는다** — `picking-view.ts` 는 ④a 가 내보내는 `GET …/{pickingOrderId}` 의 응답 뷰 그 자체이고,
  `:pick` 200 이 같은 `PickingLine`(파생 8칸)이라 ④b 가 그것을 **재사용**하는 정상 스택이다. 죽은 코드가 아니라 순서다.
  ⇒ **④a** 피킹 조회 2 + `picking-view.ts` + 컨트롤러·모듈 ≈ **230** / **④b** `:pick` + `consume()` 배선 + `manual-permissions` + M2 마디 e2e ≈ **165**. 둘 다 예산 350 안.
- ⛔ **`consume()` 배선을 ①로 옮기지 않는다** — I-4 도메인 파일(`issue-posting.ts`)이 들어가면 「코어 전용 PR」 규칙과 ≤200 이 동시에 깨진다. ③으로 옮기는 것도 ✕
  (M2 마디 e2e 가 `:pick` 없이 못 선다 — 배선과 그 회귀 e2e 는 같은 PR 이어야 한다).
- ✅ **M2 마디 픽스처가 `goods-issue-rules.ts` 를 통과한다** — 실측 관문 전건: `SOURCE_DOCUMENT_TABLES.PICKING_ORDER`(:61)가 `picking_order` 실재를 세고,
  `sourceLocationId` 는 **`sourceWarehouseId` 의 위치**여야 하며(:206-209 — 픽스처의 `picking_line.location_id` 를 `picking_order.warehouse_id` 안으로 맞춰야 한다),
  `lot.item_id = itemId`(:200-204) · `pickingLineId` 실재(:181·210) · `issueTypeCode ∈ ISSUE_TYPE`(:198) · 도착지 짝(:87-89). 전부 픽스처로 맞출 수 있다.
- ✅ 회귀 무변경 — `test/logistics-goods-issue.e2e-spec.ts:535·901` 이 `sourceDocumentTypeCode='GOODS_RECEIPT'` 만 쓰고 `pickingLineId` 가 없다.
  §3 의 «헤더 축» 권고로 바꿔도 그 파일은 그대로 통과한다.
- ✏ 인계 6행 중 **I-9** 행을 한 줄 보강 — `shopfloor_receipt` 가 무는 것이 `goods_issue` 축인 근거는 `plan-integration.md` §1-1 ⑨ 이고, ⑥⑦ 체인이
  I-8 에서 «픽스처로만» 이어진다는 사실을 I-9 브리프에 그대로 넘겨야 한다(I-9 e2e 도 같은 픽스처가 필요하다).

## 9. `plan-integration.md` ↔ I-8.md — **✅**(§12 의 integration 4행 전건 실측 확인)

| §12 행 | 실측 | 판정 |
|:-:|---|:-:|
| #1 (279행 함수 셋) | `plan-integration.md` 276~283 에 ⌜`reserve()`/`pick()`/`consume()` 를 더한다⌝ 실재 | ✅ 계획 PR 이 고친다 |
| #2 (§9 반박 2 트리거 감지) | 위험표 2행 ⌜잔액 UPDATE 트리거로 감지⌝ 실재 · baseline 트리거 6개 중 `inventory_balance` 는 `trg_inventory_balance_qty`(수량 정합) 하나 | ✅ 뒤집는 것이 맞다 |
| #3 (282행 lot 스냅샷) | ⌜`:release` 가 `lot.bom_id` 스냅샷으로 찍고 I-8 은 그 스냅샷을 쓴다⌝ 실재 | ✅ 뒤집는 것이 맞다 |
| #4 / #13 (150행 「예약만 건다」) | §1-5 표에 ⌜**원장 없음**, `inventory_reservation` 만 건다⌝ 실재 | ✅ 못 건다가 맞다 |
| **추가** | §3-4 의 `balance-lock.ts:39` 인용이 출고 경로에는 틀리다(사본이 `issue-posting.ts:264`) | ✏ §3 에 적음 |

---

## 재수립 결과 (5줄)

1. **I-8.md 수정 7건** — ⓐ §3-3 예약 Δ<0 에 `consumed_qty ≥ −Δ` 하한 추가(빠지면 500) ⓑ §3-5 소진 대상을 라인 `pickingLineId` 가 아니라 **헤더 `sourceDocumentTypeCode='PICKING_ORDER'`** 로(선택 칸이라 샌다) + 배선 예산 25→35 ⓒ §3-4 의 `balance-lock.ts` 인용을 `issue-posting.ts` 사본으로 정정(중복은 I-8 에서 안 합친다) ⓓ §3-8 가드 정규식을 3패턴으로 못 박음(오탐원 5개 실측) ⓔ §6-1 ③ 판정축을 `goods_issue.status_code <> 'REGISTERED'` 조인으로 ⓕ §7-4 기출고를 **`ix_goods_issue_source` 를 타는 헤더 축**으로 ⓖ §10-2 046 의 「readOnly」 논거 삭제(계약에 없다).
2. **plan.md 계열 반영** — §12 의 #1~#4·#13 은 실측으로 전건 확인됐다(그대로 고친다). 추가로 `plan-integration.md` §1-1 ⑧ 이 옳았음이 확인돼 §7-4 를 그쪽에 맞추면 통합 계획서 수정이 **한 줄 줄어든다**. §1 43행의 PR 수는 **3 → 5**(④ 가름 반영).
3. **문의 최종 2건 유지**(045 신규 · 046 신규 — 본문만 교체) · 해소 보고 2(#145·#213) · 알려둘 것 **12 유지**(ⓓ 를 「실측된 위험」으로 격상). 멈춤 조건 ③ 미발동 판정에 동의한다.
4. **PR 분할 최종안 — 5개**: ① 코어 ~150(≤200 · `consumed_qty` 하한 테스트 1개 추가) → ② 요청 조회 3 + `core/bom` ~325 → ③ `POST` + `reservations` ~275 → **④a 피킹 조회 2 + 뷰 ~230** → **④b `:pick` + `consume()` 배선 + M2 마디 e2e ~165**. ④ 를 **미리 가른다**(리뷰 판단 아님) — I-7 R-4 「죽은 코드」 논거가 여기서는 서지 않는다.
5. **통합 위험 잔여 2** — ⓐ `:pick` 이 픽스처로만 도달해 M2 「피킹」 마디가 서버 오퍼레이션으로 안 이어진다(045 가 답할 때까지 I-9 도 같은 픽스처를 진다) ⓑ 피킹 지시 목록 e2e 는 `warehouseId` 로 걸러 부르지 않으면 `logistics-document-progress` 가 남긴 enum 밖 행에 AJV 가 걸린다.
