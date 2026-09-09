# 통합 관점 계획 — 남은 계약 오퍼레이션 249건

> 관점: **통합**. 도메인을 가로지르는 **전표 체인 · 데이터 흐름 · 테스트 전략 · 실행 위험** 순으로 슬라이스를 갈랐다.
> 짝 문서: `plan-api.md`(API 설계) · `plan-uiux.md`(UI/UX 설계) → 통합 정본 `plan.md`.
> 규칙 정본: [`README.md`](./README.md) — §0 범위 · §2 갈림길 절차 · §4 모델 배분.
> 계약 사본 고정 `a6a87e1`. 이 문서는 **계획만** 쓴다 — 코드·계약·스키마·이슈를 건드리지 않았다.

## 0. 이 계획이 실제로 읽은 것

| 무엇 | 확인한 사실 |
|---|---|
| `contracts/*.json`(7벌) | `InventoryTransaction.sourceDocumentTypeCode` **enum 4값** · `GoodsIssue.sourceDocumentTypeCode` **3값** · `GoodsReceipt.sourceDocumentTypeCode` **4값** · `PickingOrder` **2값** · `ApprovalRoute.approvalTypeCode` **9값** · `DocumentProgress.documentTypeCode` **9값** / 취소 실행 **3값** |
| 계약 전수 스캔(`businessDate` 를 싣는 쓰기) | **22건**(logistics 19 · shipment 3). 그중 구현된 것 2건(`POST /logistics/goods-receipts` · `POST /trace/lots`). ⭐ **`POST /production/material-consumptions`·`POST /production/production-results` 에는 `businessDate` 가 없다** — 계약이 「이 둘은 원장을 지나지 않는다」를 그렇게 말하고 있다(C-8-1) |
| `prisma/schema.prisma`(181 모델) | 원장 라인을 FK 로 무는 표는 **6개**뿐 — `goods_receipt_line` · `goods_issue_line` · `putaway_task` · `stock_transfer_line`(issue/receipt 2칸) · `material_return_line` · `inventory_adjustment_line`. `material_consumption`·`production_result`·`shopfloor_receipt_line`·`shipment_line` 에는 **없다** |
| `src/core/inventory-posting` | `post()` 는 `from`/`to` 로만 이동을 말하고 유형표를 두지 않는다. **`reserved_qty`·`picked_qty` 를 건드리지 않는다**(코드 주석 명시) |
| `src/core/document-state` | 전이표에 등록된 것 **4칸 8전이**뿐. 없는 (칸, 액션) 은 «던진다»(F-6) |
| `src/logistics/goods-receipt` | 전표+원장+잔액+적치를 한 트랜잭션. 번호는 `GR-YYYYMMDD-NNNN` 을 `count()+1` 로 짓는다(채번 규칙 미등재) |
| `test/logistics-goods-receipt.e2e-spec.ts` | 시드 관행 = `PREFIX` 상수로 마스터를 짓고 `LIKE 'PREFIX%'` 로 지운다 · `ROLE`+`PERMISSIONS`(화면 ID 배열)로 권한 사용자/무권한 사용자 둘을 만든다 · 응답은 계약 스키마를 AJV 로 검증한다 |

---

## 1. 전표 체인 지도 — 화살표마다 어느 FK, 어디서 원장

### 1-1. 자재 흐름 (조달 → 투입)

```
purchase_order ──① asn.purchase_order_id ─→ asn
      │                                       │
      └──② inbound_receipt_line.purchase_order_line_id ─→ inbound_receipt ─(자재 LOT 생성)
                                                    │
                                                    ├─③ inbound_variance.inbound_receipt_line_id
                                                    │
                                                    └─④ goods_receipt.source_document_type_code
                                                         = 'INBOUND_RECEIPT'  ★원장 GOODS_RECEIPT (to 만)
                                                              │
                                                              └─⑤ putaway_task.goods_receipt_line_id
                                                                     ★원장 STOCK_TRANSFER (from→to)
material_issue_request ─⑥ picking_order.source_document_type_code='MATERIAL_ISSUE_REQUEST'
      │                        │
      │                        └─⑦ picking_line.inventory_reservation_id (예약 소진)
      │
      └─⑧ goods_issue.source_document_type_code='PICKING_ORDER'
              ★원장 GOODS_ISSUE (from = 자재창고 · to = 생산창고 위치 또는 없음)
                   │
                   └─⑨ shopfloor_receipt.goods_issue_id / shopfloor_receipt_line.goods_issue_line_id
                            │  (차이 수량은 variance_qty 파생 컬럼)
                            └─⑩ material_consumption.shopfloor_receipt_line_id   ⛔ 원장 없음
                                     └─⑪ lot_relation(source=자재LOT, target=생산LOT, N:M)   ⚠ I-10 은 만들지 않는다 — 052 회신 뒤
```

### 1-2. 생산 흐름 (지시 → 실적 → 제품 입고)

```
production_order ─⑫ production_plan.production_order_id ─⑬ work_order.production_plan_id
        (:confirm 이 Routing 공정별 W/O + work_order_dependency 를 한 트랜잭션으로 전개)
                                 │
   :release ──⑭ lot(lot_type=생산LOT, source_type_code='WORK_ORDER', lifecycle=WAITING) 선발행
                                 │
   work_session ─⑮ production_result.work_session_id
                                 │
   POST /production/production-results  ⛔ 원장 없음
        ├─⑯ production_result_lot_allocation.production_result_id → lot_id   (실적↔생산LOT)
        ├─⑰ material_usage_allocation.production_result_id / .material_consumption_id
        └─⑱ lot_lifecycle_history  L1 WAITING→ACTIVE  (transition_code='L1')
                                 │
   제품이 창고에 잡히는 것은 ⑲ goods_receipt.source_document_type_code='PRODUCTION_RESULT'
        ★원장 GOODS_RECEIPT — **이미 구현된 오퍼레이션이 그 자리다**(M-04-04 제품 입고 적치)
   :close  → L2 WAITING→VOIDED (실적 없는 슬롯만)
   :cancel → L3 WAITING·ACTIVE→VOIDED (선발행 전건)
```

### 1-3. 품질·출하 흐름

```
production_result ─⑳ inspection_request.production_result_id / .lot_id
        └─㉑ inspection_result.inspection_request_id ─㉒ inspection_measurement
             :confirm → trace.lot.status_code 전이 + trace.lot_status_event (C4·C6·C14·C15)
                     │
   lot_hold ─(등록 C5·C10 / 해제·재판정 C7·C8)→ lot_status_event
   nonconformance ─㉓ nonconformance_lot.lot_id
        └─㉔ disposition_decision.nonconformance_id  (REWORK·SCRAP·NORMAL)
                 └─ SCRAP 이면 ㉕ goods_issue.source_document_type_code='DISPOSITION_DECISION'
                        ★원장 GOODS_ISSUE (from 만 — 자체 폐기는 도착지 짝을 비운다)

sales_order ─㉖ shipment_request.sales_order_id (비울 수 있다 = 단독 생성)
   └─㉗ picking_order.source_document_type_code='SHIPMENT_REQUEST'
   └─㉘ shipment.shipment_request_id
          POST /logistics/shipments ★여기서 재고가 빠진다 —
              서버가 goods_issue 를 만들고 shipment_line.goods_issue_line_id 로 잇는다
              (계약 x-internal-note: 「재고 차감(goods_issue)은 01 자재창고 계약이 소유한다」)
          └─㉙ shipment_lot_allocation.shipment_line_id → lot_id (genealogy 종결점)
   :confirm → ERP 송신 «적재»만 (재고는 이미 빠졌다) · 확정 취소 경로 없음
   :request-cancel → :cancel  (미확정 구간에서만)

반품 입고 ─ goods_receipt.source_document_type_code='SHIPMENT'(또는 비움)
   └─ quality/disposition-candidates → nonconformance → disposition_decision
        └─ NORMAL 이면 POST /logistics/stock-reinstatements
             ★반출·도착·보류 해제·Lot Status 전이가 한 트랜잭션 (stock_transfer 2단 스캔을 «쓰지 않는다»)
```

### 1-4. 브리프의 물음에 대한 답 — 「투입·실적·출하는 원장을 어떻게 지나는가」

계약을 실제로 읽어 답한다. **셋 다 자기 이름으로 원장을 지나지 않는다.**

| 사건 | 원장 통과 방식 | 근거(계약 실물) |
|---|---|---|
| **투입**(`material_consumption`) | ⛔ **지나지 않는다.** 재고는 그 앞의 **출고**(`GOODS_ISSUE`, `sourceDocumentTypeCode='PICKING_ORDER'`)에서 이미 움직였다. 투입은 「어느 생산LOT 에 붙었나」를 계보(`lot_relation`)로 적는 기록이다 | `GoodsIssue.sourceDocumentTypeCode` 의 `PICKING_ORDER` 설명이 그대로 「**생산 투입**」이라 적었다 · `MaterialConsumptionCreate` 에 `businessDate` 가 없다 · `material_consumption` 에 `inventory_transaction_line_id` 컬럼이 없다 |
| **실적**(`production_result`) | ⛔ **지나지 않는다.** 제품이 재고로 잡히는 것은 **입고**(`GOODS_RECEIPT`, `sourceDocumentTypeCode='PRODUCTION_RESULT'`)다 — 이미 구현된 오퍼레이션 | `GoodsReceipt.sourceDocumentTypeCode` 의 `PRODUCTION_RESULT` 설명 = 「M-04-04 **제품 입고 적치**」 · `ProductionResultCreate` 에 `businessDate` 없음 · `production_result` 에 원장 FK 없음 |
| **출하**(`shipment`) | ⭕ **`GOODS_ISSUE` 로 지난다** — 다만 `shipment` 가 아니라 서버가 만드는 **`goods_issue`** 를 통해서다. 판별자는 `PICKING_ORDER`(→ `picking_order.source_document_type_code='SHIPMENT_REQUEST'`) | `ShipmentCreate` 에 `businessDate` **있음** · `shipment_line.goods_issue_line_id` FK · 계약 x-internal-note 「재고 차감(goods_issue)은 01 자재창고 계약이 소유한다」 |

⇒ **원장 판별자 4값은 늘릴 필요가 없다.** 「투입·실적·출하」는 각자 자기 표에 남고, 재고는 언제나 입고·출고·조정·이동 넷 중 하나를 통과한다. 이 문장이 이 계획 전체의 뼈대다 — 슬라이스마다 「이건 원장을 지나는가」를 이 표로 먼저 가른다.

### 1-5. 원장을 «실제로» 지나는 미커버 오퍼레이션 (17건)

`businessDate` 를 싣는 쓰기 22건에서 구현 2건을 뺀 20건 중, 실제로 `posting.post()` 를 부를 것 17건:

| 오퍼레이션 | from | to | `sourceDocumentTypeCode` |
|---|---|---|---|
| `POST /logistics/goods-issues`(postImmediately) · `:post` | 출발 창고·위치 | 도착지 위치(생산투입) 또는 **없음**(반품·폐기) | `GOODS_ISSUE` |
| `POST /logistics/putaway-tasks/{id}:complete` · `:complete-temporary` | `from_location_id` | `actual_location_id` | `STOCK_TRANSFER` |
| `POST /logistics/stock-transfers`(반출) | 출발 창고·위치 | **`IN_TRANSIT`** 상태 행 | `STOCK_TRANSFER` |
| `POST /logistics/stock-transfers/{id}:arrive` | `IN_TRANSIT` | 도착 창고·위치 | `STOCK_TRANSFER` |
| `POST /inventory/adjustments/{id}:post` | (감) | (증) | `INVENTORY_ADJUSTMENT` |
| `POST /logistics/recycle-entries` | 없음 | 목적 위치 | `GOODS_RECEIPT` *(추측 — 계약이 판별자를 말하지 않는다. §2 절차 대상)* |
| `POST /logistics/shipments` | 출하 창고·위치 | 없음 | `GOODS_ISSUE`(서버가 만든 `goods_issue` 를 통해) |
| `POST /logistics/shipments/{id}:cancel` | 없음 | 되돌림 | `GOODS_ISSUE` 역트랜잭션 |
| `POST /logistics/stock-reinstatements` | 반품 보관 위치 | 판매 가능 위치 | `STOCK_TRANSFER` |
| `POST /logistics/document-progress/{type}/{id}:cancel` | 역방향 | 역방향 | 원 문서와 **같은 값** + `reversal_of_transaction_id` |
| `POST /inventory/handling-units/{id}:pack` · `PUT .../contents` | — | — | **원장 없음 — 확정**(I-16 재수립 R-20). ⛔ ~~포장은 차원(`handling_unit_id`)만 바꾼다~~ 는 **뒷절이 틀렸다** — `uq_inventory_balance_dim` **11칸에 그 칸이 없다**(psql 실측). 잔량 차원 자체가 취급단위를 모르므로 「차원을 바꾼다」가 성립하지 않는다. 결론(원장 미경유)은 같다 |
| `PUT /inventory/counts/{id}/lines` · `:close` | — | — | **원장 없음** — 실사는 조정을 만들고 조정이 전기한다(결정 49) |
| `POST /logistics/material-issue-requests` | — | — | **원장 없음**, `inventory_reservation` 만 건다 |
| `POST /logistics/picking-orders/.../{id}:pick` | — | — | **원장 없음**, `reserved_qty` → `picked_qty` 이동 |
| `POST /logistics/shopfloor-receipts` | — | — | **원장 없음** — 차이가 있어도 `variance_qty`+사유로 기록만(I-9 §3-4 · 재고는 I-14 조정) |
| `POST /logistics/inbound-receipts` · `:split` | — | — | **원장 없음**(§Z-2 — LOT 등록은 원장을 지나지 않는다) |
| `POST /trace/lots/{id}:complete` | — | — | **원장 없음** — 생명주기 축만 옮긴다 |

⚠ `businessDate` 를 싣지만 원장을 지나지 않는 7건(`inbound-receipts`·`:split`·`counts/lines`·`:close`·`material-issue-requests`·`lots:complete`·`shopfloor-receipts`)은 **회신 대기 15번(C-8-1 어긋남)의 실물**이다. `§Z-4` 가 LOT 등록에서 이미 같은 판정을 내렸다 — **받아서 형식만 검증하고 저장하지 않는다**. 슬라이스마다 이 판정을 그대로 반복하고 요청서에 건수를 누적한다.

---

## 2. 공유 코어 후보 — 「언제 만들어야 뒤가 재작업을 안 하나」

「사용처 하나뿐인 추상화 금지」(CLAUDE.md)와 균형을 잡는 기준을 하나로 둔다: **두 번째 사용처가 「이미 계약에 실재하고 3슬라이스 안에 온다」면 첫 번째에서 만든다.** 실재 여부는 계약을 세어 판정한다 — 상상이 아니다.

