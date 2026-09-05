# 남은 249건 구현 계획 — **API 설계 관점**

> 3관점 중 하나. 통합 정본은 `plan.md` 가 된다. 규칙: `README.md` · 공통 브리프: `planner-brief.md`.
> 계약 사본 `a6a87e1` 고정. **이 문서는 계획만 한다 — 코드·계약·스키마를 고치지 않았다.**
>
> 이 관점이 보는 축은 셋이다 — **상태기계**(무엇이 무엇으로 옮겨 가고 어느 전이가 원장을 부르는가) ·
> **계약 스키마 ↔ 물리 모델의 어긋남**(물리를 고친다는 원칙이라 그것이 곧 마이그레이션 목록) ·
> **횡단 관심사가 오퍼레이션마다 어떻게 붙는가**(403·멱등키·`If-Match`/`ETag`·계약 검증).

## 0. 이 계획이 선 근거 (실측)

계약 원문을 `jq` 로 훑어 249건 전건의 파라미터·응답·`x-*` 를 뽑았고, `prisma/schema.prisma`(181 모델)와
`prisma/seed.ts`(코드그룹 107 · 채번규칙 1)를 대조했다. 아래 수치는 전부 그 실측이다.

| 축 | 249건 중 | 근거 |
|---|---|---|
| `Idempotency-Key` 필수 | **116** | `#/components/parameters/IdempotencyKey`(`required: true`) 참조 수 |
| `If-Match` **필수** | **46** | `IfMatchVersion` 참조 |
| `If-Match` **선택** | **28** | `IfMatchVersionOptional` 참조 — 오프라인 큐 대상(공유계약 C-9) |
| 응답에 `ETag` 헤더 | **42** | `responses.*.headers.ETag` |
| 계약이 403 선언 | **116** | `uncovered.tsv` 의 403 열 |
| 그중 `OPERATION_PERMISSIONS` 에 **이미 있는 것** | **88** | `derived-permissions.ts` + `manual-permissions.ts` 키 대조 |
| 그중 **없어서 가드가 던지는 것** | **28** | 같은 대조 — §5.3 에 전건 나열 |
| 계약이 `codeGroupCode=` 로 가리키는 코드그룹 | 108종, **전건 시드됨** | `seed.ts` 대조 결과 미시드 0 |
| 계약이 `x-source-column` 을 단 프로퍼티 중 **물리에 없는 칸** | **0** | 선언된 앵커는 전부 실재 — 어긋남은 «앵커를 안 단 자리»에만 있다 |

⭐ 마지막 줄이 이 관점의 가장 큰 발견이다. 계약은 자기가 물리에 못 앉힌 자리를 `x-source-column`
**생략**과 `x-internal-note` 의 「모델에 이 컬럼이 아직 없다」로 스스로 표시해 두었다. 그래서 마이그레이션
목록은 추측이 아니라 **그 표시를 긁어 만든 것**이다(§5.2).

## 1. 슬라이스 목록

25 슬라이스, 249건 전건 배정. 「건너뜀」은 슬라이스 안에 남겨 두고 §3 표가 사유를 진다 —
슬라이스에서 빼면 그 슬라이스가 끝났는지 알 수 없다.

범례: **멱등** = `Idempotency-Key` 필수 · **If-Match** 필수/선택/— · **ETag** = 200·201 이 `ETag` 를 내림 ·
**403** = 계약이 403 을 선언(권한 게이트 대상).

> **완전성 보증** — 아래 25 표의 오퍼레이션 행을 합치면 **249개, 중복 0, 누락 0**이다(`uncovered.tsv`
> 와 기계 대조). §3 건너뜀 표의 4건은 슬라이스 표에도 남아 있어 두 번 나온다 — 슬라이스가 「무엇을
> 다 다뤘는가」를 잃지 않게 하려는 것이다.

### S01. 발주 P/O — 7건

| | |
|---|---|
| 선행 슬라이스 | 없음 (mdm 완료분이 원천) |
| 쓰는 표 | `logistics.purchase_order`·`purchase_order_line` — 있음 |
| 마이그레이션 | **필요** — `purchase_order.approval_request_id`(nullable FK) 신설. 계약 `PurchaseOrder.approvalRequestId` 가 `x-source-column` 없이 서 있고 노트가 「모델에 이 컬럼이 아직 없다」라 적었다. `PurchaseOrderCreate.sourceInboundReceiptLineId`(초과 입하 정산용 P/O 역참조)도 같은 자리. |
| posting(원장) 연결 | 없음 — P/O 는 재고를 안 움직인다 |
| 상태기계 | 있음 (`LOGISTICS_DOCUMENT_STATUS`) |
| 예상 PR 수 | 2 — ① 조회 GET 3건 ② 마이그레이션 선행 커밋 + 쓰기 4건 + e2e |
| 설계 미정 자리 · §2 판정 초안 | `:request-approval` 이 P/O 상태를 옮기는가. §2 2단계 기준 3(스키마를 안 늘리는 쪽) → **안 옮긴다**. 승인 진행은 `approval_request.status_code` 가 지고 문서는 `REGISTERED` 에 머문다. `LOGISTICS_DOCUMENT_STATUS` 4값에 「승인대기」가 없는 것이 그 근거다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/purchase-orders` | — | — | — | — |
| `GET /logistics/purchase-orders/{purchaseOrderId}` | — | — | ✓ | — |
| `GET /logistics/purchase-orders/{purchaseOrderId}/lines` | — | — | — | — |
| `POST /logistics/purchase-orders` | ✓ | — | ✓ | ✓ |
| `POST /logistics/purchase-orders/{purchaseOrderId}:request-approval` | ✓ | 필수 | — | ✓ |
| `PUT /logistics/purchase-orders/{purchaseOrderId}` | ✓ | 필수 | ✓ | ✓ |
| `PUT /logistics/purchase-orders/{purchaseOrderId}/lines` | ✓ | 필수 | ✓ | ✓ |

### S02. ASN·입하 — 12건

| | |
|---|---|
| 선행 슬라이스 | S01 |
| 쓰는 표 | `logistics.asn`·`asn_line`·`inbound_receipt`·`inbound_receipt_line`·`inbound_variance` — 있음 |
| 마이그레이션 | **필요** — `inbound_receipt_line.lot_id`(nullable FK). 계약 `InboundReceiptLine.lotId` 가 앵커 없이 선 자리다. 자재 LOT 등록(`POST /trace/lots`, 이미 구현)이 만든 LOT 을 입하 라인이 되짚어야 `document-progress` 의 후속 판정이 선다. |
| posting(원장) 연결 | 없음 — 입하는 아직 재고가 아니다(입고가 잡는다) |
| 상태기계 | 있음 (`LOGISTICS_DOCUMENT_STATUS`) · 라인 상태는 「칸 불필요」 |
| 예상 PR 수 | ~~3~~ → **6**(I-3 재수립 R-3) — ① ASN 조회 3 ②a 마이그 선행 + LOT 코어(`src/core/lot/` ≤200) ②b 입하 등록 + P/O 귀속 ③ 입하·차이 조회 4 ④ 헤더 수정·라인 치환 ⑤ `:split` + 차이 |
| 설계 미정 자리 · §2 판정 초안 | ~~`:split` 이 원 전표를 어떻게 두는가 … + 문의~~ → **철회**(I-3 재수립 R-8): `W-01-03` §5-1 이 「취소 · 원 도착으로 복귀 — 아직 아무것도 저장되지 않았다」로 답했고 `InboundReceiptSplitRequest` 다섯 칸에 원본을 가리키는 칸이 없다 — §2 **0단계**에서 끝난다. 두 건을 새로 만들고 원본은 «없다». 실제 문의는 026(입하 `POSTED` 축·두 PUT 화면 부재)·027(오류 기록 뒤 담당자 착지 화면 부재) |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/asns` | — | — | — | — |
| `GET /logistics/asns/{asnId}` | — | — | — | — |
| `GET /logistics/asns/{asnId}/lines` | — | — | — | — |
| `GET /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` | — | — | — | — |
| `GET /logistics/inbound-receipts` | — | — | — | — |
| `GET /logistics/inbound-receipts/{inboundReceiptId}` | — | — | ✓ | — |
| `GET /logistics/inbound-receipts/{inboundReceiptId}/lines` | — | — | — | — |
| `POST /logistics/inbound-receipt-lines/{inboundReceiptLineId}/variances` | ✓ | — | — | ✓ |
| `POST /logistics/inbound-receipts` | ✓ | 선택 | ✓ | ✓ |
| `POST /logistics/inbound-receipts:split` | ✓ | — | — | ✓ |
| `PUT /logistics/inbound-receipts/{inboundReceiptId}` | ✓ | 필수 | ✓ | ✓ |
| `PUT /logistics/inbound-receipts/{inboundReceiptId}/lines` | ✓ | 필수 | — | ✓ |

### S03. 적치 — 4건

| | |
|---|---|
| 선행 슬라이스 | 이미 구현된 입고(`goods-receipt`)가 `putaway_task` 를 만든다 |
| 쓰는 표 | `logistics.putaway_task` — 있음 |
| 마이그레이션 | 없음 — `PutawayTask.warehouseId`·`warehouseManagementLevelCode` 는 `from_location → warehouse` 조인 파생이다 |
| posting(원장) 연결 | **있음** — `:complete` 가 dock→선반 이동을 원장에 쌓는다 |
| 상태기계 | 있음 (`PUTAWAY_TASK_STATUS`: `PENDING`·`COMPLETED`·`COMPLETED_TEMPORARY`) |
| 예상 PR 수 | 2 — ① 조회 GET 2건 ② `:complete`+`:complete-temporary`+posting+e2e (코어 PR, diff ≤ 200) |
| 설계 미정 자리 · §2 판정 초안 | 없음 — 값 3개가 시드에 있고 계약이 전이 둘을 그대로 연다. 임시 적치에서 정상 적치로 가는 전이는 계약에 없다(dead end). |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/putaway-tasks` | — | — | — | — |
| `GET /logistics/putaway-tasks/{putawayTaskId}` | — | — | ✓ | — |
| `POST /logistics/putaway-tasks/{putawayTaskId}:complete` | ✓ | 선택 | — | ✓ |
| `POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary` | ✓ | 선택 | — | ✓ |

### S04. 출고·피킹·자재요청·현장입고 — 17건

| | |
|---|---|
| 선행 슬라이스 | S03 · S09(승인) |
| 쓰는 표 | `logistics.goods_issue`·`goods_issue_line`·`picking_order`·`picking_line`·`material_issue_request(_line)`·`shopfloor_receipt(_line)` — 전부 있음 |
| 마이그레이션 | 없음 (실측) — `goods_issue.approval_request_id`·취소 흔적 3칸이 **이미 있다**. 계약의 「모델에 이 컬럼이 아직 없다」 노트는 **낡았다**(§5.2 표 B). |
| posting(원장) 연결 | **있음** — `:post` 가 창고→목적지 출고를 쌓는다. 피킹 `:pick` 은 `inventory_reservation` 을 걸고 푼다 |
| 상태기계 | 있음 (`LOGISTICS_DOCUMENT_STATUS`) · 피킹 라인 상태는 「칸 불필요」(`plannedQty ↔ pickedQty` 가 진행을 담는다) |
| 예상 PR 수 | 4 — ① 조회 GET 10건 ② 출고 전표 + `:post` posting + e2e(코어) ③ `:request-approval` + 라인 PUT ④ 자재요청·피킹`:pick`·현장입고 + e2e |
| 설계 미정 자리 · §2 판정 초안 | `:post` 가 「승인이 필요한 전표」를 어떻게 가르는가. 계약이 `reasonCode` → 결재선 파생(G-31)이라 적었다 → **결재선이 그 유형·사업부로 존재하면 승인 필수**로 읽는다. §2 0단계 선례 인용. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/goods-issues` | — | — | — | — |
| `GET /logistics/goods-issues/{goodsIssueId}` | — | — | ✓ | — |
| `GET /logistics/goods-issues/{goodsIssueId}/lines` | — | — | — | — |
| `GET /logistics/material-issue-requests` | — | — | — | — |
| `GET /logistics/material-issue-requests/shortage` | — | — | — | — |
| `GET /logistics/material-issue-requests/{materialIssueRequestId}` | — | — | — | — |
| `GET /logistics/picking-orders` | — | — | — | — |
| `GET /logistics/picking-orders/{pickingOrderId}` | — | — | — | — |
| `GET /logistics/shopfloor-receipts` | — | — | — | — |
| `GET /logistics/shopfloor-receipts/{shopfloorReceiptId}` | — | — | — | — |
| `POST /logistics/goods-issues` | ✓ | 선택 | ✓ | ✓ |
| `POST /logistics/goods-issues/{goodsIssueId}:post` | ✓ | 필수 | — | ✓ |
| `POST /logistics/goods-issues/{goodsIssueId}:request-approval` | ✓ | 필수 | — | ✓ |
| `POST /logistics/material-issue-requests` | ✓ | 선택 | — | ✓ |
| `POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick` | ✓ | 선택 | — | ✓ |
| `POST /logistics/shopfloor-receipts` | ✓ | 선택 | — | ✓ |
| `PUT /logistics/goods-issues/{goodsIssueId}/lines` | ✓ | 필수 | — | ✓ |

### S05. 창고이동·재생재 — 7건

