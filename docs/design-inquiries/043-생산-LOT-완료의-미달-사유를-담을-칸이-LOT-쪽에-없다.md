# 43. 생산 LOT 완료의 미달 사유를 담을 칸이 LOT 쪽에 없다 — 슬롯 N 개와 W/O 마감이 `work_order.completion_variance_reason_code` 한 칸을 함께 쓴다 · 서버는 덮어쓴다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /trace/lots/{lotId}:complete` · `POST /production/work-orders/{workOrderId}:close`(I-6) |
| 구현 상태 | **구현함(I-7 · `:complete` 의 `completionVarianceReasonCode` 를 `work_order.completion_variance_reason_code` 에 **덮어쓴다** — 마지막에 쓴 것이 남는다 · 빈 값으로 지우지는 않는다 · LOT 축 보존 칸을 만들지 않는다)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길**(슬롯이 둘 이상인 모든 W/O) · 계약이 스스로 미정이라 적었다(⌜B-13 **미충족**⌝ · ⌜서버가 한 곳에서 정한다⌝) → 2단계 **기준 3**(칸을 새로 만들지 않는 쪽 · I-6 규칙 4·5 「정상이면 그 칸을 안 건드린다」와 같은 결) |
| 되돌릴 때 | 「LOT 단위로 보존하라」면 `trace.lot.completion_variance_reason_code` 마이그 1 + `:complete` 가 그 칸에 쓰고 `work_order` 칸은 `:close` 만 쓴다(`lot-complete.service.ts` 한 줄 · `lotView` 한 줄) · 「마감이 지워라」면 `:close` 정상 갈래에 `null` 대입 한 줄(I-6 규칙 5 되돌림) |

## 무엇이 문제인가

`:complete` 의 미달 사유(`LotComplete.completionVarianceReasonCode`)는 **LOT 단위** 판정이다(`P-02-06` §5-3 — 슬롯의 `lot.initial_qty` 대비 누적 양품 `Σ allocated_qty`). 그런데 그것을 담을 칸이 `trace.lot` 에 없고(실측), 계약이 가리키는 칸은 **`work_order.completion_variance_reason_code`** 한 칸이다. 같은 칸을 I-6 `:close` 의 `reasonCode`(W/O 합계 미달·초과 사유)가 쓴다.

- 계약 `:complete` x-internal-note: ⌜B-13(LOT 단위 사유 보존)이 **미충족**이다 · LOT 단위 사유를 보존하려면 `trace.lot` 쪽 칸이 필요하다 · LOT 은 미달인데 W/O 합계는 정상인 조합에서 마감이 빈 값으로 앞 사유를 지우는지 유지하는지 아직 정해지지 않았다 — **서버가 한 곳에서 정한다**⌝.
- `P-02-06` §5-3 ⚠ · §8 미결 2 가 같은 자리를 미결로 남겼다.
- ⚠ 화면 파급: **`W-02-05` §4-A 가 같은 칸을 마감 화면에 「미달·초과 사유」로 그린다.** 슬롯 N 개를 순차 완료하면 **마지막 LOT 의 사유가 마감 화면의 사유로 보인다** — 마감 담당자가 「W/O 합계가 왜 미달인가」로 읽는 칸에 「셋째 슬롯이 왜 미달이었나」가 서 있다.

## 지금 서버는

- `:complete` 는 미달(누적 양품 `Σ allocated_qty` < `initial_qty`)이면 `completionVarianceReasonCode` 필수(400 `REQUIRED`) · 정상·초과인데 사유가 오면 400 `INVALID`(`:close` 규칙 5 와 대칭) · 값은 `WORK_ORDER_COMPLETION_VARIANCE_REASON` 대조 · 그 값을 `work_order.completion_variance_reason_code` 에 **덮어쓴다**(`status_code`·`version_no` 는 안 건드린다). 정상·초과면 W/O 를 읽지도 않는다. `lot.completed_at`(+`remarks`·`version_no`+1)만 찍고 어느 상태 칸도 안 옮기며 `lot_lifecycle_history` 도 안 쓴다(I-7 §3-3).
- **마감된 W/O 의 LOT 을 미달로 완료하면 400 `STATE_LOCKED`** — `trg_work_order_closed_immutable` 이 UPDATE 를 막아 500 이 새는 자리를 앞당겨 거절한다(구현 이탈 · I-7 §11-2). 정상·초과는 마감 뒤에도 통과한다. 그래서 「마감 뒤 슬롯 완료가 마감 사유를 덮는」 조합은 생기지 않고, 「슬롯 N 개 순차 완료 → 마지막 슬롯 사유 → 마감이 덮거나(미달·초과) 남기거나(정상)」 만 남는다.
- LOT 축 사유는 **보존되지 않는다.** 원천 W/O 행이 없으면 400 `INVALID`(`lot.source_id` 에 FK 가 없다).

흔적: `lot-complete.service.ts` `recordVarianceReason` 주석 ⌜미달 사유는 **W/O 가 담는다** — `trace.lot` 에 LOT 단위 칸이 아직 없다(계약 x-internal-note ⌜B-13 이 미충족이다⌝ · 문의 043)⌝ · e2e `완료 — 미달이면 W/O 의 \`completionVarianceReasonCode\` 가 함께 찍힌다(한 트랜잭션)` · `이벤트 — 완료는 \`lot-lifecycle-events\` 에 아무 행도 더하지 않는다`.