| 코어 | 계약이 세어 준 사용처 | 언제 만드나 | 안 만들면 무엇이 재작업되나 |
|---|---|---|---|
| **승인 워크플로**(`approval_request`·`approval_step`) | `approvalTypeCode` **9값 전건**이 오퍼레이션과 1:1 — `:request-approval` 4건(`adjustments`·`goods-issues`·`purchase-orders`·`production-results`) + `lots:request-iqc-skip` + 취소 4건(`document-progress` 3종 + `shipments`) | ⭐ **I-1 에서 맨 먼저.** 「진행 중 요청은 하나」·`ROUTE_NOT_FOUND`·순차 결재(`NOT_YOUR_TURN`)·`J-8`(승인은 자물쇠만 푼다)가 9자리에서 **글자 그대로 같다** | 9자리에 같은 400 판정이 흩어진다. 나중에 모으려면 9개 서비스를 다시 연다 |
| **다형 취소**(`document-progress`) | 조회 **9종** · 취소 실행 **3종** · `document_cancellation` 표는 이미 있다 | ⭐ **I-5** — 입하·입고·출고 셋이 다 선 «직후», 그러나 이동·조정·출하보다 «앞». 취소 판정 로직(`successorCount`·`cancellable`·`cancelBlockedReasonCode`·`SUCCESSOR_EXISTS` 재판정)이 뒤의 전표에 그대로 붙는다 | 출하 취소(`shipments:request-cancel`·`:cancel`)가 **같은 규약의 두 번째 구현**이 된다. J-7·J-8 을 두 번 짜면 반드시 갈린다 |
| **역트랜잭션**(원장 되돌림) | `inventory_transaction.reversal_of_transaction_id`·`reversal_of_business_date` 컬럼이 **이미 있다** · `CancelResult.reversed`·`reversalTransactionNo`·`reversalBusinessDate` | ⭐ **I-5 안에서 `InventoryPostingService.reverse()` 로.** 코어 전용 PR(diff ≤ 200줄) | 취소·정정·출하취소·실적 A급 정정이 각자 「반대 부호 라인을 쓴다」를 짠다. 원장 불변식이 깨지는 1순위 자리다 |
| **예약·피킹 수량**(`reserved_qty`·`picked_qty`) | 계약 `InventoryBalance` 가 「**서버 전기가 올리고 소진되면 내린다**」 — ~~`material_issue_request`(예약 건다)~~(**못 건다** — 배정 축 3겹 부재 · I-8 §5-2 · 문의 045) · `picking:pick`(~~예약→피킹~~ 예약이 있으면 소진·없으면 `picked` 만 · I-8 §3-3) · `goods_issue:post`(피킹 소진) · `shipment_requests/.../:pick`(제품 피킹) **4자리** | ⭐ **I-8 에서 코어로.** ⛔ 지금 `InventoryPostingService` 는 이 두 칸을 **일부러 안 건드린다**(코드 주석). 계약(아키텍처 C-1 도 같다)과 **구현이 어긋나 있는 유일한 자리**다 | 4자리가 각자 `inventory_balance` 를 직접 UPDATE 하게 된다 — 결정 08 「잔량 직접 덮어쓰기 금지」를 정면으로 깬다 |
| **ERP 아웃박스**(`integration_message`) | 적재 지점 — 입고(§Z-9 로 «지금은 안 넣는다») · `work-orders:close` · `shipments:confirm` · 출고(`sendToErp`) · 조정(`erpMessageQueued`) **5자리** | **I-6(`:close`)에서 처음 만들고 I-23(`:confirm`)이 두 번째 사용처.** 그 전에는 만들지 않는다 — 적재 함수는 **`src/core/outbox/`**(사용처가 두 도메인 · I-6 R-11 · `src/integration/message` 는 조회·재처리만) 에 «하나»만 붙이면 된다 | 5자리가 각자 `integration_message.create` 를 부르며 `message_key` 규약이 갈린다(전역 `UNIQUE` 라 충돌이 런타임에 터진다) |
| **LOT 상태 전이**(`lot_status_event` 9전이 · `lot_lifecycle_history` 3전이) | 품질 축 9전이(C4~C15)를 일으키는 것 = 검사 확정 · 보류 등록/해제 · 부적합 처분 · 재등록 **5자리** / 생명주기 3전이 = 실적·마감·취소 **3자리** | 생명주기는 **I-6·I-7 에서**(`transitions.ts` 에 이미 등록돼 있다 — 코드를 안 쓰고 있을 뿐 · `lot_lifecycle_history` 를 쓰는 `LotLifecycleService.moveWithin()` 은 I-6 이 코어에 만든다 — R-12). ⚠ `production.work_order.status_code` 키는 **없다** — I-6 이 열고 I-11 이 그 키에 `work-session-start` 를 더한다. 품질 축은 **I-19 에서** 전이표를 채우고 I-20·I-21·I-23 이 재사용 | 「값 목록이 없어 막는다」(F-6)를 슬라이스마다 다르게 흉내 낸다. 회신 12·13 이 오면 고칠 자리가 5곳으로 흩어진다 |
| **채번**(`numbering_rule`·`numbering_counter`) | 표는 **이미 있다.** 지금 규칙은 `PRODUCTION_RESULT` **1건**뿐이고 나머지 전표는 서버가 형식을 지어낸다(GR-·PT-, §Z-1·문의 14) | ⭐ **I-2 에서 코어로 승격.** P/O·입하·출고·이동·조정·실사·출하 … **최소 15개 전표번호**가 뒤따른다 | `count()+1` 패턴이 15벌 복사된다. 규칙이 등재되는 순간 15군데를 고쳐야 하고, `count()` 는 취소·삭제가 생기면 번호를 재사용한다(입고에 이미 있는 잠재 결함) |
| **시리얼**(`serial_number`) | `POST /trace/serial-numbers` **1자리** + 발행 이력의 `targetTypeCode='SERIAL_NUMBER'` | ⛔ **코어로 만들지 않는다.** 사용처가 하나다 — I-26 의 서비스 안에 둔다 | — |
| **`screenId` 생략**(`ApprovalTarget`·`DocumentTarget`·`DocumentProgress`) | **3자리** | I-1 에서 「채울 표가 없으면 키를 생략한다」를 한 줄 헬퍼로 두고 I-5·I-27 이 재사용 | 세 자리가 각자 `null` 을 보낸다 — 계약이 「널을 보내지 않는다」로 막은 것이다(재검토 §3) |

---

## 3. 슬라이스 목록

범례 — **표**: 있음 / 결손(마이그레이션 필요) · **원장**: posting 을 부르는가 · **상태기계**: `transitions.ts` 에 칸을 더하는가 · **PR**: 예상 PR 수(관행 「전표 하나 + posting 연결 + e2e」 = 1, 조회 GET 묶음 = 1, 마이그레이션 = 선행 1).