| | |
|---|---|
| 선행 슬라이스 | S04 |
| 쓰는 표 | `logistics.stock_transfer`·`stock_transfer_line`·`recycle_entry` — 있음 |
| 마이그레이션 | **필요** — `stock_transfer_line.handling_unit_id`(nullable FK, 계약 `StockTransferLine.handlingUnitId` 앵커 없음) · `recycle_entry` 에 `warehouse_id`·`remarks` 신설(계약 `RecycleEntry.warehouseId`·`remarks`). |
| posting(원장) 연결 | **있음** — `POST /logistics/stock-transfers` 가 반출(`IN_TRANSIT`), `:arrive` 가 입고를 쌓는 **2단 전기** |
| 상태기계 | 있음 (`LOGISTICS_DOCUMENT_STATUS`) |
| 예상 PR 수 | 3 — ① 조회 GET 3건 ② 이동 2단 + posting + e2e(코어) ③ 재생재 + e2e |
| 설계 미정 자리 · §2 판정 초안 | `:arrive` 부분 도착이 상태를 어디로 두는가. 계약은 「반출한 수량 이하만」만 적는다. §2 2단계 기준 3 → **상태값을 늘리지 않는다**. 부분 도착은 `received_qty` 합이 담고 전액 도착에서만 `POSTED` 로 옮긴다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/stock-transfers` | — | — | — | — |
| `GET /logistics/stock-transfers/{stockTransferId}` | — | — | ✓ | — |
| `GET /logistics/stock-transfers/{stockTransferId}/lines` | — | — | — | — |
| `POST /logistics/recycle-entries` | ✓ | 선택 | — | ✓ |
| `POST /logistics/stock-transfers` | ✓ | 선택 | ✓ | ✓ |
| `POST /logistics/stock-transfers/{stockTransferId}:arrive` | ✓ | 선택 | — | ✓ |
| `PUT /logistics/stock-transfers/{stockTransferId}/lines` | ✓ | 필수 | — | ✓ |

### S06. 문서진행·취소 (다형) — 4건

| | |
|---|---|
| 선행 슬라이스 | S02·S04 · **구현된 입고** · S09(승인) |
| 쓰는 표 | `app.document_cancellation` — **있음**(실측). 진행 조회는 파생 뷰라 전용 표가 없다 |
| 마이그레이션 | 없음 — ⭐ §I-38 「취소 흔적 2/14 표」가 **`app.document_cancellation` 로 이미 해소돼 있다**. 유형·id·직전상태·사유·시각·주체를 다 담는 다형 표다. 유형별 표에 3칸을 더할 이유가 사라졌다. |
| posting(원장) 연결 | **있음** — 전기된 문서면 역트랜잭션. 전기 전이면 상태만 바뀌고 원장에 아무것도 안 생긴다(`CancelResult.reversed`) |
| 상태기계 | **있음 · 이 계획의 중심 상태기계**(§5.1-A) |
| 예상 PR 수 | 3 — ① 진행 조회 2건(후속 판정 포함) ② `:request-cancel` + 승인 연결 + e2e ③ `:cancel` + 역전기 + `SUCCESSOR_EXISTS` 재판정 + e2e (코어) |
| 설계 미정 자리 · §2 판정 초안 | `DocumentProgress.screenId` — **채울 표가 없다**(계약 재검토 2026-09-04 §3). 계약이 물러난 길을 이미 적었다: 「정하지 못하면 이 키를 생략한다(널을 보내지 않는다)」. 그대로 생략한다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/document-progress` | — | — | — | — |
| `GET /logistics/document-progress/{documentTypeCode}/{documentId}` | — | — | — | — |
| `POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel` | ✓ | 필수 | — | ✓ |
| `POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel` | ✓ | 필수 | — | ✓ |

### S07. 실사·조정·취급단위·예약 — 21건

| | |
|---|---|
| 선행 슬라이스 | S06(취소 축) · S09(승인) |
| 쓰는 표 | `inventory.inventory_count(_line)`·`inventory_adjustment(_line)`·`handling_unit(_content)`·`handling_unit_reconfiguration(_line)`·`inventory_reservation` — **전부 있음** |
| 마이그레이션 | 없음 (실측) — 계약이 「`inventory_adjustment_line` 은 물리 모델에 아직 없다」라 두 곳에 적었는데 **낡았다**. 우리 모델에 있다(§5.2 표 B). |
| posting(원장) 연결 | **있음** — `:post` 가 실사 차이를 원장 트랜잭션으로 쌓는다(결정 49 「잔량 직접 덮어쓰기 금지」) |
| 상태기계 | 있음 (`INVENTORY_COUNT_STATUS` 3값 · 조정은 `LOGISTICS_DOCUMENT_STATUS`) |
| 예상 PR 수 | 5 — ① 조회 GET 11건 ② 실사 전표 + 라인 PUT ③ `:close` + 마감 판정 4사유 ④ 조정 + `:post` posting + `:request-approval` + e2e(코어) ⑤ 취급단위 + `:pack` + 재포장 이력 |
| 설계 미정 자리 · §2 판정 초안 | 취급단위 `status_code` 가 NOT NULL 인데 계약이 「칸 불필요」로 닫았다(`x-no-code-key`). §2 2단계 기준 4(값을 조용히 도출하지 않는 쪽) → **고정 상수 하나**를 쓰고 이름을 붙여 남긴다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /inventory/adjustments` | — | — | — | — |
| `GET /inventory/adjustments/{inventoryAdjustmentId}` | — | — | ✓ | — |
| `GET /inventory/adjustments/{inventoryAdjustmentId}/lines` | — | — | — | — |
| `GET /inventory/counts` | — | — | — | — |
| `GET /inventory/counts/{inventoryCountId}` | — | — | ✓ | — |
| `GET /inventory/counts/{inventoryCountId}/lines` | — | — | — | — |
| `GET /inventory/handling-units` | — | — | — | — |
| `GET /inventory/handling-units/{handlingUnitId}` | — | — | ✓ | — |
| `GET /inventory/handling-units/{handlingUnitId}/contents` | — | — | — | — |
| `GET /inventory/handling-units/{handlingUnitId}/repack-events` | — | — | — | — |
| `GET /inventory/reservations` | — | — | — | — |
| `POST /inventory/adjustments` | ✓ | — | ✓ | ✓ |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:post` | ✓ | 필수 | — | ✓ |
| `POST /inventory/adjustments/{inventoryAdjustmentId}:request-approval` | ✓ | 필수 | — | ✓ |
| `POST /inventory/counts` | ✓ | — | ✓ | ✓ |
| `POST /inventory/counts/{inventoryCountId}:close` | ✓ | 필수 | — | ✓ |
| `POST /inventory/handling-units` | ✓ | — | ✓ | ✓ |
| `POST /inventory/handling-units/{handlingUnitId}:pack` | ✓ | 선택 | — | ✓ |
| `PUT /inventory/adjustments/{inventoryAdjustmentId}/lines` | ✓ | 필수 | ✓ | ✓ |
| `PUT /inventory/counts/{inventoryCountId}/lines` | ✓ | 선택 | — | ✓ |
| `PUT /inventory/handling-units/{handlingUnitId}/contents` | ✓ | 선택 | — | ✓ |

### S08. LOT 부수 (외부식별자·보류·이력·완료) — 7건

| | |
|---|---|
| 선행 슬라이스 | 구현된 `trace/lot` · S19(보류 등록) |
| 쓰는 표 | `trace.lot_external_identifier`·`lot_hold`·`lot_status_event`·`lot_lifecycle_history` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 — `:complete` 는 LOT 상태와 W/O 사유만 쓴다 |
| 상태기계 | **있음** — `trace.lot.lifecycle_status_code`(L1·L2·L3 는 이미 `transitions.ts` 에 등록됨) · `:complete` 는 그 셋 밖의 새 전이 |
| 예상 PR 수 | 2 — ① 조회 GET 4건 ② `:complete`·`:request-iqc-skip`·외부식별자 PUT + e2e |
| 설계 미정 자리 · §2 판정 초안 | `:complete` 가 «수명주기» 축인지 «품질» 축인지. 계약은 「생산 LOT 을 완료로 옮긴다」만 적는다. `LOT_LIFECYCLE_STATUS` 3값에 「완료」가 없고 `LOT_STATUS` 4값에도 없다 → §2 1단계 **본길**. 계약 문자 그대로 두고(어느 칸도 안 옮기고 W/O 사유만 기록) 문의를 낸다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /trace/lot-lifecycle-events` | — | — | — | — |
| `GET /trace/lot-status-events` | — | — | — | — |
| `GET /trace/lots/{lotId}/external-identifiers` | — | — | — | — |
| `GET /trace/lots/{lotId}/holds` | — | — | — | — |
| `POST /trace/lots/{lotId}:complete` | ✓ | 선택 | — | ✓ |
| `POST /trace/lots/{lotId}:request-iqc-skip` | ✓ | — | — | ✓ |
| `PUT /trace/lots/{lotId}/external-identifiers` | ✓ | 필수 | — | ✓ |

### S09. 결재선·승인요청 — 12건

| | |
|---|---|
| 선행 슬라이스 | 없음 — **모든 `:request-approval`·`:request-cancel` 의 선행이다** |
| 쓰는 표 | `app.approval_route`·`approval_route_step`·`approval_request`·`approval_step` — 있음 |
| 마이그레이션 | **필요** — `approval_route` 에 부분 유일 인덱스 `(approval_type_code, COALESCE(business_unit_id,0)) WHERE is_active` (§I-35). `:activate` 가 「같은 (approvalTypeCode, businessUnitId) 로 이미 활성인 것이 있으면 400」이라 요구한다. |
| posting(원장) 연결 | 없음 — ⭐ 「승인은 자물쇠를 풀 뿐 실행하지 않는다」(계약 J-8) |
| 상태기계 | **있음** (`APPROVAL_REQUEST_STATUS`: `PENDING`·`APPROVED`·`REJECTED` · 결재선은 `is_active` 불리언 축이라 상태기계가 아니다) |
| 예상 PR 수 | 3 — ① 결재선 CRUD + 단계 PUT + 유일 인덱스 마이그 ② 승인 요청 조회 2건 ③ `:approve`/`:reject` + 순차 결재 강제 + e2e |
| 설계 미정 자리 · §2 판정 초안 | 결재선이 둘 이상 걸릴 때. 계약이 **정본을 스스로 가졌다** — ① 사업부 지정본이 공통본을 이긴다 ② 그러고도 둘이면 `400 ROUTE_AMBIGUOUS`. 미정이 아니다(§2 0단계). |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /app/approval-requests` | — | — | — | ✓ |
| `GET /app/approval-requests/{approvalRequestId}` | — | — | ✓ | ✓ |
| `GET /app/approval-routes` | — | — | — | — |
| `GET /app/approval-routes/{approvalRouteId}` | — | — | ✓ | — |
| `GET /app/approval-routes/{approvalRouteId}/steps` | — | — | — | — |
| `POST /app/approval-requests/{approvalRequestId}:approve` | ✓ | 필수 | ✓ | ✓ |
| `POST /app/approval-requests/{approvalRequestId}:reject` | ✓ | 필수 | ✓ | ✓ |
| `POST /app/approval-routes` | ✓ | — | ✓ | ✓ |
| `POST /app/approval-routes/{approvalRouteId}:activate` | ✓ | 필수 | ✓ | ✓ |
| `POST /app/approval-routes/{approvalRouteId}:deactivate` | ✓ | 필수 | ✓ | ✓ |
| `PUT /app/approval-routes/{approvalRouteId}` | ✓ | 필수 | ✓ | ✓ |
| `PUT /app/approval-routes/{approvalRouteId}/steps` | ✓ | 필수 | — | ✓ |

### S10. 알림 — 8건

| | |
|---|---|
| 선행 슬라이스 | S09(승인 요청이 알림 대상) |
| 쓰는 표 | `app.notification`·`notification_event`·`notification_subscription` — 있음, **구조가 다르다** |
| 마이그레이션 | **필요 · 구조 변경** — 계약의 구독은 「이벤트 하나의 수신자 목록」(`recipients[]` = `ROLE`(businessUnitId+roleId) | `USER`)인데 물리는 「사용자 하나의 이벤트 구독」(`app_user_id, event_type_code, channel_code`)이다. 축이 반대다. `app.notification_subscription_recipient`(nullable business_unit_id·role_id·app_user_id) 신설 + `notification_subscription` 에 `zalo_enabled` 추가가 최소안. |
| posting(원장) 연결 | 없음 |
| 상태기계 | 없음 — 읽음은 `read_at` 시각 축이다 |
| 예상 PR 수 | 2 — ① 알림 조회 4건 + `:read`/`:read-all` ② 마이그 + 구독 PUT + `recipients:preview` + e2e |
| 설계 미정 자리 · §2 판정 초안 | `zaloEnabled` — 계약이 스스로 「켜도 보낼 곳이 아직 없다」라 적었다. 칸만 만들고 전송기는 만들지 않는다(§0 범위). |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /app/notification-events` | — | — | — | — |
| `GET /app/notification-subscriptions` | — | — | ✓ | ✓ |
| `GET /app/notifications` | — | — | — | — |
| `GET /app/notifications/unread-count` | — | — | — | — |
| `POST /app/notification-subscriptions/recipients:preview` | ✓ | — | — | ✓ |
| `POST /app/notifications/{notificationId}:read` | ✓ | — | — | ✓ |
| `POST /app/notifications:read-all` | ✓ | — | — | — |
| `PUT /app/notification-subscriptions` | ✓ | 필수 | — | ✓ |

### S11. 발행이력·프린터 — 7건

| | |
|---|---|
| 선행 슬라이스 | 없음 |
| 쓰는 표 | `app.document_issue_log`·`app.printer` — 있음 |
| 마이그레이션 | **필요** — `document_issue_log` 에 인쇄 결과 칸(`print_outcome_code`·`print_failure_reason`·`printed_at`)이 없다. `:report-print` 가 그것을 쓴다. `printer` 에 `display_name`·`status`·`status_message`·`is_default`·`supported_document_type_codes` 없음. |
| posting(원장) 연결 | 없음 |
| 상태기계 | 없음 — 발행은 append-only(「발행 기록을 되돌리지 않는다」) |
| 예상 PR 수 | 2 — ① 조회 GET 4건(rendition 제외) ② 마이그 + `POST /app/document-issues` + `:report-print` + e2e |
| 설계 미정 자리 · §2 판정 초안 | `printer.status` 가 무엇에서 오는가. 실물 프린터를 물어볼 길이 없다(C11 인터넷 비보장). §2 2단계 기준 4 → **저장 칸으로 두고 사람이 갱신**한다. 자동 탐지를 지어내지 않는다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /app/document-issues` | — | — | — | — |
| `GET /app/document-issues/summary` | — | — | — | — |
| `GET /app/document-issues/{documentIssueLogId}` | — | — | — | — |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | — | — | — | — |
| `GET /app/printers` | — | — | — | — |
| `POST /app/document-issues` | ✓ | — | — | ✓ |
| `POST /app/document-issues/{documentIssueLogId}:report-print` | ✓ | — | — | — |

### S12. 감사·첨부·대시보드 — 5건

