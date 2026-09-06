# 48. 생산창고 입고 전표가 영원히 `REGISTERED` 이고, 수령 전표가 선 출고를 취소 판정이 못 본다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shopfloor-receipts` · `GET /logistics/shopfloor-receipts`(`statusCode` 필터) · `POST /logistics/goods-issues/{goodsIssueId}:cancel`(I-5 취소 판정) |
| 구현 상태 | **구현함(I-9 · 등록 `status_code = 'REGISTERED'` 고정 · 옮기는 오퍼레이션 0 · 취소 판정은 수령 전표를 안 본다)** |
| 판정 | `coverage-100/README.md` §2 0단계 **선례**(원장을 안 지나는 물류 전표의 등록값 `REGISTERED` — `material-issue-request.constants.ts:7` · `goods-issue-rules.ts:14`) · 취소 판정은 1단계 **본길** → 2단계 기준 1(I-5 코어 파일을 이 슬라이스가 안 건드리는 쪽) |
| 되돌릴 때 | ① 「수령 전표가 붙은 출고는 취소 불가」면 `cancel-eligibility.service.ts` 후속 프로브 1(`shopfloor_receipt.goods_issue_id` 직접 FK · ~10줄 · 코어 PR) ② 「수령 전표에도 취소 경로」면 계약에 `DocumentProgress.documentTypeCode` 10번째 값 + `transitions.ts` 키 + 액션 오퍼레이션 신설 ③ 「`POSTED` 로 태어난다」면 상수 한 줄 — 단, 원장 행 없는 `POSTED` 가 I-5 「`steps` 의 `POSTED` 줄은 원장 행이 있을 때만」 과 갈린다 |

## 무엇이 문제인가

ⓐ 계약이 `ShopfloorReceipt.statusCode` 를 `LOGISTICS_DOCUMENT_STATUS` **4값**(`REGISTERED`·`POSTED`·`CANCEL_REQUESTED`·`CANCELLED`)으로 못박고 목록 필터에도 걸어 두었는데, **그 값을 옮기는 오퍼레이션이 계약에 0건**이다. 등록 본문 `ShopfloorReceiptCreate` 에 `statusCode` 칸도 없다. ⇒ 목록 `statusCode` 필터 4값 중 **셋이 영원히 빈다**.

ⓑ 「등록이 곧 확정」이라 `POSTED` 를 쓸 수도 있으나, `POSTED` 는 이 계약 전체에서 **전기완료**의 이름이다. 이 전표는 원장을 **영원히 안 지난다**(`plan.md` §0 #13 「기록만」 · `shopfloor_receipt_line` 에 원장 FK 칸 0) ⇒ 원장 행 없는 `POSTED` 는 거짓이 된다.

ⓒ ⭐ **취소 판정이 수령 전표를 못 본다** — `cancel-eligibility.service.ts:143-155` 는 후속 문서를 `(source_document_type_code, source_document_id)` 다형 축 **3표**(`goods_receipt`·`goods_issue`·`picking_order`)로만 세고, LOT 축 프로브(`:51`)는 `GOODS_ISSUE` 를 뺐다. `shopfloor_receipt.goods_issue_id` 는 **직접 FK** 라 어느 프로브에도 안 잡힌다. ⇒ 수령 전표가 붙은 `POSTED` 출고를 I-5 가 그대로 취소하고 역트랜잭션까지 낸다. `M-01-09` §8 #1 이 초과 수령의 정정을 **바로 그 출고 취소(`W-01-13`)** 로 돌렸으므로 이것은 가장자리가 아니라 **본길**이다. 취소된 출고를 가리키는 수령 전표는 되돌릴 경로가 0(`DocumentProgress.documentTypeCode` 9값에 `SHOPFLOOR_RECEIPT` 없음 · `transitions.ts` 키 없음)이라 영원히 `REGISTERED` 로 남고, I-10 투입이 그 위에 붙는다.

## 지금 서버는

- 등록 = `status_code 'REGISTERED'` 상수(`shopfloor-receipt.constants.ts`). `transitions.ts` 에 키를 넣지 않았다(액션 없는 빈 표를 코어에 두지 않는다).
- 출고 취소 판정(`cancel-eligibility`)은 **고치지 않았다** — I-5 코어 파일이고 답이 오면 프로브 한 줄이다. 후속 소형 PR 후보로 둔다.
- 목록 `statusCode` 필터는 문자 그대로 넘긴다(4값 대조 없음 · 선례).

흔적: `docs/coverage-100/slices/I-9.md` §3-5 · R-4 · §9(I-5/I-13 행) · `cancel-eligibility.service.ts:51·143-155`(수령 전표를 세지 않는 자리).
