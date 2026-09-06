# 49. `ShopfloorReceiptLineCreate.issuedQty` 를 클라이언트가 보내는데 서버가 이미 아는 값이고, 다를 때 무엇을 할지 계약이 적지 않았다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shopfloor-receipts` |
| 구현 상태 | **구현함(I-9 · `goods_issue_line.issue_qty` 와 대조해 다르면 400 `INVALID` — 덮어쓰지 않는다)** |
| 판정 | `coverage-100/README.md` §2 1단계 **가장자리**(클라이언트 값이 출고 라인과 다를 때만 갈린다) → 2단계 기준 2(거부하는 쪽) + 기준 4(값을 조용히 도출하지 않는 쪽) — 둘이 같은 답 |
| 되돌릴 때 | 「서버값으로 덮어써라」면 검사 한 줄 삭제 + `issue_qty` 로 INSERT(완화 · 마이그 0) · 「보내지 말라」면 계약 `ShopfloorReceiptLineCreate` 에서 `issuedQty` 를 required 에서 빼고 서버가 채운다(마이그 0) |

## 무엇이 문제인가

ⓐ `shopfloor_receipt_line.variance_qty` 는 **GENERATED `(issued_qty − received_qty)`** 라 **클라이언트가 보낸 `issuedQty` 가 차이의 분모**가 된다. 조용히 덮어쓰면 화면이 본 차이와 저장된 차이가 갈린다.
ⓑ `M-01-09` §4-A 는 「출고 수량 = 읽기 전용 — **출고에서**」라 적어 화면은 되읽어 보낼 뿐이다 — 그런데 계약은 `issuedQty` 를 `readOnly` 없이 **required** 로 받는다.
ⓒ 응답 `ShopfloorReceiptLine.issuedQty` 도 `readOnly` 가 아니고 `varianceQty` 만 `readOnly` 다.
ⓓ 같은 「출고 수량」이 `goods_issue_line.issue_qty` 와 `shopfloor_receipt_line.issued_qty` **두 벌**로 남는다.
ⓔ 오늘 두 벌이 **갈릴 경로는 없다** — 출고는 항상 `POSTED` 로 태어나고(`M-01-09` §8 #1 `postImmediately: true` · I-4 R-6) 전기된 출고 라인의 치환은 400 `STATE_LOCKED`(`goods-issue-update.service.ts:261`) · 취소→재출고는 새 `goods_issue_line_id` 다. ⇒ 불일치는 **클라이언트가 틀린 경우뿐**이고 그래서 400 이 「업무를 없애는 거부」가 아니다.
ⓕ 046(요청 라인 `issued_qty` ↔ 출고 합계)과 같은 «두 벌» 계열이나, 표·물음·되돌림 비용이 다르다 — 046 은 올리는 오퍼레이션 부재(마이그 후보), 이것은 대조 규칙 부재(한 줄).

## 지금 서버는

- `issuedQty !== goods_issue_line.issue_qty` → 400 `INVALID`(`field: lines[i].issuedQty`). 단위 테스트 `issuedQty 가 출고 라인의 issue_qty 와 다르면 400 INVALID // 설계 미정 — 문의 049`.
- 같은 자리에서 `itemId`·`lotId`·`uomId` 도 출고 라인과 대조한다(`M-01-09` §6 「품목 상이 ⛔ 매칭 실패」 — 이것은 화면이 답했다).

흔적: `docs/coverage-100/slices/I-9.md` §3-3 ⓔ · R-6 · R-7 · `shopfloor-receipt.service.ts`(대조 자리).