| | |
|---|---|
| 선행 슬라이스 | 없음 |
| 쓰는 표 | `audit.audit_event`(occurred_at RANGE 파티션)·`app.attachment` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 |
| 상태기계 | 없음 |
| 예상 PR 수 | 2 — ① `GET /audit/events`(기간 필수) + `GET /app/attachments` 목록 ② `GET /app/dashboard-summary` |
| 설계 미정 자리 · §2 판정 초안 | `audit_event.before_value`/`after_value` jsonb 키 규약이 없다(§I-5 · 계약이 직접 「사람이 읽게 만들 수 없다」라 적음). §2 1단계 = 가장자리 → 원본 jsonb 를 그대로 내리고 화면 가공은 하지 않는다. 대시보드 OEE 의 분모(계획 조업 시간)는 `mdm.work_calendar*` 에서 구한다(계약이 지목). |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /app/attachments` | — | — | — | — |
| `GET /app/attachments/{attachmentId}/content` | — | — | — | — |
| `GET /app/dashboard-summary` | — | — | — | ✓ |
| `GET /audit/events` | — | — | — | ✓ |
| `POST /app/attachments` | ✓ | — | — | ✓ |

### S13. 계획·상위지시 — 10건

| | |
|---|---|
| 선행 슬라이스 | 없음 (ERP 수신본) |
| 쓰는 표 | `planning.production_order`·`production_order_change_field`·`production_order_acknowledgement`·`production_plan` — 있음 |
| 마이그레이션 | **필요** — `production_plan.split_of_plan_id`(nullable self FK). 계약 `ProductionPlanCreate.splitOfPlanId` + 시드에 `PRODUCTION_PLAN_SPLIT_REASON` 이 이미 있다. |
| posting(원장) 연결 | 없음 |
| 상태기계 | 있음 (`PRODUCTION_PLAN_STATUS` 2값 `DRAFT`·`CONFIRMED` · `PRODUCTION_ORDER_STATUS` 3값) |
| 예상 PR 수 | 3 — ① 조회 GET 4건 ② 마이그 + 계획 CRUD + DELETE ③ `:confirm`(전개까지 한 트랜잭션) + `:acknowledge`/`:resync` + e2e (코어 — W/O 를 만든다) |
| 설계 미정 자리 · §2 판정 초안 | `:resync` 가 무엇을 남기는가 — 202 이고 「결과는 연계 수신으로 온다」. §0 범위대로 **아웃박스 행 하나**(`integration.integration_message`)까지만 하고 전송기는 안 만든다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `DELETE /planning/production-plans/{productionPlanId}` | ✓ | 필수 | — | ✓ |
| `GET /planning/production-orders` | — | — | — | — |
| `GET /planning/production-orders/{productionOrderId}` | — | — | ✓ | — |
| `GET /planning/production-plans` | — | — | — | — |
| `GET /planning/production-plans/{productionPlanId}` | — | — | ✓ | — |
| `POST /planning/production-orders/{productionOrderId}:acknowledge` | ✓ | 필수 | — | ✓ |
| `POST /planning/production-orders/{productionOrderId}:resync` | ✓ | — | — | ✓ |
| `POST /planning/production-plans` | ✓ | — | — | ✓ |
| `POST /planning/production-plans/{productionPlanId}:confirm` | ✓ | 필수 | — | ✓ |
| `PUT /planning/production-plans/{productionPlanId}` | ✓ | 필수 | — | ✓ |

### S14. 작업지시 — 13건

| | |
|---|---|
| 선행 슬라이스 | S13 |
| 쓰는 표 | `production.work_order`·`work_order_dependency`·`work_order_resource_assignment` — 있음 |
| 마이그레이션 | 없음 · ⚠ 다만 `:close` 의 「개발품 제외」 판정 축이 `mdm.item.development_item` 인데 그 칸이 없다(계약이 직접 적음). 계약도 「그때까지 서버는 전건을 적재한다」라 물러났으니 **칸을 만들지 않고 전건 적재**한다. |
| posting(원장) 연결 | 없음 (직접) — 다만 `:release` 가 자재 출고요청을 자동 발행하고 `:cancel`/`:close` 가 선발행 LOT 을 폐번한다 |
| 상태기계 | **있음 · 두 축 동시**(`WORK_ORDER_STATUS` 8값 + `trace.lot.lifecycle_status_code` L2·L3) — §5.1-C |
| 예상 PR 수 | 4 — ① 조회 GET 4건 + 자원계획 POST/DELETE ② W/O 생성·수정 ③ `:release`(선발행 + 출고요청 자동발행, 코어) ④ `:hold`/`:resume`/`:close`/`:cancel` + e2e (코어) |
| 설계 미정 자리 · §2 판정 초안 | `:close` 의 「정상」 허용 오차 폭. 계약이 「서버 정책이 정한다」라 넘겼고 `app.operation_policy` 자리가 있다. 상수로 두고 근거를 적는다(server-architecture §5 4번과 같은 처리). 이월 잔량 W/O 자동 생성은 **계약이 「아직 정해지지 않았다 — 만들지 않는다」**라 못박았다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `DELETE /production/work-orders/{workOrderId}/resource-plans/{workOrderResourcePlanId}` | ✓ | — | — | — |
| `GET /production/work-orders` | — | — | — | — |
| `GET /production/work-orders/{workOrderId}` | — | — | ✓ | — |
| `GET /production/work-orders/{workOrderId}/resource-plans` | — | — | — | — |
| `GET /production/work-orders/{workOrderId}/validation` | — | — | — | ✓ |
| `POST /production/work-orders` | ✓ | — | ✓ | ✓ |
| `POST /production/work-orders/{workOrderId}/resource-plans` | ✓ | — | — | — |
| `POST /production/work-orders/{workOrderId}:cancel` | ✓ | 필수 | — | ✓ |
| `POST /production/work-orders/{workOrderId}:close` | ✓ | 필수 | — | ✓ |
| `POST /production/work-orders/{workOrderId}:hold` | ✓ | 선택 | — | ✓ |
| `POST /production/work-orders/{workOrderId}:release` | ✓ | 필수 | — | ✓ |
| `POST /production/work-orders/{workOrderId}:resume` | ✓ | 선택 | — | ✓ |
| `PUT /production/work-orders/{workOrderId}` | ✓ | 필수 | — | ✓ |

### S15. 작업세션 — 9건

| | |
|---|---|
| 선행 슬라이스 | S14 |
| 쓰는 표 | `production.work_session`·`work_session_event`·`work_session_worker` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 |
| 상태기계 | 있음 (`WORK_SESSION_STATUS`: `RUNNING`·`STOPPED`·`ENDED`) — ⚠ **W/O 층과 세션 층을 섞지 않는다** |
| 예상 PR 수 | 2 — ① 조회 GET 4건 ② 세션 열기·사건·작업자·`:leave`·`:end` + e2e |
| 설계 미정 자리 · §2 판정 초안 | 없음 — 계약이 층 분리를 문장으로 못박았다(「`:hold` 는 W/O 의 status_code, `events` 의 `STOP` 은 세션 층」). |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /production/work-sessions` | — | — | — | — |
| `GET /production/work-sessions/{workSessionId}` | — | — | — | — |
| `GET /production/work-sessions/{workSessionId}/events` | — | — | — | — |
| `GET /production/work-sessions/{workSessionId}/workers` | — | — | — | — |
| `POST /production/work-sessions` | ✓ | 선택 | — | ✓ |
| `POST /production/work-sessions/{workSessionId}/events` | ✓ | 선택 | — | ✓ |
| `POST /production/work-sessions/{workSessionId}/workers` | ✓ | 선택 | — | ✓ |
| `POST /production/work-sessions/{workSessionId}/workers/{workSessionWorkerId}:leave` | ✓ | — | — | ✓ |
| `POST /production/work-sessions/{workSessionId}:end` | ✓ | 선택 | — | ✓ |

### S16. 실적·소비·반납·인계·사전점검·수리 — 19건

| | |
|---|---|
| 선행 슬라이스 | S14·S15 · S09(정정 승인) |
| 쓰는 표 | `production.production_result(_lot_allocation)`·`material_consumption`·`material_return(_line)`·`operation_handover(_line)`·`precheck_decision`·`repair_execution`·`material_usage_allocation` — 전부 있음 |
| 마이그레이션 | 없음 · ⚠ `production_result.shift_id` 가 NOT NULL 인데 계약이 필수를 풀었다(「교대는 설계가 정의하는 값이 아니다」). 물리를 고치는 쪽이면 nullable 로 완화 — 두 릴리스 규칙에 안 걸린다(삭제가 아니다). |
| posting(원장) 연결 | **있음** — 실적이 완제품을 잡고 자재 소비가 WIP 를 뺀다. 반납은 역방향 |
| 상태기계 | **있음** — `trace.lot.lifecycle_status_code` L1(대기→활성, 이미 등록됨) · 실적 자체의 `status_code` 는 「칸 불필요」 |
| 예상 PR 수 | 5 — ① 조회 GET 10건 ② 실적 + LOT 배분 + L1 전이 + posting + e2e(코어) ③ 자재 소비/반납 + posting + e2e(코어) ④ `:correct` + `:request-approval`(A급 판정) ⑤ 인계·사전점검·수리 + `:return` |
| 설계 미정 자리 · §2 판정 초안 | `:request-approval` 의 「A급 보정」 판정식. 계약이 「서버가 정정 내용으로 판정한다」만 적었다 — §2 1단계 **본길**(모든 호출의 결과가 갈린다). 계약 문자 그대로 = 「수불에 영향을 주는 정정」으로 좁게 읽어 **수량 칸이 바뀌면 A급**으로 두고 문의를 낸다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /production/material-consumptions` | — | — | — | — |
| `GET /production/material-consumptions/{materialConsumptionId}` | — | — | — | — |
| `GET /production/material-returns` | — | — | — | — |
| `GET /production/material-returns/{materialReturnId}` | — | — | — | — |
| `GET /production/operation-handovers` | — | — | — | — |
| `GET /production/operation-handovers/{operationHandoverId}` | — | — | — | — |
| `GET /production/precheck-decisions` | — | — | — | — |
| `GET /production/production-results` | — | — | — | — |
| `GET /production/production-results/{productionResultId}` | — | — | — | — |
| `GET /production/repair-executions` | — | — | — | — |
| `POST /production/material-consumptions` | ✓ | 선택 | — | ✓ |
| `POST /production/material-returns` | ✓ | 선택 | — | ✓ |
| `POST /production/operation-handovers` | ✓ | 선택 | — | ✓ |
| `POST /production/precheck-decisions` | ✓ | — | — | ✓ |
| `POST /production/production-results` | ✓ | 선택 | — | ✓ |
| `POST /production/production-results/{productionResultId}:correct` | ✓ | — | — | ✓ |
| `POST /production/production-results/{productionResultId}:request-approval` | ✓ | — | — | ✓ |
| `POST /production/repair-executions` | ✓ | — | — | ✓ |
| `POST /production/repair-executions/{repairExecutionId}:return` | ✓ | — | — | — |

### S17. 시리얼 — 2건

| | |
|---|---|
| 선행 슬라이스 | S16 |
| 쓰는 표 | `trace.serial_number`·`serial_component_relation` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 |
| 상태기계 | 없음 — 계약이 「칸 불필요」로 닫음 |
| 예상 PR 수 | 1 |
| 설계 미정 자리 · §2 판정 초안 | 없음 |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /trace/serial-numbers` | — | — | — | — |
| `POST /trace/serial-numbers` | ✓ | 선택 | — | ✓ |

### S18. 검사결과·측정·의뢰 — 11건

| | |
|---|---|
| 선행 슬라이스 | S16(실적이 검사 의뢰를 만든다) · S19(LOT 상태 전이 대상) |
| 쓰는 표 | `quality.inspection_request`·`inspection_result`·`inspection_measurement`·`inspection_item_spec` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 — 다만 `:confirm` 이 LOT 품질 상태를 옮겨 **차단 판정을 바꾼다**(결정 10) |
| 상태기계 | **있음 · 두 축**(`INSPECTION_RESULT_STATUS` `DRAFT`→`CONFIRMED` + `trace.lot.status_code` C-계열 전이) — §5.1-E |
| 예상 PR 수 | 3 — ① 조회 GET 8건 ② 결과 등록·수정 + 측정치 ③ `:confirm` + LOT 상태 전이 + PQC 일괄 전이 + e2e (코어) |
| 설계 미정 자리 · §2 판정 초안 | ⛔ **`transitions.ts` 가 품질 축을 일부러 비워 두었다** — 시드 `LOT_STATUS`(`NORMAL`·`INSPECTION_PENDING`·`DEFECTIVE`·`SCRAPPED`)와 `LOT_STATUS_TRANSITION`(C4·C5·C6·C7·C8·C9·C10·C14·C15)의 대응이 없다. 이 슬라이스의 **최대 갈림길**이고 §5.1-E 가 초안을 낸다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /quality/inspection-requests` | — | — | — | — |
| `GET /quality/inspection-requests/{inspectionRequestId}` | — | — | — | — |
| `GET /quality/inspection-results` | — | — | — | — |
| `GET /quality/inspection-results/defect-rate-trend` | — | — | — | — |
| `GET /quality/inspection-results/summary` | — | — | — | — |
| `GET /quality/inspection-results/{inspectionResultId}` | — | — | ✓ | — |
| `GET /quality/inspection-results/{inspectionResultId}/measurement-summary` | — | — | — | — |
| `GET /quality/inspection-results/{inspectionResultId}/measurements` | — | — | — | — |
| `POST /quality/inspection-results` | ✓ | 선택 | — | ✓ |
| `POST /quality/inspection-results/{inspectionResultId}:confirm` | ✓ | 필수 | — | ✓ |
| `PUT /quality/inspection-results/{inspectionResultId}` | ✓ | 필수 | — | ✓ |

### S19. LOT 보류·상태 — 9건

| | |
|---|---|
| 선행 슬라이스 | S18 |
| 쓰는 표 | `trace.lot_hold`·`lot_status_event` — 있음 |
| 마이그레이션 | **필요** — `lot_hold.target_lot_status_code`(계약 `LotHoldCreate.targetLotStatusCode` — 「의심자재는 `INSPECTION_PENDING`, 클레임·리콜 재Hold 는 `DEFECTIVE`」로 도착 상태가 갈린다). ⚠ 대기 중 문의 13번(`LOT_HOLD_STATUS` 시드)이 이 자리다 — 「값 정의」라 권고안대로 간다. |
| posting(원장) 연결 | 없음 — ⛔ 차단 판정은 `blocked_qty` 가 아니라 Lot Status 단일 지점이다(결정 10) |
| 상태기계 | **있음** — 보류 등록(C9·C10)·해제(C7·C8)가 `trace.lot.status_code` 를 옮긴다 |
| 예상 PR 수 | 3 — ① 조회 GET 7건 ② 마이그 + `POST /quality/lot-holds`(N LOT) + e2e ③ `:release` + 도착 상태 분기 + e2e (코어) |
| 설계 미정 자리 · §2 판정 초안 | `lot_hold.status_code` 값 목록(문의 13). 계약이 「칸 불필요」로 닫았다 → 열림/닫힘을 `released_at` 널 여부로 읽고 `status_code` 에는 상수 하나를 쓴다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /quality/disposition-candidates` | — | — | — | — |
| `GET /quality/lot-hold-events` | — | — | — | — |
| `GET /quality/lot-holds` | — | — | — | — |
| `GET /quality/lot-holds/{lotHoldId}` | — | — | ✓ | — |
| `GET /quality/lot-status-summary` | — | — | — | — |
| `GET /quality/lot-status-transitions` | — | — | — | — |
| `GET /quality/lot-statuses` | — | — | — | — |
| `POST /quality/lot-holds` | ✓ | — | — | ✓ |
| `POST /quality/lot-holds/{lotHoldId}:release` | ✓ | 필수 | — | ✓ |

