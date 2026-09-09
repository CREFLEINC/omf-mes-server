# 203. ⛔ **「판정 순서는 뒤가 이긴다」가 `shipmentProgressCode` 의 `NOT_ALLOCATED` 를 «도달 불가»로 만든다**

**구분: 통보**(회신을 기다리지 않는다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-requests`(+`/{id}`·`summary` 필터) — `ShipmentRequest.shipmentProgressCode` |
| 구현 상태 | **구현 예정(I-22 PR ③)** — **`A = 0` 을 맨 먼저 잘라** `NOT_ALLOCATED` 를 낸다 |
| 판정 | §2 **1단계 본길** → **2단계 기준 4**(값을 «조용히» 도출하지 않는다) · 기준 2 |
| 되돌릴 때 | 판정 함수의 첫 줄. 계약 문자 그대로 두면 `NOT_ALLOCATED` 가 영영 0건입니다 |

## 계약 문장

> `NOT_ALLOCATED`=배정 합 0 · `PARTIALLY_ALLOCATED`=0 보다 크고 요청 합보다 작은 배정 합 · `PICKING`=배정 합이 요청 합과 같고 피킹 합이 배정 합보다 작다 · **`PICKED`=피킹 합이 배정 합과 같고 출하 합 0** · `PARTIALLY_SHIPPED`=출하 합이 0 보다 크고 배정 합보다 작다 · **`SHIPPED`=출하 합이 배정 합과 같다.**
> ⭐ **판정 순서는 뒤가 이긴다** — NOT_ALLOCATED, PARTIALLY_ALLOCATED, PICKING, PICKED, PARTIALLY_SHIPPED, SHIPPED.

## ⛔ 배정 합이 0 이면 뒤의 둘이 «공허참»입니다

**A = 0**(그리고 P = 0 · S = 0)일 때:

| 값 | 식 | 참? |
|---|---|:-:|
| `NOT_ALLOCATED` | `A = 0` | ✓ |
| `PARTIALLY_ALLOCATED` | `0 < A < R` | ✕ |
| `PICKING` | `A = R ∧ P < A` | ✕ |
| **`PICKED`** | `P = A ∧ S = 0` → `0 = 0 ∧ 0 = 0` | **✓ 공허참** |
| `PARTIALLY_SHIPPED` | `0 < S < A` | ✕ |
| **`SHIPPED`** | `S = A` → `0 = 0` | **✓ 공허참** |

「뒤가 이긴다」이므로 답은 **`SHIPPED`** 입니다.
⇒ **`NOT_ALLOCATED` 는 어떤 데이터로도 나오지 않는 죽은 값**이고, `W-04-02` §3 「상태」 드롭다운에서 그 값을 고르면 **영영 빈 목록**입니다.

## ⇒ 우리가 정한 것

```
if (A == 0)              → NOT_ALLOCATED       ⭐ 「뒤가 이긴다」에서 벗어나는 «유일한» 예외
if (S == A && A > 0)     → SHIPPED
if (0 < S && S < A)      → PARTIALLY_SHIPPED
if (P == A && S == 0)    → PICKED
if (A == R && P < A)     → PICKING
                         → PARTIALLY_ALLOCATED
```

⛔ 나머지 다섯은 **계약 순서를 그대로** 따릅니다. 예외는 `A = 0` 하나뿐이고, 그 자리를 이 통보로 남깁니다.

## 📨 알려 드리는 것

**「뒤가 이긴다」에 「단 배정 합이 0 이면 `NOT_ALLOCATED` 다」를 덧붙여 주시거나, `PICKED`·`SHIPPED` 의 식에 `A > 0` 을 넣어 주십시오.**
지금 문장대로 구현하면 화면의 상태 드롭다운 6값 중 하나가 죽습니다.

⚠ 참고 — 같은 축에 **또 하나의 함정**이 있어 별건으로 알려 드립니다(**통보 205** — 부분 배정 건이 「피킹중」 배지를 못 답니다).

## 흔적

`docs/coverage-100/slices/I-22.md` §5-1 · §8-2 **L-14~L-23** · §8-6 · §9-1 #2 · §0-재수립 **R-7·R-11** ·
`contracts/shipment-04제품출하.json`(`shipmentProgressCode.description` python) · `W-04-02` §3·§4-A·§5-3(설계 사본).
