# I-22 독립 리뷰 — **API 설계 관점**

> 대상: `docs/coverage-100/slices/I-22.md`(1,050줄 전문 · PR **#458** · 브랜치 `docs/coverage-100-a-i22-plan`) ·
> 내 관점의 통합 계획서 `docs/coverage-100/plan-api.md` §5.1 **S21**.
> 계약 `contracts/shipment-04제품출하.json`·`logistics-01자재창고.json`·`quality-03품질.json`
> (읽기 전용 · `contracts/COMMIT.txt` = **a6a87e144116ebaa32c01df5a12a0fd2924427e7**)을 **python 으로 직접 파싱**했고,
> 널 정책 한 자리는 저장소의 **ajv 설정 그대로 컴파일해 실행**해 판정했다(§3-1).
> ⛔ `I-22-review-uiux.md`·`I-22-review-integration.md` 는 **열지 않았다.** ⛔ 코드·계약·마이그레이션 수정 0 ·
> PR 생성/병합/코멘트 0 · `contracts:update`/`check` 0 · `pnpm exec` 0 · DB 접속 0 · 워크트리 접촉 0 · 통보문 0.
> 심각도: CREFLE `pr-review` 4단계(Blocker/Major/Minor/Nit).

---

## 0. 판정 요약

**채택 3 · 부분 반증 2 · 근거 반증 1 · 유지 1** — 대상은 브리프 §2 의 일곱(계획안 §0 「리뷰가 반드시 볼 자리 5」와 덤 둘).

| # | 자리 | 판정 |
|:-:|---|:-:|
| **⓵** | `:pick` 이 예약을 «건다» — 04 계약 **두 곳** | **부분 반증** — 결론 ⭕ · **근거 문장 하나가 실측과 다르다**(Major A-2) |
| **⓶** | `pickedQty` 를 담을 칸 0개 ⇒ 예약 롤업 | **채택**(재측정 일치) |
| **⓷** | 세 거부가 **409** · 01 은 409 미선언 | **결론 채택 · 근거 반증** — 01 은 **409 를 선언한다**(Blocker A-1) |
| **⓸** | `shippingInspectionStatusCode` 가 라인 축인데 칸 0개 | **부분 반증**(용어) · 실질 채택(Minor A-9) |
| **⓹** | 04 는 누적 · 01 은 대체 · `exclusiveMinimum` 없음 | **채택** — 네 사실 전건 실측 일치 |
| **⓺** | ⓐ안(`reserved_qty` 만) | **유지** — 다만 ⓒ 의 계약 근거가 §0 #1 이 적은 것보다 세다(Major A-2 와 같은 자리) |
| **⓻** | 6값 판정식·「뒤가 이긴다」·`PICKING` 함정 | **채택 + ⭐⭐ 더 큰 함정을 놓쳤다** — `NOT_ALLOCATED` 가 **도달 불가**다(Blocker A-3) |

**Blocker 3 · Major 7 · Minor 10 · Nit 3.**
(Blocker A-1·A-3·A-7 · Major A-2·A-4·A-5·A-6·A-8·A-19·A-22 · Minor A-9~A-15·A-20·A-21·A-23 · Nit A-16·A-17·A-18)

---

## 1. ⭐⭐ 브리프 §2 의 일곱 — 개별 판정

### 1-1. ⓵ — **부분 반증.** 「두 곳이 「건다」」는 절반만 사실이다

python 으로 두 자리를 그대로 꺼냈다.

**자리 ①** — `POST …/lines/{shipmentRequestLineId}:pick` 의 `description` **원문**:

> 현장이 집은 제품 LOT 과 수량을 이 라인에 기록한다. ⭐ 화면이 예약을 직접 쓰지 않는다 — 서버가 이 피킹의 결과로 inventory_reservation 을 **걸고 푼다**(01 자재창고 계약 · M-01-08 §5-5 **와 같은 규약**). **자재 피킹의 :pick 과 대칭이다.** …

⇒ 「건다」가 아니라 **「걸고 푼다」**다. 그리고 같은 문장이 **「01 과 같은 규약 · 대칭이다」**라고 이어진다 —
계획안 §0 #1 ⓑ(「01 자재 피킹과 갈린다」)가 **정면으로 겨눠야 할 문장**인데 §0 #1 은 「건다」만 잘라 인용했다.

더 무거운 것: **같은 문장이 01 계약에 이미 있다.** `logistics-01자재창고.json` 의 `InventoryReservation.description`:

> 재고 예약. 조회만 제공한다 — 예약은 **출고 요청과 피킹의 결과로 서버가 걸고 푼다**. 근거: M-01-08 §5-5

⇒ 04 의 그 문장은 **예약 수명 전체를 말하는 01 문장의 복제**이지 「`:pick` 하나가 걸고 푼다」가 아니다.
`I-8.md` 가 문의 045 로 「거는 오퍼레이션이 없다」를 확인한 것도 바로 이 문장을 두고서다.

**자리 ②** — `GET /logistics/shipment-lot-allocations` 의 `x-internal-note` **원문**:

> … 제품 피킹(M-04-01)은 배분을 만들지 않는다 — 2026-08-26 에 :pick 액션(…)을 이 계약에 세웠고, **서버가 그 결과로 inventory.inventory_reservation 을 건다.** 01 자재창고 계약의 「예약은 화면이 직접 쓰지 않는다」 규약을 그대로 지킨다.

⇒ **실재한다. 그리고 이 한 곳만이 「거는 행위」를 04 `:pick` 에 명확히 붙인다.**

**판정.** 결론(「이 슬라이스가 예약을 «거는» 코어를 처음 만든다」)은 **채택**한다 — 자리 ② 하나로 충분하고,
「거는」 함수가 저장소에 0개인 것도 재측정으로 확인했다(`reservation-qty.ts` 는 `PickMove`·`ConsumeMove` 둘뿐 ·
`src/core/inventory-posting/reservation-qty.ts:31-45`). 예고 셋도 전건 실재한다:
`plan-integration.md:280`(「`reserve()` 는 … 사용처 0 → 첫 사용처 **I-22**」) · `plan.md:43`(§1 9행이 같은 말) ·
`src/core/inventory-posting/inventory-posting.service.ts:42-43`(줄 번호까지 정확).
`plan-api.md:548` 의 「거는 오퍼레이션이 계약에 없다」가 **04 에서 거짓**이라는 것도 채택 — 다만 그 줄은
S21(=I-22) 자기 행이라 「01 의 사실을 S21 표에 옮겨 적은 것」이라는 §0 #1 의 설명은 틀렸다(Nit A-16).

> **Major A-2.** §0 #1 은 「두 곳이 「건다」」로 적었으나 자리 ① 은 **「걸고 푼다」**이고 「01 과 대칭」을 함께 말한다.
> 이 문장은 §6-2 의 **ⓒ안(걸고 곧바로 푼다)의 계약 근거**다 — 계획안도 §6-2 표에서 ⓒ 칸에 ⭕ 를 찍어 두고서
> §0 #1 에서는 그 절반을 지웠다. **§0 #1 의 인용을 원문 전문으로 바꾸고, ⓐ 를 고른 근거를 「계약 문자」가
> 아니라 「README §2 2단계 기준 1(재고를 덜 쓰는 쪽) + `M-04-01` §4-C」로 다시 세워야 한다.**
> ⇒ 뒤집기 비용이 작다는 §0 #1 의 판단은 유지한다. 판정 자체는 ⓐ 로 **유지**.

> **Major A-4.** ⓐ 를 고르면 `inventory_reservation` 행을 «만들어야» 하는데 계약 `InventoryReservation.warehouseId`
> 는 **required**(널 불가)다. 04 문서에는 창고 축이 **0개**(부록 #11 재확인 — `schema.prisma` 의 `shipment_request` 에
> `plant_id`·`warehouse_id` 없음)라 창고는 **잠근 잔액 행에서만** 온다. ⇒ §3-2 ⑩ 의 「(품목·LOT) 2행+ → 400」은
> 단순한 방어가 아니라 **「같은 제품 LOT 이 창고 둘에 있으면 그 LOT 은 영영 피킹할 수 없다」**는 운영 결론이다.
> 계획안은 이것을 「문의 031 의 04 판」이라고만 적었다 — **통보 후보 G 를 그 문장으로 세워야 한다.**

### 1-2. ⓶ — **채택.** 재측정 전건 일치

- `grep -rn 'picked_qty' prisma/migrations` ⇒ **7히트 전부 baseline** — `:1109`·`:1113`(`inventory_balance`,
  생성 컬럼 식) · `:1439`·`:1449`(`picking_line`, `ck_picking_qty`) · `:2839`·`:2850`(트리거) · `:3284`(뷰).
  `logistics.shipment_request_line` 에 **없다**(baseline `:2337-2363` DDL 전문 대조 · `schema.prisma` 모델 전문 대조).
- 04 의 9 오퍼레이션이 내리는 스키마 11개에서 `x-source-column` 은 **정확히 하나**뿐이다 —
  `ShipmentRequestLine.pickedQty -> picked_qty`. ⇒ 「가리킬 칸이 없는 `x-source-column`」이 다른 데 더 있지는 않다.
- 롤업의 원천이 되는 축도 성립한다: `ShipmentLinePickedLot` 은 `lotId`·`pickedQty`·`uomId`·`pickedAt` 넷이 required 이고
  `lotNo` 만 선택인데, 넷 다 `inventory_reservation` 에 있다(`lot_id`·`reserved_qty`·`uom_id`·`created_at`).
- `ix_reservation_source (source_document_type_code, source_document_id, status_code)` 실재(부록 #16 그대로).

> **Minor A-10.** 롤업식이 「예약 행 `reserved_qty` 합」인데, I-23 이 `released_qty` 를 올리는 갈래를 쓰면
> `pickedQty` 가 과대가 된다(계약은 「**누적** 피킹 수량 … 배정 잔여 = `allocatedQty − pickedQty`」). I-22 안에서는
> 푸는 경로가 0건이라 안전하다 — **§11 인계에 「I-23 이 `released_qty` 를 쓰면 롤업식이 `reserved − released` 로
> 바뀐다」 한 줄을 못 박아야** 그때 조용히 어긋나지 않는다.

### 1-3. ⓷ — **결론 채택 · 근거는 반증.** 01 은 409 를 «선언한다»

python 실측(`contracts/logistics-01자재창고.json` · `POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick`):

```
responses = ['200', '400', '403', '409']      # 404 는 «없다»
409.description = "저장 충돌. 다시 읽어 오면 풀린다"
409.schema      = #/components/schemas/ConflictResponse
```

> **Blocker A-1.** 계획안 **부록 #6** 「01 자재 피킹 `:pick` 은 **409 를 선언하지 않는다**(400·403·404 만)」는
> **두 조각 다 거꾸로다** — 409 를 선언하고, 404 를 선언하지 않는다.
> 더 나쁜 것은 **계획안이 근거로 댄 `I-8.md` 가 이미 옳게 적어 두었다**는 점이다 —
> `I-8.md:114`·`:120` 「200 `PickingLine` · **400 · 403 · 409**」 · §6-8 「404: 라인이 없거나 그 지시의 라인이 아닐 때」
> (I-8 은 **미선언 404 를 내기로** 판정했다). ⇒ **R-24 형**이다. §0 #3 의 「I-8 과 갈린다」 대조는 통째로 무너진다.
> 실측 부록이 「재측정하지 않는다」로 고정하는 표라 **이 한 줄이 구현 브리프까지 그대로 흘러간다.**

**그런데 결론은 살아남는다.** 계획안이 «안 쓴» 더 센 근거가 같은 파일에 있다 —
`ShipmentConflictResponse.x-internal-note` **원문**:

> 이름을 가른 이유: 앞 계열(app-공통·**logistics-01**·mdm)의 `ConflictResponse` 는 **저장 충돌의 «원인»만** 말하고,
> 이쪽은 **거부의 «업무 사유»**를 말한다. 두 축은 직교하며 겹치는 지점은 `VERSION_CONFLICT` ↔ `conflictCause=user` 하나다.

⇒ 01 의 409 는 **저장 충돌 봉투**(`ConflictResponse` = `conflictCause`+`message` 둘뿐, 업무 `code` 칸이 아예 없다)이고,
04 의 409 는 **업무 거부 봉투**(`code` required · enum 5값)다. 04 의 409 description 이 세 사유를 직접 적은 것과 합쳐
**「04 세 거부 = 409」는 성립한다. 채택.**

> **Major A-5.** 다만 계획안이 안 본 반대 신호가 **같은 04 파일 안에** 있다 — `ErrorItem.code` 의 `example` 이
> **`QTY_EXCEEDS_ALLOCATION`** 이고 `ErrorItem.field` 의 example 이 **`shippedQty`** 다. 즉 04 계약 스스로
> 「배정 초과」를 **400 필드 오류의 코드 이름**으로 한 번 적어 두었다. 그리고 `ShipmentConflictResponse.code` enum 은
> `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE`·`ALREADY_CONFIRMED`·`CANCEL_IN_PROGRESS` **다섯뿐**이라
> **세 사유가 전부 `INVALID_STATE` 하나로 접힌다** — POP 화면(`M-04-01`)이 「보류 LOT」·「가용 부족」·「배정 초과」를
> **자유 텍스트 `message` 파싱 말고는 가를 방법이 없다.**
> ⇒ §1-6 의 「새 코드 **0건**」은 「409 봉투가 새 코드를 실을 수 없어서」이지 「필요 없어서」가 아니다.
> **그 사실을 §1-6 에 적고 통보 후보로 올려야 한다**(아래 후보 **O**).

> **Minor A-11.** §3-4 의 「⚠ `conflictCause` 가 함께 실린다」는 실측 확인 ✓ —
> `src/common/errors/conflict.exception.ts:53-58` 이 언제나 `{conflictCause, message, ...extra}` 를 낸다.
> `conflictCause` 는 `ShipmentConflictResponse` 의 **선택·비널 칸**이고 `'user'` 가 enum 안이라 ajv 통과 ✓.
> 반면 `code` 는 **required** 인데 공용 예외는 `extra.code` 를 **선택**으로 둔다 — 04 의 모든 409 호출이
> `code` 를 명시로 넘겨야 한다. 계획안 본문에는 있으나 **§8 e2e 에 「409 응답에 `code` 가 실린다」 단언이 없다.**

### 1-4. ⓸ — **부분 반증(용어) · 실질 채택**

실측: `shippingInspectionStatusCode`(enum 5값)는 **`ShipmentRequest`(헤더)의 required 칸**이다.
`ShipmentRequestLine` 에는 **그 칸이 없고** `shippingInspectionRequired`(boolean) 하나뿐이다.

> **Minor A-9.** §0 #4 ⓑ 의 「`shippingInspectionStatusCode` 5값은 **라인 축**인데」는 틀렸다 — **헤더 축**이다.
> 라인별 판정은 계약 필드가 아니라 **롤업의 내부 중간값**이다. 실질(라인에 검사를 매다는 칸이 0개라 축을
> 골라야 한다)은 그대로 성립하므로 **§5-2 의 판정은 유지**하되, §0 #4·§5-2 의 문장을 「라인 축」 대신
> 「헤더 required 칸을 라인 롤업으로 만든다」로 고쳐야 한다. **응답 스키마 위험은 0** 이다(라인에 그 칸이 없어
> 뷰가 내릴 것이 없다).

부수 실측 — `quality-03품질.json` `InspectionRequest.targetTypeCode` enum = `LOT`·`WORK_ORDER`·`SHIPMENT_REQUEST`
**셋** ✓(부록 #20 일치) · description 이 「LOT(**OQC 제품 LOT**) … 출하 지시(`SHIPMENT_REQUEST` · OQC)」로 두 축을 다 적었다 ✓.
`ShipmentLotAllocation.oqcPassed` 의 「검사 대상이 아닌 배분은 **true** 로 내린다」도 원문 그대로 ✓.

### 1-5. ⓹ — **채택.** 네 사실 전건 실측 일치

| 사실 | 실측 |
|---|---|
| 04 `ShipmentLinePick.pickedQty` 에 `exclusiveMinimum` 이 **없다** | ✓ `{type:number, example:180, description:"이번에 집은 수량. 0 보다 커야 한다"}` — 키가 없다 |
| 01 `PickingLinePick.pickedQty` 에는 **있다** | ✓ `exclusiveMinimum: 0` |
| 04 응답 `ShipmentRequestLine.pickedQty` = **누적** | ✓ 「**누적** 피킹 수량. ⭐ 서버가 유지한다 … 배정 잔여 = allocatedQty − pickedQty」 |
| 01 은 **대체** | ✓ `PickingLine.pickedQty` 가 `x-source-column: picked_qty`(칸 그 자체) · 구현 `picking-pick.service.ts:46`「`picked_qty` 를 **대체**하고 그 차이만큼」·`:89` `delta = pickedQty.minus(line.picked_qty)` |

⇒ **I-21 R-15 와 방향이 반대**라는 계획안의 주장은 사실이다. 04 는 `pickedQty > 0` 에서 **서비스가 유일한 그물**이다. 채택.

같은 결의 자리를 하나 더 확인해 보강한다 — `ShipmentRequestLineCreate` 도 `requestedQty`·`allocatedQty`
둘 다 **최소값 키가 없다**. 물리는 `requested_qty > 0` CHECK 는 있으나(**baseline `:2344`**)
**`allocated_qty > 0` CHECK 는 없다**(`allocated_qty app.qty_t NOT NULL DEFAULT 0` · `ck_shipment_request_qty` 는
`shipped ≤ allocated ≤ requested` 만 본다). ⇒ **`allocatedQty > 0` 은 계약도 물리도 안 막는 «순수 서버 규칙»이다** —
§1-3 표의 판정 그대로이고 통보 후보 J 가 그 자리다 ✓.
반대로 `ShipmentRequestCreate.lines` 의 `minItems: 1` 은 **계약에 실재**하므로 「죽은 절 — 서비스에서 다시 세지
않는다」도 ✓(가드가 본문을 ajv 로 검증한다 · `contract-validation.guard.ts:39`).

### 1-6. ⓺ — **유지.** 다만 §0 #1 의 근거 배치가 바뀐다

§1-1 Major A-2 로 옮겨 적었다. ⓐ/ⓒ 선택 자체는 API 관점에서 **응답이 갈리지 않는다** —
`ShipmentRequestLine.pickedQty`·`picks[]` 는 어느 안이든 예약 행에서 나고, `inventory_balance` 는 04 의
어느 응답에도 실리지 않는다. ⇒ **계약 정합만 보면 ⓐ·ⓒ 는 등가**이고, 갈림은 통합 관점의 몫이다. **유지.**

### 1-7. ⓻ — **채택 + ⭐⭐ 계획자가 «더 큰» 함정을 놓쳤다**

**채택되는 부분** — `ShipmentRequest.shipmentProgressCode.description` 원문에 판정식과 순서가 **문장으로** 있다:

> NOT_ALLOCATED=배정 합 0 · PARTIALLY_ALLOCATED=0 보다 크고 요청 합보다 작은 배정 합 ·
> **PICKING=배정 합이 요청 합과 같고 피킹 합이 배정 합보다 작다** · PICKED=피킹 합이 배정 합과 같고 출하 합 0 ·
> PARTIALLY_SHIPPED=출하 합이 0 보다 크고 배정 합보다 작다 · SHIPPED=출하 합이 배정 합과 같다.
> ⭐ **판정 순서는 뒤가 이긴다** — NOT_ALLOCATED, PARTIALLY_ALLOCATED, PICKING, PICKED, PARTIALLY_SHIPPED, SHIPPED.

⇒ 「값 이름이 그대로 말한다」(`plan-integration.md:399`)가 부족하다는 지적 ✓ · **`PICKING` 함정 사실** ✓
(부분 배정 `A < R` 이면 `PICKING` 이 영영 참이 안 된다). **채택.**

> **Blocker A-3 — `NOT_ALLOCATED` 가 도달 불가다. 그리고 계획안의 e2e 가 그것과 «모순»된다.**
> 계약 문자를 그대로 계산하면 `A = 0`(`R > 0` · `P = 0` · `S = 0`)일 때:
>
> | 값 | 식 | 참? |
> |---|---|:-:|
> | `NOT_ALLOCATED` | `A = 0` | ✓ |
> | `PARTIALLY_ALLOCATED` | `0 < A < R` | ✕ |
> | `PICKING` | `A = R ∧ P < A` | ✕ |
> | **`PICKED`** | `P = A ∧ S = 0` → `0 = 0 ∧ 0 = 0` | **✓ 공허참** |
> | `PARTIALLY_SHIPPED` | `0 < S < A` | ✕ |
> | **`SHIPPED`** | `S = A` → `0 = 0` | **✓ 공허참** |
>
> 「**뒤가 이긴다**」이므로 답은 **`SHIPPED`** 다. ⇒ 계약 문자 아래에서 **`NOT_ALLOCATED` 는 어떤 데이터로도
> 나오지 않는 죽은 값**이고, 질의 `shipmentProgressCode=NOT_ALLOCATED` 는 **영영 빈 목록**이다.
>
> 그리고 계획안이 §5-1 에 적은 구현(**「역순 if 사슬 — `SHIPPED` → … → `NOT_ALLOCATED`」**)은 정확히 그렇게 돈다:
> `SHIPPED` 를 먼저 재고 `S = A → 0 = 0` 이 참이라 **그 자리에서 `SHIPPED` 를 반환**한다.
> 그런데 §8-0 픽스처는 **`SR-F`: `A = 0` → `NOT_ALLOCATED`** 로 적었고 §8-2 **L-14~L-19** 는 「6값 **전건**」을 단언한다.
> ⇒ **계획서가 스스로 못 지키는 e2e 를 적었다.** `SR-F` 는 구현대로면 `SHIPPED` 를 받아 **반드시 빨개진다.**
>
> **닫는 법(둘 중 하나를 §5-1 에서 정해야 한다):**
> ⓐ `A = 0` 을 **맨 먼저** 잘라 `NOT_ALLOCATED` 를 낸다(= 「뒤가 이긴다」에서 벗어나는 **유일한 예외**를 명시).
> ⓑ 계약 문자를 그대로 따르고 `NOT_ALLOCATED` 가 죽은 값임을 통보한다.
> README §2 2단계 기준 4(「값을 조용히 도출하지 않는 쪽」)와 기준 2 를 보면 **ⓐ + 통보**가 맞다 —
> `W-04-02` 「상태」 드롭다운에 `NOT_ALLOCATED` 가 있는데 늘 0건이면 화면이 못 쓴다.
> ⇒ **통보 후보 N**(§4).

> **Major A-6 — `SR-B` 픽스처가 축을 하나만 갖는다(§6-3 ⑵).** §8-0 은 `SR-B` 를 「`0 < A < R`(부분 배정) →
> `PARTIALLY_ALLOCATED`」로만 적었다. 그런데 부분 배정이어도 **`P = A` 가 되면 `PICKED` 가 이긴다**(계획안 §5-1 이
> 스스로 「`PICKED`·`PARTIALLY_SHIPPED`·`SHIPPED` 가 나중에 이긴다」라 적었다). ⇒ **L-20**(「부분 배정은 피킹해도
> `PARTIALLY_ALLOCATED` 다」)이 성립하려면 픽스처가 **`0 < P < A` 를 못 박아야** 한다. 지금 문장대로면 `P` 가
> 미정이라 시험이 무엇을 죽이는지 정해지지 않는다.

---

## 2. 널 정책 — **전수**(브리프 ⭐ · I-21 R-13 자리)

9 오퍼레이션의 응답 스키마 그래프를 **전건 순회**했다(에러 봉투·페이지 메타·인라인 `match` 포함).

### 2-1. 널을 «못 받는» 선택 칸 ⇒ **키 생략** — 실측 **13**개

| # | 칸 | 계획안 |
|:-:|---|:-:|
| 1 | `SalesOrder.erpSalesOrderNo` | ⭕ |
| 2 | `SalesOrder.lines` | ⭕ |
| 3 | `SalesOrder.versionNo` | ⭕ |
| 4 | `SalesOrderLine.requestedDeliveryDate` | ⭕ |
| 5 | `ShipmentRequest.lines` | ⭕ |
| 6 | `ShipmentRequest.versionNo` | ⭕ |
| 7 | `ShipmentLinePickedLot.lotNo` | ⭕ |
| 8 | `ShipmentLotAllocation.lotNo` | ⭕ |
| 9 | `match`(객체 자체) | ⭕(§1-2 ⑥) |
| **10** | ⭐⭐ **`match.reasonCode`** | ⛔ **계획안은 「널을 «받는» 칸」으로 적었다 — 반대다**(Blocker A-7) |
| **11** | `ErrorItem.field` | ⛔ 빠졌다 |
| **12** | `ErrorItem.uniqueScope` | ⛔ 빠졌다 |
| **13** | `ShipmentConflictResponse.currentVersion` | ⛔ 빠졌다(공용 예외가 `undefined` 면 이미 생략한다 — 무해하지만 명시가 필요) |

(`ShipmentConflictResponse.conflictCause` 도 선택·비널이나 계획안이 「언제나 싣는다」로 이미 처리했다 ✓ — enum 안 값이라 통과.)

### 2-2. ⭐⭐ Blocker A-7 — `match.reasonCode: null` 은 **ajv 가 깨진다**

계약 실측:

```json
"reasonCode": {
  "type": ["string","null"],
  "enum": ["LABEL_ITEM_MISMATCH","LOT_NOT_ALLOCATED"],   // ⛔ null 이 enum 에 «없다»
  "x-code-key": "CD-SHIPMENT-LOT-MATCH-FAIL-REASON",
  "description": "… matched 가 참이면 null 이다."          // ⛔ enum 과 모순
}
"required": ["matched"]                                    // reasonCode 는 선택이다
```

저장소의 e2e ajv 설정 그대로(`ajv/dist/2020` · `{strict:false, allErrors:true}` + `ajv-formats` +
int64/double 등 6포맷 · `test/logistics-picking.e2e-spec.ts:44-48` 과 동일) 컴파일해 **실행**했다:

| 응답 | 결과 |
|---|---|
| `{matched:true, reasonCode:null}` | ⛔ **FAIL** — `keyword:"enum"`, `allowedValues:["LABEL_ITEM_MISMATCH","LOT_NOT_ALLOCATED"]` |
| `{matched:true}`(키 생략) | ⭕ PASS |
| `{matched:false, reasonCode:'LOT_NOT_ALLOCATED'}` | ⭕ PASS |
| `match` 키 자체 생략 | ⭕ PASS |

⇒ 계획안 **§1-4-0 표**(「`match`(2칸) 널 받는 = `reasonCode`」) · **§1-2 ⑥ 각주**(「`matched=true` 면 **`null`**
(계약 명시 — **키 생략이 아니다**)」) · **§4-4**(「`{matched:true, reasonCode:null}`」) · **e2e A-14**
(「`reasonCode` 를 **생략하면** ajv 가 깨진다」)가 **전부 정확히 거꾸로다.**
그대로 구현하면 A-14 가 아니라 **A-1·A-14 두 시험이 실제로 빨개진다**(A-1 이 목록 응답을 ajv 로 본다).

**닫는 값** — `matched=true` 면 **키를 생략**한다. 그리고 이것은 **계약 자기 모순**이므로 통보 후보 **M**(§4).

### 2-3. 널을 «받는» 칸 — 실측 **6**(계획안 표는 7을 적고 문장은 6이라 적었다)

`ShipmentRequest.salesOrderId` · `ShipmentRequest.timeSlotCode` · `ShipmentRequestLine.salesOrderLineId` ·
`ShipmentRequestLine.customerLotRequirement` · `ShipmentRequestLine.minimumRemainingShelfLifeDays` ·
`ShipmentLotAllocation.handlingUnitId`.
⇒ `match.reasonCode` 를 §2-2 대로 빼면 **문장의 「6칸」이 맞고 표가 한 줄 많다.** 표를 고친다.

### 2-4. 부수 — 칸 수 오측 4건 · 선례 인용 오류 1건

> **Minor A-12.** §1-4-0 의 프로퍼티 수가 넷 틀렸다 — `SalesOrder` **7→9** · `ShipmentRequest` **10→12** ·
> `ShipmentRequestLine` **12→13** · `ShipmentLotAllocation` **12→13**. 분류(널 받음/키 생략)는 다 맞으므로
> 판정은 안 바뀌지만, **전수 셌다는 표에서 넷이 틀린 것은 §6-3 ⑵ 가 겨눈 「축 수를 안 센다」와 같은 결**이다.
> (`SalesOrderLine` 7 ✓ · `ShipmentLinePickedLot` 5 ✓ · `ShipmentRequestSummary` 8·**전건 required** ✓)

> **Nit A-17.** 「키를 생략한다」의 선례로 든 `picking-view.ts:12-16`·`goods-issue-view.ts:77` 은 **반대쪽 절반의
> 선례**다 — `picking-view.ts:10-12` 원문이 「⛔ 널이어도 **키를 생략하지 않는다** … 전부 계약이 `null` 을 허용한 칸이다
> (`goods-issue-view.ts:77` 선례 · I-8.md R-20)」다. 키 생략의 선례와 **공용 헬퍼**는 따로 있다 —
> `src/common/http/omit-empty.ts:5` 의 `omitEmpty` (`nonconformance-view.ts:63`·`lot-hold-view.ts:31`·
> `precheck-decision-view.ts:10` 등). §7-1 의 뷰 줄 수(140+75)도 그 헬퍼를 쓰면 줄어든다.

---

## 3. 관점별 전수 점검표 — 계약 정합

### 3-1. 횡단 4축 — **전건 재측정 일치**

python 으로 9 오퍼레이션의 `responses[*].headers` 를 훑었다 ⇒ **한 건도 없다** ⇒ **ETag 0** ✓(부록 #5).
`parameters` 의 `$ref` 도 전건 대조:

| 오퍼레이션 | `Idempotency-Key` | `X-Worker-No` | 선언 응답 |
|---|:-:|:-:|---|
| `GET /logistics/sales-orders` | — | — | **200 만** |
| `GET /logistics/sales-orders/{salesOrderId}` | — | — | 200·404 |
| `GET /logistics/shipment-requests` | — | — | **200 만** |
| `GET /logistics/shipment-requests/summary` | — | — | **200 만** |
| `GET /logistics/shipment-requests/{shipmentRequestId}` | — | — | 200·404 |
| `GET /logistics/shipment-lot-allocations` | — | — | **200 만** |
| `POST /logistics/shipment-requests` | ✓ | **—** | 201·400·403·409 |
| `POST …/lines/{…}:pick` | ✓ | ✓ | 200·400·403·404·409 |
| `PUT /logistics/shipment-lot-allocations/{…}` | ✓ | ✓ | 200·400·403·404·409 |

⇒ §1-1 표 **전건 일치** ✓. `IfMatchVersion`·`IfMatchVersionOptional` 참조 **0건** ✓.
`X-Worker-No` 는 `required: true`·`maxLength: 50`·`pattern` 없음.

> **Nit A-18.** 헤더 `maxLength: 50` 을 계획안이 안 적었다. 가드는 헤더를 안 보므로(§3-4 #2 ✓ 실측 확인 —
> `contract-validation.guard.ts:36-39` 가 body·query·params 만 넘긴다) **서버가 유일한 그물**인데, 저장소의
> 「읽고 버림」형 8벌 중 길이를 보는 것이 0개다. 04 에서 새로 세울 필요는 없다(전례를 복제한다) — 사실만 남긴다.

### 3-2. 질의 파라미터 — **수가 둘 틀렸다**

| 오퍼레이션 | 계획안 | **실측** |
|---|:-:|:-:|
| `GET /logistics/sales-orders` | 8 | **8** ✓ |
| `GET /logistics/shipment-requests` | 13 | ⛔ **14** |
| `GET /logistics/shipment-requests/summary` | 11 | **11** ✓ |
| `GET /logistics/shipment-lot-allocations` | 9 | ⛔ **10** |

> **Minor A-13.** 계획안 §1-2 는 **행 수**를 세고 **파라미터 수**로 적었다(`customerId`·`shipToPartnerId` 를 한 줄,
> `page`·`size` 를 한 줄로 묶었다). 그 탓에 §1-2 ④ 의 산술이 깨진다 — 「**목록 13** 에서 정확히 **셋**이 빠졌다」인데
> `13 − 3 = 10 ≠ 11` 이다. **실측은 `14 − 3 = 11`** 이고 빠진 셋은 `page`·`size`·`sort` 로 계획안 결론과 같다.
> ⇒ **결론은 유지, 숫자만 고친다.** 배분 목록도 9→10.

축 자체는 전건 일치 ✓ — `statusCode` 가 「⛔ 이 축으로는 거를 수 없다」로 남아 있는 것 ✓ ·
`shipmentProgressCode` 가 **목록·요약 둘 다에 enum 으로** 실린 것 ✓(부록 #4) ·
`sort` 가 목록에만 있고 요약에는 없는 것 ✓ · `shipDateFrom` 이 **목록·요약 둘 다** 「필수 — 공유계약 L-3」인 것 ✓.

### 3-3. ⭐ 400 미선언 — 계획안이 한 계열만 봤다

목록·요약·배분목록·지시서목록 넷은 **`200` 만** 선언한다. 그런데 계획안이 세우는 400 은 **세 계열**이다:

| 계열 | 어디 | 계획안 |
|---|---|:-:|
| `shipDateFrom` 부재 → 400 `REQUIRED` | 목록 · **요약** | 목록만 적었다(§4-2) |
| `sort` 화이트리스트 밖 → 400 `INVALID` | 목록(e2e **L-36**) | §9-3 ⓗ·후보 L 에 없다 |
| **계약 가드 자신**(enum 밖 `shipmentProgressCode`·타입 강제 실패) → 400 | 네 목록 전부(e2e **L-22**) | 없다 |

> **Major A-8.** ⓐ **§4-3(요약)이 `shipDateFrom` 필수를 아예 안 적었다** — 계약 요약 파라미터 description 이
> 「필수 — 공유계약 L-3. **목록과 같은 기준을 쓴다**」라 못 박았고 `plan-uiux.md:918` L-3 목록도 목록 쪽을 적었는데,
> §8-2 에 요약용 400 e2e 가 **0건**이다(L-2 는 목록만). ⇒ **「요약도 `shipDateFrom` 없으면 400」 한 줄 + e2e 한 건**을
> §4-3·§8-2 에 더해야 한다. ⓑ **통보 후보 L 을 세 계열로 넓혀야 한다** — 지금 문안(「`shipDateFrom` 을 필수라
> 적어 놓고 400 을 안 실었다」)은 셋 중 하나만 말한다.

(참고 — 저장소는 **미선언 상태 코드를 내는 선례가 이미 있다**: I-8 이 01 `:pick` 의 미선언 404 를 냈다(`I-8.md` §6-8).
계획안의 「400 을 낸다」 판정 자체는 **채택**.)

### 3-4. 권한 · 403 — **「수정 0줄」 채택. 미선언은 계획안이 말한 것보다 넓다**

실측(`src/common/permissions/derived-permissions.ts`):

```
:63  'GET /logistics/sales-orders':                          ['W-04-01']
:64  'GET /logistics/sales-orders/{salesOrderId}':           ['W-04-01']
:65  'GET /logistics/shipment-lot-allocations':              ['M-04-04','P-04-01']
:66  'GET /logistics/shipment-requests':                     ['M-04-01','W-04-02','W-04-04','W-04-05']
:67  'GET /logistics/shipment-requests/{shipmentRequestId}': ['W-04-04']
:180 'POST /logistics/shipment-requests':                    ['W-04-01']
:181 'POST …/lines/{shipmentRequestLineId}:pick':            ['M-04-01']
:265 'PUT /logistics/shipment-lot-allocations/{…}':          ['P-04-01']
```

- ⭐ **403 을 선언한 셋이 전부 등재돼 있다** ⇒ `manual-permissions.ts` **0줄** · `operation-permissions.spec.ts` 무변 —
  그 spec 은 `declares403` **250**(계약 고정) 과 `covered.length >= 152` 만 본다(`operation-permissions.spec.ts:57-68`).
  ⇒ **§0/§7-4 의 「권한 표 수정 0줄」 채택.** `permission.guard.ts:39` 가 「403 을 선언한 자리에서만」 보므로 정확하다.
- **403 을 «미선언»한 오퍼레이션은 9 중 6 — 조회 전건**이다.

> **Minor A-14 — §9-3 ⓔ 의 사실이 틀렸다.** 계획안은 「`summary` **만** 두 표 어디에도 키가 없다」로 적고
> 그 자리를 특별한 것처럼 다뤘다. 실측은 **여섯 조회가 전부 403 미선언**이고 **그중 다섯이 이미 `DERIVED_PERMISSIONS`
> 에 행을 갖고 있다**(위 `:63~:67`). 그 다섯 행은 가드가 영영 읽지 않는 **죽은 행**이다 — 계획안이 ⓔ 에서
> 「수동표에 넣으면 e2e 로 영영 반증 불가」라 한 바로 그 상태에 **이미 다섯이 놓여 있다.**
> ⇒ **결론(아무것도 더하지 않는다)은 채택.** 다만 ⓔ 문장을 「여섯 조회가 전부 무가드이고 다섯 행은 이미 죽어 있다.
> `summary` 만 도출표가 빠뜨렸을 뿐이며, 더해도 무효라 안 더한다」로 고쳐야 통보·인계에서 오해가 안 난다.

> **Minor A-15 — 403 e2e 가 한 건뿐이고 그것도 겨냥이 흐리다.** §8 전체에서 403 을 단언하는 것은 **A-24**
> (「`X-Worker-No` 없음 → 400 · **권한 없음 → 403**」) 하나다. 그 파일은 GET(403 미선언 · 가드가 안 본다)과
> PUT(403 선언)을 함께 담으므로 **403 단언이 PUT 을 겨눈다고 명시**해야 한다 — GET 에 걸면 200 이 와서
> 시험이 뒤집힌다. 그리고 **`POST /logistics/shipment-requests` 와 `:pick` 에 403 단언이 0건**이다(둘 다 가드 대상).
> §8-3·§8-4 에 한 줄씩 더한다.

### 3-5. 페이지네이션 · 봉투 — 이상 없음

- 목록 셋의 200 스키마가 전부 `required: ["items","page"]` ✓ · `PageMeta.required = ["page","size","total"]` ✓.
- 배분 목록만 `match` 를 **선택 키**로 더 갖는다 ✓(§2-1 #9).
- 요약은 래퍼 없이 `ShipmentRequestSummary` 를 그대로 낸다 ✓ · **8칸 전건 required** ✓ ⇒ §4-3 의
  `coalesce(sum(...),0)` 요구가 옳다 ✓(README §6-3 ⑷ 자리 — 계획안이 미리 겨눴다).
- 요약이 `page`·`size`·`sort` 를 받아도 무시하는 것이 **안전하다** ⇒ e2e **L-45 성립** ✓ —
  `contract-validator.ts:124-126` 이 「계약에 없는 질의 파라미터는 막지 않는다」로 못 박았다.

### 3-6. §8 e2e — 「죽이는 변이」 짝 표본 검증

| e2e | 짝이 성립하나 | 근거 |
|---|:-:|---|
| **A-14** | ⛔ **거꾸로** | §2-2 — ajv 실행으로 반대가 증명됐다(**Blocker A-7**) |
| **L-14~L-19 + `SR-F`** | ⛔ **성립 불가** | §1-7 — 계획서 자신의 구현이 `SHIPPED` 를 낸다(**Blocker A-3**) |
| **L-20 + `SR-B`** | ⚠ 미정 | §1-7 — 픽스처가 `P` 를 안 정했다(**Major A-6**) |
| **L-42** | ⛔ **죽일 변이가 없다** | 아래 **Major A-19** |
| L-41(0건 합계 `0`) | ⭕ | 요약 8칸 전건 required 실측 ✓ |
| L-45(요약이 page/size/sort 무시) | ⭕ | `contract-validator.ts:124-126` ✓ |
| L-22(enum 밖 → 400) | ⭕ | 질의 enum 이 실재해 가드가 컴파일한다 ✓ (다만 §3-3 의 미선언 400) |
| S-2(`erpSalesOrderNo` 키 생략) | ⭕ | `type: string`(비널)이라 `null` 이면 ajv FAIL ✓ |
| A-1(`handlingUnitId` 는 `null`) | ⭕ | `type: ['integer','null']` ✓ |
| P-31(`version_no` 안 오른다) | ⭕ | `shipment_request.version_no` 물리 실재 ✓ |
| P-10/P-11(`pickedQty ≤ 0` → 400) | ⭕ | `exclusiveMinimum` 부재 실측 ✓ — 서비스가 유일한 그물 |

> **Major A-19 — L-42 는 어떤 픽스처로도 반증되지 않는다.** 「`unallocatedQtyTotal` = `Σ(요청−배정)` 이다 |
> 두 합의 차로 바꿔도 같은 값이라 ⚠ — **라인이 여럿이고 일부만 부분 배정인 픽스처**로 가른다」라 적었는데,
> `Σ(Rᵢ − Aᵢ) ≡ ΣRᵢ − ΣAᵢ` 는 **모든 픽스처에서 항등**이다(합의 선형성). 라인이 몇이든, 부분 배정이 몇이든 갈리지 않는다.
> 널 갈래도 같다 — 0행이면 양쪽 다 `NULL → coalesce → 0`.
> ⇒ **§6-3 ⑵ 가 겨눈 「값이 한 종류뿐인 축」의 순수한 형태**다. L-42 를 지우고, 그 자리를 계약이 실제로 요구하는 것
> (「⛔ 화면이 두 합을 받아 다시 빼지 않는다」 = **응답에 칸이 실린다**)을 죽이는 단언으로 바꾼다 — 즉
> **「`unallocatedQtyTotal` 키가 응답에 있고 값이 맞다」**(required 8칸 중 하나를 빼면 깨진다). 계산식 비교는 못 한다.

---

## 4. 계획자가 안 본 자리 (API)

1. ⭐⭐ **`match.reasonCode` 의 enum ↔ description 모순** — 계약 자기 모순이고 ajv 가 실제로 깬다(§2-2 · Blocker A-7).
2. ⭐⭐ **`NOT_ALLOCATED`·`PICKED` 의 공허참** — 「뒤가 이긴다」가 `A = 0` 에서 `SHIPPED` 를 낸다(§1-7 · Blocker A-3).
3. **`ErrorItem.code` 예시 `QTY_EXCEEDS_ALLOCATION` + `field: shippedQty`** — 04 자신이 「배정 초과」를 400 코드로
   한 번 적었다. 409 봉투의 enum 5값에는 그 코드가 없어 세 사유가 `INVALID_STATE` 하나로 접힌다(§1-3 · Major A-5).
4. **요약의 `shipDateFrom` 400** — §4-3 에 없고 e2e 0건(§3-3 · Major A-8 ⓐ).
5. **400 미선언이 세 계열**이다 — 필수 기간 · 정렬 화이트리스트 · **계약 가드 자신**(§3-3 · Major A-8 ⓑ).
6. **403 미선언이 조회 여섯 전건**이고 **그중 다섯이 이미 죽은 도출 행을 갖고 있다**(§3-4 · Minor A-14).
7. **`POST`·`:pick` 에 403 e2e 가 0건** · A-24 의 403 겨냥이 흐리다(§3-4 · Minor A-15).
8. **`InventoryReservation.warehouseId` 가 required** 인데 04 문서에 창고 축이 0 ⇒ 「(품목·LOT) 2행+ → 400」은
   **「그 LOT 은 영영 피킹 불가」**라는 운영 결론이다(§1-1 · Major A-4).
9. **`ShipmentConflictResponse.code` 가 required 인데 공용 예외는 선택**이다 — 409 e2e 에 `code` 단언이 없다(Minor A-11).
10. **`omitEmpty` 헬퍼**(`src/common/http/omit-empty.ts:5`)를 안 썼고 널 선례를 반대쪽으로 인용했다(Nit A-17).
11. **스키마 칸 수 4건 · 질의 수 2건 오측**(Minor A-12·A-13).
12. **`shipment_request_line.version_no` 가 물리에 실재**한다(`schema.prisma` · baseline `:2358`). 04 는 If-Match 0 이라
    안 올려도 되지만, I-8 은 **`picking_line.version_no` 를 If-Match 토큰으로 썼다**(`I-8.md` §6-8) — 04 가 라인
    `version_no` 를 «안 움직인다»는 판정을 **§3-2 에 한 줄로** 못 박아야 한다(P-31 은 헤더만 본다). ⇒ **Minor A-20.**
13. **상세 응답의 N+1** — `ShipmentRequestLine.pickedQty`·`picks` 가 **둘 다 required** 라 상세는 라인마다 예약 롤업을
    해야 한다. 계획안은 롤업의 «식»만 적고 **질의 형태**(라인 id 집합으로 `groupBy` 한 번인지, 라인당 조회인지)를
    안 적었다. `ix_reservation_source` 는 `(type, id, status)` 라 **`source_document_id IN (…)`** 한 번이 탄다. ⇒ **Minor A-21.**
14. `SalesOrder.statusCode` 의 `x-no-code-key` 가 「등록·수정 경로가 없다 — 상태를 «올릴» 주체가 MES 안에 없다」라
    적었다 ⇒ §1-4-1 의 「ERP·엑셀이 넣은 값을 그대로 내린다」 **채택**(확인 도장).

---

## 5. PR 분할·줄 예산 — **7 → 8 로 늘려야 한다**

**PR 수를 3 에서 늘리는 판정 자체는 채택**한다(§7-1 파일별 근거가 비슷한 기존 파일 실측이라 견고하다).
다만 산술이 두 군데 안 맞는다.

| PR | 계획안 | **재계산**(§7-1 파일 합) | 판정 |
|:-:|--:|--:|---|
| ① 코어 | 124 | 70+30+12+2+10 = **124** | ⭕ 200 한도 안 |
| ② 마이그+지시서 | 280 | 35+6+50+115+65 (+모듈) ≈ **280** | ⭕ |
| ③ 상세+파생축 | 340 | 140+130 + 컨트롤러 몫 ≈ **310~340** | ⚠ 350 예산에 **10** 만 남는다 |
| ④ 목록+요약 | 300 | 210 + 컨트롤러 몫 ≈ **250~300** | ⭕ |
| ⑤ 편성 POST | 300 | 195+14 + 컨트롤러 몫 ≈ **250~300** | ⭕ |
| ⑥ `:pick` 심장 | 280 | 230 + 컨트롤러 몫 ≈ **260~280** | ⭕ |
| **⑦ 배분 2건** | **360** | 60+165+75+125 (+모듈) = **425+** | ⛔ **350 예산 초과 · 계획안 숫자와 65 차이** |
| 합 | **1,984** | §7-1 총계 **1,886** | ⛔ **98 어긋난다** |

> **Major A-22.** ⑦ 을 **⑦a / ⑦b 로 가른다** ⇒ **8 PR**.
> - **⑦a** `GET /logistics/shipment-lot-allocations`(원시 SQL · `q`/`lotQ`/`match`) + 뷰 ≈ **300** — ③ 뒤(`oqcPassed` 가 롤업을 쓴다).
> - **⑦b** `PUT …/{id}`(포장 연결) + M4 마디 e2e + §12 마감표 ≈ **145** — **롤업과 무관하다.** `oqcPassed`·`packedQty` 를
>   내리는 뷰는 ⑦a 가 이미 세우므로 ⑦b 는 ⑦a 뒤에 두되, **스택 깊이를 늘리지 않는다**(③ → ⑦a → ⑦b).
>
> **Minor A-23.** ③ 이 340 이면 리뷰 수정분 자리(§6 「+20~30」)가 없다. `shipment-request-progress.ts`(~130)의
> **검사 롤업 부분(§5-2)을 ④ 로 미루면** ③ 은 진행 6값만 지고 ~250 이 된다 — ④ 의 목록이 두 파생 축을 다 쓰므로
> 경계가 자연스럽다. (⑦a 의 `oqcPassed` 는 그러면 ④ 뒤가 된다 — 스택은 ② → ③ → ④ → {⑤ ∥ ⑦a} → {⑥ ∥ ⑦b}.)

나머지 §10 판정은 채택 — ①·⑥ 을 R-n 확정 뒤에만 띄우는 것 ✓ · 마이그를 ② 안의 선행 커밋으로 두는 것(R-8) ✓ ·
④ 를 리뷰 라운드와 나란히 띄우는 것은 ⛔ **하지 마라** — ④ 가 `shipmentProgressCode`(Blocker A-3 의 자리)를 쓴다.

**§10-1 통합 계획서 대조표** — 10행 중 아홉은 실측 일치. 3행(`plan-api.md:548` 거짓)은 §1-1 대로 **채택하되 문구 수정**,
5행(`plan-integration.md:399` 부족)은 **채택 + Blocker A-3 을 함께 실어야** 「부족하다」의 실제 크기가 드러난다.

---

## 6. 통보 후보 (⛔ 번호 없음 — 통합자가 준다)

**기존 A~L 에 대한 판정**

| 후보 | 판정 |
|:-:|---|
| A(예약 판별자 `SHIPMENT_REQUEST_LINE`) | **유지** — `InventoryReservation.sourceDocumentTypeCode` enum 이 `["PRODUCTION_ORDER"]` 하나 · description 「가리킬 표가 늘면 계약을 고친다」 실측 ✓ |
| B(`SR` 접두어 충돌) | **유지** — `numbering.service.ts:24` 의 `SHOPFLOOR_RECEIPT:'SR'` 실측 ✓. `SHIPMENT_REQUEST`·`INVENTORY_RESERVATION` 접두어는 **둘 다 아직 없다** ✓ |
| C(`pickedQty` 칸 0개) | **유지** ✓ |
| D(납품라벨 칸 0개) | **유지** ✓ |
| E(부분 포장 불가) | **유지** ✓ |
| F(검사 롤업 축) | **유지** — 다만 「라인 축」→「헤더 required 칸」으로 문구 수정(§1-4) |
| G(창고 축 0개) | **강화 필요** — 「(품목·LOT) 잔액이 둘이면 **그 LOT 은 영영 피킹 불가**」를 본문에 넣는다(Major A-4) |
| H(`businessDate` 부재) | **유지** ✓ |
| I(`statusCode` 상수) | **유지** ✓ |
| J(「배정 수량 ≥ 1」) | **유지 + 보강** — 물리에 `allocated_qty > 0` CHECK 가 **없다**는 사실을 함께 적는다(§1-5) |
| K(되돌리는 오퍼레이션 0건) | **유지** ✓ |
| L(목록 400 미선언) | **넓혀야 한다** — 세 계열(필수 기간 · 정렬 · 계약 가드) · **요약도 같다**(Major A-8) |

**새 후보(내가 낸 것)**

| 후보 | 제목 | 한 줄 요지 |
|:-:|---|---|
| **M** | `match.reasonCode` 가 「참이면 null」이라 적혔는데 enum 에 `null` 이 없다 | `GET /logistics/shipment-lot-allocations` 200 의 `match.reasonCode` 는 `type:["string","null"]` 이면서 `enum:["LABEL_ITEM_MISMATCH","LOT_NOT_ALLOCATED"]` 라 **`null` 을 실으면 ajv 가 깨진다**. 서버는 `matched=true` 일 때 **키를 생략**한다 |
| **N** | 「뒤가 이긴다」가 `shipmentProgressCode` 의 `NOT_ALLOCATED` 를 도달 불가로 만든다 | 배정 합 0 이면 `PICKED`(`P=A ∧ S=0`)·`SHIPPED`(`S=A`)가 **공허참**이라 뒤가 이겨 `SHIPPED` 가 나온다. `W-04-02` 「상태」 드롭다운의 `NOT_ALLOCATED` 가 영영 0건이 된다 — 서버는 **`A = 0` 을 먼저 잘라** `NOT_ALLOCATED` 를 낸다(계약 문자에서 벗어나는 유일한 자리) |
| **O** | 제품 피킹의 세 거부가 409 봉투에서 한 값으로 접힌다 | `ShipmentConflictResponse.code` enum 5값에 「보류」·「가용 부족」·「배정 초과」를 가를 값이 없어 셋 다 `INVALID_STATE` 다. 정작 같은 계약의 `ErrorItem.code` 예시는 **`QTY_EXCEEDS_ALLOCATION`**(400 필드 오류)이다 — POP 화면이 자유 텍스트 `message` 말고는 사유를 못 가린다 |

---

## 7. 내가 실제로 연 파일 · 돌린 명령

**계약(python 파싱 · 읽기 전용 · `contracts:update`/`check` 0)**
`contracts/shipment-04제품출하.json`(9 오퍼레이션 전건 · `description`/`x-internal-note`/`parameters`/`responses`/
`headers` · 스키마 11개의 `properties`·`required`·`enum`·`type`·`x-source-column`·`x-code-key` 전수 · 응답 스키마
그래프 재귀 순회) · `contracts/logistics-01자재창고.json`(`:pick` 3건 · `PickingLinePick` · `PickingLine` ·
`InventoryReservation` · `ConflictResponse`) · `contracts/quality-03품질.json`(`InspectionRequest.targetTypeCode`) ·
`contracts/COMMIT.txt`

**ajv 실행 1건** — `node` 로 `ajv/dist/2020`(`{strict:false, allErrors:true}` + `ajv-formats` + int64 등 6포맷,
`test/logistics-picking.e2e-spec.ts:44-48` 과 동일 설정)에 배분 목록 200 스키마를 컴파일해 `match.reasonCode`
네 경우를 판정(§2-2 표).

**소스**
`src/core/inventory-posting/inventory-posting.service.ts`(:30-60) · `reservation-qty.ts`(:1-50) · 디렉터리 목록 ·
`src/common/permissions/{derived-permissions.ts(grep),operation-permissions.ts,operation-permissions.spec.ts(:1-80),
permission.guard.ts(:1-60),manual-permissions.ts(grep)}` ·
`src/common/contract/{contract-validation.guard.ts,contract-validator.ts(:100-160)}` ·
`src/common/errors/conflict.exception.ts` · `src/common/http/omit-empty.ts` · `src/common/pagination/pagination.ts`(grep) ·
`src/logistics/picking/{picking-pick.service.ts(grep),picking-view.ts(:10-14)}` ·
`src/logistics/goods-issue/goods-issue-view.ts`(:73-80) · `src/logistics/stock-transfer/stock-transfer.service.ts`(:160-175) ·
`src/core/numbering/numbering.service.ts`(:15-50 · grep)

**물리**
`prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql`(`:2323-2372` 전문 · `picked_qty`·
`sales_order_id` grep) · `grep -rn 'picked_qty|sales_order_id' prisma/migrations` · `prisma/schema.prisma`
(`shipment_request_line` 모델 전문)

**문서**
`docs/coverage-100/README.md`(§0~§6-2) · `git show origin/main:docs/coverage-100/README.md`(**§6-3** — 내 브랜치엔 없다) ·
`docs/coverage-100/slices/I-22.md` 전문 1,050줄 · `docs/coverage-100/slices/I-8.md`(:112-124 · :542-560 · 409 grep) ·
`docs/coverage-100/slices/I-21-review-api.md`(:1-60 형식) · `docs/coverage-100/plan-api.md`(:540-566) ·
`docs/coverage-100/plan-integration.md`(:276-284 · :393-402) · `docs/coverage-100/plan-uiux.md`(:915-928 · :1005-1016 · :1130-1140) ·
`docs/coverage-100/plan.md`(:43 · :55-56 · :129)

**돌리지 않은 것** — 게이트(lint·typecheck·test) 0 · DB 접속 0 · `pnpm exec` 0 · `prisma` 명령 0 · `gh` 0.

**실측 부록 중 내가 «뒤집어» 재측정한 것** — **#6**(01 `:pick` 의 409 · Blocker A-1) · **#37**(사본 8 — 재확인 결과
**정확하다**: 자유 함수 7 + `stock-transfer.service.ts:169` 의 private 메서드 1). 그 밖의 부록 값은 재측정하지 않았다.
