# 59. ⭐⭐ 적치 원장의 판별자가 `STOCK_TRANSFER` 인데 그 표는 적치를 모른다 — 되돌릴 수 없는 행이 오늘부터 쌓인다

> ## ✅ 결정 (2026-09-08 · 통보)
>
> **`STOCK_TRANSFER` 를 그대로 쓰고, `transaction_no` 의 `PT-` 접두어를 «정본 판별 규칙»으로 문서화한다.**
>
> **왜 정할 수 있나**(§2 1-1) — MES 본질(재고 원장)이지만 **이미 쌓인 행이 «식별은» 된다.**
> 적치가 쓴 원장 행은 `transaction_no = putaway_task_no`(`PT-` 접두어)라 진짜 재고이동과 구별된다.
> 위험은 「구분 불가」가 아니라 **「정정 불가」**이고, 식별이 되는 한 실무는 성립한다.
>
> **판별 규칙(정본)**
> ```
> source_document_type_code = 'STOCK_TRANSFER' AND transaction_no LIKE 'PT-%'   → 적치
> source_document_type_code = 'STOCK_TRANSFER' AND transaction_no NOT LIKE 'PT-%' → 재고 이동(I-13)
> ```
>
> ⛔ **레인 C 에 전달했다** — I-13 의 진짜 재고이동은 **`PT-` 접두어를 쓰지 않는다.**
> 쓰면 한 값에 두 뜻이 섞여 **식별조차 못 하게 되고**, 이미 쌓인 행은 `block_ledger_header_mutation`
> 때문에 정정이 불가능하다.
>
> **답이 「다섯째 enum 값」으로 오면** — 새 행부터 그 값을 쓰고, 옛 행은 위 규칙으로 계속 식별한다(정정 불가).

| 칸 | 내용 |
|---|---|
| **구분** | ⭐ **통보**(§2 1-1 — 2026-09-08 규칙) · 회신을 기다리지 않는다 |
| 걸리는 오퍼레이션 | `POST /logistics/putaway-tasks/{putawayTaskId}:complete` · `…:complete-temporary` · `GET /inventory/transactions?sourceDocumentTypeCode=STOCK_TRANSFER` · **I-13 재고 이동의 반출·도착·취소** |
| 구현 상태 | **구현함(I-12 · `sourceDocumentTypeCode='STOCK_TRANSFER'` · `sourceDocumentId=putaway_task_id` · `transactionNo=putaway_task_no`)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길**(두 오퍼레이션의 모든 호출이 이 값을 쓴다) → 계약 문자가 둘로 갈려 후보 넷을 재어 가장 덜 어긋나는 것을 골랐다(`slices/I-12.md` §3-6 · R-1) |
| 되돌릴 때 | ⛔ **이미 쌓인 원장 행은 고칠 수 없다** — `block_ledger_header_mutation` 이 `status_code` 외 UPDATE·DELETE 를 막는다(baseline `migration.sql:2960-2993`). 답이 「다섯째 값」이면 새 행부터 그 값 + 옛 행은 `(STOCK_TRANSFER, putaway_task_id)` 로 남는다 · 「헤더 전표」면 계약 신설 + 마이그 + 적치 서비스 한 자리 |

## 무엇이 문제인가

⓪ **먼저** — 이 답은 **I-13(재고 이동) 착수 «전»에** 받아야 한다. I-13 이 `stock_transfer` 행을 만드는 순간 아래 ⓑⓒ 가 실제 충돌이 된다.

ⓐ 계약 `InventoryTransaction.sourceDocumentTypeCode` 는 `enum` **4값**(`GOODS_RECEIPT`·`GOODS_ISSUE`·`INVENTORY_ADJUSTMENT`·`STOCK_TRANSFER`)이고 「값은 «대상 테이블 이름»이다 · `sourceDocumentId` 는 그 표의 식별자다 · 가리킬 표가 늘면 계약을 고친다」라 못 박았다. 적치에는 `stock_transfer` 헤더가 없다. 계약 자신이 「`STOCK_TRANSFER` 는 «재고를 움직이므로 원장을 남긴다»는 **추론**이다 — 근거가 얕다」라 적어 두었다.
ⓑ 충돌 경로가 취소만이 아니다 — `document-progress-query.service.ts` 는 `cancelable` 을 안 보고 `(type, id)` 로 원장을 찾아 `POSTED` 단계를 만든다 ⇒ I-13 이 `stock_transfer 5` 를 만들면 `GET /logistics/document-progress/STOCK_TRANSFER/5` 가 **남의 적치 원장**을 읽는다.
ⓒ **오늘부터** `GET /inventory/transactions?sourceDocumentTypeCode=STOCK_TRANSFER` 가 존재하지 않는 `stock_transfer` 를 가리키는 행을 낸다.
ⓓ 후보 넷을 다 재었다 — `PUTAWAY_TASK` 다섯째 값은 응답·질의 **두 enum** 이 닫혀 AJV 가 잡는다 · `GOODS_RECEIPT` 로 쓰면 다형 취소가 한 문서에서 원장 2행을 만나 **500** 을 낸다(`document-cancel-execute.service.ts` 「2행이면 던진다」) · 서버가 `stock_transfer` 헤더를 만드는 안은 「창고 간(from≠to)만」이라는 계약·화면(`M-01-10:139` 「창고 내 이동은 헤더 없이 수불만」)과 충돌하고 전표·번호·상태·사유 넷을 새로 만든다.

## 지금 서버는

- `putaway-posting.ts` 의 상수 `SOURCE_DOCUMENT_TYPE = 'STOCK_TRANSFER'` 에 「⚠ 설계 미정 — 문의 059」 주석. 원장 번호는 `putaway_task_no`(`PT-YYYYMMDD-NNNN`) 그대로(채번 신설 0 · 입고 선례).
- 오늘 `document-type-registry.ts` 의 `STOCK_TRANSFER` 가 `cancelable:false` 라 다형 취소는 이 행을 찾지 않는다 — **I-13 이 이동 취소를 열기 전까지만** 안전하다.
- e2e `⚠ 원장 헤더가 sourceDocumentTypeCode=STOCK_TRANSFER · sourceDocumentId=putawayTaskId 다 — stock_transfer 가 «아니다»` 가 이 형상을 못 박는다.

⇒ **묻는 것**: 다섯째 값 `PUTAWAY_TASK` 를 열 것인가 · 「대상 테이블 이름」 규칙을 완화할 것인가 · 적치에도 헤더 전표를 둘 것인가. 답이 오기 전에 I-13 을 시작해야 하면 `(type, id)` 조회에 표 축을 더하는 임시 조치가 필요하다(`slices/I-12.md` §11 ①).

흔적: `docs/coverage-100/slices/I-12.md` §3-6 · R-1 · §11 ① · `src/logistics/putaway/putaway-posting.ts` · `test/logistics-putaway-task.e2e-spec.ts`.