### S20. 부적합·처분·특채·불량 — 12건

| | |
|---|---|
| 선행 슬라이스 | S18·S19 · S09(처분 승인) |
| 쓰는 표 | `quality.nonconformance(_lot)`·`disposition_decision`·`concession`·`defect_record`·`sorting_result` — 있음 |
| 마이그레이션 | 없음 — `sourceCode`·`affectedQtyTotal`·`dispositionProgressCode`·`followUp*` 는 **전부 계약이 「서버가 롤업한다」라 선언한 파생**이다(L-2). 저장 칸을 만들지 않는다. |
| posting(원장) 연결 | 없음 |
| 상태기계 | 있음 (`NONCONFORMANCE_STATUS`: `NOT_REQUESTED`→`PENDING_DECISION`→`DECIDED`) |
| 예상 PR 수 | 3 — ① 조회 GET 9건(분포·후보 포함) ② 부적합 등록 + `:request-disposition` ③ 처분 결정 + 승인 연결 + e2e |
| 설계 미정 자리 · §2 판정 초안 | 없음 — 3값·2전이라 재량이 없다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /quality/concessions` | — | — | — | — |
| `GET /quality/concessions/{concessionId}` | — | — | — | — |
| `GET /quality/defect-records` | — | — | — | — |
| `GET /quality/defect-records/distribution` | — | — | — | — |
| `GET /quality/disposition-decisions` | — | — | — | — |
| `GET /quality/disposition-decisions/{dispositionDecisionId}` | — | — | — | — |
| `GET /quality/nonconformances` | — | — | — | — |
| `GET /quality/nonconformances/{nonconformanceId}` | — | — | ✓ | — |
| `GET /quality/nonconformances/{nonconformanceId}/disposition-decisions` | — | — | — | — |
| `POST /quality/nonconformances` | ✓ | — | — | ✓ |
| `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions` | ✓ | 필수 | ✓ | ✓ |
| `POST /quality/nonconformances/{nonconformanceId}:request-disposition` | ✓ | 필수 | — | ✓ |

### S21. 판매오더·출하요청·배분 — 9건

| | |
|---|---|
| 선행 슬라이스 | S16(완제품 LOT) · S19(Release 판정) |
| 쓰는 표 | `logistics.sales_order(_line)`·`shipment_request(_line)`·`shipment_lot_allocation` — 있음 |
| 마이그레이션 | **필요** — `shipment_request.sales_order_id`(nullable FK · 계약 `ShipmentRequest.salesOrderId`). |
| posting(원장) 연결 | 없음 (배분은 예약 축) — `:pick` 이 `inventory_reservation` 을 걸고 푼다 |
| 상태기계 | 없음 — ⭐ `ShipmentRequest.statusCode` 는 「칸 불필요」로 닫혔고 진행은 **파생 `shipmentProgressCode` 6값**이다(저장 칸 없음, 판정식은 계약이 정본으로 가짐) |
| 예상 PR 수 | 3 — ① 조회 GET 6건 + `shipmentProgressCode` 파생 ② 마이그 + 출하요청 등록 ③ `:pick` + 배분 PUT + e2e |
| 설계 미정 자리 · §2 판정 초안 | 없음 — 계약이 6값의 판정식과 우선순위(「뒤가 이긴다」)까지 적었다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/sales-orders` | — | — | — | — |
| `GET /logistics/sales-orders/{salesOrderId}` | — | — | — | — |
| `GET /logistics/shipment-lot-allocations` | — | — | — | — |
| `GET /logistics/shipment-requests` | — | — | — | — |
| `GET /logistics/shipment-requests/summary` | — | — | — | — |
| `GET /logistics/shipment-requests/{shipmentRequestId}` | — | — | — | — |
| `POST /logistics/shipment-requests` | ✓ | — | — | ✓ |
| `POST /logistics/shipment-requests/{shipmentRequestId}/lines/{shipmentRequestLineId}:pick` | ✓ | — | — | ✓ |
| `PUT /logistics/shipment-lot-allocations/{shipmentLotAllocationId}` | ✓ | — | — | ✓ |

### S22. 출하·취소·재등록 — 7건

| | |
|---|---|
| 선행 슬라이스 | S21 · S09(취소 승인) |
| 쓰는 표 | `logistics.shipment`·`shipment_line`(취소 흔적 3칸 **있음**) — 있음 |
| 마이그레이션 | **필요** — `shipment.expedited`·`expedite_reason`(§I-41 긴급 출하 사유 · 계약 `Shipment.expedited`). |
| posting(원장) 연결 | **있음** — 출하 처리가 재고를 차감한다. ⭐ `:confirm` 은 재고를 안 건드리고 ERP 적재만 건다(2026-08-07 2단 확정). 재등록은 **한 트랜잭션에 보류 해제 + LOT 전이 + 이동 문서** |
| 상태기계 | **있음** (`SHIPMENT_STATUS`: `UNCONFIRMED`·`CONFIRMED`·`CANCELLED`) — ⭐ 취소가 **다형 경로가 아니라 리소스 축**이다(`CD-CANCELABLE-DOCUMENT-TYPE` 3값에 `SHIPMENT` 가 없다) |
| 예상 PR 수 | 3 — ① 조회 GET 2건 ② 마이그 + 출하 처리 + posting + e2e(코어) ③ `:confirm`/`:request-cancel`/`:cancel` + 재등록 + e2e (코어) |
| 설계 미정 자리 · §2 판정 초안 | 재등록이 만드는 이동 문서의 `reason_code`. 계약 노트가 「`logistics.stock_transfer.reason_code` 에 실린다」라 이미 지목했다 — 미정이 아니다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /logistics/shipments` | — | — | — | — |
| `GET /logistics/shipments/{shipmentId}` | — | — | ✓ | — |
| `POST /logistics/shipments` | ✓ | — | — | ✓ |
| `POST /logistics/shipments/{shipmentId}:cancel` | ✓ | 필수 | — | ✓ |
| `POST /logistics/shipments/{shipmentId}:confirm` | ✓ | 필수 | — | ✓ |
| `POST /logistics/shipments/{shipmentId}:request-cancel` | ✓ | 필수 | — | ✓ |
| `POST /logistics/stock-reinstatements` | ✓ | — | — | ✓ |

### S23. 고장·보전오더·보전실적 — 15건

| | |
|---|---|
| 선행 슬라이스 | 없음 (mdm 설비·툴 완료분) |
| 쓰는 표 | `maintenance.breakdown`·`maintenance_order(_item,_trigger)`·`maintenance_result` — 있음. ⛔ **`maintenance_result_line`·`maintenance_result_part` 는 없다** |
| 마이그레이션 | **필요 · 이 계획에서 가장 큰 마이그레이션** — ① `breakdown`: `occurrence_state_code`·`stopped_at`·`notify_assignee` ② `maintenance_order`: `planned_date`·`base_date`·`order_note`·`issued_by`·`issued_at`, 그리고 담당자 축이 `assigned_worker_id`(worker)인데 계약은 `assigneeUserId`(app_user)다 ③ `maintenance_result`: `target_type_code`/`target_id`·`result_note`·`is_outsourced`·`outsource_vendor_name`·`reset_counter`·`shot_count_before/after_reset`·`closed` ④ **표 2개 신설** `maintenance_result_line`(시드에 `MAINTENANCE_RESULT_LINE_RESULT` 가 이미 있다)·`maintenance_result_part` |
| posting(원장) 연결 | ⚠ **부분적으로 있을 수 있다** — 예비품 소모(`parts`)가 재고를 뺀다면 posting 이다. 계약이 그 연결을 안 적었다 → §2 2단계 기준 1(재고를 안 쓰는 쪽) → **원장을 부르지 않고** 기록만 하고 문의 |
| 상태기계 | **있음 · 둘** (`EQUIPMENT_BREAKDOWN_STATUS`: `RECEIVED`→`HANDLING`→`DONE` · `MAINTENANCE_ORDER_STATUS`: `ISSUED`→`DONE`|`CANCELLED`) |
| 예상 PR 수 | 4 — ① 마이그레이션 선행 커밋(위 4건) ② 고장 조회+등록+수정+`:start-handling`+`:complete`+e2e ③ 보전오더 + `:cancel` ④ 보전실적(라인·부품) + e2e |
| 설계 미정 자리 · §2 판정 초안 | 담당자 축이 `worker` 인가 `app_user` 인가. §2 2단계 기준 3(스키마를 안 늘리는 쪽) → **기존 `assigned_worker_id` 를 쓰고** 계약의 `assigneeUserId` 를 worker 로 해석하지 않는다 — 두 축이 다르므로 그대로 두고 문의를 낸다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /maintenance/breakdowns` | — | — | — | — |
| `GET /maintenance/breakdowns/{breakdownId}` | — | — | ✓ | — |
| `GET /maintenance/orders` | — | — | — | — |
| `GET /maintenance/orders/{maintenanceOrderId}` | — | — | ✓ | — |
| `GET /maintenance/results` | — | — | — | — |
| `GET /maintenance/results/{maintenanceResultId}` | — | — | ✓ | — |
| `POST /maintenance/breakdowns` | ✓ | — | — | ✓ |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | ✓ | — | — | ✓ |
| `POST /maintenance/breakdowns/{breakdownId}:complete` | ✓ | 필수 | — | ✓ |
| `POST /maintenance/breakdowns/{breakdownId}:start-handling` | ✓ | 필수 | — | ✓ |
| `POST /maintenance/orders` | ✓ | — | — | ✓ |
| `POST /maintenance/orders/{maintenanceOrderId}:cancel` | ✓ | 필수 | — | ✓ |
| `POST /maintenance/results` | ✓ | 선택 | — | ✓ |
| `PUT /maintenance/breakdowns/{breakdownId}` | ✓ | 필수 | — | ✓ |
| `PUT /maintenance/results/{maintenanceResultId}` | ✓ | 필수 | — | ✓ |

### S24. 비가동·점검·툴사용·수집채널·검교정 — 21건

| | |
|---|---|
| 선행 슬라이스 | S23 |
| 쓰는 표 | `maintenance.equipment_downtime`·`equipment_inspection(_result)`·`tool_usage`·`collection_channel`·`collection_observation`·`quality.equipment_calibration` — 전부 있음 |
| 마이그레이션 | **필요** — ① `tool_usage`: `collection_method_code`·`conversion_base_qty`·`conversion_ratio`·`occurred_at` ② `collection_channel`: `channel_key`·`signal_name`·`inspection_item_id`·`item_id`·`process_id`(현재 `channel_code`/`channel_name`/`uom_id` 만) ③ `equipment_calibration`: `history_type_code`·`agency_type_code`·`agency_name`·`tolerance_note`·`recorded_by`·**`blocks_use`·`cleared_at`·`cleared_by`** — `:clear` 가 그 셋 위에 선다 |
| posting(원장) 연결 | 없음 |
| 상태기계 | ⛔ 없음 — 전부 **구간 축**이다(`ended_at` · `cleared_at` 널 여부가 열림/닫힘). 계약이 「구간을 닫는 것은 액션이다」(G-16)로 못박았다 |
| 예상 PR 수 | 4 — ① 마이그레이션 선행 커밋 ② 비가동 + `:close` + 집계 ③ 점검·툴사용 ④ 수집채널 + 검교정 + `:clear` + e2e |
| 설계 미정 자리 · §2 판정 초안 | `CalibrationCreate` 의 `resultCode` 값 집합이 «이력 유형마다 다르다»는데 시드 `CALIBRATION_RESULT` 는 한 그룹이다. §2 2단계 기준 2(거부하는 쪽) → **그룹 등재값만 통과**시키고 유형별 부분집합 검사는 걸지 않는다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `GET /maintenance/calibrations` | — | — | — | — |
| `GET /maintenance/calibrations/{calibrationId}` | — | — | — | — |
| `GET /maintenance/collection-channels` | — | — | — | — |
| `GET /maintenance/collection-channels/observations` | — | — | — | — |
| `GET /maintenance/collection-channels/{collectionChannelId}` | — | — | ✓ | — |
| `GET /maintenance/downtimes` | — | — | — | — |
| `GET /maintenance/downtimes/summary` | — | — | — | — |
| `GET /maintenance/downtimes/{downtimeId}` | — | — | ✓ | — |
| `GET /maintenance/inspections` | — | — | — | — |
| `GET /maintenance/inspections/{inspectionId}` | — | — | — | — |
| `GET /maintenance/tool-usages` | — | — | — | — |
| `GET /maintenance/tool-usages/{toolUsageId}` | — | — | — | — |
| `POST /maintenance/calibrations` | ✓ | — | — | ✓ |
| `POST /maintenance/calibrations/{calibrationId}:clear` | ✓ | — | — | — |
| `POST /maintenance/collection-channels` | ✓ | — | — | ✓ |
| `POST /maintenance/downtimes` | ✓ | — | — | ✓ |
| `POST /maintenance/downtimes/{downtimeId}:close` | ✓ | 선택 | — | ✓ |
| `POST /maintenance/inspections` | ✓ | — | — | ✓ |
| `POST /maintenance/tool-usages` | ✓ | — | — | ✓ |
| `PUT /maintenance/collection-channels/{collectionChannelId}` | ✓ | 필수 | — | ✓ |
| `PUT /maintenance/downtimes/{downtimeId}` | ✓ | 필수 | — | ✓ |

