# 208. 피킹을 되돌릴 때 **`released_qty` 를 어디에 반영할지** 계약이 안 정했다 — 서버는 `Σ(reserved − released)` 로 낸다

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **통보 192(예약 롤업)의 형제입니다**

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-requests`(+`/{id}`·`summary`) — `ShipmentRequestLine.pickedQty` · `ShipmentRequest.shipmentProgressCode` |
| 구현 상태 | **구현 예정(I-22 PR ③·④)** — 롤업식에 `released_qty` 를 뺀다 |
| 판정 | §2 **1단계 본길** → 계약 침묵 ⇒ **2단계 기준 4**(조용히 도출하지 않는다 — 뺀다는 사실을 남긴다) |
| 되돌릴 때 | 롤업식 한 줄. ⚠ 안 빼면 취소된 피킹이 영구히 남습니다 |

## 무엇이 비어 있나

`ShipmentRequestLine.pickedQty` 는 「**누적** 피킹 수량. ⭐ 서버가 유지한다 … **배정 잔여 = `allocatedQty − pickedQty`**」입니다.
저희는 그 값을 **예약 행에서 롤업**합니다(문의 192).

그런데 `inventory.inventory_reservation` 에는 **`released_qty`** 칸이 있고 `ck_reservation_qty (released_qty + consumed_qty ≤ reserved_qty)` 가 그 축을 이미 갖고 있습니다.
**출하 취소(I-23)가 그 칸을 올릴 것**인데, **「그때 `pickedQty` 에서 빼라」는 문장이 계약에도 화면 명세에도 없습니다.**

## ⛔ 안 빼면 두 값이 함께 틀립니다

1. `pickedQty` 가 과대 ⇒ **배정 잔여가 실제보다 작게** 보이고 다시 집을 수 없습니다.
2. `shipmentProgressCode` 의 `P`(피킹 합)가 과대 ⇒ **`P = A` 가 참이 되어 `PICKED` 로 잘못 오릅니다.** 취소된 출하가 「피킹 완료」로 보입니다.

## ⇒ 우리가 정한 것

```
pickedQty (라인)  = Σ(reservation.reserved_qty − reservation.released_qty)
P (진행 판정)      = 같은 식의 작업지시 합
```

- ⛔ `consumed_qty` 는 **빼지 않습니다** — 「집었다」는 사실은 소진돼도 남습니다(출하된 수량은 `shippedQty` 축이 따로 셉니다).
- I-22 안에는 예약을 «푸는» 경로가 0건이라 오늘은 `released_qty` 가 언제나 0입니다. ⇒ **단위 spec 에서 `released_qty > 0` 픽스처로 못 박습니다**(e2e 로는 반증할 수 없습니다).

## 📨 알려 드리는 것

**`ShipmentRequestLine.pickedQty` 의 설명에 「해제된 예약분은 빼고 센다」를 적어 주십시오.**
그리고 **출하 취소가 예약을 「해제(`released_qty`)」로 처리하는지 「소진 되돌림(`consumed_qty` 감소)」으로 처리하는지** 정해 주시면 I-23 이 그대로 따르겠습니다 — 두 길이 `pickedQty` 에 반대로 작용합니다.

## 흔적

`docs/coverage-100/slices/I-22.md` §1-4-1 · §5-1 · §8-6 · §11 ① · §0-재수립 **R-14** ·
baseline `migration.sql`(`inventory_reservation` · `ck_reservation_qty`) · `src/core/inventory-posting/reservation-qty.ts` ·
`contracts/shipment-04제품출하.json`(`pickedQty` description) · **통보 192**(형제).
