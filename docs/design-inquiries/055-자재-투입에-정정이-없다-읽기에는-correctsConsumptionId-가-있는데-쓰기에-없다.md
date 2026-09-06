# 55. 자재 투입에 정정(`:correct`)이 없다 — 읽기 스키마에는 `correctsConsumptionId` 가 있는데 쓰기에 없다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /production/material-consumptions` |
| 구현 상태 | **구현함(I-10 · `corrects_consumption_id` 영원히 NULL · `replacedConsumptionId` 만 받는다 · 삭제·취소 경로 0건)** |
| 판정 | `coverage-100/README.md` §2 1단계 **본길**(스캔 오류를 되돌리는 길이다) → 그러나 **오퍼레이션이 없으므로 만들 수 없다**(계약 침묵) → 2단계 기준 5(새 오퍼레이션·새 개념 0) |
| 되돌릴 때 | `POST …/{materialConsumptionId}:correct` 가 계약에 서면 **마이그 0**(칸은 이미 실재한다) — `corrects_consumption_id` 를 채우는 서비스 한 자리 + 「이미 정정된 원본」 판정(I-7 R-21 선례를 그대로 쓸 수 있다) |

## 무엇이 문제인가

ⓐ 실적에는 `POST …/{productionResultId}:correct` 가 있고 투입에는 **0건**이다. 같은 도메인 안에서 정정 축이 한쪽에만 있다.
ⓑ 계약 `MaterialConsumption.statusCode.x-no-code-key` 가 ⌜정정은 상태를 바꾸는 것이 아니라 **«새 행»으로 남긴다**(`corrects…Id` 가 원본을 가리킨다)⌝ 라 적어 **정정 행의 존재를 전제**하는데, 그 행을 만들 오퍼레이션이 없다. 읽기 스키마만 그 칸을 갖는다.
ⓒ 화면 `P-02-03` §8 미결 9 가 ⌜투입 정정 경로가 계약에 없다⌝ 로 열려 있고, `P-02-11` §5-2 는 `corrects`(⌜잘못 기록한 것을 고친다 — 원래 투입이 없었던 셈⌝)와 `replaced`(⌜실제로 교체했다 — 이전 투입도 실재했다⌝)가 **둘이 다르다**를 못박았다 ⇒ 러닝체인지로 대신할 수 없다.
ⓓ ⇒ **스캔 오류를 되돌릴 길이 0** 이다 — `material_consumption` 에 삭제·취소 오퍼레이션도 0건이라 잘못 스캔한 LOT 이 영구 기록으로 남는다.
ⓔ 물증 하나 더 — `W-CO-06` §4-B 에 **`can_cancel_input`(투입 취소) 단말 플래그가 물리에 실재하는데** 그 플래그를 소비할 오퍼레이션도 화면도 **0건**이다. 「투입을 되돌린다」를 누군가 이미 상정했다는 뜻이다.
ⓕ `plan.md` 212행 · `plan-uiux.md` 590·1178행(E)이 이미 이 자리를 요청서 후보로 세워 두었다.

## 지금 서버는

- `corrects_consumption_id` 를 **넣지 않는다** — 뷰가 `correctsConsumptionId` 를 내지만(`material-consumption-view.ts:29`) 값이 언제나 NULL 이라 키가 생략된다. `actual_consumed_qty`·`received_at` 과 함께 **영원히 비는 칸 셋**의 하나다.
- `replacedConsumptionId` 는 받는다 — 존재하지 않으면 400 `INVALID`, 그 투입의 `work_order_id` 가 본문과 다르면 400 `INVALID`(`assertBelongs`). 「이미 다른 투입이 교체한 것인가」는 **안 본다**(체인을 막는 계약 문장이 0).
- 삭제·취소 오퍼레이션을 **만들지 않았다**(계약에 0건 · 새 오퍼레이션을 지어내지 않는다).

흔적: `docs/coverage-100/slices/I-10.md` §3-14 · §8-1 #14 · §8-3 ⓜ · `material-consumption-view.ts:29-30` · `material-consumption.service.ts:109·222`.