### S25. 예비품 일괄등록 — 1건

| | |
|---|---|
| 선행 슬라이스 | mdm 예비품(구현됨) |
| 쓰는 표 | `mdm.spare_part` — 있음 |
| 마이그레이션 | 없음 |
| posting(원장) 연결 | 없음 |
| 상태기계 | 없음 |
| 예상 PR 수 | 1 — XLSX 파서 의존성 추가 + 행별 성공·실패 집계 |
| 설계 미정 자리 · §2 판정 초안 | 행 실패 정책. 계약이 「통째로 되돌리지 않고 성공·실패 건수와 실패 행 목록을 돌려준다」라 이미 적었다 — 미정이 아니다. |

| 오퍼레이션 | 멱등 | If-Match | ETag | 403 |
|---|---|---|---|---|
| `POST /mdm/spare-parts:import` | ✓ | — | — | ✓ |

## 2. 순서

`development-strategy.md` 의 M1~M5 를 기본으로 두되, **다형 취소(S06)와 승인(S09)이 여러 마일스톤의
공통 선행**이라 앞으로 당긴다. 그 둘이 없으면 어느 마일스톤도 완료 기준(「취소 경로를 포함한 전표 체인
e2e」)을 못 채운다 — 2026-09-04 드리프트가 취소를 리소스 축에서 유형 축으로 옮긴 결과다.

| # | 슬라이스 | 왜 여기인가 |
|---|---|---|
| 1 | **S09** 결재선·승인요청 | `:request-approval` 8건 · `:request-cancel` 2건의 선행. 재고를 안 건드려 실패 비용이 가장 싸다 |
| 2 | **S01** 발주 P/O | M1 사슬의 머리. posting 없음 — 승인 연결을 여기서 처음 검증한다 |
| 3 | **S02** ASN·입하 | P/O → 입하. 입고(구현됨)로 이어져 M1 의 빈 앞부분이 메워진다 |
| 4 | **S03** 적치 | 입고가 이미 `putaway_task` 를 만들고 있다 — **완결되지 않은 채 서 있는 유일한 자리**라 먼저 닫는다 |
| 5 | **S06** 문서진행·취소 | 앞 넷 + 구현된 입고가 다 서야 취소 3유형이 전부 e2e 가 된다. **M1 완료 판정** |
| 6 | **S04** 출고·피킹·자재요청·현장입고 | M1 의 「불출」. 예약(`inventory_reservation`)이 여기서 처음 움직인다 |
| 7 | **S13** 계획·상위지시 | M1 의 W/O 앞단 |
| 8 | **S14** 작업지시 | 선발행 LOT(L2·L3)이 이미 `transitions.ts` 에 등록돼 있다 — 소비처를 만든다 |
| 9 | **S15** 작업세션 → 10 **S16** 실적 외 | M1 tracer bullet 완결(L1 전이 · 완제품 잡기). **M2** |
| 11 | **S18** 검사 → 12 **S19** 보류 → 13 **S20** 부적합 | **M3**. S18 이 LOT 품질 축을 열고 S19 가 그 위에 보류를 얹는다 |
| 14 | **S21** 출하요청·배분 → 15 **S22** 출하 | **M4**. Release 판정(S19)이 선행 |
| 16 | **S07** 실사·조정·취급단위 | **M5**. 원장에 쓰지만 사슬 밖이라 뒤로 미룬다. 조정은 S06 취소 축을 재사용한다 |
| 17 | **S05** 창고이동·재생재 | M5. 2단 전기라 posting 이 이미 굳은 뒤가 안전하다 |
| 18 | **S08** LOT 부수 → 19 **S17** 시리얼 | M5. 앞 슬라이스들이 만든 이력을 읽는 쪽이 대부분 |
| 20 | **S23** 고장·보전 → 21 **S24** 비가동 외 | M5. **마이그레이션 부담이 가장 크다** — 원장을 안 건드려 뒤로 미뤄도 다른 것을 막지 않는다 |
| 22 | **S10** 알림 → 23 **S11** 발행이력 → 24 **S12** 감사·대시보드 → 25 **S25** 예비품 | M5 주변부. 앞의 전부가 이들의 «내용»이라 마지막이 자연스럽다 |

⚠ 순서에서 벗어난 자리 둘: **S03 을 4번으로 당긴 것**(입고가 이미 만드는 미완 자원이라)과
**S07 을 16번으로 미룬 것**(strategy 는 실사를 M5 로 두었고 그대로다 — 다만 조정이 승인·취소 축을
재사용하므로 S06·S09 뒤여야 한다).

## 3. 건너뜀 표

§0 「DB 안에서 끝나는 것만」에 걸리는 것. **슬라이스에서 빼지 않고** 그 슬라이스 안에서 이 표를 근거로
남긴다.

| 오퍼레이션 | 슬라이스 | 사유 |
|---|---|---|
| `POST /app/attachments` | S12 | 바이너리 업로드(`multipart/form-data`). `attachment.storage_key` 가 **DB 밖 저장소**를 가리킨다 — 저장소가 없으면 키를 만들 수 없다 |
| `GET /app/attachments/{attachmentId}/content` | S12 | 같은 이유. 응답이 `application/octet-stream`·`image/*` 다 |
| `POST /maintenance/breakdowns/{breakdownId}/attachments` | S23 | 같은 이유(사진 최대 3장, `multipart/form-data`). ⚠ 덤으로 계약 불일치를 하나 찾았다 — `CD-ATTACHMENT-TARGET-TYPE` enum 이 `WAREHOUSE`·`NOTICE` 둘뿐이라 **`BREAKDOWN` 을 담을 값이 없다**(§5.4 문의 대상) |
| `GET /app/document-issues/{documentIssueLogId}/rendition` | S11 | 서버가 PDF·PNG 를 **그린다**. 렌더러가 있어야 하고 §0 이 프린터·PDF 를 범위 밖으로 뒀다 |
| **부분 건너뜀** `POST /planning/production-orders/{productionOrderId}:resync` | S13 | 202 접수까지·아웃박스 행까지만. 실제 ERP 재요청은 범위 밖 |
| **부분 건너뜀** `POST /production/work-orders/{workOrderId}:close` 의 ERP 적재 | S14 | 계약도 「ERP 실제 전송만 트랜잭션 밖」이라 적었다. 아웃박스까지만 |
| **부분 건너뜀** `PUT /app/notification-subscriptions` 의 `zaloEnabled` | S10 | 계약이 「켜도 보낼 곳이 아직 없다」라 적었다. 칸만 만들고 전송기는 없음 |

전건 건너뜀은 **4건**, 나머지 245건은 슬라이스 안에서 끝난다.

