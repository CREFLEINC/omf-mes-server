# 46. `material_issue_request_line.issued_qty`(계약 required · `readOnly` · ⌜누적 출고 수량⌝)를 올리는 오퍼레이션이 계약 어디에도 없다 — 같은 «기출고»가 두 벌(`issued_qty` 칸 ↔ `goods_issue` 합계)이 되고 `ck_material_issue_line_qty` 가 무의미해진다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/material-issue-requests/{materialIssueRequestId}` · `GET …/shortage` · `POST /logistics/goods-issues`(`:post`) |
| 구현 상태 | **구현함(I-8 · 상세 `issuedQty` 는 물리 칸 값(오늘 언제나 0) · `shortage.issuedQty` 는 `goods_issue` 헤더 축 합계 · 출고 전기는 그 칸을 올리지 않는다)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길** · 계약이 올리는 자리를 안 적었다 → 2단계 **기준 4**(요청 라인 ↔ 출고 라인의 짝을 서버가 지어내지 않는 쪽) |
| 되돌릴 때 | ① 「출고 전기가 올린다」면 되짚을 축이 먼저 필요하다 — `picking_line` 은 요청 «헤더»만 가리킨다(`picking_order.source_document_id`) · 라인 짝(`picking_line.material_issue_request_line_id` 류) 컬럼 추가 마이그 + `postIssue()` 에 UPDATE ~15줄 ② 「칸을 버린다」면 계약에서 `issuedQty` 제거 + 두 릴리스 삭제 규칙 ③ 「shortage 도 그 칸으로 센다」면 ①이 선행 |

## 무엇이 문제인가

계약 `MaterialIssueRequestLine.issuedQty` 는 `x-source-column: issued_qty` · **required · `readOnly: true`** · ⌜누적 출고 수량. 요청 수량을 넘지 않는다⌝ 이다. 그런데 그 칸을 «올리는» 오퍼레이션이 없다 — `POST /logistics/material-issue-requests` 는 0 으로 만들고, `POST /logistics/goods-issues` 의 `GoodsIssueLineUpsert` 는 `pickingLineId`(선택)만 실어 요청 «라인»을 모른다.

- 요청 상세는 그 칸을 **언제나 0** 으로 내린다. `W-02-10` 의 「기출고」 열이 비어 보인다.
- `GET …/shortage` 의 `issuedQty` ⌜이 W/O 앞으로 출고된 수량의 합⌝ 은 다른 축 — `goods_issue(POSTED · source=PICKING_ORDER) ⋈ picking_order(source=MATERIAL_ISSUE_REQUEST) ⋈ material_issue_request.work_order_id` 합 — 으로 셀 수밖에 없다. **같은 「기출고」가 두 벌**이 된다.
- 물리 `ck_material_issue_line_qty (issued_qty <= requested_qty)`(baseline:1411)는 아무것도 지키지 않는다.
- 출고가 요청 라인을 되짚을 축이 계약·물리 어디에도 없다 — `picking_line` 은 요청 **헤더**만 가리킨다.

## 지금 서버는

- 상세 `issuedQty` = 물리 칸 값 그대로(0). `shortage.issuedQty` = 출고 헤더 축 합계(`shortage.service.ts` · 인덱스 `ix_goods_issue_source` 쪽). 출고 전기(`issue-posting.ts`)는 `picking_line_id` 로 코어 `consume()` 만 부르고 요청 라인은 건드리지 않는다.
- 두 값이 갈리는 것을 **알고** 둔다 — 지어내서 맞추면 답이 온 뒤 되돌릴 비용이 마이그 둘이다.

흔적: `docs/coverage-100/slices/I-8.md` §7-4·R-18·R-23 ⓐ · `shortage.service.ts:24`(⛔ `issued_qty` 안 씀) · `material-issue-request-view.ts:43`(언제나 0) · `material-issue-request.service.ts:97`(기본값 0 그대로) · `issue-posting.ts:252`(피킹 소진은 출고 헤더 축 — 요청 라인을 되짚는 축이 없다).
