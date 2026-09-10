# 217. 계약 enum **둘**에 값을 더해 주십시오 — 출고의 원천 `SHIPMENT` 가 없고, 「상류 문서가 소유한다」는 차단 사유가 없다

**구분: 통보**(회신을 기다리지 않는다 — 서버는 아래대로 구현했고, 계약에 값이 실리면 한두 줄로 따라간다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shipments`(I-23) · `GET /logistics/goods-issues` · `GET /logistics/document-progress/{documentTypeCode}/{documentId}` · `POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel` |
| 구현 상태 | **구현함**(I-23 PR ④b · ⑦a) — ⓐ 출하가 만든 출고 전표의 원천 유형에 `SHIPMENT` 를 싣는다 ⓑ 출하가 소유한 출고·입고 전표의 다형 취소를 `STATE_LOCKED` 로 막는다 |
| 판정 | §2 **1단계 본길**(출하마다 · 진행현황 조회마다 걸린다) → **1-1단계 통보** — MES 본질 ⭕(원장 정합) × 바꾸는 비용 ✕(값 하나 · 코드 한 줄 · 마이그 0) |
| 되돌릴 때 | ⓐ 다른 값으로 오면 `goods_issue.source_document_type_code` 에 `UPDATE` 한 문장 + 상수 한 줄 ⓑ 여섯째 값이 오면 `cancel-eligibility.service.ts:121` 의 한 줄을 새 키로 옮기고 spec 둘 |

## ⓐ `GoodsIssue.sourceDocumentTypeCode` — enum 3값에 `SHIPMENT` 가 없다

계약은 이 칸을 **2026-09-01(`omf-mes#336`)에 enum 3값으로 닫았다** — `PICKING_ORDER` · `GOODS_RECEIPT` · `DISPOSITION_DECISION`(`logistics-01자재창고.json` `GoodsIssue` `:7528`~). 같은 설명이 「새 대상이 생기면 화면이 문자열을 정하기 전에 이 목록에 등재한다(A-16)」라 적었다.

출하 등록은 **출고 전표를 만든다** — 계약 `ShipmentLine.goodsIssueLineId` 가 그 전표 라인을 가리킨다. 그 전표의 원천은 **출하**다.

| 자리 | 값 | 계약 |
|---|---|---|
| `goods_issue.source_document_type_code` | **`SHIPMENT`** | ⛔ enum 3값 **밖** |
| `goods_issue.source_document_id` | **`shipment_id`**(A-10 — 짝 id 는 판별자가 가리키는 표의 식별자) | — |
| 원장 `inventory_transaction.source_document_type_code` | `GOODS_ISSUE` | ✅ `InventoryTransaction` enum 5값 **안** |

⭐ **거울 쪽에는 이미 있다** — `GoodsReceipt.sourceDocumentTypeCode` 4값이 `INBOUND_RECEIPT` · **`SHIPMENT`** · `PRODUCTION_RESULT` · `SUBCONTRACT_ISSUE` 다(`:8004`~). 입고는 출하를 원천으로 부를 수 있는데 출고는 못 부른다 ⇒ **대칭 결손**으로 읽었다.

⇒ 오늘 출하가 만든 출고 전표가 `GET /logistics/goods-issues` 응답에 실리면 **그 한 칸이 계약 enum 밖**이다.

### 왜 이 모양인가
- ⛔ **원장에 `SHIPMENT` 를 직접 싣지 않는다** — `InventoryTransaction.sourceDocumentTypeCode` 는 **required + enum 5값**이라 원장 조회가 깨진다. 출고 전표 한 장을 사이에 두면 원장은 enum 안에 머물고, 어긋나는 자리가 **출고 전표 한 칸**으로 좁혀진다.
- ⛔ **출고 전표를 생략하지 않는다** — 되짚기(`ShipmentLine.goodsIssueLineId`)와 취소 역전기가 붙을 문서가 없어진다.

### ⚠ 구현 중 정정 하나
처음 구현은 출하 헤더를 맨 뒤에 만들면서 `source_document_id` 에 **출하작업지시 id** 를 넣었다 — 판별자는 `SHIPMENT` 인데 id 는 다른 표의 것인 **유령 참조**였고, 단위·e2e 가 그 틀린 값을 오히려 못 박고 있었다. 뒤 PR 작성 중에 찾아 «헤더 먼저»로 고쳤다(`shipment-posting.ts:20-23`).

### 📨 청하는 것
`GoodsIssue.sourceDocumentTypeCode` enum 에 **`SHIPMENT`(→ `logistics.shipment`)** 를 더하고, 설명의 대응표에 「출하(`SHIPMENT` → `logistics.shipment` · `W-04-04`·`W-04-05` 출하 등록)」 한 줄을 더해 주십시오.

## ⓑ `DocumentProgress.cancelBlockedReasonCode` — 「상류 문서가 소유한다」가 없다

출하가 만든 출고 전표(평시)와 입고 전표(긴급 직행 · 통보 221)는 **출하의 부품**이다. 그것을 다형 취소(`document-progress … :cancel`)로 **따로** 취소하면 **출하는 살아 있는데 재고만 돌아온다.** 원장은 소급 정정이 안 되므로 막아야 한다 — 취소는 출하의 `:cancel` 한 길뿐이다(그쪽이 역전기 둘 · 예약 · 롤업을 한 트랜잭션으로 되돌린다 · 통보 220).

계약 enum 5값(`:7320`) — `SUCCESSOR_EXISTS` · `ALREADY_CANCELLED` · `CANCEL_IN_PROGRESS` · `STATE_LOCKED` · `TYPE_NOT_CANCELABLE`.

| 후보 | 판정 |
|---|---|
| `SUCCESSOR_EXISTS` | ⛔ **틀린 안내**가 된다 — 출하는 그 전표의 «후속»이 아니라 «상류»이고, 후속 유형 enum 에 `SHIPMENT` 가 없다. 세기만 하면 `successors: []` 인데 `successorCount: 1` 이라 화면이 **보이지 않는 후속을 먼저 취소하라**고 안내한다 |
| **`STATE_LOCKED`** | ✅ **채택** — 「상태가 잠겼다」. 안내가 덜 정확할 뿐 틀리지 않는다 |

구현 — `src/logistics/document-progress/cancel-eligibility.service.ts:40-48`(판정) · `:102`(원천 유형을 읽는다) · `:121`(`STATE_LOCKED: … || ownedByShipment`).

### 📨 청하는 것
여섯째 값을 주십시오 — 예: **`OWNED_BY_UPSTREAM`**(「상류 문서가 소유한다 — 그 문서에서 취소하라」). 이름은 설계가 정한다.
⚠ 5값의 **우선순위**도 계약에 없다 — 오늘은 싼 판정부터(`TYPE_NOT_CANCELABLE` → `ALREADY_CANCELLED` → `CANCEL_IN_PROGRESS` → `STATE_LOCKED` → `SUCCESSOR_EXISTS` · `:52-54`) 두었으니 여섯째의 자리도 함께 정해 주십시오.

## 흔적
- 계약: `contracts/logistics-01자재창고.json` — `GoodsIssue`(`:7528`) · `GoodsReceipt`(`:8004`) · `DocumentProgress.cancelBlockedReasonCode`(`:7320`) · `InventoryTransaction`(`:10942`)
- 코드: `src/logistics/shipment/shipment-posting.ts:20-33`·`:147` · `src/logistics/goods-issue/issue-posting.ts:254-259` · `src/logistics/document-progress/cancel-eligibility.service.ts:40-48`·`:96-121`
- 계획서: `docs/coverage-100/slices/I-23.md` §3-2 · §9-1 · R-17(질의에서 통보로 내렸다)