| # | 슬라이스 | 건 | 선행 | 표 | 마이그 | 원장 | 상태기계 | PR |
|---|---|---|---|---|---|---|---|---|
| I-1 | 승인 코어 — 결재선·결재함 | 12 | — | 있음 | ⚠ `approval_route` 유일 제약(§I-35) | ✕ | ⭕ `approval_request.status_code` | 3 |
| I-2 | P/O(발주) + 채번 코어 | 7 | I-1 | 있음 | ⚠ P/O 유일 제약(§I-48) | ✕ | ⭕ | 3 |
| I-3 | 입하 — 라인·차이·초과분리 | 12 | I-2 | 있음 | ✕ | ✕ | ⭕ | 3 |
| I-4 | 출고 — 전표·전기 | 7 | I-3 | 있음 | ⚠ `goods_issue.destination_id` NOT NULL 해제(#147) | ⭐ | ⭕ | 3 |
| I-5 | 다형 취소 + 역트랜잭션 코어 | 4 | I-3·I-4 | 있음(`document_cancellation`) | 완화 1(`reason_code` NOT NULL 해제 · R-1) | ⭐ 역 | ⭕ | 6 |
| I-6 | W/O — 발행~마감 + 4M 배정 | 13 | I-2 | ⚠ `work_order_resource_assignment` 축이 다르다(네 칸 유지 · `SHIFT` 는 이 경로로 안 채워진다) | ⭕ 식 유일 인덱스 1(`remainder_disposition_code` 는 `close_disposition_code` 로 이미 있다 — I-6 R-9) | ✕ | ⭐ | ~~4~~ **7**(I-6 R-5) |
| I-7 | 생산 실적 + LOT 생명주기 | 7 | I-6 | 있음 | ⚠ 2(D1 `shift_id` 완화 · D2 `correct_reason_code` · I-7 재수립 R-19) | ✕ | ⭐ L1 만(L2·L3 는 I-6 이 병합해 «쓰기»는 끝났다 · L2 상수 정정 I-7 PR ①) | 4 |
| I-8 | 출고요청·피킹·예약 코어 | 8 | I-4 | 있음 | ✕ | ⭐ 예약/피킹 칸 | ⭕ | 3 |
| I-9 | 생산창고 입고 | 3 | I-8 | 있음 | ⚠ 차이 전기 자리가 없다 | ⚠ 미정 | ⭕ | 2 |
| I-10 | 자재 투입·반출 + 계보 | 6 | I-9·I-7 | 있음 · `lot_relation` 은 이 슬라이스가 쓰지 않는다(052) | **2** NOT NULL 완화(`terminal_id`·`return_quality_status_code`) | ✕ | ✕ | 3 |
| I-11 | 작업 세션·작업전점검 | 11 | I-6 | 있음 | **1** NOT NULL 완화(`work_session.shift_id` · R-3) | ✕ | ⭕ 세션 | 5 |
| I-12 | 적치 완료·임시적재 | 4 | (입고 구현됨) | 있음 | ✕ | ⭐ | ⭕ | 2 |
| I-13 | 재고 이동 2단 | 6 | I-5 | 있음 | **⭕ A4** | ⭐ ×2 | ⭕ | **4** |
| I-14 | 재고 조정 | 7 | I-1·I-5 | 있음 | **⭕ N-1** | ⭐ | ⭕ | **4** |
| I-15 | 실사 | 6 | I-14 | 있음 | ✕ | ✕(조정이 진다) | ⭕ | 3 |
| I-16 | 취급 단위·포장·재구성 | 7 | I-12 | **신설 2**(`handling_unit_repack_event(+_line)`) | **⭕ N-2** | **✕ 확정**(원장 미경유) | ⭕ | **4** |
| I-17 | 재생재 등록 | 1 | I-3 | 있음(`recycle_entry`) | ⚠ `item.mes_category_code` 없음(#64) | ⭐ | ✕ | 1 |
| I-18 | LOT 부가·상태 이력·IQC 생략 | 5 | I-1 | 있음 | ✕ | ✕ | ✕ | 2 |
| I-19 | 검사 — 의뢰·결과·측정·확정 | 11 | I-7 | 있음 | ⚠ `#280` 검사 의뢰 기준 완화 | ✕ | ⭐ 품질 축 | 4 |
| I-20 | LOT 상태·보류 | 10 | I-19 | 있음 | ✕ | ✕ | ⭕ | 3 |
| I-21 | 부적합·처분·특채 | 11 | I-20 | 있음 | ✕ | ✕(폐기는 I-4 재사용) | ⭕ | 3 |
| I-22 | 출하지시·작업지시·제품 피킹 | 9 | I-8 | 있음 | ✕ | ⭐ 예약 | ⭕ | 3 |
| I-23 | 출하·확정·취소 + 재등록 | 7 | I-22·I-5 · **I-19 품질 전이 코어(재등록, A)** | 있음(재등록은 `stock_transfer` 재사용) | ⚠ 긴급 출하 사유(§I-41) | ⭐ | ⭕ | 4 |
| I-24 | 생산 계획·생산오더 | 10 | I-6 | 있음 | ⭕(A11 두 칸 — I-24 R-1) | ✕ | ⭕ | 4 |
| I-25 | 공정 인계·수리 왕복 | 6 | I-7 | 있음 | ✕ | ✕ | ✕ | 2 |
| I-26 | 제품 개체 조회·발번 | 2(진행1·보류1) | I-7 | 있음 | 현재✕ | ✕ | 현재✕·조건부 채번별도 | GET1 + 조건부 코어/쓰기 |
| I-27 | 발행 이력·프린터 | 7(진행5·유보1·제외1) | I-26저장조회 | A9nullable6/A10유보 | ✕ | ✕ | ✕ | R16 책임별 |
| I-28 | 알림 | 8 | I-1 | 있음 | ✕ | ✕ | ✕ | 2 |
| I-29 | 통합 대시보드 | 1 | 전부 | 있음 | ✕ | ✕ | ✕ | 1 |
| I-30 | 설비 점검·고장 | 9(진행8·보류1) | — | A15 nullable8추가·2완화 | ✕ | ✕ | ⭕ 고장 start, 완료 보류 | 실행8 + 조건부 |
| I-31 | 보전 지시·실적 | 8 | I-30·I32순간helper | 확장/완화·표2 | MO/cancel·부여/PM최소공유 | ✕ 기존출고참조 | ⭕ 지시 | R12 최소책임별/초과 때만 분할 |
| I-32 | 비가동 | 6 | I-11 | 있음 | ✕ | ✕ | ✕ | 2 |
| I-33 | 툴 사용·계측기·수집 채널 | 12 | I31경계·I32순간 | 추가4/5/8·완화2/3·T | 네축NULL式/검교정유형별유일·A참조조율 | ✕ | 누계NKU·CAL기본효과 | R14 10조각후보 |
| I-34 | 첨부 | 4 | — | 있음(`attachment`) | ✕ | ✕ | ✕ | 1 (3건 건너뜀) |
| I-35 | 변경 이력·예비품 엑셀 | 2 | — | 있음 | ⚠ audit jsonb 규약(§I-5) | ✕ | ✕ | 2 |
| | **합계** | **249** | | | | | | **92** |

### 3-1. 슬라이스별 상세

각 절의 형식 — 「체인 마디 · 원장 · 예상 설계 미정(§2 절차 초안)」. **오퍼레이션 전건은 §10 부록**에 슬라이스별로 실었다.

##### I-1 · 승인 코어 — 결재선·결재함 — 12건

**체인 마디**: 없음 — 뒤의 9자리가 매달리는 «가로대»다. `approvalTypeCode` 9값이 오퍼레이션과 1:1 이라 여기서 정한 판정이 그대로 9번 쓰인다.
**원장**: 없음. **상태기계**: `app.approval_request.status_code` 칸을 새로 연다 — 상신 → 승인/반려. `approval_step` 은 기록 전용(수정·삭제 없음).
**예상 설계 미정**
- `approval_route` 의 유일 키가 모델에 없다(§I-35 · 계약은 「같은 `(approvalTypeCode, businessUnitId)` 활성 결재선 중복이면 400」). → **§2 1단계 가장자리** → 2단계 기준 2「거부하는 쪽」 → 앱에서 먼저 막고 부분 유일 인덱스는 **선행 마이그레이션**으로 건다(`WHERE is_active`).
- `approval_request.status_code` 값 목록이 `#213` 대기다. → 2단계 기준 5「새 개념 수가 적은 쪽」 → `PENDING`·`APPROVED`·`REJECTED` 셋만 두고 `transitions.ts` 에 등록, 요청서에 적는다.
- `ApprovalTarget.screenId` → 계약이 물러난 길을 이미 적었다(「정하지 못하면 키를 생략한다」) — 그대로 따른다. 판단 아님.


##### I-2 · P/O(발주) — 전표+승인 상신 — 7건

**체인 마디**: 체인의 머리. `purchase_order` → (I-3) `inbound_receipt_line.purchase_order_line_id`.
**함께 서는 코어 — 채번**(`app.numbering_rule`·`numbering_counter`). 표는 이미 있고 규칙이 `PRODUCTION_RESULT` 하나뿐이다. 여기서 **`NumberingService.next(documentTypeCode, plantId, businessDate)`** 를 세우고, 규칙이 없으면 «서버 기본 패턴»으로 떨어지되 그 패턴을 **한 곳에** 둔다. 입고가 이미 쓰는 `GR-`·`PT-` 도 이 함수로 옮긴다(diff 는 입고 서비스 15줄).
⛔ `count()+1` 을 복사하지 않는다 — 취소가 생기면 번호를 재사용하고, 15개 전표에 퍼지면 되돌릴 수 없다.
**예상 설계 미정**: 채번 형식 미등재(문의 14 — 「값 정의」라 권고안대로 구현). P/O 유일 제약·OCR 자리(§I-48) → 선행 마이그레이션.


##### I-3 · 입하 — 등록·라인·차이·초과분리 — 12건

**체인 마디**: `purchase_order_line` →(②) `inbound_receipt_line` → 자재 LOT 생성 →(④) 이미 구현된 입고가 이어받는다. **여기가 서면 M1 의 앞쪽 절반이 닫힌다.**
**원장**: ⛔ 없다. §Z-2 가 이미 판정했다 — 「원장을 지는 것은 입고다」. `businessDate` 는 받아서 형식만 검증하고 저장하지 않는다(회신 15 의 실물).
**분리 등록**(`:split`)은 정량분·초과분 두 입하를 한 트랜잭션으로 만든다 — 라인 수준의 원자성이 e2e 의 핵심 단언이다.
**예상 설계 미정**
- `Lot.receiptDispositionCode`(§Z-5)가 「입하 라인의 칸인가 LOT 의 칸인가」 미해소. → **본길이 아니다**(입하 등록은 이 값 없이 성립) → 1단계 가장자리 → 3「스키마를 안 늘리는 쪽」 → 칸을 빼고 요청서에 남긴다.
- ASN 은 조회 3건뿐이고 등록 경로가 계약에 없다(연계가 채운다) — 시드가 필요하다. e2e 는 `asn` 을 직접 INSERT 해 만든다.


##### I-4 · 출고 — 전표·전기·원장 out — 7건

**체인 마디**: ⑧ `goods_issue` — **재고가 처음으로 «나가는» 자리**. `sourceDocumentTypeCode` 3값이 세 업무를 가른다(피킹=생산투입 · 입고=반품/자재폐기 · 처분결정=제품폐기).
**원장**: ⭐ `GOODS_ISSUE`. 라인마다 `from`={출발 창고·위치·품질상태·재고상태}, `to`= 헤더 `destinationTypeCode` 가 `LOCATION` 이면 그 위치, `PARTNER`/`DISPOSAL_SITE`/비움이면 **없음**. `goods_issue_line.inventory_transaction_line_id` 로 되짚는다(입고와 같은 모양). ⚠ `from` 의 품질·재고 상태 두 칸은 계약 `GoodsIssueLineUpsert` 에 **없다** — 7칸 키로 `inventory_balance` 를 잠그고 되읽어 1행이면 그 값, 2행+ 면 400(문의 031 · I-4 재수립 R-1).
⭐ **M1 최단 경로가 여기 있다** — `sourceDocumentTypeCode='GOODS_RECEIPT'`(자재 폐기·공급사 반품)는 **피킹 없이** 성립한다. 즉 I-8 을 기다리지 않고 「불출 → balance 감소」를 닫을 수 있다.
**예상 설계 미정**
- ~~차단 판정: `trace.lot.status_code ∈ {DEFECTIVE, SCRAPPED, INSPECTION_PENDING}` 이면 400~~ → **철회**(I-4 재수립 R-7). 그 집합은 폐기(`W-01-06` 불량창고 입고분 · `W-04-10` 처분=폐기)·반품(`W-01-05` 보류 LOT)을 **전건 400** 으로 만들어 바로 위 「M1 최단 경로」와 자기모순이다. 결정 10 의 단일 지점은 `mdm.judgment_type_control.blocks_issue`(실재 · 시드·DB 0행) — I-4 는 그 칸을 읽고 문자열 집합을 박지 않는다(오늘은 아무것도 안 막는다). `blocks_picking` 은 I-8.
- ~~`goods_issue.destination_id` NOT NULL → 선행 마이그레이션~~ → **이미 적용됨**(`20260901090000_goods_issue_destination_and_spare` · #44 ≡ #147). I-4 마이그 **0건**.


##### I-5 · 다형 취소 — document-progress — 4건

**체인 마디**: 체인 «전체»를 거꾸로 되짚는 가로대. 조회 9종 · 취소 실행 3종.
**함께 서는 코어 — 역트랜잭션**: `InventoryPostingService.reverse(tx, {원 트랜잭션})` 를 **전용 PR(diff ≤ 200줄)** 로 만든다. `inventory_transaction.reversal_of_transaction_id`·`reversal_of_business_date` 컬럼이 이미 있다. 역처리가 잔액을 음수로 만들면 400(계약 명시).
**핵심 판정 — `successorCount`·`cancellable`**: 원천 참조가 다형(`source_document_type_code`+`source_document_id`)이라 「유형 → 어느 표를 뒤져야 하나」 표가 서버에 필요하다. 계약이 그 표를 명시적으로 서버 소유로 넘겼다(A-10 보강). ~~`entity_type_registry` 표가 이미 있으니 거기서 읽는다 — 코드에 표를 박지 않는다.~~ ⭐ **I-5 재수립 R-6 으로 절반 기각** — 등록부는 칸이 넷(`schema_name`·`table_name`·`id_column_name`·`is_active`)이라 `DocumentProgress` required 10 을 못 채우고 9종 중 4종이 없다. 매핑은 코드의 정적 표 하나, 등록부는 부팅 시 대조(로그 경고)에만 쓴다.
⭐ `:cancel` 은 승인 후 **재판정**한다 — `SUCCESSOR_EXISTS` 400. 승인은 그대로 유효하다(J-8). e2e 가 「승인 → 그 사이 후속 생성 → 실행 400 → 승인은 살아 있음」을 반드시 못 박는다.
**예상 설계 미정**: 취소 흔적 컬럼이 14표 중 2표에만 있다(§I-38). → `app.document_cancellation`(다형 표)이 이미 있으므로 **컬럼을 늘리지 않고 그 표에 적는다** — 2단계 기준 3「스키마를 안 늘리는 쪽」.


##### I-6 · W/O — 발행·확정배포·중단·재개·취소·마감 + 4M 배정 — 13건

**체인 마디**: ⑬ `work_order` — 생산 흐름의 머리. `:release` 가 ⑭ 생산LOT 선발행 + 자재 출고요청 자동 발행(R29)까지 한 트랜잭션.
**원장**: 없음. **상태기계**: ⭐ 이 슬라이스가 가장 크다 — `work_order.status_code`(발행·확정·중단·재개·취소·마감) + `trace.lot.lifecycle_status_code` 의 **L2·L3**(`transitions.ts` 에 이미 등록돼 있다 — 처음으로 «쓰는» 자리).
**4M 배정**: 계약은 `WorkOrderResourcePlan{resourceTypeCode, resourceId}` 인데 물리 `work_order_resource_assignment` 는 `equipment_id`·`mold_id`·`worker_id`·`shift_id` **네 칸으로 갈라 두었다**. 계약이 요구하는 `uq(work_order_id, resource_type_code, resource_id)` 도 없다.
→ **§2 1단계 본길이 아니다**(매핑 규칙은 결정 가능) → 2단계 기준 3「스키마를 안 늘리는 쪽」 → **네 칸을 유지하고 `resourceTypeCode` 로 어느 칸에 넣을지 가른다.** 유일 제약은 `(work_order_id, resource_type_code, COALESCE(equipment_id, mold_id, worker_id, shift_id))` **식** 유일 인덱스(`WHERE` 없음 · `ck_work_order_resource_target` 이 하나만 non-null 임을 보장)로 **선행 마이그레이션**(I-6 R-9).
**예상 설계 미정**
- `:close` 의 「정상」 허용 오차 폭 → 서버 정책(계약이 그렇게 적었다). 상수로 두고 근거를 적는다.
- 잔량 이월의 자동 전개 여부 → 계약이 「정해지지 않았다 — 정해지기 전까지 만들지 않는다」로 이미 물러났다. 그대로 따른다.
- ~~`remainder_disposition_code` 컬럼이 물리에 없다(§I-25) → 선행 마이그레이션~~ → **이미 있다** — `work_order.close_disposition_code`(`20260826000000_data_model_v4:72` · I-6 실측).
- POP 버퍼 미동기 실적 게이트 → 「서버가 단말 버퍼를 볼 수단이 계약에 없다」(계약 자인) → **본길** → 판정을 만들지 않고 요청서에 싣는다.


##### I-7 · 생산 실적 — 등록·정정·상신 + LOT 생명주기 L1 — 7건

**체인 마디**: ⑮~⑱ — 실적이 생산LOT 에 붙고 소비 계보가 닫힌다. **M1 의 종점**.
**원장**: ⛔ 없다(§1-4). 제품이 재고로 잡히는 것은 **이미 구현된 입고**(`sourceDocumentTypeCode='PRODUCTION_RESULT'`)다 — 그래서 M1 체인 e2e 는 실적 뒤에 «기존» 입고 오퍼레이션을 한 번 더 부른다.
**상태기계**: ⭐ L1(WAITING→ACTIVE) 을 처음 «쓴다». `production_result_lot_allocation`·`lot_lifecycle_history` 가 실적 저장과 **같은 트랜잭션**(원칙 2 「lot 계보」). `material_usage_allocation` 은 ~~투입(I-10) 이 쓴다~~ **I-10 도 못 쓴다**(CHECK `ck_material_usage_target` 이 `production_result_id`/`output_lot_id` 를 요구하는데 투입 시점엔 둘 다 없다 · I-10 §2-3 · 문의 052) — 실적은 건드리지 않는다(I-7 재수립 R-19). 저장소 전체에서 이 표를 채우는 자리가 0 이다.
**예상 설계 미정**
- `:correct` 의 A급 판정을 「서버가 정정 내용으로 판정한다」인데 등급 기준이 없다. → 1단계 **본길**(모든 정정의 승인 필요 여부가 갈린다) → 계약 문자 그대로 + 문의. 잠정: 「수량 5칸 중 하나라도 바뀌면 A급」 — 계약이 「수불에 영향」이라 적은 것의 가장 좁은 해석이고, 넓히는 것은 호환 완화다.
- 지연 실적의 마감 뒤 편입(R83) → I-6 의 게이트 물음과 같은 뿌리. 함께 요청서에 싣는다.


##### I-8 · 자재 출고요청·피킹·예약 — 8건

**체인 마디**: ⑥⑦ — 「BOM 소요 → 예약 → 피킹 → 출고」. I-4 가 만든 출고를 **정식 경로**로 잇는다.
**함께 서는 코어 — 예약·피킹 수량**. ⛔ 지금 `InventoryPostingService` 는 `reserved_qty`·`picked_qty` 를 안 건드리는데, 계약 `InventoryBalance` 는 「서버 전기가 올리고 소진되면 내린다」라 적었다. 넷이 쓴다(출고요청·자재피킹·출고전기·제품피킹).
→ **§2 0단계 선례 있음**(계약 본문이 인용 가능) → 코어에 ~~`reserve()`/~~`pick()`/`consume()` **둘**을 더한다(`reserve()` 는 예약을 걸 잔액 행을 정할 근거가 0 · 사용처 0 → 첫 사용처 **I-22** · I-8 §3-7). 잔량을 직접 UPDATE 하는 길은 여전히 posting 하나뿐이다(결정 08).
**예상 설계 미정**
- 「부족」 판정(`/material-issue-requests/shortage`)이 BOM 소요 − 기출고를 서버가 낸다. BOM 버전 선택 기준(작업지시 시점 스냅샷인가 현재 확정본인가)이 계약에 없다. → 1단계 가장자리(버전이 갈린 품목에서만) → 2단계 기준 4「조용히 도출하지 않는 쪽」 → ~~`work_order`/`lot` 이 이미 든~~ **`work_order` 에는 `bom_id`·`bom_version` 이 없다**(I-6 실측) — `production_plan.bom_id`(NOT NULL) 를 `:release` 가 `lot.bom_id`/`bom_version` 스냅샷으로 찍고 ~~I-8 은 그 스냅샷을 쓴다~~ **I-8 은 `production_plan.bom_id` 단일 축**(스냅샷 축은 미배포 W/O 를 400 으로 막아 `W-02-10` 「BOM 소요량 불러오기」를 죽인다 · `PUT /planning/production-plans` 로 계획 BOM 이 바뀔 수 있음은 실측 — 알려둘 것 ⓓ · I-8 §7-2 · R-24). 소요 = `required_qty × order_qty ÷ bom.base_qty`(스크랩률 미적용 — I-6 R-18 · 문의 037).
- `picking_line.status_code` 값 목록 없음(`G-2`) → 값을 내려주되 서버가 분기하지 않는다.


##### I-9 · 생산창고 입고 — shopfloor-receipts — 3건

**체인 마디**: ⑨ — 출고분이 생산창고에 도착한다.
**원장**: ⚠ **이 슬라이스의 유일한 진짜 물음.** `ShopfloorReceiptCreate` 는 `businessDate` 를 싣는데(원장을 지난다는 신호) `shopfloor_receipt_line` 에는 원장 FK 컬럼이 **없고** 계약 `ShopfloorReceiptLine` 에도 없다. 그런데 `variance_qty`(출고량 − 입고량) 파생 컬럼은 있다.
→ **§2 0단계**: 선례는 `stock_transfer` 다 — 반출/도착 2단이고 그 중간을 `inventoryStatusCode='IN_TRANSIT'` 로 표현한다(계약 `InventoryBalance.inventoryStatusCode` 4값에 실재).
→ **1단계**: 차이가 0 이면 결과가 같으므로 **가장자리**.
→ **2단계 기준 1「재고·원장·상태를 쓰지 않는 쪽」** → **차이가 있어도 원장을 만들지 않는다.** 차이는 `variance_qty`+`variance_reason_code` 로 «기록»만 하고, 재고를 맞추는 것은 **재고 조정(I-14)** 의 몫이다(결정 49 「실사 조정 = 원장 트랜잭션」과 같은 결). `businessDate` 는 §Z-4 판정대로 형식만 검증한다.
→ **3단계 흔적**: 단언 테스트에 `// 설계 미정 — 문의 NNN(생산창고 차이의 원장 처리)`.
⚠ 이 판정이 뒤집히면 `shopfloor_receipt_line` 에 컬럼이 붙는 마이그레이션이 생긴다 — 「차이가 크다」 3조건 중 첫째에 걸리므로 그때는 이 슬라이스만 3관점 재수립.
→ **I-9 계획서(2026-09-07) 실측 확인** — 뒤집을 근거 0. 덤: 한 출고 = 수령 전표 하나 · 본문 라인은 출고 라인 **전건**(빠지면 400 `LINE_REQUIRED` · I-9 R-1) ⇒ 체인 ⑨ 는 1:1 로 굳는다.


##### I-10 · 자재 투입·반출 — 계보(lot_relation) — 6건

**체인 마디**: ⑩⑪ — 자재LOT → 생산LOT 계보가 **시작되는 지점**(계약 문구). ⚠ ⑪ 은 이 슬라이스가 **만들지 않는다**(아래 계보).
**원장**: ⛔ **투입도 반출도 없다**(I-10 §4-4 · 재수립 R-2). `material_return_line.inventory_transaction_line_id` 컬럼은 실재하나 계약 `MaterialReturn`·`MaterialReturnCreate`·`MaterialReturnLine` 어디에도 원장·`inventoryTransactionLineId` 언급이 0건이라 채우지 않는다 — `STOCK_TRANSFER` 의 첫 사용처는 **I-13 그대로**. ~~반출(`material-returns`)만 ⭐ 있다~~(2026-09-07 정정).
**계보**: `lot_relation` 은 계약 7벌에 **자원이 전무하다**(계약 x-internal-note: 「읽거나 쓰는 화면이 118장 중 0장」). 계약이 「서버가 계보 관계를 이 등록과 한 트랜잭션으로 만든다」라 적었으나 **이 등록에서는 만들지 않는다**(I-10 §3-9 · 재수립 R-1) — 투입 시점에 생산LOT 이 아직 없고(`ck_material_usage_target` 도 같은 이유로 못 채운다 · §3-10) `relation_type_code`·`allocation_method_code`·`trace_accuracy_code` NOT NULL 셋의 문자열이 계약·화면·시드 어디에도 없다. 소비자 실측 0(`src/`·`test/`·seed · `shipment_lot_allocation` 은 별도 표). **문의 052** 회신 뒤에 만든다(선택지 ② = 실적 시점 후속). ~~그래도 서버는 써야 한다 · e2e 는 DB 를 직접 읽어 단언한다~~.
**코드 상수 셋**: `material_consumption.consumption_type_code='NORMAL'`·`status_code='RECORDED'` · `material_return.status_code='REQUESTED'` — 계약 `x-no-code-key` 로 판정 주체를 서버에 넘겼고 응답 required 라 문자열은 서버가 골랐다(**문의 053** 판정 확인 요청 · 재수립 R-4·R-5). `return_quality_status_code` 는 요청·응답 어디에도 칸이 없어 값을 만드는 대신 NOT NULL 을 푼다(마이그 2 중 하나).
**예상 설계 미정**: ~~`trace_accuracy_code`·`allocation_method_code` 값 목록 미확정인데 컬럼은 NOT NULL~~ → `material_usage_allocation` 자체를 이 슬라이스가 못 쓴다(위 계보 · 052). 단말 토큰은 발급(`terminal.service.ts:200-223` `issueToken`)만 있고 검증·계약 `security` 선언이 0 이라 `terminal_id` NOT NULL 을 푼다(**문의 054** · I-11 과 공동).


##### I-11 · 작업 세션 — 세션·이벤트·작업자·작업전점검 — 11건

**체인 마디**: 실적의 «구간» 축. `work_session` → `production_result.work_session_id`(비울 수 있다).
**원장**: 없음. **상태기계**: 세션 상태(열림/중단/종료) — ⚠ W/O 층의 `:hold`/`:resume` 와 **다른 축**이다(계약이 명시). 섞으면 두 축이 한 필드가 된다.
⭐ `work_session.idempotency_key` 가 **전역 UNIQUE** 다(아키텍처 C-3 실측) — ~~한쪽만 쓴다~~ → **둘 다 쓴다**(판정은 `runIdempotent` · 컬럼은 둘째 그물 — I-7 `production_result` 방식 그대로 · I-11 §3-4).
**예상 설계 미정**: ~~`can_start_work` 게이팅의 판정 입력(단말·점검 이력·W/O 상태)이 세 표에 흩어져 있다~~ → 서버 몫은 **`can_start_work` 하나**(입력 두 표 `routing_operation` → `terminal_process`) · 점검 이력은 화면이 판정한다(`P-02-02` §5-9 · I-11 §3-6). **단말 토큰 부재 → 403**(게이팅을 판정할 수 없다 · F-6 · I-11 재수립 R-1) — 투입·반출(I-10 R-3)과 답이 다른 이유는 계약 ⌜서버가 강제한다⌝ 한 줄. 마이그 1(`work_session.shift_id`).


##### I-12 · 적치 — 완료·임시적재(원장 STOCK_TRANSFER) — 4건

**체인 마디**: ⑤ — 이미 구현된 입고가 «만든» 적치 지시를 닫는다. **선행이 이미 서 있어 언제든 낄 수 있다** — 병렬 후보 1순위.
**원장**: ⭐ `STOCK_TRANSFER`. `from`=`from_location_id`(입고가 전기한 장부 위치), `to`=`actual_location_id`. `putaway_task.inventory_transaction_line_id` 로 되짚는다.
**예상 설계 미정**: `capacityQty` 를 권장 판정에 쓰지 않는다(§Z-11 에서 이미 판정 완료 — 반복하지 않는다). 임시 적치의 상태값 `COMPLETED_TEMPORARY` 는 계약이 문자열을 줬다.


##### I-13 · 재고 이동 — 반출·도착 2단 — 6건

⛔ **2026-09-08 · 통보 059 — I-13 이 반드시 지킬 것.** 적치(I-12)가 이미 `source_document_type_code='STOCK_TRANSFER'` 로 원장을 쌓고 있고, **`transaction_no` 의 `PT-` 접두어가 그 둘을 가르는 «정본 판별 규칙»**이다. ⇒ **I-13 의 재고 이동은 `PT-` 접두어를 쓰지 않는다.** 쓰면 한 값에 두 뜻이 섞여 **식별조차 못 하게 되고**, 이미 쌓인 원장 행은 `block_ledger_header_mutation` 때문에 **정정이 불가능**하다. ⭐ **서버 실측(2026-09-08 · 레인 C)**: 채번은 `STOCK_TRANSFER: 'ST'` 로 이미 서 있고(`src/core/numbering/numbering.service.ts:36`) 전기는 그 번호를 그대로 쓴다(`src/logistics/stock-transfer/transfer-posting.ts:134`) — 병합된 반출 전기는 이 규칙을 지키고 있다.

**체인 마디**: 창고 간 이동. 체인의 본줄기가 아니라 «가지»이지만 **`IN_TRANSIT` 를 처음 쓰는 자리**다(~~I-9 판정의 선례가 된다~~ — I-9 는 `IN_TRANSIT` 를 안 쓰고 먼저 닫혔다 · I-9 R-17).
**원장**: ⭐ 두 번 — 반출이 `from`=출발, `to`={도착 창고, `IN_TRANSIT`} · 도착이 `from`={도착 창고, `IN_TRANSIT`}, `to`={도착 창고·위치, **반출 원장 라인의 `from_inventory_status_code`**}. ⛔ ~~`AVAILABLE` 고정~~ — 고정하면 **보류 재고가 이동만으로 가용이 된다**(세탁). 화면 `M-01-10` §5-3·§6 이 보류 LOT 이동을 「경고 + 진행 가능」(결정 14)으로 **정상 경로**로 열었고, 적치·출고 선례도 상태를 바꾸지 않는다(`putaway-posting.ts:52-53`·`issue-posting.ts:196-198`) · I-13 재수립 R-2. ⚠ 도착 손검사는 **반출 원장이 준 11칸으로 잠근 행**에서 한다 — 7칸 잠금 그대로면 두 번째 이동이 언제나 400 이다(R-6). `stock_transfer_line` 이 `issue_transaction_line_id`·`receipt_transaction_line_id` **두 칸**을 가진 것이 이 2단의 물증이다.
**예상 설계 미정**: `IN_TRANSIT` 행의 `location_id` 는 NOT NULL 인데 이동 중에는 위치가 없다. → 2단계 기준 3 → 도착 위치를 미리 쓴다(`to_location_id`).
⛔ **취소는 I-13 이 만들지 않는다**(2026-09-07 · 레인 C 지적). 문서는 **1건**이고 원장 전기가 2회일 뿐이다(계약 `x-internal-note` 「두 문서가 아니라 한 문서의 두 전이다」). 취소 API 의 `documentTypeCode` 는 입하·입고·출고 3종뿐이라 `STOCK_TRANSFER` 에 실행 경로가 없고, `document-type-registry.ts` 도 `cancelable: false` 로 이미 등록했다. §508 의 「I-13 이 각자 취소를 짠다」는 I-5 를 앞당긴 «이유»를 적은 문장이지 I-13 의 범위가 아니다 — 미지원으로 두고 문의로 올린다.


##### I-14 · 재고 조정 — 등록·상신·전기 — 7건

**체인 마디**: 원장을 직접 움직이는 넷째 판별자. 실사(I-15)·생산창고 차이(I-9)·호퍼 실측이 모두 여기로 모인다.
**원장**: ⭐ `INVENTORY_ADJUSTMENT`. 라인이 증/감을 함께 담으므로 `from`만/`to`만 라인이 섞인다.
**승인**: `:request-approval` → I-1 재사용. `:post` 는 승인이 안 끝났으면 400(계약).
**설계 미정 — 판정됨**(I-14 재수립 R-1): 조정이 «어느 상태로» 넣는가(`quality_status_code`·`inventory_status_code`). 계약은 **안 싣는다**(실측). ⇒ **등록·치환 시점에 잔액 행에서 읽어 라인에 저장**하고 `:post` 는 저장값을 그대로 `PostingEndpoint` 에 싣는다 — 0행이면 400, 2행+면 400(2단계 기준 4 · 문의 130). ⚠ 전기 손검사는 **저장된 두 코드로 좁힌 11칸 행**에서 한다(잠금은 7칸 · R-2).


##### I-15 · 실사 — 개시·라인·마감 — 6건

**체인 마디**: 실사 → 차이 → 조정(I-14). ⛔ **실사 자신은 원장을 쓰지 않는다** — 결정 49 「잔량 직접 덮어쓰기 금지」.
`POST /inventory/counts` 는 라인을 **서버가 장부에서 만든다**(화면이 열거하지 않는다) — 창고 하나에 수천 라인이라 페이지네이션이 필수.
**예상 설계 미정**: `:close` 의 통과 조건(「미실사 0 · 차이 없음 또는 전부 조정됨」)은 계약이 적었다. 「조정됨」을 무엇으로 판정하나 — `inventory_count_line` ↔ `inventory_adjustment_line` 연결이 필요하다. `inventory_adjustment.inventory_count_id` 로 헤더는 이어진다. ⭐ **라인 대응은 I-14 가 연다** — 마이그 N-1(`inventory_adjustment_line.inventory_count_line_id`)가 서므로 I-15 는 헤더 단위로 물러설 필요가 없다(I-14 재수립 R-4). 판정식: 「이 실사의 `variance_qty <> 0` 인 `inventory_count_line` 중, `inventory_adjustment_line.inventory_count_line_id` 로 가리켜지고 그 조정 헤더가 `POSTED` 인 것이 아닌 행이 0」. ⚠ I-15 가 `TRUNCATE … CASCADE` 를 쓰면 조정 라인이 함께 비워진다.


##### I-16 · 취급 단위 — 등록·구성·포장확정·재구성 이력 — 7건

**체인 마디**: 포장 단위 — I-22 의 `shipment_lot_allocation` 에 연결된다(`PUT /logistics/shipment-lot-allocations/{id}`).
**원장**: ⚠ 미정. 포장은 «어디 있나»를 바꾸지 않고 `handling_unit_id` 차원만 붙인다. `inventory_transaction_line.handling_unit_id` 칸은 있다. → 2단계 기준 1「재고를 안 쓰는 쪽」 → **원장을 만들지 않는다**. ⛔ ~~재구성 이력은 `handling_unit_reconfiguration`(+`_line`)에 적는다 — 표가 이미 있다~~ — **이름만 보고 칸을 안 본 판정이었다**(I-16 재수립 R-1). 그 표는 라인 필수 6칸 중 **4칸이 없고**(`handling_unit_id`·`role_code`·`qty_before`·`qty_after`), 헤더 NOT NULL 3칸이 계약에 원천 0 이며, 결정타로 **`ck_handling_unit_reconfiguration_distinct(source ≠ target)` 가 계약의 대표 경로(한 HU 의 `PUT …/contents`)를 구조적으로 막는다.** 재사용하려면 FK 있는 NOT NULL 칸(`uom_id`)을 지어내고 `moved_qty > 0` 도 풀어야 한다 ⇒ **표 2 신설(N-2)**. 계약이 「데이터 모델 담당에게 통지 — 기다리지 않는다」라 적은 것이 **아직 유효하다**(문의 140).


##### I-17 · 재생재 등록 — 1건

**체인 마디**: 분쇄재 → 새 자재 LOT + 재고 증가, 한 트랜잭션. `recycle_entry` 표는 **실재한다**(계약은 「담을 표가 없다」고 적었는데 물리에 있다 — 되돌림 항목).
**원장**: ⭐ 있다(「그 수량만큼 재고를 늘린다」). 판별자가 계약에 없다 → 2단계 기준 5 → 「들어온다」이므로 `GOODS_RECEIPT` 로 두고 요청서에 싣는다. *(추측 — 계약이 말하지 않는다.)*
**예상 설계 미정**: `item.mes_category_code`(재생재 품목 축)가 물리에 없다(#64) → 품목을 그대로 쓰고 하위 구분을 만들지 않는다.


##### I-18 · LOT 부가 — 외부식별자·보류 조회·상태 이력·IQC 생략 — 5건

**체인 마디**: 가지. 조회 4 + IQC 생략 요청 1. **원장·상태기계 없음** → 커버리지를 싸게 올리는 슬라이스(병렬 후보).
`GET /trace/lot-status-events`·`/trace/lot-lifecycle-events` 는 표(`lot_status_event`·`lot_lifecycle_history`)가 이미 있고 I-7·I-19 가 «쓴다» — 조회를 먼저 세워도 빈 목록이 나올 뿐 깨지지 않는다.
`:request-iqc-skip` 은 I-1 재사용(`approvalTypeCode='IQC_SKIP'`).
~~**예상 설계 미정**: 회신 12(한도승인 재고 상태 값)가 여기 붙는다~~ → ⛔ **이 슬라이스가 아니다.** I-18 재수립 R-10 실측 — `:request-iqc-skip` 의 본문 `ApprovalRequestCreate` 는 프로퍼티가 `reason` 하나뿐이라 **한도를 받을 칸이 0개**이고, 이 슬라이스는 재고·LOT 상태를 **한 칸도 안 옮긴다**. 회신 12 는 **I-21(특채) 단독**이다(`design-inquiries/재정리-2026-09-08-레인A.md` · **통보 089 §2** 가 `concession.status_code = 'APPROVED'` 로 이미 판정했다).


##### I-19 · 검사 — 의뢰·결과·측정치·판정 확정 — 11건

**체인 마디**: ⑳~㉒ — 실적/입하 LOT → 검사 → **Lot Status 전이**. 품질 축 전이표를 처음 채우는 자리.
**원장**: 없음. **상태기계**: ⭐ `trace.lot.status_code` — `transitions.ts` 가 **일부러 비워 둔 칸**이다(값 불일치 때문). 회신 E-3 으로 `LOT_STATUS` 4값(`NORMAL`·`DEFECTIVE`·`INSPECTION_PENDING`·`SCRAPPED`)이 확정됐고 계약 `InventoryBalance.qualityStatusCode` 가 같은 넷을 적었다 → **여기서 채운다.**
전이 매핑(계약 실물): 합격→`NORMAL` · 불합격→`DEFECTIVE` · 보류→`INSPECTION_PENDING` · PQC 합격판정개수 초과→같은 W/O 생산LOT **전체** `INSPECTION_PENDING`(C14).
⭐ **도착값(`to`)은 위가 맞고 출발값(`from`)은 액션마다 다르다**(I-19 R-1) — 상수 하나로 묶지 않는다. `DEFECTIVE` 에서 나오는 전이는 **재등록(`stock-reinstate`) 하나뿐**이다. C14 는 `from` 밖 LOT 을 400 이 아니라 **건너뛴다**(I-19 R-7 · 형제 코어와 같은 모양).
**예상 설계 미정**: C14 의 「전체」 범위(같은 W/O 인가 같은 공정인가)가 좁혀지지 않으면 가장자리 → 계약 문자 그대로 「같은 W/O」.
**규모 주의**: 측정치가 135,000 자릿수라 `/measurements` 는 반드시 페이지네이션, `/measurement-summary` 는 서버 집계(L-1·L-2).


##### I-20 · LOT 상태·보류 — 등록·해제·전이·요약 — 10건

**체인 마디**: 보류 등록/해제가 출고·출하·피킹의 가부를 바꾼다(결정 10 단일 지점). **I-4·I-8·I-22 가 이 판정을 «읽는다»**.
⛔ **2026-09-08 정정(I-20 계획 · api 관점 확인)** — 「I-20 이 `judgment_type_control` 에 행을 채운다」는 **전제가 두 겹으로 깨졌다**: ⓐ 쓰는 오퍼레이션(`PUT /mdm/judgment-type-controls/{codeValueId}`)이 **이미 구현·커버**돼 있고 ⓑ `JUDGMENT_TYPE` 은 **회신 E-1 대기로 잠긴 빈 그룹**이라 시드로도 채우면 안 된다(quality-03 계약에 `judgment` 문자열 0건 · `assignment.tsv`·`uncovered.tsv` 0행) ⇒ **이 슬라이스는 그 표에 아무것도 하지 않는다.**
**원장**: ⛔ 없다 — 계약이 「`inventory_balance.blocked_qty` 는 쓰지 않는다. 잔액은 서버가 파생한다」로 못 박았다.
**트랜잭션**: `lot_hold` INSERT + `lot.status_code` UPDATE + `lot_status_event` 가 **한 트랜잭션**(B-8).
**예상 설계 미정**: 회신 11(보류 해제 사유 — 철회 예정) · 회신 13(`LOT_HOLD_STATUS` 시드). 13 은 §Z-3 에서 이미 판정했다(`HELD` 를 넣되 해제 판정은 `released_at IS NULL`) — **반복하지 않고 그대로 쓴다**.


##### I-21 · 부적합·처분·특채 — 11건

**체인 마디**: ㉓㉔ — 부적합 → 처분(REWORK·SCRAP·NORMAL) → 각각 다른 하류로 갈린다. SCRAP 은 I-4 의 출고(`DISPOSITION_DECISION`)를, NORMAL 은 I-23 의 재등록을, REWORK 은 I-6 의 재작업 W/O 를 부른다.
**원장**: ⛔ 직접은 없다 — 전부 다른 슬라이스의 오퍼레이션이 진다. 이 구조가 「원장 판별자 4값으로 닫힌다」의 두 번째 증거다.
**상태기계**: 처분 저장 + Lot Status 전이가 한 트랜잭션. 도착 상태가 계약에 표로 있다(재작업→`INSPECTION_PENDING` · 폐기→`SCRAPPED` · 정상→`NORMAL`).
**예상 설계 미정**: 부분 처분(수량을 갈라 여러 번)이 되므로 「남은 수량」 파생을 서버가 낸다 — `summary` 에 실린다. 수량 합이 대상 수량을 넘으면? 계약이 말하지 않는다 → 2단계 기준 2「거부하는 쪽」 → 400.


##### I-22 · 출하지시·출하작업지시·제품 피킹·LOT 배분 — 9건

**체인 마디**: ㉖㉗㉙ — 출하지시(ERP 수신) → 출하작업지시 → 제품 LOT 피킹 → LOT 배분.
**원장**: ⛔ 없다. 예약만 움직인다(I-8 코어 재사용 — **두 번째 사용처**라 코어 판정이 여기서 검증된다).
⭐ **2026-09-09 정정(I-22 §0-재수립 R-2)** — 「재사용」의 뜻이 갈렸다. `pick()`·`consume()` 은 **재사용**이 맞으나 **예약을 «거는» 함수는 저장소에 0개**라 이 슬라이스가 `reserveBalances()` 를 **신설**한다(코어 전용 PR ≤200). 그리고 `:pick` 은 예약을 **걸고 «곧바로 푼다»** — `balance.picked += Δ` · `reservation.consumed = reserved` · **`reserved` 순변화 0**(ⓒ안). ⛔ 「걸어 두고 I-23 이 푼다」(ⓐ안)는 **반증됐다** — `M-01-08` §5-5·`W-04-08` §4:76 이 `picked_qty` 를 「집었으나 아직 안 나간 것」으로 정의한다.
⭐ `salesOrderId` 를 비우면 단독 생성 — 「무지시 standalone 이 예외가 아니라 상시 구조」(계약). e2e 가 둘 다 돈다.
**예상 설계 미정**: `shipmentProgressCode` 6값이 2026-09-04 에 신설됐고 `statusCode` 필터는 「칸 불필요」로 닫혔다 — 파생 축이므로 서버가 계산한다. 도출 규칙(배정·피킹·출하 수량 비교)은 값 이름이 그대로 말한다.


##### I-23 · 출하 — 처리·확정·취소 + 재고 재등록 — 7건

**레인 간 선행**: 재등록은 §2의 LOT 품질 전이표를 재사용한다. **A의 I-19 품질 전이 코어 PR이 `main`에 병합되고 C가 동기화한 뒤 재등록을 구현한다**(`lanes.md` §0). 선행 코어가 없으면 별도 전이표를 만들지 않고 다른 선행 충족 슬라이스를 진행한다.
⛔ **2026-09-07 추가 — 코어만으로는 부족하다**(I-19 R-6). `trace.lot_status_event.transition_code` 가 **NOT NULL** 인데 계약 enum 9값(C4~C15)에 **재등록을 가리키는 코드가 없다**. 전이 코어는 `from=['DEFECTIVE']` 로 열리지만 C 는 이력 행에 넣을 코드가 없어 값을 **지어내야** 한다 ⇒ ⛔ 지어내지 말고 **문의 089(발행 예정)의 답을 기다린다**. 그 전까지 I-23 의 **재등록 1건만** 미루고 나머지 6건은 진행할 수 있다.
**체인 마디**: ㉘ — **재고가 마지막으로 나가는 자리.** 그리고 반품→재등록이 체인을 되감는 자리.
**원장**: ⭐ `POST /logistics/shipments` 가 서버 내부에서 `goods_issue` 를 만들고 전기한다 — **I-4 의 서비스를 도메인 간 호출로 부르지 않는다**(아키텍처 「도메인이 다른 도메인의 service 를 부르지 않는다」). 공유가 필요하면 코어다 → `postIssue()` 를 `core/` 로 올릴지, 아니면 shipment 가 `posting.post()` 를 직접 부르고 `goods_issue` 행만 자기가 만들지가 갈림길.
→ **§2 2단계 기준 5「새 개념 수가 적은 쪽」** → **shipment 가 `posting.post()` 를 직접 부르고 `goods_issue` 를 만든다.** 새 코어를 만들지 않는다. 대신 `goods_issue` 를 만드는 «데이터 모양»은 I-4 의 타입을 재사용한다.
**취소**: `:request-cancel`→`:cancel` 이 I-5 의 규약과 **같은 모양**이다(계약이 「01 자재창고가 쓰는 것과 같은 형태」라 적었다). J-7(`CANCEL_IN_PROGRESS`)·J-8(재판정) 을 I-5 코어에서 그대로 가져온다.
**재등록**: 반출·도착·보류 해제·Lot Status 전이가 **한 트랜잭션**이고 ⛔ `stock_transfer` 의 2단 스캔을 **쓰지 않는다**(계약 명시).


##### I-24 · 생산 계획·생산오더(ERP 수신) — 10건

**체인 마디**: ⑫ — 체인의 «위». ERP 가 보낸 P/O 를 받아 계획으로 전개한다. `:confirm` 이 Routing 공정별 W/O + `work_order_dependency` 를 한 트랜잭션으로 만든다.
⚠ **I-6 보다 뒤에 둔 이유**: `:confirm` 이 W/O 를 «만드는» 쪽이라 W/O 의 상태·선발행 규칙이 먼저 서 있어야 한다. 순서를 뒤집으면 `:confirm` 을 두 번 짠다.
**원장**: 없음. **예상 설계 미정**: `:resync` 는 「호출하는 화면이 현재 없다」(계약 자인) — 아웃박스에 적재까지만.


##### I-25 · 공정 인계·수리 왕복 — 6건

**체인 마디**: 가지. 공정 간 WIP 이동(`operation_handover`)과 수리 왕복(`repair_execution`).
**원장**: ⛔ 없다 — 둘 다 기록형. 수리된 물건이 «어느 LOT 으로 돌아가는가»는 계약이 「아직 정해지지 않았다」라 적었다(M-02-02 §8-3) → 본길이 아니라 **뒤 이야기**이므로 그대로 두고 요청서에 싣는다.
`repair-executions` 는 구간형이라 상태 컬럼을 두지 않는다(`open=true` = 반출 시각 없음) — 계약이 명시.


##### I-26 · 제품 개체(시리얼) 발번 — 2건

**확정 R1~R10**: GET1 진행·POST1 본길 유보(필수 상태/개체단위 원천,104·105). 조회는8필터·µs 양경계·동일WHERE/RepeatableRead count, 저장 상태 그대로다. serial_component_relation 쓰기0, 상태 전이0, 현재마이그0.
**조건부 체인**: LOT별 단위대응이 확정된 배분량 → 개체 N행 한 tx → I-27 단일 targets N개. 부분 발번0. LOT 잠금 뒤 새 문장으로 단위별 합/전체개체 count, 최종 검증·N INSERT·멱등 결과는 전달tx 하나다. 번호 N개만 모든 run tx 밖에서 준비하며 코어 신규 유형은 별도≤200. actual actor/worker/terminal 지문·bigint문자열·TraceModule AuthModule/NumberingModule 배선을 재개 예산에 포함한다.
**복구**: ① 발번과② 발행은 별도 키, 각 단계 응답 유실은 같은 키로 재생. 발행 실패로 개체 재생성0. 기존 serial/LOT/HU 발행기록 경로는 신규 발번 유보와 별개로 I-27에서 판정한다. 정정 배분 미반영은044 승계, I-7 변경0. GET 뒤 trace-lot 회귀, 쓰기 뒤 실제 단말 AppModule·채번 전체·I-27 체인 검증. 상세는 I-26 §4~§10,106·107이다.
**원장**: 없음. 도메인 발번 서비스를 범용 코어로 만들지 않는다.


##### I-27 · 발행 이력 — 기록·요약·인쇄 보고·프린터 — 7건

**체인 마디**: 개체·LOT·포장에 라벨 회차를 매긴다. `document_issue_log` 표가 `uq(document_type, target_type, target_id, issue_seq)` 를 이미 갖는다.
⭐ **I-27 R1~R16 범위 안**: 조회3·부분 정상 발행1·보고1. 프린터GET은 단말매핑/관측/기본/지원 정본 결손으로 유보, `/rendition`은 DB 밖 출력 생성으로 제외한다. 표의 존재와 정상 응답 원천은 다르다.

A9는 결과3+귀속3 nullable, whole CHECK·NoAction FK·DEFAULT/백필0이다. 구writer 종료/갱신→P5/필수값 검사 뒤 환경별 응답 활성화하며 summary의 구행 NULL outcome은 정상 null이다. GET16칸/target3칸은 같은 snapshot·7종 batch, summary는 경로 전용 middleware로 CSV를 guard 전에 정규화하고 원래 ordinal/multiplicity를 보존한다.

발행은 지원표의 정상/조건부/거부 입력군을 구분한다. GI header NKU→line/FK 재확인→LOT NKU, HU 부모NKU/최소content SHARE, CoA LOT NKU→request SHARE→result NKU 순서를 최신 실제 writer와 대조한다. 부모 잠금 뒤 새문장 MAX/batchINSERT/원래순서응답·같은tx멱등, 정확원인만 전체run최대3회다. MOLD writer는 소유조율 후 별도보완 전 TOOL만 조건부거부. 공용 core/다른레인 writer를 우회수정하지 않는다. 입력400/업무422/단말403/소진409, worker/actor/terminal 지문과 실제 소비자 회귀는 I-27 정본을 따른다.


##### I-28 · 알림 — 목록·읽음·이벤트·수신자 설정 — 8건

**체인 마디**: 전 도메인이 «발생시키는» 쪽. ⛔ 계약이 「발생 지점 표가 아직 비어 있다」라 실측으로 적었다 — **알림을 «내는» 코드는 만들지 않는다.** 목록·읽음·수신자 설정만 세운다.
**원장**: 없음. **I-28 R-1~R-10 재수립**: 발생기는 제외하고 저장 조회2·읽음2·preview1은 진행한다. 사건명은 있지만 eventCode 정본이 없어 이벤트GET/구독GET/PUT3건은 보류(문의099). A7·A8은 조건부이며 지금 마이그0. GET 토큰/규칙 스냅샷·로컬 멱등tx·app-domain 회귀는 `slices/I-28.md`가 정본이다.


##### I-29 · 통합 대시보드 집계 — 1건

**체인 마디**: 전부의 «위». 마지막에 둔다 — 카드마다 소유 화면이 따로 있고 그 화면의 집계가 서 있어야 숫자가 맞다.
OEE 분모는 `mdm.WorkCalendar*`(결정 03)에서 구한다 — 마스터는 이미 구현돼 있다.


##### I-30 · 설비 — 점검·고장 — 9건

**체인 마디**: 생산과 «옆으로» 붙는다 — 작업 전 점검 통제(I-11)가 `maintenance/inspections` 를 근거로 삼는다.
**조회는 선행 없이 진행 가능**. 쓰기는 기존 채번 코어에 EQI/MLF 등록, A 소유 전이표에 start 등록을 별도 PR로 선행한다. `src/maintenance/` 도메인은 갈리지만 공용 코어·root 모듈 등록은 소유 조율과 최신 main 통합이 필요하다.
**상태기계**: 고장 접수→처리중은 구현, 완료는 원인 마스터 원천 확인까지1건 보류(090). start 상태잠금은 구체 계약 문언의400이다.

I-30 R-1~R-14 확정: nullable8추가·2완화·과거 필수값/enum 사전조회, 공장 로컬 날짜 경계 준비 PR⓪, 조회2+2·등록1+1·메모/start2로8건 진행한다. 멱등은 로컬 주체 지문과 전달 tx를 사용한다. 채번은 tx 밖에서 먼저 끝내어 열린 업무 tx가 별도 연결을 기다리지 않게 하며 경합/실패의 결번은 허용한다(098). 실제 번호 카운터·업무·응답의 원자성 범위를 구분한다. I-11 FK 소비, I-31 다형 트리거, I-32 비가동 집계 회귀와 연결 한계는 개별 계획 §4·§8·§11이 정본이다.


##### I-31 · 보전 — 지시·실적 — 8건

**체인 마디**: 고정 BREAKDOWN/INSPECTION_NG/PM_DUE 촉발이 같은 대상의 지시로 모인다. 다형1:N과 직접breakdown FK를 I-30 조회가 함께 읽고 취소도발행흔적이다. I-31 R1~R13이 정본이며 임의 계측기 trigger유형을 추가하지 않는다.
**ERP/수불/알림 연결0**. 다만 MO/cancel 등록과 실제MDM+maintenance 두사용처의 부여층/PM사실 최소추출은 코어전용전체200으로 나눈다. PMnear는 실재 PM_NEAR_THRESHOLD_PERCENT90 비율 선례이며 새IMMINENT_DAYS 일수상수0. 전이는 A와 사용자 사전조율 후.
order8추가/priority완화·result15추가/6완화·표2/FK·trigger unique완화/bigint, 구행required 결손/구writer 환경활성화는 별도유보다. 미마감nonreset8건 정상 본길, closed/reset true만422·상태/자식/누계/PM/멱등전건0. 누계만201 성공철회·finishedAt≠PM완료. 실제writer의E/M NO KEY UPDATE→order/result UPDATE·그룹/참조 SHARE 및 후보경로재해석/유한whole run 재시도로 직렬화한다. 빈중간층 부여/부모변경/예비품FK 실제writer를 제어된배리어로 검증, 임의sleep/DBversionfixture로 대체0. µs는 I32 R2/R14 helper1회·GI issuedAt포함, 부여/PM 소유와 공유순서는 root 조율. I32 summary111의 완료실체/시각/범위는 여전히미해소. 자세한 실패/소비자 인수와 문의113~116은 I-31 §8~12.


##### I-32 · 비가동 — 구간·집계 — 6건

**체인 마디**: 작업 세션(I-11)의 조업 시간과 짝을 이룬다 — `downtimes/summary` 가 세션과 작업 캘린더를 읽어 시간가동률을 낸다.
⚠ `openOnly=true` 는 기간 필수 규칙(L-3)의 **예외**다 — 전날부터 이어진 구간을 놓치면 안 된다.

I-32 재수립 R1~R14: 조회2+등록/수정2 진행,close/summary2 유보. 추가3/완화1 및 기존µs 무손실 projection/바인딩/재생을 선행하고 equipment→downtime→새breakdown 잠금 순서를 지킨다. server now 미래검사0, 업무/응답/멱등은 같은 전달tx다. I30 연결raw90분과 I32 설비union60분은 다른 집계며 계획장비배정으로 실제session을 증폭하지 않는다. 요약의 날짜×설비 정상계획구간/적용과 완료보전 엔티티/완료일/범위는111의 본길, I31 API 미구현/DB0행은 유보 근거가 아니다. 과거캘린더수정 허용·공장minor 확정규칙을 재질문하지 않는다. P0 날짜helper #300·MaintenanceModule #305 실재를 재사용하고 P0t/P1~P4로 나눈다. 문의108~112와 I-32 §12에 배포/미완을 기록한다.


##### I-33 · 툴 사용실적·계측기 이력·수집 채널 — 12건

**체인 마디**: 툴 누계(타발수) → 보전 트리거. 계측기 차단(`blocksUse`) → 검사(I-19)의 사용 가부.
I33 R1~R14가정본이다. tool제출delta보존/NO KEY UPDATE누계가산과 실제production W/O→mold FK writer의경합을검증한다. I31 resettrue는툴ETag 원천과별개로 현재114해소전422·전건0, nonreset정상. 실제reset성공교차회귀는재개뒤조건부이며도메인API미구현을PASS라쓰지않는다.
물리: A20추가4/완화2,A21추가5/완화3+네축NULL식유일·기존uq보존,T최신관측표,A22추가8·유형별/legacyNULL유일·cal version추가0. 새quality item_spec참조는A사전조율후measurement기존보호+channel검사·사전검사뒤정확FK P2003를tx밖STATE_LOCKED400번역한다. equipment/process실제REFERRERS,ERP item/referenceCountNULL은유지한다.
CAL 기본PASS/ADJUSTED는이력+master2날짜동일tx·FAIL이력만,nonCAL확장정상/unknownCAL만422(117). clear는해당행만·다른차단/만료유지·새ETag/권한0. T는실제값/µs조회·registered와active연결부재분리,수집자운영인수별도(118). client단위빈PUT와409·500성공오집계는별도2단건미배정·서버계약변경0. 순간helper는I32P0t단일공유,일반350/400·core전체200이며10조각은후보일뿐이다.


##### I-34 · 첨부 — 올리기·목록·내려받기 — 4건

4건 중 **3건 건너뜀** — 올리기·내려받기·고장 사진은 바이너리 저장소가 필요하다(`attachment.storage_key` 가 외부 키를 가리킨다). §8 참조.
**범위 안은 `GET /app/attachments` 하나** — 한 대상에 붙은 첨부의 «메타데이터»만 읽는다. 표는 이미 있다.


##### I-35 · 변경 이력·예비품 엑셀 — 2건

**체인 마디**: 없음. `GET /audit/events` 는 파티션 표라 기간 필수(B-5). `audit_event` 를 «쓰는» 코드가 아직 없어 빈 목록이 정상이다.
**예상 설계 미정**: `before_value`/`after_value` jsonb 키 규약이 없다(§I-5) — 조회만 하므로 본길에 안 걸린다. `spare-parts:import` 는 회신 7(`molds:import` 공장)과 같은 형태 → §P-3 판정(공장이 하나일 때만 생략 허용)을 그대로 재사용.

---

## 4. 순서 — M1 tracer bullet 을 가장 짧게 닫고, 그 뒤 M2~M5

### 4-1. M1 완성 경로 (완료 조건: 「PO→GR→불출→실적→balance 한 줄, **취소 경로 포함** e2e」)

`development-strategy.md` 의 M1 은 `goods_receipt` 가 이미 서 있어 절반이 닫혔다. 남은 절반을 **7슬라이스**로 닫는다.

```
1. I-1 승인 코어      ← 뒤 9자리가 매달린다. 여기서 안 만들면 9번 다시 짠다
2. I-2 P/O + 채번 코어 ← 체인의 머리. 채번을 여기서 세워 15전표가 베끼지 않게 한다
3. I-3 입하           ← PO→입하 FK. 자재 LOT 이 여기서 난다
   ─────── (기존 `POST /logistics/goods-receipts` 가 ④를 이미 잇는다 — 새로 짤 것 없음)
4. I-4 출고           ← ⭐「불출」. `sourceDocumentTypeCode='GOODS_RECEIPT'`(자재 폐기)로
                        **피킹 없이** 원장 out 을 닫는다 — I-8 을 기다리지 않는다
5. I-5 다형 취소 + 역트랜잭션 ← ⭐ M1 완료 조건의 「취소 경로」가 여기다
6. I-6 W/O            ← 선발행 LOT
7. I-7 생산 실적       ← L1 + 계보. 제품 입고는 «기존» GR 오퍼레이션 재호출
──────────────────────────────────────────────
M1 체인 e2e 하나:  P/O 등록·승인 → 입하 → 입고(기존) → 적치 지시 확인 →
                   기타출고 전기 → W/O 발행·확정배포(선발행) → 실적 등록(L1) →
                   제품 입고(기존 GR, source=PRODUCTION_RESULT) → balance 3행 대조 →
                   입고 취소 요청·승인·실행 → 역트랜잭션 확인 → balance 원복
```

⭐ **왜 취소(I-5)를 W/O 보다 앞에 두는가.** 완료 조건이 취소를 포함하고, 취소 코어가 늦게 서면 I-13·I-14·I-23 이 각자 취소를 짠 뒤 되돌려야 한다. 2026-09-04 드리프트가 취소를 리소스 축에서 유형 축으로 옮긴 것이 정확히 이 이유였다(「유형이 늘어도 표를 갖지 않게」).

⚠ **`development-strategy.md` 순서에서 벗어나는 지점 하나** — 전략은 「PO → GR → **불출** → 실적」이라 적었고 그 불출이 자재 출고요청·피킹을 거치는 정식 경로로 읽힌다. 이 계획은 **기타출고로 먼저 닫고 정식 경로(I-8)를 M2 로 미룬다.** 근거: 계약이 `GoodsIssueCreate.sourceDocumentTypeCode` 에 `GOODS_RECEIPT` 를 열어 두어 피킹 없는 출고가 **계약상 성립**하고, M1 의 목적은 「뼈대를 한 번씩 검증」이지 「업무 완전성」이 아니다(원칙 1).

### 4-2. M2~M5

| 마일스톤 | 슬라이스 | 완료 조건(취소 경로 포함 체인 e2e) |
|---|---|---|
| **M2 — 실행 보강** | I-8 출고요청·피킹·예약 → I-9 생산창고 입고 → I-10 투입·반출 → I-11 작업 세션 → I-24 계획·생산오더 → I-25 인계·수리 | 계획 `:confirm` → W/O 전개 → `:release`(출고요청 자동) → 피킹 → 출고 → 생산창고 입고 → 투입 → 세션 → 실적 → 제품 입고 → **W/O `:cancel` 로 선발행 전건 폐번** |
| **M3 — 품질** | I-19 검사 → I-20 LOT 상태·보류 → I-21 부적합·처분 → I-18 LOT 부가 | 실적 → 검사 의뢰 → 결과 확정(Lot Status 전이) → 불합격 → 보류 → 부적합 → 처분(SCRAP) → **폐기 출고(I-4 재사용) 원장 감소** |
| **M4 — 출하** | I-22 출하지시·작업지시 → I-23 출하·재등록 | 제품 LOT → 출하작업지시 → 피킹 → 출하 처리(원장 out) → 확정(ERP 적재) / 미확정에서 **취소 요청·승인·실행 → 역트랜잭션** · 반품 입고 → 처분 NORMAL → 재등록 |
| **M5 — 주변부** | I-12 적치 · I-13 이동 · I-14 조정 · I-15 실사 · I-16 취급단위 · I-17 재생재 · I-26 시리얼 · I-27 발행 · I-28 알림 · I-30~I-33 설비 · I-35 · I-29 대시보드 | 각 슬라이스 e2e 3건. 대시보드는 맨 끝(모든 집계원이 서야 숫자가 맞다) |

⚠ **I-12·I-30 은 예외로 앞당길 수 있다** — §6-2 병렬 참조.

---

## 5. 테스트 전략

### 5-1. 기존 e2e 관행을 그대로 따른다 (실측 확인)

`test/logistics-goods-receipt.e2e-spec.ts` 골격을 복제한다:

- `const PREFIX = 'XXE2E'` — 마스터 코드에 접두를 붙여 짓고 `cleanup()` 이 `LIKE 'PREFIX%'` 로 지운다. **슬라이스마다 다른 PREFIX** 를 쓴다(동시 실행 충돌 방지).
- `const ROLE`·`const PERMISSIONS = ['W-01-10', …]` — **화면 ID 배열**로 역할을 만든다. 계약이 403 을 선언한 오퍼레이션만 `OPERATION_PERMISSIONS` 에 등록돼 있으므로, **첫 테스트는 언제나 「권한 없으면 403」**이다.
- `validator(operation, status)` — 응답을 **계약 스키마로 AJV 검증**한다. 슬라이스마다 이 헬퍼를 복제한다(계약 파일 경로만 다르다).
- 원장이 걸린 스위트는 `cleanup()` 첫 줄이 `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE` 다 — **파티션 표라 DELETE 로는 못 지운다.**
- `Idempotency-Key` 는 `randomUUID()`, 재전송 테스트만 같은 키를 두 번 보낸다.

### 5-2. 슬라이스마다 e2e 핵심 3건 (관행)

| # | 단언 | 원장을 지나는 슬라이스 | 지나지 않는 슬라이스 |
|---|---|---|---|
| 1 | **동시 생성** | 한 호출이 **전표 + 원장 헤더/라인 + 잔액 행**을 함께 만들고, 전표 라인이 `inventory_transaction_line_id` 로 원장을 되짚는다 | 한 호출이 **헤더 + 라인 + 부수 기록**(계보·이력·예약)을 함께 만든다 |
| 2 | **변화 합** | 호출 전후 `inventory_balance.on_hand_qty` 차이 = 전표 수량 합. 이동이면 **두 행의 합이 0** | 파생 칸(`variance_qty`·`availableQty`·`remainingQty`)이 서버 계산과 일치 |
| 3 | **멱등 재전송** | 같은 `Idempotency-Key` 재전송이 **원장을 두 번 만들지 않는다**(`alreadyPosted`) 그리고 **잔액이 두 번 안 움직인다** | 같은 키 재전송이 같은 응답을 주고 행이 하나뿐이다 |

⭐ 상태기계가 있는 슬라이스는 **4번째**를 더한다 — 「닫힌 상태에서 같은 액션을 다시 부르면 409/400 이고 상태가 안 바뀐다」.
⭐ 승인이 걸린 슬라이스는 **5번째** — 「승인 전 `:post` 는 400 이고 원장이 안 생긴다」.

### 5-3. 체인 e2e — 여러 슬라이스를 잇는 하나

마일스톤마다 **하나씩**, 도메인 스위트와 별도 파일로 둔다(`test/chain-m1.e2e-spec.ts` …).

- 슬라이스 스위트와 **PREFIX 를 다르게** 두고 마스터를 자기가 짓는다 — 순서 의존을 만들지 않는다.
- 단언은 **끝점 셋**뿐: ① 체인 끝의 `inventory_balance` 한 줄이 예상값 ② `lot_relation`/`production_result_lot_allocation` 로 계보가 이어짐 ③ 취소 실행 뒤 balance 원복 + `reversal_of_transaction_id` 가 원 트랜잭션을 가리킴. 중간 단계는 슬라이스 스위트가 이미 못 박았으므로 다시 세지 않는다.
- ⚠ 체인 e2e 는 **느리다**(마스터 20+행 · 오퍼레이션 12+회). 마일스톤 종료 PR 에만 붙이고 슬라이스 PR 마다 돌리지 않는다.

### 5-4. 유닛 테스트 예산

원칙 2 의 배분을 그대로 — **코어만 두껍게**: 역트랜잭션(`reverse()`), 예약/피킹 수량 이동, 채번(경계·리셋 주기), 상태 전이표(등록 안 된 칸이 «던지는지»), 승인 순차 판정. 나머지 CRUD 는 e2e 3건으로 끝낸다.

---

## 6. 실행 위험 순서

### 6-1. 먼저 하면 뒤가 편해지는 것 / 뒤로 미루면 되돌림이 생기는 것

| 순서 | 무엇 | 먼저 하면 | 미루면 |
|---|---|---|---|
| 1 | **승인 코어(I-1)** | 9자리가 3줄씩 호출만 한다 | 9자리에 400 판정 4종이 흩어지고, 모으려면 9 서비스 재개봉 |
| 2 | **채번 코어(I-2)** | 15전표가 한 줄 | `count()+1` 15벌 · 취소가 번호를 재사용하는 결함 15벌 |
| 3 | **역트랜잭션 코어(I-5)** | 취소·정정·출하취소가 같은 함수 | 원장 불변식이 4경로에서 갈린다 — **가장 비싼 되돌림** |
| 4 | **예약/피킹 코어(I-8)** | 4자리가 코어를 부른다 | 4자리가 `inventory_balance` 를 직접 UPDATE → 결정 08 위반 |
| 5 | **품질 축 전이표(I-19)** | I-20·I-21·I-23 이 재사용 | 「값이 없어 막는다」를 4번 다르게 흉내 |
| 6 | 마이그레이션 | — | ⚠ **아래 6-3** |
| 7 | 대시보드(I-29) | — | 먼저 하면 집계원이 없어 전부 0 — 두 번 짠다 |

### 6-2. 병렬로 돌릴 수 있는 슬라이스 쌍 (파일 충돌 없음)

`src/` 디렉터리와 `test/` 파일이 겹치지 않고, 마이그레이션이 같은 표를 건드리지 않는 쌍만 골랐다.

| 쌍 | 각자의 파일 | 왜 안 부딪히나 |
|---|---|---|
| **I-1 ∥ I-30** | `src/app/approval/` ∥ `src/maintenance/inspection·breakdown/` | 설비는 승인·원장 미사용. 조회는 독립이고 쓰기는 채번2유형·고장 start 코어 등록 선행. root 모듈 자기 등록만 통합 |
| **I-2 ∥ I-30/I-32** | `src/logistics/purchase-order/` ∥ `src/maintenance/` | I-30 점검번호·고장번호는 물리 NOT NULL UNIQUE이므로 기존 채번 코어를 사용한다. 채번/전이 공용 파일 동시 변경은 조율 후 별도 PR. 비가동과 번호 존재 여부를 혼동하지 않음 |
| **I-3 ∥ I-12** | `src/logistics/inbound-receipt/` ∥ `src/logistics/putaway/` | 적치는 **이미 선 입고**만 필요하다. 다만 둘 다 `logistics.module.ts` 를 건드린다 — 한쪽이 먼저 병합되면 **`origin/main`을 merge해 모듈 등록 줄의 충돌을 해소**하고 게이트를 다시 탄다(`lanes.md` §2 · I-3 은 `LotRegistryModule` import 가 하나 더 — 재수립 R-1) |
| **I-6 ∥ I-19** | `src/production/work-order/` ∥ `src/quality/inspection/` | ⚠ I-19 가 실적을 시드로 필요로 하므로 I-7 뒤. I-6 과는 겹치지 않는다 |
| **I-11 ∥ I-13** | `src/production/work-session/` ∥ `src/logistics/stock-transfer/` | 세션은 원장을 안 쓰고, 이동은 생산을 안 본다 |
| **I-27 ∥ I-28** | `src/app/document-issue/` ∥ `src/app/notification/` | 둘 다 `app-domain.module.ts` 한 줄만 겹친다 |
| **I-33 ∥ I-16** | `src/maintenance/tool·calibration/` ∥ `src/inventory/handling-unit/` | 완전 분리 |

⛔ **병렬로 두면 안 되는 쌍**: 원장 코어를 «고치는» 두 슬라이스(I-5 ∥ I-8) — 같은 `inventory-posting.service.ts` 를 늘린다(I-5 PR ① 이 `post()`·`reverse()` 공용 선잠금 헬퍼를 닫는다 — I-8 은 그 헬퍼를 재사용 · I-5 R-5). I-4 ∥ I-23 — 둘 다 `goods_issue` 를 만든다.

### 6-3. 마이그레이션이 모이는 자리

CLAUDE.md 「마이그레이션은 별도 선행 커밋」 + 아키텍처 §6 「그 도메인 첫 PR 앞에」. 실측으로 필요한 것은 ~~7건~~ ~~8건~~ **7건**이다(M-h 는 I-3 재수립 R-9 에서 드러났다 — 계약이 「선택」이라 적은 칸이 물리에서 NOT NULL. M-c 는 I-4 재수립 R-11 에서 «이미 적용됨»으로 빠졌다).

| # | 슬라이스 | 무엇 | 하위 호환? |
|---|---|---|---|
| M-a | I-1 | `approval_route` 부분 유일 인덱스 `(approval_type_code, business_unit_id) WHERE is_active`(§I-35) | ⭕ 인덱스 추가 |
| M-b | I-2 | `purchase_order` 유일 제약 · OCR 자리(§I-48) | ⭕ |
| ~~M-c~~ | ~~I-4~~ | ✅ 이미 적용됨(`20260901090000` · #44 ≡ #147) — I-4 마이그 0건(I-4 재수립 R-11) | — |
| M-d | I-6 | `work_order_resource_assignment` **식** 유일 인덱스(COALESCE 한 식 3칸) — `remainder_disposition_code` 는 `close_disposition_code` 로 이미 있다(I-6 R-9) | ⭕ 추가(반) |
| M-e | I-19 | 검사 의뢰 기준 완화(#280) | ⭕ |
| M-f | I-23 | 긴급 출하 사유 컬럼(§I-41) | ⭕ nullable |
| M-g | I-33 | equipment/key/item/process 네축NULL식유일(NULL비트+COALESCE0)·inactive포함·구uq유지, 신규정확index충돌만409 | ⭕·R5 |
| M-h | I-3 | A3 `inbound_receipt_line.lot_id?` + `inbound_variance.reason_code` **NOT NULL 해제** + `ix_inbound_variance_line` — 한 파일, PR ②a 선행 커밋 | ⭕ 추가·완화 |

⭐ **전부 추가·완화다 — 두 릴리스 규칙(§3 멈춤 조건)에 걸리는 삭제가 하나도 없다.** 이 계획대로 가면 멈춤 조건 1번은 발생하지 않는다.
⚠ 반대로 **I-9 의 판정이 뒤집히면** `shopfloor_receipt_line.inventory_transaction_line_id` 가 새로 필요해지고, 그것은 이 표에 없는 8번째다 — 「차이가 크다」 조건 첫째에 걸리므로 그 슬라이스만 3관점 재수립.

---

## 7. 회신 대기 15건과의 교차

`README.md` §0 의 대기 물음이 **어느 슬라이스의 본길/가장자리에 걸리는지** 와 §2 로 어떻게 통과할지.

| # | 물음 | 걸리는 슬라이스 | 본길/가장자리 | 통과 방법 |
|---|---|---|---|---|
| 1 | `AppUser.statusCode` 기본값 | — (mdm 구현 완료) | — | 남은 249건에 걸리지 않는다 |
| 2 | `certifiedBy` 참조 | — (mdm 구현 완료) | — | 걸리지 않는다 |
| 4 | `pmDueAxisCode` | **I-31**(보전 지시 트리거) · I-33 | 가장자리 | §O-6 판정(스키마를 따랐다)을 그대로 재사용. 새 판단 없음 |
| 5 | `type` null 인데 `enum` 에 null 없음 — **16자리** | **전 슬라이스**(응답 스키마 곳곳) | 가장자리 | §Y-1 판정 그대로 — 값이 없으면 **키를 뺀다**(널을 보내지 않는다). 슬라이스마다 반복하지 않는다 |
| 6 | 임박 임계 90 | **I-31** · I-33 · I-29 | 가장자리(임계 근처 건에서만) | I-31/33은 실제 `PM_NEAR_THRESHOLD_PERCENT=90` 비율 선례를 재사용. 일수 `IMMINENT_DAYS` 신설0·I-29 A 소유 판단은 변경하지 않음 |
| 7 | `molds:import` 공장 | **I-35**(`spare-parts:import`) | 가장자리(공장이 둘 이상일 때만) | §P-3 판정 재사용 — 공장이 하나일 때만 생략 허용, 둘 이상이면 400 |
| 8 | 같은 비밀번호 | — (auth 구현 완료) | — | 걸리지 않는다 |
| 9 | 공지 종료일 | — (app/notice 구현 완료) | — | 걸리지 않는다 |
| 10 | `notice_no` 채번 | — (구현 완료) | — | ⚠ **I-2 의 채번 코어가 이 자리를 흡수한다** — §Y-6 에서 서버가 정한 형식을 `numbering_rule` 로 옮기면 회신 시 한 곳만 고친다 |
| 11 | 보류 해제 사유(철회 예정) | **I-20**(`lot-holds:release`) | 가장자리 | 철회 예정이므로 기다리지 않는다. `release_reason_code` 컬럼이 이미 있으니 **받으면 저장하고 필수로 만들지 않는다**(2단계 기준 2 의 역 — 여기서는 「거부하지 않는 쪽」이 되돌리기 싸다: 필수화는 나중에 조일 수 있으나 필수였던 것을 푸는 것도 완화다. 계약이 필수라 적지 않았으므로 계약 문자대로) |
| 12 | 한도승인 재고 상태 값 | ⛔ ~~I-18(IQC 생략)~~ → **I-21**(특채) | 가장자리 | ⭐ **재배정됐다**(`재정리-2026-09-08-레인A.md`) — I-18 은 한도를 받을 칸이 0개고 재고·LOT 상태를 안 옮긴다(R-10 실측). **통보 089 §2** 가 `concession.status_code = 'APPROVED'` 로 판정 완료 — `app.approval_request.status_code` 가 이미 쓰는 값이라 새 코드 그룹 0 |
| 13 | `LOT_HOLD_STATUS` 시드 | **I-20** | 본길처럼 보이나 실은 가장자리 | §Z-3 에서 이미 판정 완료 — `HELD` 시드, 해제 판정은 `released_at IS NULL`. **반복하지 않는다** |
| 14 | 채번 규칙 없는 표(GR-·PT-·NTC-) | **I-2 및 그 뒤 15전표 전부** | 본길(모든 전표 번호가 달라진다)이나 **「값 정의」** | §0 규칙대로 권고안 구현. ⭐ **I-2 의 채번 코어가 이 물음의 회신 비용을 15 → 1 로 줄인다** — 이 계획이 채번을 앞으로 당긴 가장 큰 이유 |
| 15 | `businessDate`/`occurredAt` 의 C-8-1 어긋남 | **I-3·I-8·I-15·I-7**(원장을 안 지나면서 `businessDate` 를 싣는 **6 오퍼레이션**) | 가장자리 | §Z-4 판정 그대로 — **받아서 형식만 검증하고 저장하지 않는다.** 슬라이스마다 같은 판정을 반복하고 요청서에 **건수만** 누적한다(개별 문의를 6번 내지 않는다) |

⭐ **15건 중 어느 것도 본길을 막지 않는다.** §0 이 미리 「12·13·14 는 값 정의라 그대로 구현」이라 적었고, 나머지는 이미 구현된 도메인이거나 가장자리다. **회신 대기 때문에 건너뛰는 오퍼레이션은 0건이다.**

---

## 8. 건너뜀 표

§0 「DB 안에서 끝나는 것만」에 걸리는 것. **4건.**

| 오퍼레이션 | 슬라이스 | 사유 |
|---|---|---|
| `POST /app/attachments` | I-34 | **바이너리 저장소가 필요하다.** `attachment.storage_key` 가 외부 저장소 키를 가리키고, `multipart/form-data` 본문을 받아 어딘가에 써야 한다. DB 안에서 끝나지 않는다 |
| `GET /app/attachments/{attachmentId}/content` | I-34 | 같은 이유 — 파일 내용을 내린다 |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | I-34 | 같은 이유 — 고장 사진 최대 3장 |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | I-27 | **출력물 이미지·문서를 서버가 그린다.** PDF/이미지 렌더러가 필요하다 |

⛔ **건너뛰지 «않는» 것 — 착각하기 쉬운 자리 셋**
- `GET /app/attachments`(첨부 «목록») — 메타데이터만 읽는다. **범위 안**(I-34 에서 이것 하나만 구현).
- `GET /app/printers` · `POST /app/document-issues:report-print` — 프린터 «목록·상태»와 인쇄 «결과 기록». 실제 인쇄를 하지 않는다. **범위 안**.
- ERP 적재(`work-orders:close` · `shipments:confirm` · 출고 `sendToErp`) — `integration_message` 에 **쌓는 데까지**가 범위 안(§0 명시). 전송기는 만들지 않는다.

⇒ **최초 계획 기준** 249 − 4 = 245건, 목표483/487(238 + 245)였다. 이후 B의 본길 유보8건(I28 3·I30 1·I26 1·I32 2·I27프린터1)을 반영한 **현재 목표475/487**와 상세 제외/재개 조건은 `plan.md` §6을 따른다. 고정 배정·분모487은 바꾸지 않는다.

---

## 9. 위험 상위 10 — 통합 관점에서 보이는 함정

| # | 함정 | 어느 슬라이스에서 터지나 | 방어 |
|---|---|---|---|
| 1 | **원장 판별자를 늘리고 싶어진다.** 투입·실적·출하를 각각 `MATERIAL_CONSUMPTION`·`PRODUCTION_RESULT`·`SHIPMENT` 로 원장에 넣으려는 유혹 — **반출도**(`material_return_line.inventory_transaction_line_id` 칸이 있다고 `STOCK_TRANSFER` 를 만들려는 유혹 · I-10 재수립 R-2) | I-10 · I-7 · I-23 | §1-4 표를 계획서에 못 박았다. 계약 `InventoryTransaction.sourceDocumentTypeCode` **enum 4값**이 정본이고, 늘리려면 계약을 고쳐야 한다 |
| 2 | **`reserved_qty`·`picked_qty` 를 도메인이 직접 UPDATE 한다.** 코어가 안 건드리니 「내가 하면 되지」가 된다 | I-8 에서 시작해 I-22 로 번진다 | I-8 을 코어 전용 PR 로 자르고, ~~e2e 에 「도메인이 `inventory_balance` 를 직접 쓰지 않는다」를 잔액 UPDATE 트리거로 감지~~ **정적 가드 spec**(`balance-write-guard.spec.ts` · 정규식 3패턴 — 잔액 UPDATE 트리거가 없고 코어 자신이 UPDATE 하므로 DB 층에서 주체를 못 가른다 · I-8 §3-8 · R-8) |
| 3 | **역트랜잭션이 ~~3벌~~ 2벌 생긴다** — 취소·출하 취소. ⛔ **조정 역분개는 오늘 서지 않는다**(I-14 재수립 R-12 — 계약 조정 7건에 `:cancel`·`:reverse` 0건 · `DocumentProgress.documentTypeCode` enum 9값에 `INVENTORY_ADJUSTMENT` 없음 · 문의 132. 회신이 오면 되살아난다) ⇒ `reverse()` 의 **둘째 사용처는 I-23** 이다. 실적 정정은 원장을 안 지난다 — `production_result` 안의 상쇄 행 · I-7 재수립 R-19 | I-5 → ~~I-14~~ → I-23 | I-5 를 코어 전용 PR(diff ≤ 200)로 먼저. `reversal_of_transaction_id` 가 안 채워진 원장 행이 있으면 e2e 실패 |
| 4 | **채번이 15벌 복사된다.** 입고에 이미 `count()+1` 이 있어 복사가 자연스럽다. 취소가 생기면 번호를 **재사용**한다 | I-2 를 늦추면 I-3·I-4·I-13·I-14·I-15·I-22·I-23 전부 | I-2 에서 코어로 세우고 **입고의 두 함수를 그 코어로 옮기는 것**까지 같은 PR |
| 5 | **`document-progress` 의 유형↔표 대응을 코드에 박는다.** 9종 × 후속 판정이라 `switch` 가 자연스럽다 | I-5, 그리고 유형이 느는 순간 조용히 틀린다 | `app.entity_type_registry` 표가 이미 있다 — 거기서 읽는다. 계약이 명시적으로 서버 소유로 넘긴 자리(A-10 보강) | ⭐ I-5 R-6: **절반 기각** — 매핑은 코드 · 등록부는 부팅 대조로 남긴다.
| 6 | **생산창고 차이를 원장으로 처리해 버린다.** `businessDate` 가 실려 있어 「전기해야 하나 보다」로 읽힌다 | I-9 | §3-1 I-9 의 §2 판정을 따른다 — 기록만. 뒤집히면 마이그레이션이 생기므로 **그 슬라이스만 3관점 재수립**(README §1-2 첫째 조건) |
| 7 | **`:confirm`(계획 전개)을 W/O 보다 먼저 짠다.** 계획이 체인의 «위»라 순서상 먼저로 보인다 | I-24 를 앞당기면 I-6 을 두 번 짠다 | 순서표에서 I-24 를 M2 끝에 두었다. 전개는 W/O 의 상태·선발행 규칙을 «쓰는» 쪽이다 |
| 8 | **출하가 `GoodsIssueService` 를 부른다.** 도메인 간 service 호출 금지(아키텍처 §1)를 어긴다 | I-23 | shipment 가 `posting.post()` 를 직접 부르고 `goods_issue` 행은 자기가 만든다. 공유하는 것은 **타입뿐** |
| 9 | **상태값 목록이 없는 칸에 문자열을 지어낸다.** `#213` 이 안 와서 61표 중 대부분이 그렇다 | I-6 · I-11 · I-19 · I-30 · I-31 | `transitions.ts` 는 등록 안 된 (칸, 액션) 을 **던진다**. 지어낸 값을 넣으면 전이표에 등록해야 하고, 등록하는 순간 리뷰에서 보인다 — 이 «귀찮음»이 방어다 |
| 10 | **체인 e2e 가 슬라이스 e2e 를 대신한다.** 하나로 다 되니 편해 보인다 | M1 종료 후 전부 | 체인 e2e 는 **끝점 셋만** 단언한다(§5-3). 중간 단계 단언은 슬라이스 스위트에만 둔다 — 체인이 깨졌을 때 «어디서» 깨졌는지 알아야 한다 |

---

## 10. 부록 — 슬라이스별 오퍼레이션 전건 (249/249)

> 이 절이 「빠짐없이」의 보증이다. `uncovered.tsv` 249행을 정규식으로 배타 분류해 생성했다 — 미배정 0 · 중복 0.
> `403` 표시는 계약이 403 을 «선언한» 오퍼레이션(= `OPERATION_PERMISSIONS` 등록 대상).

### I-1 · 승인 코어 — 결재선·결재함 (12건)

- `GET /app/approval-requests` `403` — 승인 요청 목록
- `GET /app/approval-requests/{approvalRequestId}` `403` — 승인 요청 상세 (결재선 진행 포함)
- `POST /app/approval-requests/{approvalRequestId}:approve` `403` — 승인
- `POST /app/approval-requests/{approvalRequestId}:reject` `403` — 반려
- `GET /app/approval-routes` — 결재선 목록
- `POST /app/approval-routes` `403` — 결재선 등록
- `GET /app/approval-routes/{approvalRouteId}` — 결재선 상세
- `PUT /app/approval-routes/{approvalRouteId}` `403` — 결재선 수정
- `GET /app/approval-routes/{approvalRouteId}/steps` — 결재 단계 목록
- `PUT /app/approval-routes/{approvalRouteId}/steps` `403` — 결재 단계 전체 치환 (순서 포함)
- `POST /app/approval-routes/{approvalRouteId}:activate` `403` — 결재선 다시 사용
- `POST /app/approval-routes/{approvalRouteId}:deactivate` `403` — 결재선 사용 중지


### I-2 · P/O(발주) — 전표+승인 상신 (7건)

- `GET /logistics/purchase-orders` — P/O 목록
- `POST /logistics/purchase-orders` `403` — P/O 등록
- `GET /logistics/purchase-orders/{purchaseOrderId}` — P/O 상세
- `PUT /logistics/purchase-orders/{purchaseOrderId}` `403` — P/O 헤더 수정
- `GET /logistics/purchase-orders/{purchaseOrderId}/lines` — P/O 라인 목록
- `PUT /logistics/purchase-orders/{purchaseOrderId}/lines` `403` — P/O 라인 치환
- `POST /logistics/purchase-orders/{purchaseOrderId}:request-approval` `403` — P/O 승인 요청


### I-3 · 입하 — 등록·라인·차이·초과분리 (12건)

- `GET /logistics/asns` — 입하 예정 목록
- `GET /logistics/asns/{asnId}` — 입하 예정 상세
- `GET /logistics/asns/{asnId}/lines` — 입하 예정 라인
- `GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` — 입하 차이 목록
- `POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` `403` — 입하 차이 등록
- `GET /logistics/inbound-receipts` — 입하 목록
- `POST /logistics/inbound-receipts` `403` — 입하 등록
- `GET /logistics/inbound-receipts/{inboundReceiptId}` — 입하 상세
- `PUT /logistics/inbound-receipts/{inboundReceiptId}` `403` — 입하 헤더 수정
- `GET /logistics/inbound-receipts/{inboundReceiptId}/lines` — 입하 라인 목록
- `PUT /logistics/inbound-receipts/{inboundReceiptId}/lines` `403` — 입하 라인 치환
- `POST /logistics/inbound-receipts:split` `403` — 초과 입하 분리 등록


### I-4 · 출고 — 전표·전기·원장 out (7건)

- `GET /logistics/goods-issues` — 출고 목록
- `POST /logistics/goods-issues` `403` — 출고 등록
- `GET /logistics/goods-issues/{goodsIssueId}` — 출고 상세
- `GET /logistics/goods-issues/{goodsIssueId}/lines` — 출고 라인 목록
- `PUT /logistics/goods-issues/{goodsIssueId}/lines` `403` — 출고 라인 치환
- `POST /logistics/goods-issues/{goodsIssueId}:post` `403` — 출고 전기
- `POST /logistics/goods-issues/{goodsIssueId}:request-approval` `403` — 기타 출고 품의 상신


### I-5 · 다형 취소 — document-progress (4건)

- `GET /logistics/document-progress` — 물류 문서 진행현황
- `GET /logistics/document-progress/{documentTypeCode}/{documentId}` — 물류 문서 진행현황 상세
- `POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel` `403` — 물류 문서 취소 실행
- `POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel` `403` — 물류 문서 취소 요청


### I-6 · W/O — 발행·확정배포·중단·재개·취소·마감 + 4M 배정 (13건)

- `GET /production/work-orders` — W/O 목록·진행현황
- `POST /production/work-orders` `403` — W/O 발행
- `GET /production/work-orders/{workOrderId}` — W/O 한 건
- `PUT /production/work-orders/{workOrderId}` `403` — W/O 수정 · 4M 자원배정
- `GET /production/work-orders/{workOrderId}/resource-plans` — 4M 계획 배정 목록
- `POST /production/work-orders/{workOrderId}/resource-plans` — 4M 계획 배정 추가
- `DELETE /production/work-orders/{workOrderId}/resource-plans/{workOrderResourcePlanId}` — 4M 계획 배정 해제
- `GET /production/work-orders/{workOrderId}/validation` `403` — 4M 배정 유효성 점검
- `POST /production/work-orders/{workOrderId}:cancel` `403` — W/O 취소
- `POST /production/work-orders/{workOrderId}:close` `403` — 마감 · ERP 실적 송신
- `POST /production/work-orders/{workOrderId}:hold` `403` — 작업 중단
- `POST /production/work-orders/{workOrderId}:release` `403` — 확정·배포 · 생산LOT 선발행
- `POST /production/work-orders/{workOrderId}:resume` `403` — 작업 재개


### I-7 · 생산 실적 — 등록·정정·상신 + LOT 생명주기 L1 (7건)

- `GET /production/production-results` — 생산 실적 목록
- `POST /production/production-results` `403` — 생산 실적 등록
- `GET /production/production-results/{productionResultId}` — 생산 실적 한 건
- `POST /production/production-results/{productionResultId}:correct` `403` — 실적 정정
- `POST /production/production-results/{productionResultId}:request-approval` `403` — 실적 정정 상신
- `GET /trace/lot-lifecycle-events` — LOT 생명주기 변경이력 조회 — 전이 3종 전건
- `POST /trace/lots/{lotId}:complete` `403` — 생산 LOT 완료


### I-8 · 자재 출고요청·피킹·예약 (8건)

- `GET /inventory/reservations` — 재고 예약 조회
- `GET /logistics/material-issue-requests` — 자재 출고 요청 목록
- `POST /logistics/material-issue-requests` `403` — 추가 자재 출고 요청 발행
- `GET /logistics/material-issue-requests/shortage` — W/O 품목별 소요·기출고·부족
- `GET /logistics/material-issue-requests/{materialIssueRequestId}` — 자재 출고 요청 상세
- `GET /logistics/picking-orders` — 피킹 지시 목록
- `GET /logistics/picking-orders/{pickingOrderId}` — 피킹 지시 상세
- `POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick` `403` — 라인 피킹


### I-9 · 생산창고 입고 — shopfloor-receipts (3건)

- `GET /logistics/shopfloor-receipts` — 생산창고 입고 목록
- `POST /logistics/shopfloor-receipts` `403` — 생산창고 입고 확정
- `GET /logistics/shopfloor-receipts/{shopfloorReceiptId}` — 생산창고 입고 상세


### I-10 · 자재 투입·반출 — 계보(lot_relation) (6건)

- `GET /production/material-consumptions` — 자재 투입 목록
- `POST /production/material-consumptions` `403` — 자재 투입 등록
- `GET /production/material-consumptions/{materialConsumptionId}` — 자재 투입 한 건
- `GET /production/material-returns` — 자재 반출 목록
- `POST /production/material-returns` `403` — 자재 반출 등록
- `GET /production/material-returns/{materialReturnId}` — 자재 반출 한 건


### I-11 · 작업 세션 — 세션·이벤트·작업자·작업전점검 (11건)

- `GET /production/precheck-decisions` — 작업 전 점검 통제 판정 이력 조회
- `POST /production/precheck-decisions` `403` — 작업 전 점검 통제 판정 기록
- `GET /production/work-sessions` — 작업 세션 목록
- `POST /production/work-sessions` `403` — 작업 시작 — 세션 열기
- `GET /production/work-sessions/{workSessionId}` — 세션 한 건
- `GET /production/work-sessions/{workSessionId}/events` — 세션 이벤트 목록
- `POST /production/work-sessions/{workSessionId}/events` `403` — 세션 이벤트 적재
- `GET /production/work-sessions/{workSessionId}/workers` — 세션 작업자 목록
- `POST /production/work-sessions/{workSessionId}/workers` `403` — 작업자 참여
- `POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave` `403` — 작업자 이탈
- `POST /production/work-sessions/{workSessionId}:end` `403` — 세션 닫기


### I-12 · 적치 — 완료·임시적재(원장 STOCK_TRANSFER) (4건)

- `GET /logistics/putaway-tasks` — 적치 지시 목록
- `GET /logistics/putaway-tasks/{putawayTaskId}` — 적치 지시 상세
- `POST /logistics/putaway-tasks/{putawayTaskId}:complete` `403` — 적치 완료
- `POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary` `403` — 임시 위치 적재


### I-13 · 재고 이동 — 반출·도착 2단 (6건)

- `GET /logistics/stock-transfers` — 재고 이동 목록
- `POST /logistics/stock-transfers` `403` — 반출 등록
- `GET /logistics/stock-transfers/{stockTransferId}` — 재고 이동 상세
- `GET /logistics/stock-transfers/{stockTransferId}/lines` — 이동 라인 목록
- `PUT /logistics/stock-transfers/{stockTransferId}/lines` `403` — 이동 라인 치환
- `POST /logistics/stock-transfers/{stockTransferId}:arrive` `403` — 도착 확정


### I-14 · 재고 조정 — 등록·상신·전기 (7건)

- `GET /inventory/adjustments` — 재고 조정 목록
- `POST /inventory/adjustments` `403` — 재고 조정 등록
- `GET /inventory/adjustments/{inventoryAdjustmentId}` — 재고 조정 상세
- `GET /inventory/adjustments/{inventoryAdjustmentId}/lines` — 조정 라인 목록
- `PUT /inventory/adjustments/{inventoryAdjustmentId}/lines` `403` — 조정 라인 치환
- `POST /inventory/adjustments/{inventoryAdjustmentId}:post` `403` — 재고 조정 전기
- `POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval` `403` — 재고 조정 상신


### I-15 · 실사 — 개시·라인·마감 (6건)

- `GET /inventory/counts` — 실사 목록
- `POST /inventory/counts` `403` — 실사 개시
- `GET /inventory/counts/{inventoryCountId}` — 실사 상세
- `GET /inventory/counts/{inventoryCountId}/lines` — 실사 라인 목록
- `PUT /inventory/counts/{inventoryCountId}/lines` `403` — 한 위치의 실사 라인 치환
- `POST /inventory/counts/{inventoryCountId}:close` `403` — 실사 마감


### I-16 · 취급 단위 — 등록·구성·포장확정·재구성 이력 (7건)

- `GET /inventory/handling-units` — 취급 단위 목록
- `POST /inventory/handling-units` `403` — 취급 단위 등록
- `GET /inventory/handling-units/{handlingUnitId}` — 취급 단위 상세
- `GET /inventory/handling-units/{handlingUnitId}/contents` — 취급 단위 구성 목록
- `PUT /inventory/handling-units/{handlingUnitId}/contents` `403` — 취급 단위 구성 치환
- `GET /inventory/handling-units/{handlingUnitId}/repack-events` — 포장 재구성 이력
- `POST /inventory/handling-units/{handlingUnitId}:pack` `403` — 포장 확정


### I-17 · 재생재 등록 (1건)

- `POST /logistics/recycle-entries` `403` — 재생재 등록


### I-18 · LOT 부가 — 외부식별자·보류 조회·상태 이력·IQC 생략 (5건)

- `GET /trace/lot-status-events` — LOT 상태 변경이력 조회 — 전이 9종 전건
- `GET /trace/lots/{lotId}/external-identifiers` — LOT 외부 식별자 목록
- `PUT /trace/lots/{lotId}/external-identifiers` `403` — LOT 외부 식별자 치환
- `GET /trace/lots/{lotId}/holds` — LOT 보류 목록
- `POST /trace/lots/{lotId}:request-iqc-skip` `403` — 긴급 IQC 생략 요청


### I-19 · 검사 — 의뢰·결과·측정치·판정 확정 (11건)

- `GET /quality/inspection-requests` — 검사 의뢰 목록
- `GET /quality/inspection-requests/{inspectionRequestId}` — 검사 의뢰 한 건
- `GET /quality/inspection-results` — 검사 결과 목록
- `POST /quality/inspection-results` `403` — 검사 결과 저장
- `GET /quality/inspection-results/defect-rate-trend` — 불량률 추이
- `GET /quality/inspection-results/summary` — 검사 요약
- `GET /quality/inspection-results/{inspectionResultId}` — 검사 결과 한 건
- `PUT /quality/inspection-results/{inspectionResultId}` `403` — 검사 결과 수정
- `GET /quality/inspection-results/{inspectionResultId}/measurement-summary` — 검사 결과의 항목별 측정 요약
- `GET /quality/inspection-results/{inspectionResultId}/measurements` — 측정치 목록
- `POST /quality/inspection-results/{inspectionResultId}:confirm` `403` — 검사 판정 확정


### I-20 · LOT 상태·보류 — 등록·해제·전이·요약 (10건)

- `GET /quality/defect-records` — 불량 실적 목록
- `GET /quality/defect-records/distribution` — 불량코드 분포
- `GET /quality/lot-hold-events` — 보류 등록·해제 사건 조회
- `GET /quality/lot-holds` — LOT 보류 목록
- `POST /quality/lot-holds` `403` — LOT 보류 등록
- `GET /quality/lot-holds/{lotHoldId}` — LOT 보류 한 건
- `POST /quality/lot-holds/{lotHoldId}:release` `403` — LOT 보류 해제·재판정
- `GET /quality/lot-status-summary` — LOT 상태 요약
- `GET /quality/lot-status-transitions` — 갈 수 있는 LOT 상태
- `GET /quality/lot-statuses` — LOT 품질 상태 목록


### I-21 · 부적합·처분·특채 (11건)

- `GET /quality/concessions` — 특채 목록
- `GET /quality/concessions/{concessionId}` — 특채 한 건
- `GET /quality/disposition-candidates` — 처분 판정 대상 목록
- `GET /quality/disposition-decisions` — 처분 결정 목록
- `GET /quality/disposition-decisions/{dispositionDecisionId}` — 처분 결정 한 건
- `GET /quality/nonconformances` — 부적합 목록
- `POST /quality/nonconformances` `403` — 부적합 등록
- `GET /quality/nonconformances/{nonconformanceId}` — 부적합 한 건
- `GET /quality/nonconformances/{nonconformanceId}/disposition-decisions` — 이 부적합의 처분 결정
- `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` `403` — 처분 판정 저장
- `POST /quality/nonconformances/{nonconformanceId}:request-disposition` `403` — 처분 판정 의뢰


### I-22 · 출하지시·출하작업지시·제품 피킹·LOT 배분 (9건)

- `GET /logistics/sales-orders` — 출하지시서 목록
- `GET /logistics/sales-orders/{salesOrderId}` — 출하지시서 한 건
- `GET /logistics/shipment-lot-allocations` — 출하 LOT 배분 목록
- `PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}` `403` — 배분에 포장 단위 연결
- `GET /logistics/shipment-requests` — 출하작업지시 목록
- `POST /logistics/shipment-requests` `403` — 출하작업지시 편성
- `GET /logistics/shipment-requests/summary` — 출하작업지시 요약
- `GET /logistics/shipment-requests/{shipmentRequestId}` — 출하작업지시 한 건
- `POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick` `403` — 제품 LOT 피킹 확정


### I-23 · 출하 — 처리·확정·취소 + 재고 재등록 (7건)

- `GET /logistics/shipments` — 출하 목록
- `POST /logistics/shipments` `403` — 출하 처리
- `GET /logistics/shipments/{shipmentId}` — 출하 한 건
- `POST /logistics/shipments/{shipmentId}:cancel` `403` — 출하 취소 실행
- `POST /logistics/shipments/{shipmentId}:confirm` `403` — 출하 확정
- `POST /logistics/shipments/{shipmentId}:request-cancel` `403` — 출하 취소 요청
- `POST /logistics/stock-reinstatements` `403` — 재고 재등록 확정


### I-24 · 생산 계획·생산오더(ERP 수신) (10건)

- `GET /planning/production-orders` — P/O 목록
- `GET /planning/production-orders/{productionOrderId}` — P/O 한 건
- `POST /planning/production-orders/{productionOrderId}:acknowledge` `403` — P/O 변경 확인 처리
- `POST /planning/production-orders/{productionOrderId}:resync` `403` — ERP 재동기 요청
- `GET /planning/production-plans` — 생산 계획 목록
- `POST /planning/production-plans` `403` — 생산 계획 추가
- `DELETE /planning/production-plans/{productionPlanId}` `403` — 생산 계획 삭제
- `GET /planning/production-plans/{productionPlanId}` — 생산 계획 한 건
- `PUT /planning/production-plans/{productionPlanId}` `403` — 생산 계획 수정
- `POST /planning/production-plans/{productionPlanId}:confirm` `403` — 전개 확정


### I-25 · 공정 인계·수리 왕복 (6건)

- `GET /production/operation-handovers` — 공정 인계 목록
- `POST /production/operation-handovers` `403` — 공정 인계 확정
- `GET /production/operation-handovers/{operationHandoverId}` — 공정 인계 한 건
- `GET /production/repair-executions` — 수리 실행 목록
- `POST /production/repair-executions` `403` — 수리 투입 등록
- `POST /production/repair-executions/{repairExecutionId}:return` — 수리 반출 등록


### I-26 · 제품 개체(시리얼) 발번 (2건)

- `GET /trace/serial-numbers` — 제품 개체 목록
- `POST /trace/serial-numbers` `403` — 제품 개체 대량 발번 **본길 유보(104·105)**


### I-27 · 발행 이력 — 기록·요약·인쇄 보고·프린터 (7건)

- `GET /app/document-issues` — 발행 이력 조회
- `POST /app/document-issues` `403` — 발행 · 재발행
- `GET /app/document-issues/summary` — 대상별 발행 요약 — 목록 화면용
- `GET /app/document-issues/{documentIssueLogId}` — 발행 기록 한 건
- `GET /app/document-issues/{documentIssueLogId}/rendition` — 출력물 이미지 · 문서
- `POST /app/document-issues/{documentIssueLogId}:report-print` — 인쇄 결과 보고
- `GET /app/printers` — 프린터 목록 · 상태 **본길 유보(I-27 R15)**


### I-28 · 알림 — 목록·읽음·이벤트·수신자 설정 (8건)

- `GET /app/notification-events` — 알림 이벤트 목록
- `GET /app/notification-subscriptions` `403` — 알림 수신자 설정 조회
- `PUT /app/notification-subscriptions` `403` — 알림 수신자 설정 저장
- `POST /app/notification-subscriptions/recipients:preview` `403` — 지금 받는 사람 미리보기
- `GET /app/notifications` — 알림 목록
- `GET /app/notifications/unread-count` — 안 읽은 알림 수
- `POST /app/notifications/{notificationId}:read` `403` — 알림 읽음 처리
- `POST /app/notifications:read-all` — 모두 읽음


### I-29 · 통합 대시보드 집계 (1건)

- `GET /app/dashboard-summary` `403` — 통합 대시보드 집계


### I-30 · 설비 — 점검·고장 (9건)

- `GET /maintenance/breakdowns` — 고장 기록 목록
- `POST /maintenance/breakdowns` `403` — 고장 보고 등록
- `GET /maintenance/breakdowns/{breakdownId}` — 고장 기록 한 건
- `PUT /maintenance/breakdowns/{breakdownId}` `403` — 처리 내역 저장
- `POST /maintenance/breakdowns/{breakdownId}:complete` `403` — 고장 완료 · 원인 마스터 원천 확인 전 보류(090)
- `POST /maintenance/breakdowns/{breakdownId}:start-handling` `403` — 처리 중으로
- `GET /maintenance/inspections` — 점검 기록 목록
- `POST /maintenance/inspections` `403` — 점검 기록 등록
- `GET /maintenance/inspections/{inspectionId}` — 점검 기록 한 건


### I-31 · 보전 — 지시·실적 (8건)

- `GET /maintenance/orders` — 보전 지시 목록
- `POST /maintenance/orders` `403` — 보전 지시 발행
- `GET /maintenance/orders/{maintenanceOrderId}` — 보전 지시 한 건
- `POST /maintenance/orders/{maintenanceOrderId}:cancel` `403` — 보전 지시 취소
- `GET /maintenance/results` — 보전 실적 목록
- `POST /maintenance/results` `403` — 보전 실적 등록
- `GET /maintenance/results/{maintenanceResultId}` — 보전 실적 한 건
- `PUT /maintenance/results/{maintenanceResultId}` `403` — 보전 실적 수정


### I-32 · 비가동 — 구간·집계 (6건)

- `GET /maintenance/downtimes` — 비가동 목록
- `POST /maintenance/downtimes` `403` — 비가동 등록
- `GET /maintenance/downtimes/summary` — 비가동 집계
- `GET /maintenance/downtimes/{downtimeId}` — 비가동 한 건
- `PUT /maintenance/downtimes/{downtimeId}` `403` — 비가동 수정
- `POST /maintenance/downtimes/{downtimeId}:close` `403` — 비가동 지금 종료


### I-33 · 툴 사용실적·계측기 이력·수집 채널 (12건)

- `GET /maintenance/calibrations` — 계측기 이력 목록
- `POST /maintenance/calibrations` `403` — 계측기 이력 등록
- `GET /maintenance/calibrations/{calibrationId}` — 계측기 이력 한 건
- `POST /maintenance/calibrations/{calibrationId}:clear` — 계측기 이력의 사용 차단을 해소한다
- `GET /maintenance/collection-channels` — 수집 채널 목록
- `POST /maintenance/collection-channels` `403` — 수집 채널 등록
- `GET /maintenance/collection-channels/observations` — 최근 수신 신호
- `GET /maintenance/collection-channels/{collectionChannelId}` — 수집 채널 한 건
- `PUT /maintenance/collection-channels/{collectionChannelId}` `403` — 수집 채널 수정
- `GET /maintenance/tool-usages` — 툴 사용실적 목록
- `POST /maintenance/tool-usages` `403` — 툴 사용실적 등록
- `GET /maintenance/tool-usages/{toolUsageId}` — 툴 사용실적 한 건


### I-34 · 첨부 — 올리기·목록·내려받기 (4건)

- `GET /app/attachments` — 첨부 목록
- `POST /app/attachments` `403` — 첨부 올리기
- `GET /app/attachments/{attachmentId}/content` — 첨부 파일 내려받기
- `POST /maintenance/breakdowns/{breakdownId}/attachments` `403` — 고장 사진 붙이기


### I-35 · 변경 이력·예비품 엑셀 (2건)

- `GET /audit/events` `403` — 변경 이력 조회
- `POST /mdm/spare-parts:import` `403` — 예비품 엑셀 올리기

---

_생성: 2026-09-06 · 통합 관점 계획자 · 계약 사본 `a6a87e1` · 코드·계약·스키마 무수정._
