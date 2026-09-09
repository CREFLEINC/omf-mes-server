# I-22 3관점 재수립 — **통합 관점** 독립 리뷰

> 대상: `docs/coverage-100/slices/I-22.md`(1,050줄 · PR #458) · 브랜치 `docs/coverage-100-a-i22-plan`
> 실측일 **2026-09-09** · `main` **752751b**(origin) / 브랜치 base **03b6650** · 계약 `contracts/COMMIT.txt` = **a6a87e1**
> 관점의 몫: 물리 모델·마이그레이션·트랜잭션 경계·**예약/원장 코어**·슬라이스와 레인의 선후·공용 파일 충돌·멱등/잠금·성능
> ⛔ 코드 0줄 · 마이그 0 · PR 코멘트 0 · 통보문 0(후보 목록만) · `contracts/*.json` 읽기 전용 · DB 는 읽지 않았다(물리는 `prisma/migrations/**` 68 전건 + `schema.prisma` 정적 실측)

---

## 0. 판정 요약

| | 수 |
|---|--:|
| **채택** | **7** (⓵ 전제 · ⓶ 측정 · ⓹ 절반 · A13 마이그 · PR 7분할의 산술 · 잠금 순서 무해 판정 · 코어 신설 필요성) |
| **반증** | **4** (⭐⭐ **⓺ 예약 ⓐ안** · ⓶ 의 「가리킬 칸 0개 ⇒ 통보」 근거 · ⓹ 의 「01 과 정반대」 절반 · **PR ⑦ 예산**) |
| **유지** | **4** (⓷ 409 · ⓸ 검사 축 · ⓻ 6값 · 마이그 A13 결론) |

**findings**: Blocker **1** · Major **6** · Minor **9** · Nit **4**

> ⭐ **한 줄 결론** — 물리·마이그·잠금·모듈 배선은 거의 다 맞다. **그러나 이 슬라이스의 심장인 §2 ⓺(예약 ⓐ안)이 틀렸다.**
> 계획자가 인용한 계약 문장이 **잘렸다** — 04 `:pick` description 은 「예약을 **건다**」가 아니라 「예약을 **걸고 푼다**」이고,
> 같은 규약을 가리키는 계약 문장이 **하나 더**(`GET /inventory/reservations` description 「서버가 걸고 푼다」),
> 설계 화면이 **둘 더**(`M-01-08` §5-5 「피킹하면 `picked_qty` 로 옮겨 간다」 · `M-04-01` §5-7 「되돌리기를 두지 않는다 — **예약이 소진된다**」) 있다.
> ⓐ 를 반대하는 근거는 계획서가 적은 「`M-04-01` §4-A 한 줄」이 아니라 **계약 2문장 + 화면 2문장 = 넷**이고,
> ⓐ 를 지지하는 유일한 근거는 **우리 자신의 `plan-integration.md:395`** 한 줄뿐이다(브리프 §3 「계획서 문장을 근거로 쓰지 마라」에 정면으로 걸린다).

---

## ⭐ 1. 브리프 §2 의 일곱 — 개별 판정

### 1-1. ⓵ 「`:pick` 이 예약을 «건다» — `plan-api.md:548` 은 04 에서 거짓」 → ✅ **채택(전제)** · ⚠ **인용 정정**

**ⓐ 거는 함수가 정말 없는가 — 있다/없다 전문 재측정 결과: «없다»(채택).**

`src/core/inventory-posting/` 전 10파일(1,560줄)을 다 읽었다. 공개 메서드는 **넷뿐**이다:

| 메서드 | 줄 | `reserved_qty` 를 |
|---|---|---|
| `post()` | `inventory-posting.service.ts:48` | 안 건드린다 |
| `reverse()` | `:108` | 안 건드린다 |
| `pick()` → `pickBalances` | `:161` → `reservation-qty.ts:74` | **내린다**(`reserved_qty = reserved_qty - Δ`, `:88`) |
| `consume()` → `consumeBalances` | `:166` → `:129` | 안 건드린다(주석 `:127` 「예약은 건드리지 않는다」) |

`reserved_qty` 를 **올리는** 문장은 저장소 전체에 0개다. `inventory_reservation` 에 **INSERT** 하는 코드도 0개다
(`grep -rn "inventory_reservation\.\(create\|createMany\|upsert\)\|INSERT INTO inventory.inventory_reservation" src` → **0행**;
`UPDATE` 는 `reservation-qty.ts:115` 하나뿐). ⇒ **코어를 새로 만드는 판정은 옳다.**

**예고 셋도 전건 실재한다(채택).**

| 예고 | 실측 |
|---|---|
| `inventory-posting.service.ts:42-43` | ⭕ 「⛔ 예약을 «거는» 함수는 아직 없다 … **첫 사용처는 I-22 다**」 — 줄 번호까지 정확 |
| `plan.md:43`(I-8 행) | ⭕ 「`reserve()` 는 사용처 0 이라 **I-22** · I-8 §3-7」 |
| `plan-integration.md`(I-8 절) | ⭕ 「`reserve()` 는 예약을 걸 잔액 행을 정할 근거가 0 · 사용처 0 → 첫 사용처 **I-22**」 |
| `inventory-reservation.service.ts:41-42` | ⭕ 「⚠ **오늘 언제나 빈 목록이다** … 첫 사용처는 I-22」 — 계획서가 안 센 **넷째** 예고 |

⭐ **덤 — `plan.md` 는 자기 안에서 모순이다.** `plan.md:43`(I-8 행)이 「첫 사용처는 I-22」라 적어 두고
`plan.md:55`(I-22 행)의 「코어」 칸은 **`—`** 다. 계획안 §10-1 #2 의 「통합 계획서가 코어를 안 잡았다」는
그래서 «두 자리»를 고쳐야 한다 — 19행의 코어 칸 + `plan-integration.md` I-22 절의 「I-8 코어 재사용」.

**⚠ 그러나 인용이 잘렸다(§1-6 으로 이어진다).** 계획안 §0 #1·§6-2 표는 계약을 「서버가 이 피킹의 결과로
`inventory_reservation` 을 **건다**」로 인용했는데, **실제 문장은 「걸**고 푼다**」다**:

```
$ python3 -c "... c['paths']['…:pick']['post']['description']"
… ⭐ 화면이 예약을 직접 쓰지 않는다 — 서버가 이 피킹의 결과로 inventory_reservation 을 걸고 푼다
   (01 자재창고 계약 · M-01-08 §5-5 와 같은 규약). 자재 피킹의 :pick 과 대칭이다. …
```

「푸는 쪽만 한다」(`plan-api.md:548`)가 틀린 것은 맞다. 그러나 정정판은 **「거는 쪽만 한다」가 아니라 「걸고 푼다」**다.
`plan-api.md:548` 의 취소선(`~~걸고~~`)이 **원문이 「걸고 푸는」이었음을 그대로 보여 준다** — 편집이 한쪽으로 과했고,
계획안은 그것을 **반대쪽으로 다시 과하게** 되돌렸다.

### 1-2. ⓶ 「`pickedQty` 담을 칸이 물리에 0개 · 예약 롤업」 → ✅ **채택(측정·결론)** / ⛔ **반증(근거·통보 C)**

**전건 grep 재실측 — 계획자 값이 맞다.**

```
$ grep -rn "picked_qty" prisma/migrations/          # 7행, 파일 «하나»(baseline)
  :1109  inventory_balance.picked_qty
  :1113  available_qty GENERATED (on_hand − reserved − picked − blocked) STORED
  :1439  picking_line.picked_qty
  :1449  ck_picking_qty CHECK (picked_qty <= planned_qty)
  :2839 :2850  check_balance_qty() 트리거 두 갈래
  :3284  뷰
$ ls prisma/migrations | wc -l                       # 68 ✓
```
`logistics.shipment_request_line` 에 `picked_qty` **0개** ✓(`schema.prisma:1356-1382` 재확인).
칸을 안 세우고 롤업으로 내는 결론도 **채택**한다 — A13 한 칸이 유지된다.

**⛔ 그러나 「가리킬 칸이 «저장소 전체에» 없다 ⇒ 통보 후보 C」는 반증한다.**

| 실측 | 근거 |
|---|---|
| 04 계약의 `x-source-column` 은 **파일 전체에 이것 하나**다 | python 전수 — `/components/schemas/ShipmentRequestLine/properties/pickedQty` |
| 04 계약에 `x-source-table` 이 **0개**다 | 같은 전수 |
| `M-04-01` §4-A 가 그 앵커를 **명시한다** — 「피킹 수량 \| **`inventory_balance.picked_qty` 파생**」 | `.design-reference/…/M-04-01-제품LOT피킹스캔.md:75` |
| 그 칸은 **실재한다** | baseline `migration.sql:1109` · `schema.prisma:515` |
| `plan-api.md:25` 의 전수 인구조사 — 「`x-source-column` 을 단 프로퍼티 중 **물리에 없는 칸 = 0**」 | 이 판정이 참일 때만 인구조사가 맞다 |

⇒ 앵커는 **매달려 있지 않다.** 「라인 축에 그 칸이 없다」는 사실은 남지만, 통보문의 제목이
「가리킬 칸이 없다」가 아니라 **「앵커가 «잔액» 칸을 가리키는데 응답은 «라인» 립도다 — 서버가 라인 축으로 롤업한다」**여야 한다.
그리고 이 사실은 §1-6 과 한 몸이다: **ⓒ 안에서는 `inventory_balance.picked_qty` 가 실제로 움직여 앵커가 살고, ⓐ 안에서는 영영 0이라 앵커가 죽는다.**

**⭐ 그리고 롤업 식 자체에 결함이 하나 있다(Major M-3).** §0 #2·§5-1 이 `P = Σ reserved_qty` 라고만 적었다.
`inventory_reservation` 에는 `released_qty` 가 있고 **I-23 출하 취소가 그것을 올린다**(계획안 §11 스스로 그렇게 인계한다).
그러면 취소된 피킹이 `pickedQty` 에 영구히 남는다. 식은 **`Σ(reserved_qty − released_qty)`** 여야 한다.

### 1-3. ⓷ 「세 거부가 400 이 아니라 409」 → ⚠ **유지 · 결함 3**

계약 실측은 계획자 값 그대로다 — 409 description 「충돌 — LOT 이 Hold 이거나 가용이 모자라거나 배정을 넘는다」 ·
`x-internal-note` 「서버가 막는 것 셋 — ① `lot_hold` ② 가용 초과 ③ `allocatedQty − pickedQty` 초과」 ✓.
01 자재 피킹이 409 를 선언하지 않는다는 것도 계약 실측으로 참이다. **409 판정 자체는 유지**한다.
⛔ 그러나 §3-2 의 «순서표»에 통합 관점 결함이 셋 있다.

**ⓐ ④ 의 잠금이 `FOR UPDATE OF l` 인지 계획서가 안 적었다 — I-8 은 그 자리에 «이유까지» 적어 두었다.**

```ts
// src/logistics/picking/picking-pick.service.ts:69-77
// ① 라인만 잠근다(`OF l`) — 지시까지 잡으면 같은 지시의 두 라인이 서로를 막는다.
SELECT … FROM logistics.picking_line l JOIN logistics.picking_order o ON …
 WHERE l.picking_line_id = … AND l.picking_order_id = … FOR UPDATE OF l
```
04 는 헤더를 «반드시» 조인한다(⑫ 의 `allocated_qty` 는 라인이지만 404 대조가 `shipment_request_id` 이고
되읽기가 헤더 파생 축 셋을 얹는다). `OF l` 을 빼면 **같은 작업지시의 두 라인 피킹이 헤더 행에서 직렬화**되고,
현장이 한 작업지시의 여러 라인을 동시에 스캔하는 것이 `M-04-01` 의 정상 흐름이다.

**ⓑ ⑨(잔여 유효기간 미달)의 409 가 계획서 «자신의» 409 기준과 어긋난다.**
§0 #3 의 근거는 「`STATE_LOCKED` 계열은 재로드해도 안 풀리는데 이 셋은 **전부 재로드로 풀린다**」였다.
잔여 유효기간 미달은 **재로드로 절대 안 풀린다** — 시간이 갈수록 나빠진다. 계약 409 사유 셋에도 없고
`x-internal-note` 는 「잔여 유효기간 하한도 서버가 판정한다」라고만 적어 상태를 안 정했다.
⇒ 계획자 자신의 기준을 따르면 ⑨ 는 **400**이다. 어느 쪽이든 §3-4 순서표와 e2e P-23~P-26 이 바뀐다.

**ⓒ ⑩ 「0행 → 409」가 형제와 «조용히» 갈린다.**
`picking-pick.service.ts:130` 은 같은 자리에서 **400 `NEGATIVE_BALANCE`**(「이 위치에 그 LOT 의 재고가 없습니다」)를 낸다.
04 를 409 로 내는 것은 방어 가능하지만 §1-6 에러 코드 표에 **그 대비가 한 줄도 없다.**

### 1-4. ⓸ 「`shippingInspectionStatusCode` 라인 축 칸 0개」 → ✅ **유지**

계약 실측 확인 — 5값·롤업 우선순위 「REJECTED > HELD > PENDING > PASSED > NOT_REQUIRED」·「가장 나쁜 것이 이긴다」 ✓.
`inspection_request.target_type_code` enum 3값에 라인 축 없음 ✓. 「LOT 축 + 헤더 축 둘 다」 판정 유지.
`status_code = 'CONFIRMED'` 필터·최대 회차 판정도 옳다(`20260907174412`·`20260907193144` 로 `overall_judgment_code` 가 nullable 이 된 것 확인).
⇒ 통합 관점의 추가는 §2-4(두 벌 구현)에서 낸다.

### 1-5. ⓹ 「04 는 누적 · 01 은 대체 · `exclusiveMinimum` 이 없어 서비스가 «유일한» 그물」 → ⚠ **절반 채택 · 절반 반증**

**채택** — `ShipmentLinePick.pickedQty` 에 `exclusiveMinimum` 이 **없다**(python 덤프: `{'example': 180}` 뿐,
설명에만 「0 보다 커야 한다」). 누적/대체가 갈리는 것도 계약·구현 실측으로 참이다
(`picking-pick.service.ts:46` 「`picked_qty` 를 **대체**하고 그 차이만큼」 · `:89` `delta = pickedQty.minus(line.picked_qty)`).

**⛔ 반증 — 「I-21 R-15 와 정반대」는 사실이 아니다.** 01 은 계약 `exclusiveMinimum: 0` 이 «있는데도»
서비스에서 **다시 막는다**:

```ts
// picking-pick.service.ts:198-203
/** ④ 계약 `exclusiveMinimum: 0` + ⌜계획 수량 이하⌝ + … */
if (!pickedQty.greaterThan(0)) throw one(field('pickedQty', ERROR_CODE.RANGE, '0 보다 커야 합니다.'));
```
⇒ 04 가 예외인 게 아니라 **저장소 관행이 이미 「이중 그물」**이다. 04 의 손검사는 옳지만 그 근거는
「01 과 반대라서」가 아니라 「형제가 그렇게 하고, 04 는 가드가 없어 더 그래야 해서」다. §3-4 순 3 의 문구가 바뀐다.

### 1-6. ⭐⭐ ⓺ 「ⓐ — `reserved_qty` 만 올리고 열린 예약을 남긴다(picked 는 안 움직인다)」 → ⛔ **반증. ⓒ 가 맞다.**

계획안은 반대 근거를 **「`M-04-01` §4-A 한 줄」**이라 적었다. **실측으로 넷이다.**

| # | 근거 | 원문 | 가리키는 안 |
|:-:|---|---|---|
| **1** | 04 계약 `:pick` description | 「서버가 이 피킹의 결과로 `inventory_reservation` 을 **걸고 푼다**」 | **ⓒ** |
| **2** | **01 계약** `GET /inventory/reservations` description | 「조회만 제공한다 — 예약은 출고 요청과 피킹의 결과로 **서버가 걸고 푼다**. 근거: **M-01-08 §5-5**」 | **ⓒ** |
| **3** | `M-01-08` §5-5 — **04 계약이 「같은 규약」이라 이름을 대며 가리킨 바로 그 절** | 「출고요청 생성 시 예약이 걸리고, **피킹하면 `picked_qty`로 옮겨 간다.**」 | **ⓒ** |
| **4** | `M-04-01` §5-7 액션 표 | 「확정 후 되돌리기 \| ⛔ **두지 않는다 — 예약이 소진된다.**」 | **ⓒ** |
| (5) | `M-04-01` §4-A | 「피킹 수량 \| `inventory_balance.picked_qty` 파생」 | **ⓒ**(계획자가 센 그 한 줄) |

**ⓐ 를 지지하는 근거는 «하나»뿐이고 그것이 우리 자신의 계획서다** — `plan-integration.md` I-22 절의
「예약만 움직인다」. 브리프 §3 이 「⛔ 계획서 문장을 근거로 쓰지 마라」라 못 박은 바로 그 자리다.
게다가 **같은 문장의 나머지 절반이 ⓒ 를 지지한다**: 「(I-8 **코어 재사용** — **두 번째 사용처**라
코어 판정이 여기서 검증된다)」. ⓐ 로 가면 I-22 는 I-8 코어를 **한 줄도 재사용하지 않는다**(새 `reserve()` 만 쓴다).
ⓒ 로 가야 `pick()` 의 **예약 갈래**(`inventoryReservationId !== null` · `reservation-qty.ts:79·88·95`)가
처음으로 실제로 돌고 그 문장이 참이 된다.

**⭐ 계획안 §6-2 비교표의 세 행이 잘못 채점됐다.**

| 행 | 계획안 | 실측 |
|---|---|---|
| 「계약 문장」 | ⓐ ⭕ 「건다」 | ⚠ **원문은 「걸고 푼다」** — ⓐ 는 절반, ⓒ 가 ⭕ |
| 「`M-04-01` §4-C — 예약 3칸이 뜻을 갖는다」 | ⓐ ⭕ · ⓒ ⚠ | ⚠ **비대칭이 아니다.** `released_qty` 는 ⓐ·ⓒ 어느 안에서도 I-22 안에서는 **영원히 0** 이고, `consumed_qty` 는 ⓐ 에서 **영원히 0** · ⓒ 에서 **= reserved**. 「죽은 칸」 수는 ⓐ 가 2, ⓒ 가 1이다 — **ⓒ 가 낫다** |
| README §2 2단계 기준 1·5 | ⓐ 「한 칸」 · ⓒ 「세 칸」 | ⚠ **순변화로 세면** ⓐ = `balance.reserved` 1칸 + 예약 행 · ⓒ = `balance.picked` 1칸 + 예약 행(`consumed` 포함). ⓒ 의 «두 번 쓰기»는 같은 트랜잭션 안 같은 행이다. 그리고 **애초에 2단계에 갈 자리가 아니다** — README §2 **0단계에 선례가 넷** 있다(위 표). 계획자는 0단계를 건너뛰고 2단계 tie-breaker 로 갔다 |

**⭐ 결정타 — 새 개념 수(기준 5)가 ⓐ 에서 «더» 늘어난다.**

| | ⓐ | ⓒ |
|---|---|---|
| I-22 가 코어에 더하는 것 | `reserveBalances` + `lockBalancesByItemLot` | **같다** — `pick()` 은 이미 있다 |
| I-23 이 코어에 더해야 하는 것 | ⛔ **`releaseBalances()` 신설**(출하 취소가 예약을 «해제»해야 하는데 `released_qty` 를 올리는 함수가 저장소에 0개다) | ⭕ **0** — 취소는 `pick()` 의 **Δ<0 갈래**가 이미 감당한다(`reservation-qty.ts:80-81·109-112` 가 `picked_qty >= −Δ`·`consumed_qty >= −Δ` 하한을 이미 갖고 있다) |
| I-23 이 부르는 순서 | `pick()` → `consume()` → `post()` | `consume()` → `post()` |

**⭐ 그리고 ⓐ 는 «오늘 있는 계약 한 건»을 깨뜨린다.** `GET /inventory/reservations` 의 `openOnly`
(「아직 소진되지 않은 예약만」)가 ⓐ 에서는 **제품 피킹 예약을 전부 «열린 것»으로 계속 낸다** —
출하가 끝날 때까지. 자재 피킹 화면(`M-01-08`)의 목록이 제품 예약으로 오염된다.
ⓒ 에서는 `consumed = reserved` 라 `openOnly` 가 즉시 걸러 낸다.

⇒ **판정: ⓒ(걸고 곧바로 푼다).** 계획안 §0 #1 이 스스로 적은 대로 **뒤집기 비용은 작다** —
`shipment-pick.service.ts` 의 코어 호출 한 줄(+`posting.pick(...)`)과 e2e 4건(P-2·P-3·P-5·P-8),
그리고 §11 인계 첫 행이 바뀐다. **코어 PR ① 의 줄수는 거의 안 변한다**(`pick()` 이 이미 있다).

### 1-7. ⓻ 「6값 판정식 · 「뒤가 이긴다」 · `PICKING` 함정」 → ✅ **유지**

계약 덤프로 전건 확인했다 — 6값 식·「⭐ 판정 순서는 뒤가 이긴다 — NOT_ALLOCATED, PARTIALLY_ALLOCATED,
PICKING, PICKED, PARTIALLY_SHIPPED, SHIPPED」·「PICKING = 배정 합이 요청 합과 같고 피킹 합이 배정 합보다 작다」 ✓.
부분 배정이 `PICKING` 을 못 지나는 함정도 참이다. **계약 문자대로 구현 + 「알려둘 것」 ⓖ** 유지.
⇒ 통합 관점의 추가는 §2-4(두 벌 구현)다.

---

## ⭐ 2. 내 관점이 특히 봐야 할 자리

### 2-1. 마이그레이션 A13 — ✅ **유지**(하위 호환 · 추가만 · 순서 무의존 · 이름 관행 일치)

가장 가까운 선례 **N-1**(`prisma/migrations/20260908140000_inventory_adjustment_line_count_ref/migration.sql`)과
**문장 단위로 같은 모양**이다:

| 검사 | A13 초안 | 선례 |
|---|---|---|
| FK 제약 이름 무명(`REFERENCES` 만) | ⭕ | N-1 이 같은 주석까지 단다 — 「Prisma 기본형이어야 `migrate diff` 가 드리프트를 안 낸다」 |
| 인덱스 `ix_<table>_<col>` | ⭕ `ix_shipment_request_sales_order` | `ix_inventory_adjustment_line_count_line` |
| `COMMENT ON COLUMN` | ⭕ | N-1·A4 둘 다 |
| 추가 1 · 완화 0 · 삭제 0 · 백필 0 | ⭕ | `lanes.md` §1-2 |
| 사전 대조 SQL 을 주석에 | ⭕ | N-1·A4 둘 다 |
| 파일명 `<ts>_a_i22_…` | ⭕ | `20260908151000_b_i30_…`·`20260908152504_b_i31_…` |

- **「백필 0」검증** — `prisma/seed.ts` 에 `shipment_request` INSERT **0건**(grep: 460행 주석 하나뿐).
  주석의 「`SELECT count(*) FROM logistics.shipment_request` — 기대 0」은 시드 실측과 맞는다.
- **인덱스를 거는 판단이 A4 와 갈리는데 옳다** — A4 는 「⛔ 인덱스를 더하지 않는다 — 이 칸으로 «거르는» 질의가 0건」이라 안 걸었고,
  A13 은 `unassignedOnly` 의 `NOT EXISTS` 가 그 칸을 실제로 탄다. N-1 쪽 선례를 따른 것이 맞다.
- **Nit** — 최근 마이그 하나(`20260908220249`)는 FK 에 `ON DELETE NO ACTION ON UPDATE NO ACTION` 을 명시한다.
  A13 초안은 생략했다. PG 기본값이 같아 드리프트 0이고 N-1·A4 도 생략했으므로 **관행 안**이다. 그대로 둬도 된다.

### 2-2. ⭐ 물리는 baseline «만» 보지 않았는가 — ✅ **채택. I-21 R-4 형 사고 없음.**

독립 재측정:

```
$ grep -rl "shipment_request" prisma/migrations/
  20260727000000_baseline_physical_model_v3      # 원표
  20260826000000_data_model_v4                   # ship_time_slot_start/end + ck_shipment_request_time_slot
  20260901040000_align_notice_receipt_shipment   # ship_time_slot_code (+ 옛 2칸 [사용 중지] 주석)
```
계획안 부록 #1·#13 과 **정확히 일치**한다. `timeSlotCode` 를 후속 마이그에서 찾아낸 것도 맞다.
⇒ **I-21 R-4 형(baseline 만 읽은) 사고는 이 계획안에 없다.** ⓶ 의 `picked_qty` 도 68 전건 재grep 로 확인했다.

⚠ 다만 **`ck_shipment_request_time_slot`**(`20260826000000:117-119`)을 계획안이 한 줄도 안 적었다.
`ship_time_slot_end > ship_time_slot_start` 인데 둘 다 NULL 이면 참이라 POST 가 안 걸리지만,
「이 슬라이스가 읽지도 쓰지도 않는다」의 근거로 CHECK 를 함께 적어야 완전하다(**Nit**).

### 2-3. ⭐⭐ 코어 설계 — `reserveBalances()` + `lockBalancesByItemLot()` 가 기존 모양과 맞는가

**ⓑ 모양 — 대체로 맞다. 다만 세 가지가 어긋난다.**

| 항목 | 계획안 | 기존 코어 실측 | 판정 |
|---|---|---|---|
| 한 문장 `UPDATE … WHERE 하한 RETURNING` | ⭕ | `pickBalances`(`reservation-qty.ts:86-93`)와 같은 모양 · 「먼저 SELECT 하지 않는다」 주석 `:71-72` | ⭕ 맞다 |
| 행을 잠그지 않는다(호출자가 잠근다) | ⭕ | 파일 머리 주석 `:12-13` 그대로 | ⭕ |
| `isZero()` 건너뛰기 | ⭕ | `:77`·`:134` 와 대칭 | ⭕ |
| 트리거 갈래 | 「`available_qty >= Δ` 라 갈래 1 이 문장마다 참」 | ✅ **재검증**: `check_balance_qty()`(baseline:2831-2856)는 `on_hand >= 0` 이면 갈래 1, **음수면 갈래 2**(「음수재고 상태에서는 예약·피킹·차단 수량을 가질 수 없습니다」). `available_qty >= Δ > 0` ⇒ `on_hand >= Δ + reserved+picked+blocked > 0` 이라 **갈래 2 에 못 간다** | ⭕ 맞다(계획안이 갈래 2 를 안 적었지만 결론은 참) |
| `field` 를 호출자가 준다 | ⭕ | `:10-11` 규약 | ⭕ |
| **`lockBalancesByItemLot` 의 키 모양** | `(itemId, lotId)` 2칸 | `lockBalancesInOrder` 는 **`BalanceLockKey` 7칸**(`balance-lock.ts:4-12`) | ⚠ **다른 개념**이다 — §2-3 ⓓ |
| **`ReserveMove` 에 `lotId`·`warehouseId` 축** | `dimension: BalanceDimension` 11칸에서 | `inventory_reservation` 은 **item·lot·warehouse·location 4칸만** 갖는다 | ⛔ **Major M-2** |
| **`reservationNo` 유일 충돌** | 「유일 위반을 그대로 올린다 — 도메인이 409 로 옮긴다」(§8-6) | ⭕ `production-plan.service.ts:155` 선례 | ⭕ |

**ⓒ 「`reserved_qty` 만 올리고 열린 예약」 → §1-6 에서 «반증»했다.**

**ⓓ 동시성 — 잠금 순서는 형제와 «어긋나지 않는다»(채택). 그러나 두 가지가 빠졌다.**

- ✅ **교착 창은 안 열린다.** `lockBalancesByItemLot` 이 `ORDER BY inventory_balance_id … FOR UPDATE` 를 지키는 한
  `lockBalancesInOrder`(`balance-lock.ts:60-61`)와 **같은 오름차순**이라 I-4 R-1 ②·I-5 R-5 의 자리는 다시 안 열린다.
  I-8 의 문서→잔액→예약 순서와도 같다(계획안 §6-4 표 ⭕).
- ⚠ **그러나 `FOR UPDATE` 는 «팬텀»을 막지 않는다.** ⑩ 의 「2행+ → 400」은 직렬화되지 않는다 —
  다른 트랜잭션의 `move()`(`inventory-posting.service.ts` ①)가 같은 (품목·LOT)의 **새 차원 행을 INSERT** 하면
  이 트랜잭션은 못 본다. I-8 도 같은 처지이므로 **새 결함은 아니지만**, 계획서가 「잠금 안에서 세니 경쟁이 없다」(§3-2 두 번째 ⭐)라
  적은 것은 **⑫(같은 라인의 Σ 예약)에만** 참이고 **⑩ 에는 거짓**이다. 문구를 갈라야 한다(**Minor**).
- ⚠ **잠금 «폭»이 넓어진다.** `(item, lot)` 만으로 잠그면 그 LOT 의 **모든 공장·창고·위치 잔액 행**을 잡는다.
  제품 LOT 은 오늘 한 창고에만 서므로 실무상 1행이지만, 함수 doc 주석에 그 폭을 적어 두지 않으면
  I-23·I-16 이 그대로 재사용해 넓은 잠금을 퍼뜨린다(**Minor**).

### 2-4. ⭐ 파생 축 둘이 «두 벌»로 구현된다 — 계획서에 그 말이 없다 (Major M-4)

`shipmentProgressCode`·`shippingInspectionStatusCode` 는 **응답 필드**(TS · `shipment-request-progress.ts`)이면서
동시에 **질의 필터/집계**(SQL)다:

| 자리 | 어디서 도는가 |
|---|---|
| `ShipmentRequest.shipmentProgressCode`(응답) | TS 판정 함수 |
| `GET …/shipment-requests?shipmentProgressCode=` | ⛔ **SQL** — 페이지네이션 «전»이라 TS 함수를 못 부른다 |
| `?pickingCompleteOnly` · `?shippableRemainderOnly` | ⛔ **SQL** |
| `summary.pendingInspectionCount` · `incompletePickingCount` | ⛔ **SQL** |
| `ShipmentRequest.shippingInspectionStatusCode`(응답) | TS |

**이 자리를 이미 겪은 선례가 저장소에 주석으로 남아 있다** — `disposition-rollup.ts:20-23`:
> 「⭐ `export` 다 — ②a″ 의 질의 필터는 페이지네이션 «전»이라 이 함수를 못 부르고 **같은 판정을 SQL 로 다시 적는다.**
> 문자열이 갈리면 「목록이 거른 것」과 「행이 보이는 값」이 어긋난다(I-20 R-2 형).」

⇒ 계획안 §4-3 의 「⛔ 목록과 같은 `where` 함수를 공유한다」는 **필터 축에만** 답이고 **파생 축에는 답이 없다.**
그리고 **e2e 가 한쪽만 덮는다**: L-14~L-19 는 6값을 **응답 필드**로만 보고, L-21 은 **필터**를 값 하나로만 본다.
⇒ **6값 중 5값에서 필터와 필드가 갈려도 초록**이다 — README **§6-3 ⑵**(「픽스처의 각 축에 값이 둘 이상인지 세라」)의 정확한 모양.
검사 5값도 같다(L-23~L-27 은 필드, L-43 은 건수 축 하나).

### 2-5. 레인 파급 — I-23 · A2 인수분과의 겹침

**ⓐ I-23 이 이 위에 선다 — 「예약을 «푸는» 쪽이 I-23」 판정이 §1-6 으로 «바뀐다».**

| | ⓐ(계획안) | ⓒ(내 판정) |
|---|---|---|
| I-23 출하 처리 | `pick()` → `consume()` → `post()` | **`consume()` → `post()`** |
| I-23 출하 취소 | ⛔ **`releaseBalances()` 신설 필요**(계획안에 없다 — §11 이 「푸는 쪽이 I-23」이라고만 적었다) | ⭕ `pick()` Δ<0 로 되돌린다(코어 무변경) |
| `pick()` 의 예약 갈래 첫 사용처 | I-23 | **I-22**(= `plan-integration.md` 의 「두 번째 사용처라 코어 판정이 여기서 검증된다」가 참이 된다) |

⇒ §11 인계 첫 행과 `plan.md` §1 20행(I-23 코어 칸)이 함께 바뀐다.
**I-23(#410) 소유를 사용자에게 확인한다**는 §11 마지막 줄은 옳다 — 실측: `#410` 은 `Lane-C` 라벨만 붙고 **미배정**이다.

**ⓑ A2 가 인수한 것은 I-13~I-17 이 아니라 «여섯»이고, 겹치는 파일이 하나 있다.**

`gh issue list --label Lane-C` 실측 — A2 인수분은 **#403 I-13 잔여 2 · #404 I-14 잔여 3 · #405 I-16(7) ·
#406 I-15(6) · #407 I-17(1) · #408 I-35(2) = 6슬라이스 21오퍼**(`lanes.md:48` 의 「6(21 오퍼)」와 일치).
**I-22(#409)는 A · I-23(#410)은 미배정.**

| 공용 파일 | 겹치는 상대 | 판정 |
|---|---|---|
| `src/logistics/logistics.module.ts` | ⭐ **A2 의 I-17 재생재**(`logistics.recycle_entry` · A5) · I-13 잔여 | ⚠ 계획안 §7-2 는 「레인 **B·C**」라 적었다 — **실제 상대는 A2** 다. 그리고 A 가 A2 의 병합자다(`lanes.md` §0-1). 문구 정정 필요(**Minor**) |
| `prisma/schema.prisma` | A5(I-17) — 다른 모델 블록 | ⭕ 자동 병합 |
| `prisma/migrations/**` | A5(I-17) | ⭕ 초 단위 타임스탬프 · 둘 다 추가만 · 순서 무의존 |
| `src/core/numbering/numbering.service.ts` `DEFAULT_PREFIX` | A2(I-17·I-35) · B | ⚠ `lanes.md` §1-4 **목록 밖**인데 4레인이 공유한다. ① 이 그것을 건드리므로 ① 을 «먼저·작게» 내고 바로 병합해야 창이 작다(**Minor**) |
| `src/core/inventory-posting/**` | A2 의 I-14 전기(#404 **진행 중**) | ⭕ I-14 는 «호출자»다. 단 ① 이 `inventory-posting.service.ts:40-43` 머리 주석을 고치므로 동시 진행이면 3줄 충돌 가능(**Nit**) |
| `test/inventory-reservation.e2e-spec.ts` | — | ⚠ 회귀 대상 ✓(계획안 §8-7). 이유가 하나 더 있다 — 아래 M-5 |
| `src/common/permissions/manual-permissions.ts` · `error-codes.ts` · `transitions.ts` | — | ⭕ **0줄**(§7-1 실측 확인 — `derived-permissions.ts:180·181·265` 세 자리가 이미 있다) |

**ⓒ 이슈 #409 의 「⚠ 인계」를 계획안이 «통째로» 안 봤다 → Major M-5.**

---

## 3. findings

### Blocker — **1건**

#### **B-1. §2 ⓺ 판정(ⓐ)이 틀렸다 — 계약 2문장 + 화면 2문장이 ⓒ 를 가리킨다**

§1-6 전문. 이것이 뒤집히면 **코어 PR ①(호출 규약) · 심장 PR ⑥ · e2e 4건(P-2·P-3·P-5·P-8) ·
§0 #1·#2 · §6-2 표 · §11 인계 첫 행 · `plan.md` §1 19·20행**이 함께 선다.
⛔ **계획안이 스스로 「뒤집기 비용이 작다」라 적었으므로 지금 뒤집는 것이 가장 싸다** — 구현 뒤면 e2e 12건과 I-23 설계가 함께 흔들린다.

### Major — **6건**

#### **M-1. `④ FOR UPDATE OF l` 이 계획서에 없다 — 빼면 같은 작업지시의 두 라인 피킹이 직렬화된다**
§1-3 ⓐ. I-8 이 `picking-pick.service.ts:69` 에 **이유까지 주석으로 남긴** 자리다. §3-2 ④ 에 `OF l` 을 명시하고,
「같은 작업지시의 서로 다른 두 라인을 동시에 피킹해도 둘 다 200」을 e2e 이름으로 못 박아야 한다(지금 P-1~P-32 에 없다).

#### **M-2. `inventory_reservation` 은 잔액 차원 11칸 중 «4칸»만 담는다 — 예약을 되돌릴 때 차원을 복원할 수 없다**
실측(baseline:1209-1232 · `schema.prisma:593-624`): `item_id` · `lot_id?` · `warehouse_id`(**NOT NULL**) · `location_id?` 넷뿐.
`plant_id`·`legal_entity_id`·`business_unit_id`·`quality_status_code`·`inventory_status_code`·`ownership_type_code`·`owner_partner_id` **0개**.
그런데 `pickBalances`(`reservation-qty.ts:91`)는 **11칸 `dimensionWhere`** 로 잔액 행을 겨냥한다.
⇒ 예약을 소진·해제하는 쪽(ⓐ 면 I-23, ⓒ 면 이 슬라이스의 같은 트랜잭션)은 **예약 행만으로는 그 11칸을 못 복원**하고
(품목·LOT)로 다시 잠가 ⑩ 의 「2행+ → 400」 벽을 다시 만난다.
⭐ **ⓒ 로 가면 이 위험이 한 트랜잭션 안으로 접힌다**(잠근 행을 그대로 넘긴다) — ⓐ 는 그것을 **몇 시간~며칠 뒤 I-23** 으로 미룬다.
그 사이 `lot_hold`(I-20)나 처분(I-21)이 `inventory_status_code` 를 바꾸면 예약이 **영영 못 풀린다**.
계획안 §11 인계 표에 이 사실이 한 줄도 없다.

#### **M-3. `pickedQty` 롤업이 `released_qty` 를 빼지 않는다 — 출하 취소가 반영되지 않는다**
§1-2 마지막. §0 #2·§5-1(`P = Σpicked(예약 롤업)`)·§1-4-1 셋을 **`Σ(reserved_qty − released_qty)`** 로 고쳐야 한다.
`inventory_reservation.released_qty`(baseline:1219)와 `ck_reservation_qty (released + consumed <= reserved)`(:1230)가
그 축을 이미 갖고 있고, 계획안 §11 이 직접 「I-23 이 푼다」라 적었다.
⇒ 이 결함은 **`shipmentProgressCode` 로 번진다**(P 가 과대 ⇒ `PICKED` 로 잘못 오른다).
e2e 는 「예약을 일부 해제한 뒤 `pickedQty` 가 내려간다」로만 잡히는데 I-22 에는 해제 경로가 없으므로
**단위 spec(`shipment-request-progress.spec.ts`)에서 `released_qty > 0` 픽스처로 못 박아야 한다.**

#### **M-4. 파생 축 둘이 TS·SQL 두 벌로 갈라지는데 e2e 가 한쪽만 덮는다 (README §6-3 ⑵)**
§2-4 전문. 처방: ⓐ 판정 함수와 SQL 술어를 **같은 파일**에 나란히 두고(`disposition-rollup.ts` 선례)
ⓑ e2e 를 「6값 각각에 대해 **필터로 부른 목록**과 **응답 필드**가 같은 집합을 낸다」 형태로 바꾼다
(지금의 L-14~L-19 + L-21 조합으로는 5값이 반증 공백).

#### **M-5. 이슈 #409 의 「⚠ 인계」가 계획안에 0회 등장한다 — 제품 예약이 자재 예약 목록에 섞이고, 계약 enum 을 «런타임에» 위반한다**
`gh issue view 409` 본문:
> 「⚠ 인계 — 자재 피킹(I-8)과 **같은 피킹 표를 쓴다** — 목록에 `sourceDocumentTypeCode` 질의가 없어 자재·제품 피킹이 섞인다(I-8 「알려둘 것」). **이 슬라이스가 그 자리를 다시 본다.**」

실측: `GET /inventory/reservations` 의 질의는 **8개**(`itemId`·`lotId`·`warehouseId`·`sourceDocumentId`·`statusCode`·`openOnly`·`page`·`size`) —
**`sourceDocumentTypeCode` 가 없다.** 그리고 `InventoryReservation.sourceDocumentTypeCode` 는 `enum: ["PRODUCTION_ORDER"]` 로 **닫혀 있다**.
⇒ I-22 가 `SHIPMENT_REQUEST_LINE` 예약을 만드는 순간 **그 조회가 계약 enum 밖의 값을 내리기 시작하고,
화면은 그것을 걸러 낼 축이 없다.** 계획안은 §8-7 에서 **e2e 픽스처 오염**만 걱정했고(그것도 맞다),
**런타임 계약 위반과 필터 축 부재**는 통보 후보 A 에도 안 실었다.
⭐ ⓐ 안이면 `openOnly=true` 로도 안 걸러진다(열린 채 남으므로) — ⓒ 면 최소한 `openOnly` 가 막아 준다.

#### **M-6. PR ⑦ 이 예산을 넘는다 — 7분할이 아니라 «8» 이다**
§7-1 파일 표를 PR 로 재배분하면(파일 22개 합 = **1,886** — 산술 재검산 일치):

| PR | 계획안 | 재산정 | 판정 |
|:-:|--:|--:|---|
| ① 코어 | 124 | **124~140** | ⭕ 200 안 |
| ② 마이그+`sales-orders` | 280 | 279 | ⭕ |
| ③ 단건+뷰+파생 축 | 340 | **370~390** ⚠ | 아래 |
| ④ 목록+summary | 300 | 232 | ⭕ 여유 |
| ⑤ 편성 | 300 | 228 | ⭕ 여유 |
| ⑥ 심장 | 280 | 255 | ⭕ |
| **⑦ 배분 2건** | **360** | ⛔ **433**(60+165+75+125+모듈 8) | **넘는다** |

- ⛔ **⑦ = 433 ≥ 브리프 예산 350**, 리뷰 수정분(+20~30)을 얹으면 **한도 400 도 넘는다**.
  ⇒ **⑦a `GET /logistics/shipment-lot-allocations`(~300) / ⑦b `PUT …/{id}` + M4 마디 e2e + §12(~140)** 로 가른다.
- ⚠ **③ 도 위험하다.** §7-1 이 근거로 든 `disposition-rollup.ts` 를 **~100** 이라 적었는데 **실측 140**이다(`wc -l`).
  게다가 그 파일은 **파생 축 하나**를 다루는 «순수» 함수이고, `shipment-request-progress.ts` 는 **둘**(6값 + 5값 롤업 + `oqcPassed`)에
  **DB 조회**(OQC 결과 · 최대 CONFIRMED 회차)까지 낀다 ⇒ **~180** 이 현실적이고 ③ 이 **~390** 이 된다.
- ⚠ **§7-1 합(1,886)과 §10 PR 합(1,984)이 98 어긋난다** — 둘 중 하나는 예산 검사가 아니다. §10 표에 파일 배분을 명시해야 한다.

⇒ **PR 8**: ① → ② → ③ → { ④ ∥ ⑤ ∥ ⑦a } → ⑥ → ⑦b. 스택 규칙(⛔ 코어·심장은 R-n 확정 뒤)은 그대로.

### Minor — **9건**

1. **⑨(잔여 유효기간)의 409 가 계획서 자신의 409 기준과 어긋난다** — §1-3 ⓑ. 400 이 자기 기준에 맞다.
2. **⑩ 「0행 → 409」가 형제(`picking-pick.service.ts:130` 400 `NEGATIVE_BALANCE`)와 갈리는데 §1-6 표에 대비가 없다.**
3. **「잠금 안에서 세니 경쟁이 없다」는 ⑫ 에만 참이다** — ⑩ 의 「2행+」는 `FOR UPDATE` 가 팬텀을 못 막아 직렬화되지 않는다(§2-3 ⓓ).
4. **`lockBalancesByItemLot` 의 잠금 «폭»**(그 LOT 의 전 공장·창고 행)을 doc 주석에 안 적으면 I-23·I-16 이 그대로 넓게 재사용한다.
5. **`handling_unit.warehouse_id` 는 nullable** (`schema.prisma:434` · baseline:1241). §3-3 ⑤ 「`hu.warehouse_id != shipment.warehouse_id` → 400」에 **널 정책이 없다**
   — I-21 R-13(널 정책 통째 누락)과 README §6-3 ⑷ 의 자리다. e2e A-22 도 널 HU 를 안 태운다.
6. **`handling_unit.status_code` 를 §3-3 이 한 번도 안 본다** — 폐기·해체된 HU 에 배분을 붙일 수 있다.
7. **채번을 트랜잭션 «밖»에서 뽑는 것은 맞지만**(`numbering.service.ts:87-89` P2024), `:pick` 은 **409 가 정상 거부**라 소진율이 높다
   — 404/400/409 로 죽는 요청마다 `RS-` 번호가 탄다. 결번 허용(I-2 R-2)이라 무해하나 「알려둘 것」에 남길 값이다.
8. **`DEFAULT_PREFIX` 는 `lanes.md` §1-4 목록 밖인데 4레인 공용**이다 — ① 을 먼저·작게 내고 바로 병합해 창을 줄인다.
9. **§7-2 의 「레인 B·C 가 손댈 수 있다」는 낡았다** — 실제 상대는 **A2**(#403~#408 여섯)이고 그중 **I-17 이 `logistics.module.ts` 를 함께 쓴다**.

### Nit — **4건**

1. `ck_shipment_request_time_slot`(`20260826000000:117`)을 §2-2 에 한 줄 적으면 「옛 2칸을 안 건드린다」의 근거가 완결된다.
2. A13 DDL 에 `ON DELETE NO ACTION ON UPDATE NO ACTION` 을 명시할지 — 관행이 갈린다(N-1·A4 생략 / `20260908220249` 명시). 드리프트 0이라 어느 쪽이든 무해.
3. `inventory_reservation` 에는 **쓰기 가드 spec 이 없다** — `balance-write-guard.spec.ts:12-17` 은 `inventory_balance` 만 본다. 「예약 행을 만드는 유일한 길」을 세우려면 그 spec 옆에 짝을 하나 두는 것이 값싸다(+~10줄, 테스트라 예산 밖).
4. `reservationNo` 접두어 `RS` 에 **계약 근거가 있다** — `InventoryReservation.reservationNo.example = 'RS-2026-000144'`(01 계약). 부록에 없다.

---

## 4. 관점별 전수 점검표 — `plan-integration.md` ↔ 계획안

| # | 통합 계획서 | 계획안 | 내 판정 |
|:-:|---|---|---|
| 1 | I-22 행 「코어 **—**」(`plan.md:55`) | 코어 PR 신설 | ✅ **채택**. ⭐ 그런데 `plan.md:43`(I-8 행)은 이미 「첫 사용처는 I-22」라 적었다 — **`plan.md` 자기모순**이라 §0 표에 두 자리를 적어야 한다 |
| 2 | I-22 행 「원장 ✕ · **⭐ 예약**」 | 원장 0 · 예약 ⭕ | ✅ 일치. `inventory_transaction` 을 만드는 오퍼레이션 0건 재확인 |
| 3 | I-22 절 「예약**만** 움직인다」 | ⓐ 안의 근거로 씀 | ⛔ **반증** — §1-6. 계약·화면 넷이 반대다 |
| 4 | I-22 절 「I-8 코어 **재사용** — **두 번째 사용처**라 코어 판정이 여기서 검증된다」 | 언급 없음 | ⛔ **ⓐ 안에서는 거짓**(재사용 0). ⓒ 안에서만 참 |
| 5 | I-22 절 「도출 규칙은 값 이름이 그대로 말한다」 | 「부족하다 — 식·우선순위·함정이 있다」 | ✅ **채택**(계약 덤프로 재확인) |
| 6 | `plan-api.md:548` 「푸는 쪽만 한다」 | 「거짓 — 04 는 «건다»」 | ⚠ **절반 채택** — 거짓인 건 맞고 정정판이 「걸고 푼다」다(취소선 `~~걸고~~` 가 원문을 보여 준다) |
| 7 | I-16 절 「포장 단위가 I-22 의 `shipment_lot_allocation` 에 연결된다」 | PR ⑦ | ✅ 일치. ⚠ 단 `handling_unit.warehouse_id` 널 정책 누락(Minor 5) |
| 8 | I-20 절 「I-4·I-8·**I-22** 가 보류 판정을 읽는다」 | §3-2 ⑦⑧ | ✅ 일치. `assertPickable`(`picking-pick.service.ts:220-235`)와 같은 두 축 |
| 9 | I-23 행 「선행 I-22·I-5 · A 의 I-19 전이 코어」 | §11 인계 · 소유 확인 | ✅ 일치. #410 미배정 실측 |
| 10 | `plan.md` §4 A13 「`sales_order_id?` 한 칸」 | 유지 | ✅ **유지** — N-1 선례와 문장 단위 일치 |
| 11 | 「예상 PR **3**」(세 계획서 전부) | 7 | ⚠ **부분 채택** — 3 은 불가능하나 7 도 부족하다. **8**(§M-6) |

---

## 5. 계획자가 안 본 자리 (새로 찾은 것)

1. ⭐⭐ **`GET /inventory/reservations` description** — 「예약은 출고 요청과 피킹의 결과로 **서버가 걸고 푼다**」. 04 계약이 「01 자재창고 계약 … 과 같은 규약」이라 가리킨 그 문장이다.
2. ⭐⭐ **`M-01-08` §5-5** — 「출고요청 생성 시 예약이 걸리고, **피킹하면 `picked_qty`로 옮겨 간다.**」 04 계약이 **이름을 대며** 가리킨 절인데 계획안이 열지 않았다.
3. ⭐⭐ **`M-04-01` §5-7 액션 표** — 「확정 후 되돌리기 ⛔ 두지 않는다 — **예약이 소진된다**」. 계획안은 같은 파일 §4-A·§4-C 만 봤다.
4. ⭐ **04 `:pick` description 의 「걸고 **푼다**」** — 인용이 「건다」에서 끊겼다(R-24 형).
5. ⭐ **이슈 #409 의 「⚠ 인계」** — 자재·제품 예약이 한 목록에 섞이고 필터 축이 없다(M-5).
6. ⭐ **`inventory_reservation` 이 차원 11칸 중 4칸만 담는다**(M-2).
7. ⭐ **롤업이 `released_qty` 를 안 뺀다**(M-3).
8. ⭐ **`FOR UPDATE OF l`**(M-1) — I-8 이 이유까지 주석에 남긴 자리.
9. ⭐ **파생 축 둘의 TS/SQL 두 벌**(M-4) — `disposition-rollup.ts:20-23` 이 같은 자리를 이미 경고한다.
10. ⭐ **01 도 `exclusiveMinimum` 위에 손검사를 «겹쳐» 둔다**(`picking-pick.service.ts:200`) — 「04 만 반대」가 아니다.
11. ⭐ **`check_balance_qty()` 의 갈래 2**(음수 재고에서는 예약·피킹·차단 수량 금지 · baseline:2850) — 결론은 안 바뀌지만 코어 주석에 적을 값이다.
12. ⭐ **`plan.md` 자기모순**(43행 ↔ 55행).
13. ⭐ **A2 인수 실측** — I-13~I-17 이 아니라 **#403~#408 여섯**이고 **I-17 이 `logistics.module.ts` 를 함께 쓴다**.
14. ⭐ **`DEFAULT_PREFIX` 가 `lanes.md` §1-4 목록 밖의 4레인 공용 파일**이다.
15. ⭐ **`disposition-rollup.ts` 는 100 이 아니라 140**이고 그것은 **순수 함수 · 축 하나**다(§M-6 ③).
16. **`ck_shipment_request_time_slot`** 을 §2-2 가 안 적었다.
17. **`handling_unit.status_code`** 를 §3-3 이 한 번도 안 본다.

---

## 6. §10 PR 분할·줄 예산 판정

**총량 추정(1,886)은 신뢰할 만하다** — 파일 22개를 하나씩 더해 재검산했고 오차 0이었다.
비슷한 파일 실측 근거도 대부분 맞다(`stock-transfer-query.service.ts` 129 · `picking-view.ts` 156 ·
`material-issue-request.service.ts` 198 · `picking-pick.service.ts` 235 · `inventory-balance.service.ts` 320 — 전건 `wc -l` 확인).

**⛔ 그러나 두 자리가 틀렸다.**

| 자리 | 계획안 | 실측 |
|---|---|---|
| `disposition-rollup.ts` 근거값 | 「~100」 | **140** — 그리고 축이 «하나»이고 «순수»다 ⇒ `shipment-request-progress.ts` ~130 은 저평가, **~180** |
| PR ⑦ | 360 | **433** — 350 초과 · 400 도 위태 |

**코어 PR ① 은 «후하게» 다시 재도 안전하다.**
선례 실측: I-8 코어 커밋 `5d23f94` 의 비테스트 diff = **+165 / −3**(`reservation-qty.ts` 143 · `balance-lock.ts` +3 ·
`inventory-posting.service.ts` +18 · `index.ts` +1). 즉 이 저장소는 **「코어 ≤200」을 비테스트로 센다.**
I-22 ① 을 항목별로 다시 재면 `reservation-qty.ts` +70(`ReserveMove` 10칸 ~22 + `reserveBalances` ~48 · 이 파일은 주석 밀도가 높다) ·
`balance-lock.ts` +30 · `inventory-posting.service.ts` +12~16 · `index.ts` +2 · `numbering.service.ts` +10~14
⇒ **124~140**. 20% 를 더 얹어도 **~168 < 200**. ⭕ **①은 유지.**
⭐ **§1-6 의 ⓒ 정정도 ① 을 안 키운다** — `pick()` 은 이미 있고 호출은 도메인(⑥)에서 한다.

**최종 권고 — 8 PR**: ① → ② → ③(재산정 ~390 ⇒ 파생 축 파일을 ③ 에 두되 뷰를 ④ 로 옮겨 ~330 으로 낮춘다) →
{ ④ ∥ ⑤ ∥ **⑦a** } → ⑥ → **⑦b**.

---

## 7. 통보 후보 (⛔ 번호 없음 — 통합자가 준다)

> 계획자 후보 12건 중 **A·C 두 건은 문구가 바뀌고**, 아래 셋이 는다.

| 후보 | 제목 | 한 줄 요지 |
|---|---|---|
| (계획자 **A** 정정) | 제품 피킹이 재고 예약을 **걸고 «푼다»** — `sourceDocumentTypeCode` enum 이 하나 는다 | 04 `:pick` description 이 「걸고 푼다」이고 01 `GET /inventory/reservations` description·`M-01-08` §5-5 가 같은 규약이다. 판별자에 `SHIPMENT_REQUEST_LINE` 이 든다 |
| (계획자 **C** 정정) | `ShipmentRequestLine.pickedQty` 의 `x-source-column` 이 **«잔액» 칸을 가리킨다** | 앵커 `picked_qty` 는 04 계약의 **유일한** `x-source-column` 이고 `x-source-table` 이 0개다. `M-04-01` §4-A 가 `inventory_balance.picked_qty` 라 명시한다 — 라인 축 칸은 없고 서버가 라인 단위로 롤업한다 |
| **새 ⓐ** | 재고 예약 목록에 **원천 문서 «유형» 질의 축이 없다** | `GET /inventory/reservations` 질의 8개에 `sourceDocumentTypeCode` 가 없어 자재 예약과 제품 출하 예약이 한 목록에 섞인다. `InventoryReservation.sourceDocumentTypeCode` enum 은 `PRODUCTION_ORDER` 하나라 제품 예약이 서는 순간 조회가 계약 밖 값을 내린다(이슈 #409 인계) |
| **새 ⓑ** | `inventory_reservation` 이 잔액 차원 **11칸 중 4칸**만 담는다 | 예약 행에 `plant`·법인·사업부·품질/재고 상태·소유 축이 없어, 예약을 소진·해제할 때 원래 잔액 행을 예약만으로 복원할 수 없다. 그 사이 LOT 상태가 바뀌면 예약이 못 풀린다 |
| **새 ⓒ** | 출하작업지시 라인의 피킹을 **되돌릴 때 `released_qty` 를 반영할 자리**를 계약이 안 정했다 | `pickedQty`·`shipmentProgressCode` 가 예약 합에서 나는데, 출하 취소가 `released_qty` 를 올려도 그것을 빼라는 문장이 계약·화면 어디에도 없다. 서버는 `Σ(reserved − released)` 로 낸다 |

⚠ 계획자 후보 **B·D·E·F·G·H·I·J·K·L** 은 통합 관점에서 반대할 근거가 없다 — 그대로 둔다.

---

## 8. 내가 실제로 연 파일 · 돌린 명령

**계약(python 덤프 · 읽기 전용 · `contracts:update`·`check` 0회)**
```
scratchpad/i22int/dump.py                       # 전 경로 재귀 + 정규식
python3 … 'inventory_reservation|예약'           # → :pick description 「걸고 푼다」 · allocations x-internal-note
python3 … ShipmentRequestLine/ShipmentLinePickedLot/ShipmentLinePick 스키마 전건
python3 … x-* 확장 전수                          # x-source-column 1개 · x-source-table 0개
python3 … logistics-01자재창고 GET /inventory/reservations + InventoryReservation
python3 … shipmentProgressCode/shippingInspectionStatusCode/:pick responses+x-internal-note
```

**물리**
```
grep -rn "picked_qty" prisma/migrations/                    # 7행 · 파일 1(baseline)
grep -rl "shipment_request" prisma/migrations/              # 3 파일
ls prisma/migrations | wc -l                                # 68
sed baseline:1095-1140 (inventory_balance+uq_dim) · 1209-1272 (reservation+HU) · 2320 · 2360 · 2820-2875 (트리거)
cat 20260908002517_…(A4) · 20260908140000_…(N-1) · 20260908192319 · 20260908220249 · 20260909010052
sed 20260826000000:110-125 · 20260901040000:94-122
schema.prisma  429-458(handling_unit) · 593-624(reservation) · 1203-1240(sales_order) · 1248-1382(shipment*)
prisma/seed.ts 465-472 · 694-701 · grep shipment_request/sales_order
```

**코어·형제 소스**
```
cat -n src/core/inventory-posting/{reservation-qty,balance-lock,index,posting.types,balance-write-guard.spec}.ts
sed src/core/inventory-posting/inventory-posting.service.ts 1-80 · 150-175
cat -n src/logistics/picking/picking-pick.service.ts        # 235줄 전문
cat -n src/core/numbering/numbering.service.ts              # 186줄 전문
sed src/inventory/balance/inventory-reservation.service.ts 1-80
sed src/quality/disposition/disposition-rollup.ts 1-40 ; wc -l → 140
cat -n src/logistics/logistics.module.ts
grep -rn "inventory_reservation\.(create|…)|INSERT INTO inventory.inventory_reservation" src   # 0행
wc -l  (참조 파일 9종 · e2e 밀도 3종)
git show --numstat 5d23f94                                   # I-8 코어 PR 비테스트 +165/−3
```

**설계 사본(고정)**
```
.design-reference/…/screens/04/M-04-01-제품LOT피킹스캔.md    §4-A·§4-B·§4-C·§5-7·§6
.design-reference/…/screens/01/M-01-08-자재출고피킹.md        §4-A·§4-B·§5-5
```

**루틴 문서**
```
docs/coverage-100/README.md(전문) · git show origin/main:…/README.md §6-3(브랜치에 아직 없다)
docs/coverage-100/slices/I-22.md(1,050줄 전문)
docs/coverage-100/plan-integration.md 180-195·275-285·345-355·375-402·530-542
docs/coverage-100/plan.md 43·55·56·85·125-133 · plan-api.md 25·543-563
docs/coverage-100/lanes.md §0·§0-1·§1-1·§1-2·§1-4·§1-5 · lane-C.md 1-40
docs/coverage-100/slices/I-21-review-integration.md(형식 · 헤딩만)
gh issue view 409 · gh issue list --label Lane-C --state all · gh pr list --state open
```

⛔ **DB 는 열지 않았다** · ⛔ 코드·마이그 수정 0 · ⛔ PR 코멘트/병합 0 · ⛔ `prisma migrate dev` 0 · ⛔ `pnpm exec` 0 · ⛔ 워크트리 무접촉 · ⛔ 주 저장소의 미커밋 3파일(`.env.example`·`.gitignore`·`deploy/HANDOFF.md`) 무접촉.

---

## 9. 한 줄 결론

**물리·마이그 A13·잠금 순서·권한 0줄·모듈 배선은 실측으로 다 맞다 — I-21 R-4 형 사고는 없다.
그러나 슬라이스의 심장이 뒤집힌다: `:pick` 은 예약을 «걸고 푼다»(ⓒ)이지 «걸기만»(ⓐ) 하지 않는다.
계약 두 문장과 설계 화면 두 절이 그렇게 적었고, ⓐ 를 지지하는 유일한 근거는 우리 자신의 계획서다.
ⓒ 로 가면 `inventory_balance.picked_qty` 가 실제로 움직여 계약의 유일한 `x-source-column` 이 살고,
`pick()` 의 예약 갈래가 처음 돌아 `plan-integration.md` 의 「두 번째 사용처」가 참이 되며,
I-23 이 새 코어(`releaseBalances`)를 만들 필요가 없어진다.
그 밖에 반드시 고칠 것 다섯 — `FOR UPDATE OF l` · 예약 롤업의 `released_qty` · 파생 축의 TS/SQL 두 벌 ·
이슈 #409 가 넘긴 예약 목록 오염 · PR ⑦(433줄)의 분할.**
