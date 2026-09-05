# 22. `GOODS_ISSUE_DISPOSAL` 결재선의 `businessUnitId` 를 「서버가 `reasonCode` 로 파생」할 매핑이 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/goods-issues/{id}:request-approval`(I-4) — 시그니처는 I-1 `ApprovalService.selectRoute(approvalTypeCode, businessUnitId)` 에서 굳는다. 같은 자리: 조정(I-14)·실적 정정(I-7)·IQC 생략(I-18)·취소 3(I-5)·출하 취소(I-23) |
| 구현 상태 | 구현 예정 — `PURCHASE_ORDER` 만 전표의 `business_unit_id` 를 주고, **나머지 8 상신자는 `null`(전 사업부 공통본)** 을 준다 |
| 판정 | §2 0단계 선례 없음 → 1단계 가장자리(사업부 지정본이 실제로 등록된 뒤에만 갈린다) → 2-3 매핑표를 만들지 않음 · 2-4 조용한 도출 금지 → 3단계 흔적: `selectRoute` 주석 `// 설계 미정 — 문의 022` |
| 되돌릴 때 | 각 상신자의 `selectRoute` 호출 한 줄(둘째 인자). 매핑이 코드 그룹이면 조인, 품목이면 `item.business_unit_id` 경유. 기존 요청 행은 이관 없음(결재선 식별자를 안 담는다 — 문의 018) |

## 무엇이 문제인가

계약 `ApprovalRoute.approvalTypeCode` 설명(✓확정 2026-09-01): 「자재 폐기와 제품 폐기를 가르는 축은 결재선의 `businessUnitId` 이고 **서버가 전표의 `reasonCode` 로 파생한다**」.
그런데 —
- `reasonCode → business_unit` 매핑이 계약에도 물리에도 없다(공통코드 그룹 없음 · `goods_issue` 에 `business_unit_id` 칸 없음 — 실측).
- 9 상신 대상 표 중 `business_unit_id` 를 가진 것은 `purchase_order` **하나**다. `goods_issue`·`inventory_adjustment`·`lot`·`shipment`·`production_result`·`goods_receipt`·`inbound_receipt` 에는 칸이 없다.

## 지금 서버는

P/O 외 8 상신자는 `businessUnitId=null` 로 `selectRoute` 를 부른다 ⇒ 전 사업부 공통본만 선다. 사업부 지정본을 등록해도 그 8 유형에서는 선택되지 않는다.

## 요청

`GOODS_ISSUE_DISPOSAL`(과 사업부 축이 필요한 다른 유형)에서 `businessUnitId` 를 무엇으로 정하나 —
① `reasonCode → businessUnit` 공통코드 매핑을 내려 준다 ② 전표 라인 품목의 `item.business_unit_id`(자재/제품)로 판단한다 ③ 상신 본문이 `businessUnitId` 를 보낸다(계약 변경) ④ 사업부 축을 쓰지 않는다(공통본만).

우리 권고안(회신이 없으면 이대로 갈 값): **②** — 자재/제품은 품목 속성이고 이미 물리에 있다. 라인 품목의 사업부가 섞이면 400 `ROUTE_AMBIGUOUS`. 이유: 새 매핑표를 만들지 않고, 계약이 말한 「서버가 파생」과 맞는다.
