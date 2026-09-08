# 075 — `LotQualityStatus` 의 창고·위치·`uomId` 가 LOT 하나에 여럿일 수 있다 — 어느 것을 내나

| 칸 | 내용 |
|---|---|
| **구분** | **통보** — MES 본질 아님(표시 파생값) × 비용 낮음(스키마 변경 없음 · 서버 계산 로직만) ⇒ 정하고 통보 |
| 걸리는 오퍼레이션 | `GET /quality/lot-statuses`(I-20 PR ①a1 · 이미 구현) — 참고: `GET /quality/lot-holds`·`…/{lotHoldId}`(PR ②a) 의 `uomId` 는 **이 문제가 없다**(아래 「LotHold 는 왜 안 걸리나」) |
| 구현 상태 | 구현함(①a1 · `src/quality/lot-status/lot-status-query.ts` `FROM` 절 — 「값이 하나일 때만 싣는다」) |
| 판정 | `docs/coverage-100/README.md` §2 2단계 기준 4(값을 조용히 도출하지 않는 쪽) |
| 되돌릴 때 | 「대표 창고 규칙」(예: 최신 입고분 우선·주 보관 위치 지정)이 정해지면 `CASE WHEN count(DISTINCT …) = 1` 을 그 규칙으로 바꾼다 |

## 무엇을 봤나

계약 `LotQualityStatus` 는 `warehouseId`·`locationId`·`onHandQty`·`heldQty`·`availableQty`·`uomId` 를 요구하지만, LOT 은 **여러 창고·위치에 잔액 행을 가질 수 있다**(`inventory.inventory_balance` 가 LOT 당 N행). 계약은 이 자리에 «어느 창고를 대표로 낼지» 설명을 0자 적었다.

⭐ **`uomId` 도 같은 함정이다(R-11)** — `inventory_balance.uom_id` 는 `uq_inventory_balance_dim` 유니크 제약의 **밖**이라 창고·위치처럼 잔액 행마다 다를 수 있고, `lot_hold.uom_id`(보류가 걸린 단위)와도 다를 수 있다. 계약은 이 셋(`warehouseId`·`locationId`·`uomId`)에 설명을 하나도 안 달아 두었다.

## 무엇을 했나

「값이 하나일 때만 싣는다」로 정했다 — `count(DISTINCT …) = 1` 이면 `min(…)` 을 내고, 아니면 **키를 생략**한다(0 이 아니라 「모른다」 — 공유계약 L-8). `heldQty`·`availableQty` 는 애초에 `inventory_balance` 가 아니라 `lot_hold` 가 정본이라 이 함정과 무관하다(계약이 `:4299`·`:1845` 에서 직접 못 박았다).

집계 칸(`on_hand_qty`)은 반대로 **접지 않고 합산**한다 — 창고가 여럿이어도 총 보유량은 하나의 사실이기 때문이다. 창고·위치·`uomId` 만 「하나일 때만」 규칙을 쓴다.

## `LotHold` 는 왜 안 걸리나

`LotHold.uomId` 는 `lot_hold.uom_id` — **보류 행 자신의** 단위 칸(있으면 `holdQty` 와 짝 · `ck_lot_hold_qty_uom`)이라 잔액 접기와 무관한, LOT 당 여럿일 수 없는 값이다. `LotHold` 스키마에는 애초에 `warehouseId`·`locationId` 자체가 없다(16 프로퍼티 실측). 제목에 「LotHold」를 함께 적은 것은 대조를 남기기 위해서다 — ②a 를 구현하며 이 자리가 안 걸린다는 것을 확인했다.
