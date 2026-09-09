# 241. `released_qty` 를 **쓰는 코드가 0개**라, 예약을 되돌려도 피킹 롤업이 안 줄어든다

**구분: 통보**(회신을 기다리지 않는다 — 식은 계약·설계 정본대로 두고, 되돌림 경로는 I-23 이 진다)

| 칸 | 내용 |
|---|---|
| 걸리는 자리 | `inventory.inventory_reservation.released_qty` · `ShipmentRequestLine.pickedQty` 롤업 · `shipmentProgressCode` |
| 드러난 곳 | I-22 PR ③a 리뷰 — 근거 주석이 「I-23 이 취소해 예약을 «푼» 뒤」를 가리키는데 **그 경로가 아직 없다** |
| 우리 처리 | ⭐ **식은 `Σ(reserved − released)` 그대로 둔다**(§5-1 정본). 주석만 사실에 맞게 고쳤다 |

## 무엇이 문제인가

`ShipmentRequestLine.pickedQty` 는 담을 칸이 없어 **예약 롤업으로 낸다** — `P = Σ(reserved_qty − released_qty)`(I-22 §1-4-1 · R-3 · R-14). `released_qty` 를 빼는 이유는 「되돌린 예약이 피킹 수량으로 계속 잡히면 안 되기 때문」이다.

**그런데 `released_qty` 를 «쓰는» 코드가 저장소에 하나도 없다.** 전수 grep(`src/**/*.ts`, spec 제외) 결과 **다섯 자리 전부 읽기**다:

| 자리 | 무엇 |
|---|---|
| `core/inventory-posting/reservation-qty.ts:188` | 가드 술어 `reserved_qty - released_qty - consumed_qty >= Δ` |
| `inventory/balance/inventory-reservation.service.ts:33` | 타입 선언 |
| 〃 `:57` | `SELECT` 목록 |
| 〃 `:86` | 가드 술어 `… > 0` |
| 〃 `:104` | 뷰 사상 |

⇒ `UPDATE … SET released_qty = …` 도, Prisma `create`/`update` 의 `released_qty:` 도 **0건**이다.

그리고 되돌림 경로로 정해 둔 것(I-22 §0-재수립 **R-2** — 「I-23 이 `releaseBalances()` 를 새로 안 만들어도 된다, `pick()` 의 Δ<0 갈래가 이미 있다」)도 **`released_qty` 를 안 건드린다** — `consumeReservation()` 은 `SET consumed_qty = consumed_qty + Δ` 뿐이다(`reservation-qty.ts:192-194`).

⛔ **게다가 올릴 수도 없다.** `ck_reservation_qty (released_qty + consumed_qty <= reserved_qty)` 아래에서, ⓒ안대로 **피킹 즉시 `consumed = reserved`** 가 되므로 그 뒤에는 `released_qty` 를 **0보다 크게 만들 여지가 없다.**

**결과**: 출하를 취소해도 예약 행은 `reserved = Q · released = 0` 이라 **`P = Q` 로 그대로 남는다.** R-14 가 넣게 한 뺄셈이 오늘 경로에서는 **아무것도 안 막는다.**

## ⇒ 우리가 한 것

**식을 안 바꾼다.** `Σ(reserved − released)` 는 §5-1 정본이고, 저장소의 다른 두 선례처럼 `− consumed` 까지 빼면 **ⓒ안에서 피킹 직후 `P = 0`** 이 되어 훨씬 더 틀린다(피킹은 `consumed = reserved` 로 끝난다).

주석만 사실에 맞게 고쳤다 — 「⚠ I-23 이 취소 시 `released_qty` 를 올려야 이 뺄셈이 산다」.

## 📨 알려 드리는 것

**⓵ 출하 취소·되돌림이 예약 행의 어느 칸을 움직여야 하는지 정해 주십시오.** 오늘 코어에는 `consumed_qty` 를 내리는 길밖에 없고, 그렇게 하면 「집었다가 되돌린 이력」이 사라집니다. `released_qty` 를 쓰려면 **`ck_reservation_qty` 와 «어떤 순서로»** 움직일지도 함께 정해야 합니다(소진된 예약은 그 CHECK 때문에 `released_qty` 를 못 올립니다).

**⓶ `released_qty` 를 앞으로도 안 쓸 계획이라면 알려 주십시오.** 그러면 세 곳의 가드 술어(`reserved − released − consumed`)와 이 롤업의 뺄셈이 **영구히 무연산**이고, 읽는 사람이 「되돌림이 반영된다」고 잘못 읽습니다.

⚠ 이 사안은 **I-23(출하 처리·확정·취소)이 실제로 부딪히는 자리**입니다 — 그 슬라이스 착수 전에 답이 있으면 좋겠습니다.

## 흔적

`docs/coverage-100/slices/I-22.md` §0-재수립 R-2 · R-14 · §1-4-1 · §5-1 · §11 ① ·
`src/logistics/shipment-request/shipment-progress.ts`(`pickedQtyOf`) ·
`src/core/inventory-posting/reservation-qty.ts:188`·`:192-194` · `src/inventory/balance/inventory-reservation.service.ts:33,57,86,104` ·
`prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1219-1231`(`ck_reservation_qty`) ·
[[240]] 과 같은 뿌리(예약 롤업이 다른 표라 제약이 안 걸린다).
