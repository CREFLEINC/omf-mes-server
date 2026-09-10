# 212. 예약 되돌림은 **`consumed` 를 내리고 `released` 를 올린다** — 막는 것은 CHECK 가 아니라 «순서»였다

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **[[241]] 의 「📨 알려 드리는 것」 ⓵·⓶ 에 대한 답이다** — 그 문서가 I-23 착수 전 답을 원했는데, 통보는 회신을 기다리지 않고 전달도 루틴 끝 일괄이라 **답이 올 수 없다.** README §2 대로 **우리가 정하고 통보한다.**

| 칸 | 내용 |
|---|---|
| 걸리는 자리 | `inventory.inventory_reservation.released_qty`·`consumed_qty` · `ShipmentRequestLine.pickedQty` 롤업 · `shipmentProgressCode` |
| 구현 상태 | ⛔ **아직 안 했다** — I-23(#410) 이 구현한다. 이 문서는 그 슬라이스의 **첫 판정**을 미리 못 박는 것이다 |
| 판정 | §2 **1단계 본길**(취소마다 걸린다) → **1-1단계 통보**(아래) → **2단계 기준 3·5** |
| 마이그레이션 | ⛔ **0** — 칸도 제약도 그대로 둔다 |
| 되돌릴 때 | 코어 함수 하나(≈10줄)와 그 호출 한 줄. 마이그가 없어 **한 커밋으로 되돌아간다** |

## ⭐ 먼저 — **선행 두 문서의 사실 하나가 틀렸다**

[[241]] 과 A→A2 배정 안내문이 둘 다 이렇게 적었다:

> ⛔ 게다가 올릴 수도 없다. `ck_reservation_qty (released_qty + consumed_qty <= reserved_qty)` 아래에서,
> ⓒ안대로 피킹 즉시 `consumed = reserved` 가 되므로 그 뒤에는 `released_qty` 를 0보다 크게 만들 여지가 없다.

**절반만 맞다.** 제약은 **합**에 걸려 있고, 취소는 `consumed` 를 «먼저» 내리므로 그 뒤 `released` 를 올리는 것은 제약을 안 건드린다.

**실측**(A2 레인 DB · 한 트랜잭션 안에서 SAVEPOINT 로 갈라 재고 전부 ROLLBACK):

| 단계 | 상태 (reserved / released / consumed) | 결과 |
|:-:|---|---|
| ① 피킹 뒤 | 10 / 0 / **10** | — |
| ② 그 상태에서 `released = 10` | 10 / 10 / 10 → 합 20 > 10 | ⛔ **`ck_reservation_qty` 위반**(241 의 주장은 «이 상태»에서만 참) |
| ③ 취소 — `consumed = 0` | 10 / 0 / **0** | ✅ 통과 |
| ④ 그 다음 `released = 10` | 10 / **10** / 0 → 합 10 ≤ 10 | ✅ **통과** |

⇒ **롤업 `P = reserved − released` 가 10 → 0 으로 실제로 떨어진다.**
⇒ 제약이 금하는 것은 「`released_qty` 를 쓰는 것」이 아니라 **「`consumed` 를 안 내린 채 올리는 것」**이다.
⛔ **그래서 마이그레이션이 필요 없다.** 「CHECK 를 고쳐야 한다」는 결론은 서지 않는다.

## ⇒ 우리가 정한 것

> **출하 취소·되돌림은 예약 행에서 ⓐ `consumed_qty` 를 내리고 ⓑ 같은 트랜잭션에서 `released_qty` 를 그만큼 올린다. 순서는 ⓐ→ⓑ 다.**

- `reserved_qty` 는 **안 건드린다** — 「원래 얼마를 잡았는가」가 남아야 `Σ(reserved − released)` 가 뜻을 갖는다([[241]] 이 정본으로 둔 식).
- ⓐ 는 **오늘 코어에 이미 있다** — `pickBalances()`/`consumeReservation()` 의 Δ<0 갈래(`reservation-qty.ts:192-194`). I-22 **R-2** 가 「I-23 이 `releaseBalances()` 를 새로 안 만들어도 된다」고 정한 그 경로다.
- ⓑ 만 **없다** ⇒ `reservation-qty.ts` 에 `consumeReservation()` 의 **형제**로 `releaseReservation()`(≈10줄)을 더한다.
  ⛔ **I-23 의 자기 서비스에서 직접 `UPDATE` 하지 않는다** — 그 파일 머리 주석이 「잠근 행을 UPDATE 한다 — **두 곳에서 잠그면 순서가 갈려 교착 창이 열린다**」라 못 박았다.
  ⭐ 코어라 **단독 커밋**으로 낸다(CLAUDE.md 「코어는 전용 PR ≤200」).

### 판정 근거 — README §2

| 단계 | 판정 |
|---|---|
| **0단계 선례** | `consumeReservation()` 이 **그대로 형제**다 — `SET consumed_qty = consumed_qty + Δ` 한 문장. 새 모양을 지어내지 않는다 |
| **1단계** | **본길** — 취소마다 걸린다 |
| **1-1단계** | ⭐ **통보**다. 「MES 본질」은 걸린다(되돌림 추적성). 그러나 **「바꾸는 비용」이 안 걸린다** — 마이그 0 · 계약 변경 0 · 기존 호출부 0 · 한 커밋으로 되돌아간다. **둘 다**여야 질의인데 하나뿐이다 |
| **2단계 기준 3** | 스키마를 안 늘리는 쪽 — `released_qty` 는 **baseline 부터 있던 칸**이고 제약도 그대로다 |
| **2단계 기준 5** | 새 개념을 안 만드는 쪽 — 대안(`reserved_qty` 를 내린다)은 「원래 잡은 양」을 지워 **[[241]] 이 정본으로 둔 식의 의미를 없앤다**. 그쪽이 새 개념이다 |

## 📨 알려 드리는 것

**⓵ [[241]] 의 물음 둘에 대한 우리 답이 위다.** 설계가 다르게 정하면 되돌리는 비용은 **코어 함수 하나 + 호출 한 줄**이다.

**⓶ ⛔ 그런데 이것으로 「되돌림이 롤업에 비친다」가 «전부» 서는 것은 아니다.**
`released_qty` 를 올려도 **`inventory_balance` 쪽은 별개**다 — 취소가 잔액의 `picked_qty`·`reserved_qty` 를
어떻게 되돌리는지는 I-23 계획이 §2 절차로 따로 판정한다. 이 통보는 **예약 행 한 표**에 대한 것이다.

**⓷ [[240]] 과 같은 뿌리다** — 예약 롤업이 다른 표라 제약이 안 걸린다.

## 흔적

- 실측: `ck_reservation_qty` 정의(`pg_constraint`) · 위 4단계 전이(A2 레인 DB · 전부 ROLLBACK · 잔여 행 0 확인)
- `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1229-1231`
- `src/core/inventory-posting/reservation-qty.ts:188`·`:192-194`
- `src/logistics/shipment-request/shipment-progress.ts:44-47`
- `docs/coverage-100/slices/I-22.md` §0-재수립 R-2 · R-14 · §5-1 · §11 ① — ⛔ **레인 A 문서라 고치지 않는다.** 위 「틀린 사실 하나」를 그쪽에 반영할지는 A 가 정한다
- ⚠ 이 판정은 **I-23 계획서 §0 이 3관점 재수립에 실어 다시 검증한다.** 뒤집히면 이 문서에 정정을 덧붙인다

## ⛔ 정정 (2026-09-10 · I-23 PR ⑦ 착수 중) — «끝 상태»는 맞고 «기제» ⓐ 가 틀렸다

위 「ⓐ 는 오늘 코어에 이미 있다 — `pickBalances()`/`consumeReservation()` 의 Δ<0 갈래」는 **피킹을 되돌리는 경우(출하 전)** 에만 성립한다.

- 그 갈래는 잔액의 `picked_qty ≥ q` 를 요구한다(`pickBalances` 의 하한).
- **출하가 나간 뒤에는** 출고가 `consumeBalances()` 로 잔액의 `picked_qty` 를 이미 소진했고, 그 함수는 **예약을 안 건드린다**.
- ⇒ 출하 취소 시점의 예약은 `reserved N / released 0 / consumed N`, 잔액의 `picked` 는 0 이다. `pickBalances(Δ<0)` 는 400 이고, `released` 만 올리던 초판 `releaseReservation()` 의 하한 `reserved − released − consumed ≥ q` 는 `0 ≥ N` 이라 **언제나 400** 이었다.

**고친 것** — `releaseReservation()` 이 **한 문장에서 `consumed −q` · `released +q`** 를 함께 쓴다(합 불변 ⇒ `ck_reservation_qty` 를 안 건드린다 · 하한은 `consumed ≥ q`). 잔액은 안 건드린다 — 되돌릴 잔액은 원장 역전기가 `on_hand` 로 돌려준다.

**바뀌지 않은 것** — 끝 상태(`consumed 0 · released N` → `P = Σ(reserved − released)` 가 0) · 마이그 0 · 계약 변경 0 · 구분(통보). 「순서 ⓐ→ⓑ」는 **한 문장 안의 두 칸**이 되어 순서 문제 자체가 사라졌다.
