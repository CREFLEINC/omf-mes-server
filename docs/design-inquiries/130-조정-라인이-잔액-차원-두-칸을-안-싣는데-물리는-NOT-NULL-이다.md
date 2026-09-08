# 130. 조정 라인이 잔액 차원 두 칸을 안 싣는데 물리는 NOT NULL 이다 — 증(+) 라인은 되읽을 잔액 행조차 없다

> ⭐ **답이 필요한 건이다**(권고안 통보가 아니다). 계약 `adjustmentQty` 는 ⌜증감 수량. 음수가 올 수 있다⌝ 뿐이고 위치에 대한 제한이 **0** 인데, 서버가 세운 규칙은 「빈 위치에 재고를 만드는 조정」을 **등록 단계에서 닫는다**. 계약이 연 갈래를 서버가 닫는 자리라 답 없이 두면 조정 기능의 한쪽이 사라진다.

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /inventory/adjustments` · `PUT /inventory/adjustments/{id}/lines` · `POST /inventory/adjustments/{id}:post` |
| 구현 상태 | **미구현** — I-14 는 조회 3건만 병합됐다(`main` · `src/inventory/adjustment/inventory-adjustment.controller.ts:25·31·43` 이 `@Get` 셋뿐). 등록·치환·상신·`:post` 는 아직 없다 |
| 판정 | `coverage-100/README.md` §2 **1단계 본길**(모든 등록이 이 칸을 채워야 한다) → 2단계 **기준 4**(값을 조용히 도출하지 않는다) + **기준 2**(거부하는 쪽 · 거부→허용이 호환 완화다). ⚠ 「스키마를 안 늘리는 쪽」(기준 3)은 **안 걸린다** — NOT NULL 완화는 칸을 늘리지 않는다 |
| 되돌릴 때 | ⓐ 「계약에 두 칸을 싣는다」면 라인 스키마 두 벌에 칸 추가 + 서버는 되읽기 한 자리를 본문 값으로 바꾼다 ⓑ 「NOT NULL 을 푼다」면 마이그 한 줄인데 **원장 쪽 구멍이 남는다**(아래 ⓓ) |

## 무엇이 문제인가

**ⓐ 계약이 안 싣는데 물리가 NOT NULL 로 요구한다.**
`InventoryAdjustmentLineUpsert` 의 프로퍼티는 `inventoryAdjustmentLineId`·`inventoryCountLineId`·`locationId`·`itemId`·`lotId`·`adjustmentQty`·`uomId`·`reasonCode` **여덟**이고 품질·재고 상태 칸이 **0** 이다(`contracts/logistics-01자재창고.json:9965-10029`). 물리는 둘 다 NOT NULL 이다 — `quality_status_code String @db.VarChar(50)` · `inventory_status_code String @db.VarChar(50)`(`prisma/schema.prisma:4030-4031`).
이 형상 자체는 **문의 031 의 조정판**이다. 출고에서는 「잠근 잔액 행에서 되읽는다」로 풀었고 그 근거 주석이 코드에 남아 있다(`src/logistics/goods-issue/issue-posting.ts:193-195`).

**ⓑ 그런데 조정에는 증(+) 라인이 있다 — 되읽을 행이 0행이다.**
출고는 「이미 있는 재고를 깎는」 것이라 되읽을 행이 반드시 있다. 조정은 `adjustmentQty` 가 양수일 수 있고, 계약 설명은 ⌜증감 수량. 음수가 올 수 있다⌝ 한 줄뿐이라 **「이미 재고가 있는 위치에서만」이라는 제한이 없다**(`:9927-9930`). 헤더 사유 5값 중 `TRANSPORT_DAMAGE`·`SYSTEM_ERROR_CORRECTION`·`OTHER`(`:9770`)는 「아직 아무 재고도 없는 (위치·품목·LOT)」으로의 증(+)을 자연히 부른다. 그 자리에서는 **품질·재고 상태를 읽어올 행이 0행**이라 넣을 값이 어디에도 없다.
값을 지어낼 근거도 0 이다 — `QUALITY_STATUS` 코드 그룹이 **DB 에 없다**(오늘 실측: `mdm.code_group` 109행 중 `INVENTORY_STATUS`·`INVENTORY_ADJUSTMENT_REASON`·`LOGISTICS_DOCUMENT_STATUS` 는 있고 `QUALITY_STATUS` 는 **0행**).

**ⓒ ⭐ 같은 레인의 I-13(재고 이동)이 이 규칙을 「영구 400」으로 바꾼다.**
서버 규칙은 「7칸 키로 잔액을 조회해 **2행 이상이면 400 `INVALID`**」인데, 재고 이동이 도착 위치에 `{도착 창고, IN_TRANSIT}` 잔액 행을 **미리** 세운다(`docs/coverage-100/plan-integration.md:325-326` ⌜반출이 `from`=출발, `to`={도착 창고, `IN_TRANSIT`}⌝ · ⌜도착 위치를 미리 쓴다(`to_location_id`)⌝). 그 위치·품목·LOT 은 그때부터 `AVAILABLE` + `IN_TRANSIT` **2행**이 되어, 이동 중인 품목은 **조정도 실사 차이 닫기도 등록 단계에서 막힌다**. 가장자리가 아니라 본길에 닿는다.

**ⓓ 대안 둘 — 어느 쪽이든 대가가 있다.**

| 안 | 하는 일 | 대가 |
|---|---|---|
| **ⓐ 계약 라인 스키마에 두 칸을 더한다** | `InventoryAdjustmentLine`·`…Upsert` 에 `qualityStatusCode`·`inventoryStatusCode` 추가 | 화면에 입력 자리가 없다 — `W-01-12` §3 라인 열은 위치·품목·LOT·장부·실물·차이·사유 **일곱**뿐이고(`.design-reference/…/W-01-12-재고조정.md:46`) §7 DS 매핑에도 상태 선택 컴포넌트가 0 이다 |
| **ⓑ 물리 NOT NULL 을 푼다** | 두 칸을 nullable 로 | ⛔ **원장 쪽 구멍이 남는다** — `PostingEndpoint.qualityStatusCode`·`inventoryStatusCode` 가 **옵셔널이 아니다**(`src/core/inventory-posting/posting.types.ts:2-7`). 전기 때 값이 반드시 있어야 하므로 「비워 두기」로는 끝나지 않는다 |

⚠ **선례가 이 저장소 안에 있고 반대로 갔다.** 문의 **053** ③ 은 **같은 형상**(계약 라인 스키마에 칸 0 · 물리 NOT NULL · 코드 그룹 0행)에서 **NOT NULL 을 풀었다** — `material_return_line.return_quality_status_code`(I-10 M-2 · 마이그 `20260907700000`). 갈리는 점은 하나다: 그 칸은 **소비처가 0**(응답에도 없어 화면에 안 보인다)이고, 이 칸은 **원장이 required 로 요구한다**.

## 지금 서버는

- **아직 없다.** 등록·치환·전기가 미구현이라 이 자리를 지나는 코드가 0 이다.
- 계획된 동작은 이렇다 — 등록·치환이 7칸 키로 잔액 행을 잠가 읽고, **1행이면 그 행의 두 코드를 라인에 저장**하고 `:post` 는 저장값을 그대로 `PostingEndpoint` 에 싣는다. **2행 이상이면 400 `INVALID`** · **0행이면 감(−) 400 `NEGATIVE_BALANCE` · 증(+) 400 `INVALID`**.
- 「증(+) 0행 400」은 **물리적으로 불가능해서가 아니라 정책**이다 — 코어 `move()` 의 `INSERT … ON CONFLICT`(`src/core/inventory-posting/inventory-posting.service.ts:262-284`)는 없는 차원 행을 만들 수 있다. 값을 지어내지 않으려고 막는 것이다.
- 소유 축(`ownership_type_code`·`owner_partner_id`)은 라인에 저장할 칸이 없어 `:post` 가 잠근 잔액 행에서 다시 읽는다(출고 `issue-posting.ts:209-210` 과 같다).

⇒ **묻는 것**: 조정 라인이 품질·재고 상태 두 칸을 **계약에 실을 것인가**, 아니면 **「아직 재고가 없는 위치에 재고를 만드는 조정」을 계약이 금할 것인가**(금하지 않는다면 그때 두 칸에 무엇을 넣는지도 함께).

「알려둘 것」으로 함께 보내는 것(문의 아님): 조정은 **`item.negative_stock_allowed` 를 «본다»** — 출고는 계약 `issueQty` 가 「보유 수량 이하」로 닫았기에 무시했고(`issue-posting.ts:155-156`), 조정 계약에는 그 문장이 없으며 화면 `W-01-12:226` 이 그 칸을 이름으로 인정한다. 같은 재고에 두 규칙이 선다.

흔적: `docs/coverage-100/slices/I-14.md` §2-2 · §3-3 · §11-1 #1 · §11-2 · **R-1 · R-3 · R-8** · `I-14-review-api.md` §1 ① · `I-14-review-integration.md` §1 ①-I-2 · 기존 **031**(출고판 · 같은 뿌리) · **053** ③(같은 형상 · 반대 판정).
