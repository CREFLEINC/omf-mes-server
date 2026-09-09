# 194. `shipment_lot_allocation` 이 **부분 포장을 담지 못해** `packedQty` 가 **0 또는 배정 전량** 둘뿐이다

**구분: 통보**(회신을 기다리지 않는다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `GET /logistics/shipment-lot-allocations`(`packedQty`·`unpackedOnly`) · `PUT /logistics/shipment-lot-allocations/{id}` |
| 구현 상태 | **구현 예정(I-22 PR ⑦a·⑦b)** |
| 판정 | §2 **0단계**(물리가 답을 준다 — HU 가 한 개 nullable FK) · 2단계 기준 3(스키마를 안 늘린다) |
| 되돌릴 때 | 중간 배분표를 신설하면 마이그 한 표 + 조회·PUT 두 자리 |

## 계약이 말하는 것

> `packedQty` — 「이미 포장에 담긴 수량. **배분 잔여 = `allocatedQty − packedQty`** 를 서버가 파생한다(L-2)」
> `unpackedOnly` — 「아직 포장에 담기지 않은 것만 — **배분 잔여가 남은 것**」

두 문장 다 **중간값**(0 < packedQty < allocatedQty)을 전제합니다.

## ⛔ 물리는 중간값을 담지 못합니다

```
logistics.shipment_lot_allocation
    handling_unit_id   bigint  REFERENCES inventory.handling_unit(handling_unit_id)   ← «한 개» · nullable
```

한 배분이 가리키는 포장이 **하나뿐**이라 「이 배분의 300 중 120 만 카톤 A 에 담겼다」를 적을 자리가 없습니다.

⚠ `inventory.handling_unit_content.qty` 로 세는 길도 막혀 있습니다 — 그 표의 유일 제약이 `uq (handling_unit_id, item_id, lot_id)` 라 **같은 (품목·LOT)의 배분 둘이 한 포장에 들어가면 수량이 합쳐져** 어느 배분 몫인지 못 가릅니다.

## ⇒ 우리가 정한 것

```
packedQty     = handling_unit_id IS NULL ? 0 : allocated_qty
unpackedOnly  = handling_unit_id IS NULL
```

⭐ **`P-04-01` §3-3 과 일관합니다** — 그 화면이 「포장 N = **서로 다른 비어있지 않은 `handlingUnitId` 수**」로 세고 있어, 이미 「배분 단위 전량 포장」을 전제하고 있습니다.

## 📨 알려 드리는 것

**부분 포장이 실제 업무에 있습니까?**
- 있다면 → 배분 하나를 포장 여럿에 나누는 **중간표**(`shipment_lot_allocation_packing`)가 필요합니다.
- 없다면 → 계약 `packedQty`·`unpackedOnly` 의 설명에서 「배분 잔여」라는 표현을 **「포장 여부」**로 바꿔 주십시오. 지금 문장은 화면이 0/전량 두 값만 받을 것을 예상하지 못하게 합니다.

## 흔적

`docs/coverage-100/slices/I-22.md` §5-3 · §1-4-1 · 부록 **#14** · `P-04-01` §3-3·§4-C(설계 사본) ·
baseline `migration.sql`(`shipment_lot_allocation`·`handling_unit_content` DDL) · `prisma/schema.prisma:1311-1329`·`:459-473`.