회신 대기 물음(#177 · 1~15번) 때문에 **본길이 막히는 오퍼레이션은 없다.** 12·13·14 는 「값 정의」라
권고안대로 가고(§5.5·S19), 15(`businessDate`/`occurredAt` 의 C-8-1 어긋남)는 이미 우리가 「받은 값을
그대로 쓴다」로 처리하고 있다.

## 4. 위험 10 — API 설계 관점

| # | 위험 | 터지는 슬라이스 |
|---|---|---|
| 1 | **`transitions.ts` 가 품질 축을 비워 둔 채다.** `LOT_STATUS` 4값과 `LOT_STATUS_TRANSITION` 9코드(C4~C15)의 대응이 없고, C14 가 가리키는 「PQC 검사 필요」는 값 목록에 아예 없다. 등록 안 된 전이는 **던진다**(F-6) — 검사 확정이 500 으로 죽는다 | **S18**(최초 폭발) · S19 · S08 |
| 2 | **`SUCCESSOR_EXISTS` 재판정이 두 번 일어난다.** 요청 시점(`:request-cancel`)과 실행 시점(`:cancel`) 둘 다. 실행 시점 판정을 빠뜨리면 승인을 기다리는 사이 생긴 후속을 못 본다 — 그것이 `J-8` 이 이번에 계약에 실린 이유다 | **S06** |
| 3 | **후속 판정이 두 갈래다.** 문서 하류 4종은 `source_document_*` 역조회, `MATERIAL_CONSUMPTION` 은 **LOT 을 가리키는 재고 사용**이다. 한 갈래로 짜면 자재 투입된 입고가 취소된다 | **S06** |
| 4 | **`If-Match` 필수 46 / 선택 28 을 뒤집기 쉽다.** 선택은 POP 오프라인 큐 자리고(C-9), 필수를 선택으로 잘못 열면 두 관리자의 동시 확정이 조용히 늦은 쪽으로 덮인다 | S04·S07·**S14**(`:release`/`:close` 가 필수) |
| 5 | **403 미등록 28건에서 가드가 «던진다».** 통과가 아니라 500 이다. 슬라이스마다 자기 오퍼레이션을 `manual-permissions.ts` 에 근거와 함께 등록하지 않으면 e2e 가 통째로 붉어진다 | 전 슬라이스 — 특히 **S07**(6건)·**S02**(4건) |
| 6 | **보전 도메인 마이그레이션이 계획 최대다.** 컬럼 15개 + 표 2개. 400줄 diff 규칙에 걸려 PR 이 쪼개지고, `assigned_worker_id`(worker) ↔ `assigneeUserId`(app_user) 축 충돌은 **되돌리기 비싼 선택**이다 | **S23** · S24 |
| 7 | **알림 구독의 축이 반대다.** 물리는 사용자별, 계약은 이벤트별 수신자 목록. 물리를 그대로 쓰면 `recipients:preview` 가 성립하지 않는다 — 구조 마이그레이션이 필요하다 | **S10** |
| 8 | **「칸 불필요」(`x-no-code-key`) 16자리의 `status_code` 가 NOT NULL 이다.** 값 없는 칸에 무엇을 넣을지 슬라이스마다 다르게 정하면 16가지 상수가 생긴다. 한 자리에서 정해야 한다 | S04·**S07**·S16·S19·S21 |
| 9 | **채번 규칙이 실적 하나뿐인데 새 전표 번호가 12종 필요하다.** 지금은 `GR-`·`PT-` 처럼 서버가 지어냈고 순번이 «연속을 보장하지 않는다». 12종을 각자 지어내면 규칙이 오면 12곳을 고친다 | S01·S02·S05·**S07**·S13·S22·S23 |
| 10 | **`x-source-column` 이 없는 프로퍼티를 「파생」으로 잘못 읽기 쉽다.** 실제로는 셋이 섞여 있다 — 진짜 파생 · 조인 표시값 · **물리에 자리가 없는 것**. 셋째를 파생으로 읽으면 응답이 조용히 널을 낸다 | S01·S02·S05·**S23**·S24 |

---

## 5. API 설계 관점 고유 절

### 5.1 상태기계 초안

`transitions.ts` 는 **칸**(`스키마.표.컬럼`) 단위로 전이를 데이터로 담는다. 아래는 그 표에 더할
초안이다. 값은 전부 `prisma/seed.ts` 에 **실재하는 시드 코드**이고, 없는 값은 「없음」이라 적었다 —
지어내지 않는다(F-6).

#### A. `LOGISTICS_DOCUMENT_STATUS` — 물류 전표 공통 축 (`REGISTERED`·`POSTED`·`CANCEL_REQUESTED`·`CANCELLED`)

이 4값 하나가 **P/O · 입하 · 입고 · 출고 · 자재출고요청 · 피킹 · 이동 · 현장입고 · 재고조정** 아홉 표의
`status_code` 를 다스린다(계약 `x-code-key: CD-LOGISTICS-DOCUMENT-STATUS` 실측 8자리 + `CancelResult`).

| 전이 | from → to | 여는 오퍼레이션 | 원장(`InventoryPostingService.post`) |
|---|---|---|---|
| `document-post` | `REGISTERED` → `POSTED` | `POST /logistics/goods-issues/{id}:post` · `POST /inventory/adjustments/{id}:post` | **부른다** |
| (전기와 동시) | (없음) → `POSTED` | `POST /logistics/goods-receipts`(구현됨) | **부른다** — 「생성과 전기가 같은 순간」이라 `REGISTERED` 에 머무는 자리가 없다 |
| `transfer-issue` | (없음) → `REGISTERED` | `POST /logistics/stock-transfers` | **부른다**(반출 = 1단째, 도착지가 `IN_TRANSIT`) |
| `transfer-arrive` | `REGISTERED` → `POSTED` | `POST /logistics/stock-transfers/{id}:arrive` | **부른다**(입고 = 2단째). ⚠ 부분 도착은 상태를 안 옮긴다 — `received_qty` 합이 담고 전량에서만 `POSTED` |
| `document-request-cancel` | `REGISTERED`·`POSTED` → `CANCEL_REQUESTED` | `POST /logistics/document-progress/{type}/{id}:request-cancel` | 안 부른다 |
| `document-cancel` | `CANCEL_REQUESTED` → `CANCELLED` | `POST /logistics/document-progress/{type}/{id}:cancel` | **조건부로 부른다** — 직전이 `POSTED` 였으면 역트랜잭션, `REGISTERED` 였으면 상태만(`CancelResult.reversed`) |
| **없음** | — | `:request-approval` (P/O·출고·조정) | ⛔ **상태를 옮기지 않는다** |

⭐ 마지막 줄이 이 축의 핵심 판정이다. `:request-approval` 은 202 와 `ApprovalRequestRef` 만 돌려주고,
승인 진행은 `app.approval_request.status_code`(`PENDING`·`APPROVED`·`REJECTED`)가 진다. 근거 셋 —
① `LOGISTICS_DOCUMENT_STATUS` 4값에 「승인대기」가 없다 ② 계약이 `GoodsIssue.approvalRequestId` 로
**참조**를 두었지 상태를 두지 않았다 ③ `:post` 가 「승인이 끝나기 전에는 400」이라 **승인 상태를 읽어**
가르는 형태다. §2 2단계 기준 3(스키마를 안 늘리는 쪽).

⚠ 취소만 문서 상태를 옮긴다. `CANCEL_REQUESTED` 가 시드에 있는 것이 그 증거이고, 계약도
「문서 상태를 취소요청으로 옮기고 승인 요청을 만든다」라 적었다.

#### B. 다형 취소 경로 — 하나의 전이, 세 유형

```
                  ┌─ INBOUND_RECEIPT ─┐
:request-cancel ──┼─ GOODS_RECEIPT   ─┼──▶ CANCEL_REQUESTED + approval_request(PENDING)
                  └─ GOODS_ISSUE     ─┘          │
                                                 │ :approve  (S09 — 자물쇠만 푼다)
                                                 ▼
                              :cancel ──▶ ❶ 후속 재판정 ──(있음)──▶ 400 SUCCESSOR_EXISTS
                                              │                     (승인은 그대로 유효)
                                          (없음)
                                              ▼
                                          ❷ app.document_cancellation 기록
                                          ❸ POSTED 였으면 역트랜잭션 posting
                                          ❹ status_code = CANCELLED
```

- **하나의 컨트롤러 · 하나의 서비스 · 유형별 어댑터 3개.** 유형마다 다른 것은 ⓐ 어느 표의 어느 행인가
  ⓑ 그 행의 `version_no`(→ `If-Match` 대조 대상) ⓒ 후속을 어떻게 찾는가, 셋뿐이다.
- ⛔ **`If-Match` 토큰의 출처가 이 경로가 아니다.** 계약이 명시했다 — 토큰은 **대상 문서 리소스의 상세
  GET** 이 내려준 `ETag` 다(입하 `/logistics/inbound-receipts/{id}` · 입고 `/logistics/goods-receipts/{id}` ·
  출고 `/logistics/goods-issues/{id}`). 그래서 어댑터가 「이 유형의 `version_no` 는 어느 표의 어느 칸인가」를
  알아야 한다.
- **후속 판정은 두 갈래**(계약 `DocumentSuccessor` 가 직접 적음) — `GOODS_RECEIPT`·`GOODS_ISSUE`·
  `PICKING_ORDER`·`INVENTORY_TRANSACTION` 은 `source_document_type_code`/`source_document_id` 역조회,
  `MATERIAL_CONSUMPTION` 은 **LOT 을 가리키는 재고 사용**이라 축이 다르다.
- `cancelBlockedReasonCode` 5값(`SUCCESSOR_EXISTS`·`ALREADY_CANCELLED`·`CANCEL_IN_PROGRESS`·
  `STATE_LOCKED`·`TYPE_NOT_CANCELABLE`)이 `GET .../{type}/{id}` 의 `cancellable` 판정과 **같은 함수**여야
  한다 — 화면이 미리 본 것과 실행 결과가 갈리면 그 화면이 틀린 안내를 한다.
- ⭐ 취소 흔적은 **`app.document_cancellation` 한 표**가 진다(실측: `document_type_code`·`document_id`·
  `previous_status_code`·`reason_code`·`reason_detail`·`cancelled_at`·`cancelled_by`). §I-38 의
  「취소 흔적 12표 결손」은 **이 표로 이미 닫혀 있다** — 유형별 표에 3칸을 더할 이유가 없다.
- ⛔ 출하 취소는 **이 경로가 아니다.** `CD-CANCELABLE-DOCUMENT-TYPE` 3값에 `SHIPMENT` 가 없고,
  `POST /logistics/shipments/{id}:request-cancel`·`:cancel` 이 리소스 축에 따로 있다(S22).

#### C. `WORK_ORDER_STATUS` — 8값, 두 축을 동시에 움직인다

시드: `PLANNED`·`CONFIRMED`·`RELEASED`·`IN_PROGRESS`·`SUSPENDED`·`COMPLETED`·`CLOSED`·`CANCELLED`.

| 전이 | from → to | 오퍼레이션 | 곁들여 움직이는 것 |
|---|---|---|---|
| `work-order-release` | `PLANNED`·`CONFIRMED` → `RELEASED` | `:release` | 생산LOT **선발행**(슬롯 생성) + 자재 출고요청 자동 발행(⛔ 긴급 W/O 제외 — `work_order_type_code` 로 서버가 가른다) |
| `work-order-hold` | `RELEASED`·`IN_PROGRESS` → `SUSPENDED` | `:hold` | ⛔ 세션을 닫지 않는다 |
| `work-order-resume` | `SUSPENDED` → `IN_PROGRESS` | `:resume` | ⛔ 세션을 다시 열지 않는다 |
| `work-order-close` | `COMPLETED`(·`IN_PROGRESS`) → `CLOSED` | `:close` | **L2**(`WAITING`→`VOIDED`, 실적 없는 슬롯만) — *이미 등록됨* · ERP 아웃박스 적재 |
| `work-order-cancel` | `PLANNED`·`CONFIRMED`·`RELEASED`·`IN_PROGRESS`·`SUSPENDED` → `CANCELLED` | `:cancel` | **L3**(`WAITING`·`ACTIVE`→`VOIDED`, 선발행 슬롯 **전건**) — *이미 등록됨* |
| (전이 아님) | — | `PUT /production/work-orders/{id}` | ⛔ 본문에 `statusCode` 칸이 없다 — 계약이 그렇게 못박았다 |

⚠ `PLANNED`→`CONFIRMED` 를 여는 오퍼레이션이 **계약에 없다.** `:release` 하나가 「확정과 배포와 선발행」을
한 트랜잭션으로 한다고 계약이 적었고, 「확정 대기」는 계약이 「전이가 아니라 파생」이라 못박았다.
→ §2 2단계 기준 3 → **`CONFIRMED` 를 지나지 않는다.** `:release` 의 `from` 에 둘 다 넣어 둔다.

⛔ `IN_PROGRESS` 로 들어가는 전이도 계약에 «액션»으로 없다 — 세션 열기(`POST /production/work-sessions`)의
부수효과다. 그래서 이 칸의 이름은 `work-session-start` 이지 `work-order-*` 가 아니다(전이를 일으키는
자원과 상태 칸을 가진 자원이 다르다 — `Transition.sourceOperation` 이 그것을 담는 자리다).

#### D. 그 밖의 단순 축 — 값이 다 있고 재량이 없는 것

| 칸 | 시드 값 | 전이 | 오퍼레이션 | 원장 |
|---|---|---|---|---|
| `logistics.putaway_task.status_code` | `PENDING`·`COMPLETED`·`COMPLETED_TEMPORARY` | `PENDING`→`COMPLETED` / `PENDING`→`COMPLETED_TEMPORARY` (되돌아옴 없음) | `:complete` · `:complete-temporary` | **부른다**(dock→선반) |
| `inventory.inventory_count.status_code` | `PLANNED`·`IN_PROGRESS`·`COMPLETED` | `PLANNED`→`IN_PROGRESS`(라인 PUT 부수효과) · `IN_PROGRESS`→`COMPLETED` | `PUT .../lines` · `:close` | 안 부른다(조정이 부른다) |
| `app.approval_request.status_code` | `PENDING`·`APPROVED`·`REJECTED` | `PENDING`→`APPROVED` / `PENDING`→`REJECTED` (되돌아옴 없음 — 「번복은 새 요청」) | `:approve` · `:reject` | 안 부른다 |
| `planning.production_plan.status_code` | `DRAFT`·`CONFIRMED` | `DRAFT`→`CONFIRMED` | `:confirm`(전개까지 한 트랜잭션) | 안 부른다 |
| `planning.production_order.status_code` | `RECEIVED`·`UPDATED`·`CANCELLED` | ⚠ **ERP 수신이 옮긴다** — `:acknowledge` 는 판정만 기록 | `:acknowledge`(P/O 상태 불변) | 안 부른다 |
| `production.work_session.status_code` | `RUNNING`·`STOPPED`·`ENDED` | `RUNNING`↔`STOPPED`(events `STOP`/`RESUME`) · →`ENDED`(`:end`) | `POST .../events` · `:end` | 안 부른다 |
| `quality.inspection_result.status_code` | `DRAFT`·`CONFIRMED` | `DRAFT`→`CONFIRMED` | `:confirm` | 안 부른다 — ⭐ 대신 **LOT 품질 축을 옮긴다**(E) |
| `quality.nonconformance.status_code` | `NOT_REQUESTED`·`PENDING_DECISION`·`DECIDED` | →`PENDING_DECISION`(`:request-disposition`) · →`DECIDED`(처분 결정 POST) | 둘 | 안 부른다 |
| `maintenance.breakdown.status_code` | `RECEIVED`·`HANDLING`·`DONE` | `RECEIVED`→`HANDLING`→`DONE` · ⭐ `RECEIVED`→`DONE` 직행 허용(「경미한 건」) · 되돌아옴 없음 | `:start-handling` · `:complete` | 안 부른다 |
| `maintenance.maintenance_order.status_code` | `ISSUED`·`DONE`·`CANCELLED` | →`DONE`(실적 등록) · →`CANCELLED`(`:cancel`, **실적 0건일 때만**) | `POST /maintenance/results` · `:cancel` | 안 부른다(예비품 소모는 §S23 미정) |
| `logistics.shipment.status_code` | `UNCONFIRMED`·`CONFIRMED`·`CANCELLED` | →`CONFIRMED`(`:confirm`, **되돌릴 수 없다**) · `UNCONFIRMED`→`CANCELLED` | `:confirm` · `:request-cancel`→`:cancel` | 출하 처리가 이미 뺐다 — `:confirm` 은 ERP 적재만 |

⛔ **구간 축은 상태기계가 아니다** — `equipment_downtime.ended_at`(`:close`) ·
`equipment_calibration.cleared_at`(`:clear`) · `work_session_worker.left_at`(`:leave`) ·
`repair_execution.returned_at`(`:return`) · `trace.lot_hold.released_at`(`:release`) · 알림 `read_at`.
계약이 「구간을 닫는 것은 액션이다」(G-16)로 못박았을 뿐 상태값이 아니다. `transitions.ts` 에 넣지 않는다.

#### E. LOT 품질 축 — **이 계획 최대의 갈림길**

`trace.lot.status_code` 는 `transitions.ts` 가 **일부러 비워 둔** 칸이다. 실측:

| | 값 |
|---|---|
| 시드 `LOT_STATUS` | `NORMAL` · `INSPECTION_PENDING` · `DEFECTIVE` · `SCRAPPED` (4) |
| 시드 `LOT_STATUS_TRANSITION` | `C4`·`C5`·`C6`·`C7`·`C8`·`C9`·`C10`·`C14`·`C15` (9) |
| 계약이 이 축을 여는 오퍼레이션 | `POST /quality/inspection-results/{id}:confirm` · `POST /quality/lot-holds` · `POST /quality/lot-holds/{id}:release` · `POST /logistics/stock-reinstatements` |

계약이 **도착 상태를 직접 적은 자리**는 넷이다 — 이것만 근거로 쓴다.

| 전이 코드 | 계약 문장 | from → to | 여는 오퍼레이션 |
|---|---|---|---|
| (검사 합격) | 「합격이면 정상」 | `INSPECTION_PENDING` → `NORMAL` | `:confirm` |
| (검사 불합격) | 「불합격이면 불량」 | `INSPECTION_PENDING` → `DEFECTIVE` | `:confirm` |
| (검사 보류) | 「보류면 검사 대기」 | * → `INSPECTION_PENDING` | `:confirm` |
| `C14` | 「PQC 불합격이 합격판정개수를 넘으면 같은 W/O 의 생산LOT **전체**를 `INSPECTION_PENDING` 으로 일괄 전이」 | `NORMAL` → `INSPECTION_PENDING` (N건) | `:confirm` |
| `C10` | 「의심자재 등록은 `INSPECTION_PENDING`」 | * → `INSPECTION_PENDING` | `POST /quality/lot-holds` |
| `C9` | 「클레임·리콜 재Hold 는 `DEFECTIVE`」 | * → `DEFECTIVE` | `POST /quality/lot-holds` |
| `C7` | 「재판정 합격 = 도착 정상」 | * → `NORMAL` | `:release` |
| `C8` | 「재판정 불합격 = 도착 불량」 | * → `DEFECTIVE` | `:release` |
| (재등록) | 「이 경로에서만 반영 목적의 Hold → 정상 전이가 허용된다」(B-13) | * → `NORMAL` | `POST /logistics/stock-reinstatements` |

⛔ **`C4`·`C5`·`C6`·`C15` 는 여는 오퍼레이션을 못 찾았다.** 그리고 `SCRAPPED` 로 가는 전이도 계약에서
못 찾았다(폐기 처분 `disposition_type_code=SCRAP` 이 그 자리로 보이나 계약이 LOT 상태를 옮긴다고
적지 않았다). §2 1단계 판정 — **본길**(모든 검사 확정의 결과가 달라진다)이라 임의로 못 고른다.
→ 위 9줄만 등록하고 나머지는 **비운 채 던지게 둔다**(F-6). 요청서에 「C4·C5·C6·C15 와 `SCRAPPED` 도착
전이를 여는 오퍼레이션이 무엇인가」를 묻는다.

⭐ 「보류」는 `LOT_STATUS` 축의 값이 **아니다** — 계약이 「`lot.status_code` 축에 없는 값이다」라 직접
적었다. 보류의 열림/닫힘은 `trace.lot_hold` 행이 지고(`released_at` 널 여부), 도착 상태만 위 축으로 옮긴다.
설계 §4.2 의 3축 분리가 그 뜻이다.

---

### 5.2 계약 스키마 ↔ `prisma/schema.prisma` 대조 → 마이그레이션 목록

방법: ① `x-source-column` 이 달린 프로퍼티 전건을 실제 모델 컬럼과 대조 → **어긋남 0건** ②
`x-source-table` 은 있는데 프로퍼티에 앵커가 없는 자리 + `x-internal-note` 가 「모델에 없다」라 적은
자리를 긁어냄 ③ 앵커 체계가 없는 도메인(설비툴·생산·품질·출하)은 프로퍼티 이름 ↔ 컬럼 이름을
snake_case 로 맞춰 대조하고 **모델을 눈으로 확인한 것만** 아래에 적는다.

#### 표 A — 신설이 필요한 칸 (전부 nullable · forward-only)

| # | 표(모델 이름) | 더할 칸 | 근거 | 슬라이스 |
|---|---|---|---|---|
| 1 | `logistics.purchase_order` | `approval_request_id BigInt?` | `PurchaseOrder.approvalRequestId` (앵커 없음) | S01 |
| 2 | `logistics.purchase_order` | `source_inbound_receipt_line_id BigInt?` | `PurchaseOrderCreate.sourceInboundReceiptLineId` | S01 |
| 3 | `logistics.inbound_receipt_line` | `lot_id BigInt?` | `InboundReceiptLine.lotId` | S02 |
| 4 | `logistics.stock_transfer_line` | `handling_unit_id BigInt?` | `StockTransferLine.handlingUnitId`·`StockTransferLineUpsert.handlingUnitId` | S05 |
| 5 | `logistics.recycle_entry` | `warehouse_id BigInt?` · `remarks String?` | `RecycleEntry.warehouseId`·`remarks` | S05 |
| 6 | `app.approval_route` | **부분 유일 인덱스** `(approval_type_code, COALESCE(business_unit_id,0)) WHERE is_active` | `:activate` 400 조건 · §I-35 | S09 |
| 7 | `app.notification_subscription` | `zalo_enabled Boolean @default(false)` | `NotificationSubscriptionReplace.zaloEnabled` | S10 |
| 8 | **표 신설** `app.notification_subscription_recipient` | `(event_type_code, recipient_type_code, business_unit_id?, role_id?, app_user_id?)` | `NotificationRecipient` — 축이 물리와 반대(§5.3 아래) | S10 |
| 9 | `app.document_issue_log` | `print_outcome_code String?` · `print_failure_reason String?` · `printed_at DateTime?` | `:report-print` + `PrintOutcomeReport` | S11 |
| 10 | `app.printer` | `display_name String?` · `status_code String?` · `status_message String?` · `is_default Boolean @default(false)` · `supported_document_type_codes String[]` | `Printer` 5칸 | S11 |
| 11 | `planning.production_plan` | `split_of_plan_id BigInt?` | `ProductionPlanCreate.splitOfPlanId` (+ 시드 `PRODUCTION_PLAN_SPLIT_REASON` 이 이미 있다) | S13 |
| 12 | `trace.lot_hold` | `target_lot_status_code String?` | `LotHoldCreate.targetLotStatusCode` — 도착 상태가 C9/C10 을 가른다 | S19 |
| 13 | `logistics.shipment_request` | `sales_order_id BigInt?` | `ShipmentRequest.salesOrderId` | S21 |
| 14 | `logistics.shipment` | `expedited Boolean @default(false)` · `expedite_reason String?` | `Shipment.expedited`·`expediteReason` · §I-41 | S22 |
| 15 | `maintenance.breakdown` | `occurrence_state_code String?` · `stopped_at DateTime?` · `notify_assignee Boolean?` | `Breakdown`·`BreakdownCreate` (+ 시드 `BREAKDOWN_OCCURRENCE_STATE` 가 이미 있다) | S23 |
| 16 | `maintenance.maintenance_order` | `planned_date Date?` · `base_date Date?` · `order_note String?` · `issued_by BigInt?` · `issued_at DateTime?` | `MaintenanceOrder`·`MaintenanceOrderCreate` | S23 |
| 17 | `maintenance.maintenance_result` | `target_type_code String?` · `target_id BigInt?` · `result_note String?` · `is_outsourced Boolean?` · `outsource_vendor_name String?` · `reset_counter Boolean?` · `shot_count_before_reset BigInt?` · `shot_count_after_reset BigInt?` · `closed Boolean?` | `MaintenanceResult`·`MaintenanceResultCreate`·`MaintenanceResultUpdate` | S23 |
| 18 | **표 신설** `maintenance.maintenance_result_line` | `MaintenanceResultLine` (시드 `MAINTENANCE_RESULT_LINE_RESULT` 가 이미 있다) | 계약 스키마 실재 · 물리 없음 | S23 |
| 19 | **표 신설** `maintenance.maintenance_result_part` | `MaintenanceResultPart` | 계약 스키마 실재 · 물리 없음 | S23 |
| 20 | `maintenance.tool_usage` | `collection_method_code String?` · `conversion_base_qty Decimal?` · `conversion_ratio Decimal?` · `occurred_at DateTime?` | `ToolUsage`·`ToolUsageCreate` (+ 시드 `CD-TOOL-USAGE-COLLECTION-METHOD` 값 2종) | S24 |
| 21 | `maintenance.collection_channel` | `channel_key String?` · `signal_name String?` · `inspection_item_id BigInt?` · `item_id BigInt?` · `process_id BigInt?` | `CollectionChannel`·`Create`·`Update` — 현재는 `channel_code`/`channel_name`/`uom_id` 만 | S24 |
| 22 | `quality.equipment_calibration` | `history_type_code String?` · `agency_type_code String?` · `agency_name String?` · `tolerance_note String?` · `recorded_by BigInt?` · **`blocks_use Boolean @default(false)`** · **`cleared_at DateTime?`** · **`cleared_by BigInt?`** | `Calibration`·`CalibrationCreate` — `:clear` 가 뒤 셋 위에 선다 | S24 |

#### 표 B — **계약이 「물리에 없다」라 적었으나 실제로는 있는 것** (마이그레이션 불필요)

계약 사본이 굳은 시점 이후 우리 모델이 앞서 나갔다. 그대로 믿고 컬럼을 또 만들면 중복이 된다.

| 계약이 적은 것 | 실측 |
|---|---|
| 「`inventory_adjustment_line` 은 물리 모델에 아직 없다」(2곳) | **있다** — `inventory.inventory_adjustment_line`(라인 사유 `reason_code` 포함) |
| 「`goods_issue.approval_request_id` 가 모델에 아직 없다」 | **있다** — 취소 흔적 3칸(`cancelled_at`·`cancelled_by`·`cancellation_reason_code`)도 함께 있다 |
| 「알림 표가 물리 모델에 없다」 | **있다** — `app.notification`·`app.notification_event` |
| 「공지 표가 물리 모델에 없다」 | **있다** — `app.notice`·`app.notice_acknowledgement` |
| 「`WorkCalendar`·`SparePart`·`InterfaceDefinition`·`OutboundItemSetting` 저장처가 없다」 | **전부 있다**(mdm 슬라이스가 이미 쓰고 있다) |

#### 표 C — **파생이라 저장 칸을 만들지 않는 것** (계약이 「서버가 낸다」라 선언)

| 프로퍼티 | 왜 |
|---|---|
| `ShipmentRequest.shipmentProgressCode` (6값) | 「라인 수량으로 판정한다 — **저장 칸이 없다**」(L-2·A-17). 판정식과 우선순위를 계약이 정본으로 가짐 |
| `Nonconformance.sourceCode`·`affectedQtyTotal`·`dispositionProgressCode` | 「서버가 대상 LOT 의 입고 유형으로 파생」·「서버가 센다」·「롤업」 |
| `DispositionDecision.followUpStatusCode`·`followUpQty` | 「서버가 후속 전표를 롤업해 낸다(L-2)」 |
| `ShipmentLotAllocation.shipmentId`·`warehouseId`·`oqcPassed`·`packedQty` | 조인·판정 — 「서버가 판정한 값」 |
| `PutawayTask.warehouseId`·`warehouseManagementLevelCode` | `from_location → warehouse` 조인 |
| `*.erpMessageQueued` · `*Create.sendToErp` | `integration.integration_message` 아웃박스 행의 존재 여부 |
| `*Create.businessDate`·`occurredAt` | ⛔ 문서 표에 저장하지 않는다 — `inventory_transaction` 으로 **그대로 흘려보낸다**(C-8·C-8-1, 실린 표는 3개뿐) |
| `DocumentProgress.screenId` · `ApprovalTarget.screenId` · `DocumentTarget.screenId` | ⛔ 채울 표가 없다 — 계약이 「정하지 못하면 **키를 생략한다**(널을 보내지 않는다)」로 물러난 길을 이미 적었다 |
| `InventoryCountLine.counted` · `PickingLine.held` | 수량 비교 파생(A-21 선례) |

#### 표 D — **물리를 완화해야 할 자리** (칸 추가가 아니라 제약 완화 · 두 릴리스 규칙에 안 걸린다)

| 표 | 지금 | 계약이 요구 |
|---|---|---|
| `production.production_result` | `shift_id BigInt` NOT NULL | 「교대는 설계가 정의하는 값이 아니다 — **필수를 풀었다**」 → nullable |
| `mdm.item` | `development_item` 칸 없음 | ⚠ **만들지 않는다** — 계약이 「그때까지 서버는 전건을 적재한다」로 물러났다(S14) |

---

### 5.3 횡단 관심사 적용표

기존 자리를 그대로 쓴다 — `runIdempotent`(`common/master`) · `setEtag`/`assertUpdated`
(`common/optimistic-lock`) · `PermissionGuard`(`common/permissions`) · `@Contract`(`common/contract`).
**다시 만들지 않는다.**

#### ① 403 게이트 — `OPERATION_PERMISSIONS`

가드는 **계약이 403 을 선언한 자리에서만** 본다(`declaresForbidden`). 그리고 그 자리에 권한이
등록돼 있지 않으면 **통과가 아니라 `Error` 를 던진다**(F-6). 그래서 아래 28건은 **구현과 같은 PR 에서
반드시 등록**해야 하고, 안 하면 그 오퍼레이션의 e2e 가 500 으로 죽는다.

| 슬라이스 | 등록이 필요한 오퍼레이션 (계약 403 선언 · 표에 없음) |
|---|---|
| S02 | `PUT /logistics/inbound-receipts/{id}` · `PUT /logistics/inbound-receipts/{id}/lines` · `POST /logistics/inbound-receipt-lines/{id}/variances` |
| S01 | `PUT /logistics/purchase-orders/{id}` · `PUT /logistics/purchase-orders/{id}/lines` · `POST /logistics/purchase-orders/{id}:request-approval` |
| S03 | `POST /logistics/putaway-tasks/{id}:complete-temporary` |
| S04 | `PUT /logistics/goods-issues/{id}/lines` · `POST /logistics/picking-orders/{id}/lines/{lineId}:pick` |
| S05 | `PUT /logistics/stock-transfers/{id}/lines` · `POST /logistics/stock-transfers/{id}:arrive` |
| S07 | `POST /inventory/adjustments/{id}:post` · `PUT /inventory/adjustments/{id}/lines` · `POST /inventory/counts/{id}:close` · `PUT /inventory/counts/{id}/lines` |
| S08 | `PUT /trace/lots/{lotId}/external-identifiers` |
| S09 | `PUT /app/approval-routes/{id}` · `PUT /app/approval-routes/{id}/steps` · `POST /app/approval-routes/{id}:activate` · `POST /app/approval-routes/{id}:deactivate` |
| S10 | `POST /app/notifications/{id}:read` |
| S13 | `PUT /planning/production-plans/{id}` · `POST /planning/production-orders/{id}:resync` |
| S15 | `POST /production/work-sessions/{id}/workers` · `POST /production/work-sessions/{id}/workers/{wid}:leave` |
| S16 | `POST /production/material-returns` |
| S23 | `PUT /maintenance/results/{id}` |
| S24 | `PUT /maintenance/downtimes/{id}` |

나머지 88건은 도출표에 이미 있다. ⚠ 도출표에는 **403 을 선언하지 않은 오퍼레이션 77건**도 들어 있는데
(예: `GET /app/printers`), 가드가 그 자리를 보지 않으므로 무해하다 — 다만 `operation-permissions.spec`
의 「계약에 실재한다」 단언만 지키면 된다. 지우지 않는다.

#### ② 멱등키 — `runIdempotent`

- **249건 중 116건**(쓰기 전건)이 `Idempotency-Key` 필수. 조회 133건은 **붙이지 않는다**.
- 자리는 컨트롤러다 — `runIdempotent(this.idempotency, request, HttpStatus.CREATED|OK, () => ...)`.
  201 은 `CREATED`, 200·202·204 는 각각 그 값을 준다(`successStatus` 가 재전송 응답의 상태를 정한다).
- ⛔ **예외 하나** — `POST /app/notification-subscriptions/recipients:preview` 는 **아무것도 저장하지
  않는데** 멱등키를 받는다. 계약이 이유를 적었다(「전 쓰기 규약대로」). 부수효과가 없으니
  `runIdempotent` 로 감싸도 되고, 감싸는 편이 「같은 키로 다시 보내면 같은 전개 결과」를 공짜로 지킨다.
- ⭐ `inventory_transaction` 을 지나는 쓰기는 멱등키가 **두 겹**이다 — `app.idempotency_record`(전역
  UNIQUE)와 `inventory_transaction`의 `UNIQUE (idempotency_key, business_date)`. `InventoryPostingService.post`
  가 뒤쪽을 이미 진다. 도메인은 앞쪽만 신경 쓴다.

#### ③ `If-Match` / `ETag` — `OptimisticLockGuard` · `setEtag`

| | 건수 | 자리 |
|---|---|---|
| `If-Match` **필수**(`IfMatchVersion`) | **46** | 가드가 없으면 400, 형식이 틀리면 400. 핸들러는 `ifMatchVersion(request)` 로 읽어 **UPDATE 의 WHERE 에 건다** |
| `If-Match` **선택**(`IfMatchVersionOptional`) | **28** | ⭐ 전부 POP 오프라인 큐 대상(C-9 — 「큐는 잠금 토큰을 싣지 않는다」). 있으면 걸고 없으면 안 건다 |
| 응답 `ETag` | **42** | `setEtag(response, versionNo)` — ⛔ 본문 필드로 내리지 않는다(A-4) |

⛔ **선택 28건을 필수로 조이거나 필수 46건을 선택으로 푸는 것이 둘 다 사고다.** 조이면 오프라인 큐가
전부 400 을 받고, 풀면 두 관리자의 동시 확정 중 늦은 쪽이 조용히 덮는다. 계약이 이미 갈라 두었으므로
**가드의 `requirement()` 판정을 그대로 믿고 손대지 않는다.**

⚠ 다형 취소(S06) 는 특수하다 — `If-Match` 는 **필수**인데 토큰의 출처가 그 경로가 아니라 **대상 문서의
상세 GET** 이다. 어댑터가 유형별로 「어느 표의 `version_no` 와 대조하는가」를 알아야 한다(§5.1-B).

`PUT .../lines` 계열(전체 치환)의 `If-Match` 는 **헤더의 부모 `version_no`** 를 본다 — 라인마다 버전을
받지 않는다. 예외는 `:acknowledge`(S13) 하나로, 계약이 「토큰이 둘이다」라 적었다 — P/O 는 헤더,
함께 고치는 W/O 는 **본문 `workOrderAdjustments[].versionNo`**. 하나라도 어긋나면 전체 거부.

#### ④ 계약 검증 가드 — `@Contract`

249건 전건. 컨트롤러 메서드에 `@Contract('METHOD /path')` 한 줄이면 요청 검증·오류 봉투·권한이 따라온다.
추가로 손댈 것 셋 —

- **404 를 선언한 오퍼레이션**은 `NotFoundException` 으로 낸다(봉투는 `ErrorResponse`).
- **409 를 선언한 오퍼레이션**은 봉투가 갈린다. 기본은 `ConflictResponse`(`conflictCause`)인데,
  계약에 **도메인 전용 409 봉투 넷**이 따로 있다 — `ProductionConflictResponse`(S14~S16) ·
  `QualityConflictResponse`(S18·S19, `currentLotStatusCode` 를 실어 준다) · `ShipmentConflictResponse`(S22) ·
  `StockReinstatementConflictResponse`(S22). ⛔ 기존 `ConflictException` 을 넓히지 않는다 —
  계약이 이름을 가른 이유가 「저장 충돌의 원인」과 「거부의 업무 사유」가 다르기 때문이다.
- **422 를 선언한 오퍼레이션**은 설비툴에 몰려 있다(보전 12건). 400 과 뜻이 갈리는지 슬라이스 시작 때
  계약 문장을 다시 읽는다 — 지금 우리 봉투에 422 자리가 없다.

---

### 5.4 에러 코드 초안

`ERROR_CODE` 는 닫힌 집합이 아니다(계약 설명이 「등」으로 끝난다). 슬라이스가 쓰는 것만 더한다.
⭐ 아래에서 **계약이 이름을 직접 적은 것**과 **우리가 이름을 붙이는 것**을 갈랐다 — 앞은 그대로 써야
화면이 알아듣고, 뒤는 §2 3단계의 「흔적」이다.

#### 계약이 이름을 적은 코드 (그대로 쓴다)

| 코드 | 상태 | 조건 | 슬라이스 |
|---|---|---|---|
| `SUCCESSOR_EXISTS` | 400 | 후속 문서·재고 사용이 있다. **요청 시점과 실행 시점 둘 다** 판정한다(J-8) | S06 |
| `ROUTE_NOT_FOUND` | 400 | 결재선이 없다 — 상신할 곳이 없는 요청을 만들지 않는다 | S01·S04·S07·S08·S16 (`:request-approval` 전건) |
| `ROUTE_AMBIGUOUS` | 400 | 사업부 지정본 우선을 적용하고도 활성 결재선이 둘 이상 | S09 |
| `NOT_YOUR_TURN` | 400 | 앞 단계가 전부 승인이 아니다(순차 결재 강제) | S09 |
| `APPROVER_TYPE_NOT_SUPPORTED` | 400 | 결재선 단계의 승인자 유형을 풀 수 없다 | S09 |
| `OPEN_SESSION_EXISTS` | **409** | 같은 W/O 에 열린 작업 세션이 있는데 `:close` | S14 |
| `CANCEL_IN_PROGRESS` | **409** | 취소 결재가 진행 중인데 `:confirm`(J-7) | S22 |
| `LINE_REQUIRED` | 400 | 라인이 0건(취급단위 `:pack`·전표 생성) | S02·S04·S07 |

#### 새로 이름을 붙이는 코드 (§2 3단계 흔적 대상)

| 코드 | 상태 | 조건 | 슬라이스 | 왜 새로 만드나 |
|---|---|---|---|---|
| `APPROVAL_REQUIRED` | 400 | `:post` 인데 승인이 안 끝났다 | S04·S07 | 계약이 「승인 전이면 400」이라만 적고 코드를 안 줬다. `STATE_LOCKED` 로 뭉치면 화면이 「결재함으로 가세요」를 못 낸다 |
| `APPROVAL_IN_PROGRESS` | 400 | 진행 중인 승인 요청이 이미 있다(「한 전표에 살아 있는 요청은 하나」) | S01·S04·S07·S16 | 위와 갈려야 한다 — 이쪽은 «기다려라», 저쪽은 «올려라» |
| `ALREADY_CANCELLED` | 400 | 이미 취소됐다 | S06 | `cancelBlockedReasonCode` 와 **같은 문자열**을 쓴다 — 조회의 사유와 실행의 오류가 같은 어휘여야 화면이 안 갈린다 |
| `CANCEL_IN_PROGRESS` | 400 | 취소 요청이 이미 진행 중이다 | S06 | 같음(S22 의 409 와 상태만 다르고 뜻이 같다) |
| `TYPE_NOT_CANCELABLE` | 400 | 취소 경로가 없는 문서 유형 | S06 | 같음 |
| `COUNT_REMAINING` | 400 | 실사 `:close` 인데 미실사가 남았다 | S07 | 계약 `CD-INVENTORY-COUNT-CLOSE-BLOCKED-REASON` 4값을 그대로 쓴다 |
| `VARIANCE_UNADJUSTED` | 400 | 실사 `:close` 인데 차이가 조정 안 됐다 | S07 | 같음 |
| `ALREADY_CLOSED` | 400 | 이미 마감됐다 | S07 | 같음 |
| `RECOMMENDED_LOCATION_MISMATCH` | 400 | 권장 위치가 있는데 다른 곳에 적치(`confirmedNoRule` 로도 안 풀린다) | S03 | 계약이 「400 으로 막는다」만 적음 |
| `QTY_EXCEEDS_SHIPPED` | 400 | `:arrive` 수량 > 반출 수량 | S05 | 계약 「반출한 수량 이하만」 |
| `NEGATIVE_BALANCE` | 400 | 역처리가 잔액을 음수로 만든다 | S06 | 계약이 「400 이다」라 적음. ⚠ 지금은 DB 트리거 `check_balance_qty()` 가 500 으로 샌다 — 잡아서 이 코드로 바꾼다 |
| `JUDGMENT_SUM_MISMATCH` | 400 | `accepted + rejected + held ≠ inspected` | S18 | 계약이 「400 이다(A-3)」라 적음 |
| `NOT_BLOCKING` | 400 | `blocksUse=false` 인 검교정 이력에 `:clear` | S24 | 계약 「막고 있지 않은 것을 풀 수 없다」 |
| `ALREADY_CLEARED` | **409** | 이미 해소된 이력에 `:clear` | S24 | 계약이 「409 다」라 적음 |
| `RESULT_EXISTS` | 400 | 실적이 있는 보전오더에 `:cancel` | S23 | 계약 「실적이 하나도 없을 때만」 |
| `CAUSE_REQUIRED` | 400 | 고장 `:complete` 인데 원인 코드·처리 내역이 없다 | S23 | 계약 「있어야 완료된다」 |
| `REMAINDER_DISPOSITION_REQUIRED` / `_NOT_ALLOWED` | 400 | W/O `:close` 3분류 대조 4규칙 | S14 | 계약이 규칙 넷을 적었으나 코드를 안 줬다 |

⛔ **`STATE_LOCKED` 와 `STALE_VERSION` 을 섞지 않는다**(G-1) — 앞은 재로드해도 안 풀리고 뒤는 풀린다.
위 목록 중 400 은 전부 앞쪽 갈래이거나 입력 문제이고, 409 는 저장 충돌(`ConflictResponse`)이거나
계약이 직접 409 로 못박은 업무 거부다.

---

### 5.5 채번

⛔ **`design/schema/numbering-conventions.md` 에는 전표 번호 규약이 없다.** 그 문서는 화면 번호
(`W-01-10`) · 요구사항 번호(`REQ-PR-0021`) · 공유계약 조항 번호(`A-10`) 같은 **문서 번호 체계**만 담는다
(실측 34줄, 표 2개). 전표 채번은 `app.numbering_rule`(패턴·리셋주기·공장·LOT유형) 표가 지는데
**시드에 규칙이 하나뿐이다.**

| 전표 | 필요한 번호 칸 | `numbering_rule` 등재 | 지금 형식 | 슬라이스 |
|---|---|---|---|---|
| 생산 실적 | `production_result_no` | ✅ `PR-{YYMMDD}-{SEQ4}` · `DAILY` | 규칙대로 | S16 |
| 입고 | `goods_receipt_no` | ❌ | `GR-YYYYMMDD-NNNN` — **서버가 골랐다**(문의 14번) | (구현됨) |
| 적치 작업 | `putaway_task_no` | ❌ | `PT-YYYYMMDD-NNNN` — 같음 | (구현됨) |
| 공지 | `notice_no` | ❌ | 서버가 지음(문의 10번) | (구현됨) |
| 발주 | `purchase_order_no` | ❌ | — | S01 |
| 입하 | `inbound_receipt_no` | ❌ | — | S02 |
| 출고 | `goods_issue_no` | ❌ | — | S04 |
| 자재 출고요청 | `issue_request_no` | ❌ | — | S04 |
| 피킹 | `picking_order_no` | ❌ | — | S04(서버 생성 경로는 계약에 없음 — 출고요청이 만든다) |
| 현장 입고 | `shopfloor_receipt_no` | ❌ | — | S04 |
| 창고 이동 | `stock_transfer_no` | ❌ | — | S05 |
| 재생재 | `recycle_entry_no` | ❌ | — | S05 |
| 재고 실사 | `inventory_count_no` | ❌ | — | S07 |
| 재고 조정 | `inventory_adjustment_no` | ❌ | — | S07 |
| 취급 단위 | `handling_unit_no` | ❌ | — | S07 |
| 재포장 | `reconfiguration_no` | ❌ | — | S07 |
| 재고 예약 | `reservation_no` | ❌ | — | S07(예약은 서버가 만든다) |
| 승인 요청 | `approval_request_no` | ❌ | — | S09 |
| 생산 계획 | `plan_no` | ❌ | — | S13 |
| 작업지시 | `work_order_no` | ❌ | ⭐ **설계가 「가운데는 항상 MES 가 만든다」라 못박은 자리**(§4.4 · CORE-1) | S14 |
| 자재 소비 | `consumption_no` | ❌ | — | S16 |
| 자재 반납 | `material_return_no` | ❌ | — | S16 |
| 공정 인계 | `handover_no` | ❌ | — | S16 |
| 검사 결과 | `inspection_result_no` | ❌ | — | S18 |
| 부적합 | `nonconformance_no` | ❌ | — | S20 |
| 특채 | `concession_no` | ❌ | — | S20 |
| 출하 요청 | `shipment_request_no` | ❌ | — | S21 |
| 출하 | `shipment_no` | ❌ | — | S22 |
| 고장 | `breakdown_no` | ❌ | — | S23 |
| 보전 오더 | `maintenance_order_no` | ❌ | — | S23 |
| 설비 점검 | `inspection_no` | ❌ | — | S24 |
| 원장 트랜잭션 | `transaction_no` | ❌ | 호출자가 준다(`PostingInput.transactionNo`) | 전 posting 슬라이스 |

**§2 판정 초안.** 1단계 = 본길에 가깝지만(모든 전표에 번호가 붙는다) **계약이 형식을 요구하지 않는다** —
어느 응답도 `pattern` 을 걸지 않았고 화면은 서버가 준 문자열을 그대로 보인다. 그래서 가장자리로 읽고
2단계 기준 5(개념 수를 안 늘리는 쪽)로 간다 —

> **`app.numbering_rule` 을 읽는 채번 코어(`core/numbering`) 하나를 만들고, 규칙이 없는 문서 유형은
> `{PREFIX}-{YYYYMMDD}-{SEQ4}` 로 떨어지는 기본값을 쓴다.** 접두어는 지금 서버가 쓰는 `GR-`·`PT-` 와
> 같은 방식으로 문서 유형별로 한 자리에 모아 둔다.

이유 셋 — ① 규칙이 오면 **그 표에 행을 넣는 것만으로** 32종이 한 번에 바뀐다 ② 지금 `GR-`/`PT-` 가
쓰는 「접두어로 세어 +1」은 순번이 연속을 보장하지 않고 부딪히면 유일 인덱스가 막는데,
`numbering_counter`(`UNIQUE (numbering_rule_id, period_key)`)가 그 자리를 이미 갖고 있다
③ 32곳에 각자 함수를 두면 규칙이 왔을 때 32곳을 고친다(위험 9).

⚠ 이것은 **새 코어를 하나 세우는 결정**이라 통합 계획에서 다른 두 관점과 반드시 맞춰야 한다.
`server-architecture.md` §2 가 코어 여섯 중 하나로 `numbering`(C-6)을 이미 예고해 두었으므로
「선제적 레이어」가 아니다 — 사용처가 32곳으로 이미 서 있다.

---

## 6. 다른 관점과 부딪힐 만한 자리 (통합 단계용)

| # | 이 관점의 주장 | 부딪힐 상대 |
|---|---|---|
| 1 | **채번 코어를 S01 앞에 세운다**(§5.5) | 통합 관점이 「사용처 둘 생길 때까지 미룬다」로 볼 수 있다. 근거는 32곳이 이미 서 있다는 것 |
| 2 | **S09(승인)를 1번으로 당긴다** — strategy 의 M5(승인 워크플로)에서 앞으로 끌어올렸다 | UI/UX 관점이 「결재함 화면이 늦다」로 볼 수 있다. 서버 쪽 근거는 `:request-approval` 8건·`:request-cancel` 2건이 전부 이것을 선행으로 갖는다는 것 |
| 3 | **LOT 품질 축(§5.1-E)에서 9줄만 등록하고 나머지는 던지게 둔다** | 통합 관점이 「검사 슬라이스가 반쯤만 돈다」로 볼 수 있다. F-6 대로면 그것이 맞다 |
| 4 | **보전 도메인 마이그레이션(표 A 15~22)을 뒤로 미룬다** | 그 사이 계약 사본이 다시 굳으면 다시 대조해야 한다 |
| 5 | **`x-no-code-key` 16자리의 `status_code` 에 고정 상수 하나** | 통합 관점이 「값을 지어내는 것 아닌가」로 볼 수 있다. NOT NULL 이라 무엇이든 넣어야 하고, 상수 하나가 「도출」보다 되돌리기 싸다(§2 2단계 기준 4) |
