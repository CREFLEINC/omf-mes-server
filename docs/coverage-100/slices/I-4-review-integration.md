# I-4 개별 계획안 재검토 — **integration 관점**

> 브리프 `brief-I-4-review.md` 「판정할 것」 7항목. 근거는 전부 파일:행 실측(코어 코드·`schema.prisma`·마이그 SQL·시드·로컬 DB `SELECT`).
> 자기 관점 계획서: `plan-integration.md` §3-1 I-4(234~242) · 399~400 · 594~601(§6-3) · I-20 절(372~377).

---

## 1. 문의 030·031 이 새 문의인가 — ✅ 동의(2건), ✏ 030 갈래 ④는 뺀다

- **031 ⭕ 진짜 문의다.** 「2행 이상」이 이론이 아니라 **실제로 도달한다** — `receipt-posting.ts:130-134` 가 `qualityStatusCode`·`inventoryStatusCode` 를 **입고 라인 값 그대로** `to` 에 실으므로, 같은 (위치·LOT)에 `NORMAL` 입고와 `DEFECTIVE` 입고가 두 번 들어오면 `uq_inventory_balance_dim`(psql 실측 · 11칸 표현식 인덱스) 상 **두 행**이 선다. `GoodsIssueLineUpsert` 에 그 두 칸이 없는 것은 계약의 구멍이 맞다.
- **030 ⭕ 022·023 과 다르다.** 022 는 「결재선을 «고르는» 축」, 030 은 「승인을 «걸어야 하는가»를 가르는 축」이라 층이 다르다. 갈래 ③(`postImmediately=true` 우회)은 integration 이 가장 아프게 보는 자리 — 등록 tx 안에서 `status_code='POSTED'` 를 «만드는» 경로(§3-9)라 승인·상신이 물리적으로 불가능하고, 원장은 되돌릴 수 없다(역트랜잭션은 I-5).
- ✏ **갈래 ④(「`PUT …/lines` 를 부르는 화면이 0건」)는 030 에서 뺀다.** 서버 구현이 하나도 안 바뀌는 화면 축이고(§8-1 ⓚ 자신이 「구현은 안 바뀐다」라 적었다), 025·026 과 같은 갈래다 ⇒ 「알려둘 것」으로 내린다. 남기면 030 이 「승인 게이트」 한 축을 잃는다.
- 「알려둘 것」 9건 중 문의로 올릴 것 **0건**에 ✅ — ⓘ(e2e 시퀀서 의존)만 문의가 아니라 **저장소 과제**(#15 계열)라 다음 전달분이 아니라 이슈 트래커로 가는 것이 맞다.

## 2. 마이그레이션 0 — ✅ 전면 동의(실측 3중 확인)

- `prisma/migrations/20260901090000_goods_issue_destination_and_spare/migration.sql:23-26` 이 두 칸의 NOT NULL 을 풀고 `ck_goods_issue_destination` 을 걸었다. `schema.prisma` `goods_issue:8-9` 가 `String?`·`BigInt?` 로 반영돼 있다.
- **로컬 DB 실측** — `pg_constraint` 에 `ck_goods_issue_destination | CHECK (((destination_type_code IS NULL) = (destination_id IS NULL)))` 이 **실재**한다. 이 슬라이스의 마이그 0건이 맞다.
- ⇒ **`plan-integration.md` §6-3 마이그 표의 M-c 행(597행)을 지운다 — 8건 → 7건.** §3-1 I-4 「예상 설계 미정」 둘째 항목(242행 「선행 마이그레이션(nullable 화)」)도 함께 지운다. §10 대조표가 이미 둘 다 잡았다 ⇒ 빠짐없다 ✅.
- `goods_issue_spare_line` 범위 밖(§2-4)에 ✅ — 마이그 §2 주석이 「예비품 전기 경로가 아직 설계되지 않았다」로 `inventory_transaction_line_id` 를 일부러 뺐다 ⇒ `:post` 가 다룰 것이 물리적으로 없다.

## 3. `:post` 전기 모양 — ✏ **잠금 설계에 구멍 셋**(나머지는 ✅)

**먼저 데드락/이중 잠금 물음의 답** — `inventory-posting.service.ts:126-174` 의 `move()` 는 `FOR UPDATE` 를 **한 번도 잡지 않는다**. `INSERT … ON CONFLICT DO NOTHING`(:140) 뒤 `UPDATE … RETURNING`(:155) 이고, UPDATE 가 스스로 행 잠금을 딴다. ⇒ §3-4 의 선잠금과 `post()` 는 **같은 트랜잭션**이라 락이 재진입되고 **이중 잠금·자기 교착은 없다** ✅. 다만 순서 불변식에 셋이 샌다:

- ✏ **①(치명) §3-4 4번 SQL 이 «교차곱»이다.** `WHERE (plant_id,warehouse_id,location_id,item_id) = ANY(...) AND COALESCE(lot_id,0) = ANY(...)` 는 라인 1의 위치와 라인 2의 LOT 을 짝지어 잠근다 — 라인이 둘 이상이면 **§3-2 의 「0행/1행/2행+」 판정이 라인마다 갈리지 않고 뭉개진다**(남의 조합이 1행으로 잡혀 통과하거나, 2행+ 로 잡혀 400 `INVALID` 오탐). **대안**: 7칸 행생성자 한 문장 —
  `WHERE (le,bu,plant,warehouse,location,item,COALESCE(lot_id,0)) IN (VALUES …) ORDER BY inventory_balance_id FOR UPDATE`, 되읽은 뒤 **라인별로 다시 그룹지어** 행 수를 센다.
- ✏ **②(데드락 실재) `to` 쪽 잔액 행이 선잠금 밖이다.** §3-1 이 `destination_type_code='LOCATION'` 이면 `to` 를 싣는데, §3-4 는 `from` 차원만 잠근다. 그러면 `move()`(:140/:155)가 **선잠금 순서 밖에서** to-행을 새로 잡는다 ⇒ 위치 A→B 출고와 B→A 출고가 동시에 돌면 **정확히 §3-4 가 막으려던 교착**이 난다. 게다가 to-행이 없으면 `ON CONFLICT DO NOTHING` 이 유일 인덱스에서 상대 tx 를 기다린다. **대안 둘 중 하나**: ⓐ 선잠금 `VALUES` 목록에 to-차원(=from 의 품질·재고·소유 + 도착 창고·위치)을 **함께 넣어 같은 `ORDER BY` 한 문장으로** 잡는다 ⓑ I-4 M1 경로가 `PARTNER`·`DISPOSAL_SITE`·비움뿐임을 근거로 **`LOCATION` 도착지를 이 슬라이스 범위 밖으로 선언**하고 400 을 낸다(그러면 §3-1 의 `to` 분기·`mdm.location.warehouse_id` 도출도 함께 빠져 PR ③ diff 가 준다). ⓐ 권장.
- ✏ **③ 같은 (위치·품목·LOT) 라인이 두 번 오는 경우가 없다.** 손검사가 라인마다 `available_qty >= issue_qty` 를 보면 둘 다 통과하고, `move()` 는 라인마다 UPDATE 하므로 **두 번째 UPDATE 에서 트리거가 500** 이다. **차원별로 합산해** 검사한다. 단위 테스트 한 줄 추가: `전기 — 같은 위치·LOT 라인이 둘이면 합계로 검사한다`.

**음수 손검사를 도메인에 두고 `negative_stock_allowed` 를 무시하는 것 — ✅ 어긋나지 않는다. 오히려 트리거가 그것을 요구한다.**
`check_balance_qty()`(baseline `20260727000000` :2831~) 는 갈래가 **셋**이다: ⓐ `on_hand ≥ 0` 이면 `on_hand < reserved+picked+blocked` 금지 ⓑ 음수면 `item.negative_stock_allowed` 필요 ⓒ **음수면 `reserved+picked+blocked > 0` 도 금지**. I-4 §3-3 의 `available_qty ≥ issue_qty` 는 `new on_hand ≥ reserved+picked+blocked ≥ 0` 을 함의하므로 **세 갈래를 모두 앞당겨 막는다** — 계산이 정확하다 ✅. `negative_stock_allowed=true` 여도 막는 것은 ⓒ 때문에라도 안전한 쪽이다. 코어 머리 주석(`inventory-posting.service.ts:24-25` 「`reserved_qty`·`picked_qty` 는 건드리지 않는다 … 별도 코어다」)과도 충돌 없다 — 읽기만 한다.
⚠ 단, `available_qty` 는 **생성 컬럼**(psql: `attgenerated='s'`)이고 Prisma 타입이 `Decimal?`(nullable)이다 — 되읽은 값이 `null` 일 수 없음을 아는 것은 우리뿐이므로, `null` 이면 `on_hand-reserved-picked-blocked` 로 계산하는 대신 **던진다**(조용히 0으로 보지 않는다). 한 줄 흔적.

**이중 전기 세 겹 — ✅ 성립한다. 키 모양 실측 일치.**
psql: `uq_inventory_idempotency | UNIQUE (idempotency_key, business_date)` · `uq_inventory_transaction_no | UNIQUE (transaction_no, business_date)`. ⇒ §3-8 ②의 「영업일이 다르면 다른 키」 한계가 **사실**이고 ③(상태 잠금)이 정본이라는 결론이 맞다 ✅.
✏ 한 줄 보탠다 — **등록(`postImmediately`) 경로와 `:post` 가 같은 멱등키 `GOODS_ISSUE:{번호}` 를 쓴다**(`receipt-posting.ts:120` `${SOURCE_DOCUMENT_TYPE}:${receiptNo}` 선례와 같은 모양). 그래서 「등록에서 전기 → 다시 `:post`」는 ②가 같은 영업일에서만 흡수하고, 영업일이 다르면 ③만 남는다. §3-8 표에 이 경로를 명시한다.
`transactionTypeCode`·`sourceDocumentTypeCode` 를 둘 다 `'GOODS_ISSUE'` 로 두는 것도 선례 일치 ✅(`receipt-posting.ts:115·119`).

**`postImmediately` 가 `document-post` 를 안 부르는 것 · 재전기 400 `STATE_LOCKED` — ✅.** `transitions.ts` 실측 축은 다섯(`mdm.equipment`·`mdm.mold`·`planning.routing`·`trace.lot.lifecycle_status_code`·`app.approval_request`)이고 `logistics.goods_issue.status_code` 는 **없다** ⇒ I-4 가 첫 줄을 여는 것이 맞다.
✏ **I-5 인계 한 줄을 §3-7 에 박는다** — 취소 두 전이는 **같은 키의 같은 객체 리터럴**에 붙는다. 「I-4 가 키를 만들고 I-5 는 «키 안에 액션만 더한다»(키를 다시 만들지 않는다)」를 인계 문장으로 남긴다. `plan-integration.md` §6-2 의 「코어를 고치는 두 슬라이스」 경고가 실제로 걸리는 자리가 여기다(데이터 표라 추가는 안전하지만 충돌 지점이 한 줄로 겹친다).

## 4. 승인 게이트 — ✅ 채택안 동의, ✏ 인덱스 문장 하나 정정

- **다형 축 실측**: `approval_request` 는 `target_type_code varchar(50)`·`target_id BigInt`·`approval_type_code varchar(50)` 세 칸으로 대상을 찾고 **FK 가 없다**(`schema.prisma` `approval_request:4-6`) ⇒ §4-1 시그니처 `(tx, targetTypeCode, targetId, approvalTypeCode)` 가 맞다 ✅. `'GOODS_ISSUE'` 값도 계약이 확정한 것이다(`src/contracts/app.d.ts:2973` `targetTypeCode: "GOODS_ISSUE" | …` 8값).
- ✏ **「`ix_approval_request_target` 이 받는다」는 절반만 맞다** — 실측 인덱스는 `@@index([target_type_code, target_id])` **2칸**이다(`schema.prisma` `approval_request:28`). `approval_type_code` 는 인덱스 뒤 필터다. `assertNoOpenRequest`(`approval.service.ts:107-114`)도 같은 모양이라 성능상 문제 없지만, §4-1 문장을 「2칸 인덱스가 받고 유형은 필터다」로 고친다(I-5 가 같은 축을 `GOODS_ISSUE_CANCEL` 로 또 조회하므로 오해가 남으면 안 된다).
- **「상신 흔적 = 승인 전표」 ✅.** `approval.service.ts:57-58` 머리 주석(「승인은 자물쇠만 푼다 … 전기·출고·조정은 대상 화면의 `:post` 가 승인 상태를 «읽고» 따로 한다」)이 정확히 이 모양을 요구한다. S04 초안 기각 근거도 실측으로 선다 — `selectRoute`(:128-137)가 `business_unit_id` 를 받되 주석이 「P/O 만 전표 값을 준다. 나머지는 `null`」이라 **전역 조건이 되는 것이 사실**이다.
- **022 권고안 ② 실측 불가 ✅** — `mdm.item` 에 `business_unit_id` 없음 확인. 갈래 ④(공통본만) 정정에 동의.
- **`PUT …/lines` 400 `APPROVAL_IN_PROGRESS`(023 과 갈리는 이유) ✅ 선다** — 023(P/O)은 승인 뒤 원장이 없고 I-4 는 있다. 되돌림 비용이 실제로 다르다(`posting.reverse()` 가 아직 없다 · `plan.md` §3 이 I-5 몫으로 잡았다).
- **뒤집을 수 있는가 ✅** — 채택안은 「막지 않는 쪽」이라 나중에 축이 생기면 조이기만 하면 된다. `assertApproved` 호출 자리는 그대로 두고 판정만 바뀐다.

## 5. LOT 차단 뒤집기 — ✅ 전면 동의(내 잠정 판정을 내가 접는다), ✏ 조회 모양만 보탬

- `mdm.judgment_type_control` 실재 확인: `blocks_issue Boolean @default(false)` · PK 는 `code_value_id`(`schema.prisma` 해당 모델 :2-3). **`blocks_issue` 칸은 있다** ✅.
- **시드·DB 둘 다 비었다** — `prisma/seed.ts:563-566` `JUDGMENT_TYPE … values: []`. psql: `mdm.judgment_type_control` **0행**, `JUDGMENT_TYPE` 코드값 **0건**. ⇒ 「오늘은 아무것도 안 막는다」가 사실 ✅.
- ⇒ **`plan-integration.md` 240행의 잠정 판정(`{DEFECTIVE,SCRAPPED,INSPECTION_PENDING}` 400)을 철회한다.** 그대로 두면 §5-1 이 실측한 대로 **내가 세운 M1 최단 경로(`GOODS_RECEIPT` 자재 폐기)가 첫 e2e 부터 전건 400** 이라 자기모순이다. I-4.md §5-3 의 대안으로 교체한다.
- ✏ **조회 모양을 명시한다** — `judgment_type_control.lot_status_code` 는 `String?` 이고 **인덱스도 UNIQUE 도 없다**(모델에 `ix_judgment_type_control_role` 하나뿐). 즉 역방향은 **다대일**이다. 판정문을 「`lot_status_code = lot.status_code` 인 행 중 `blocks_issue = true` 가 **하나라도** 있으면 400」으로 못박고, 라인마다 돌지 말고 **요청의 distinct 상태값 한 번**만 조회한다(오늘은 0행이라 왕복 1회).
- **`lot_hold` 무시 ✅ · `M-01-08` 보류 차단을 I-8 `blocks_picking` 으로 미루는 경계 ✅** — 같은 표의 다른 칸이라 경계가 데이터로 갈린다. `plan-integration.md` I-20 절(373행)의 「I-4 에서 잠정 판정을 둔 자리를 여기서 정본으로 바꾼다」를 **「I-4 는 `blocks_issue` 를 읽는다. I-20 은 `judgment_type_control` 에 행을 «채운다» — 코드는 안 바뀐다」**로 고친다. 이 교정이 I-20 의 작업 성격을 바꾼다(코드 수정 → 시드/마스터 등재).

## 6. PR 5개 분할·순서·모델 배분 — ✅ 분할 동의, ✏ PR ③ 순서 위험 둘 + 누락 테스트 둘

- **3 → 5 ✅.** ③ 372 · ④ 340 은 400 아래고, 코어 ② ~45 는 200 아래다. `postImmediately` 가 전기 함수를 부르므로 ③이 ④보다 먼저인 것도 맞다.
- ✏ **PR ③ e2e 가 전표를 직접 INSERT 하는 위험 둘**(선례 자체는 실재한다 — `logistics-inbound-receipt.e2e-spec.ts:1044·1082` 가 `goods_receipt`·`purchase_order` 를 직접 만든다):
  ① **번호 축을 건너뛴다.** `goods_issue_no` 를 손으로 만들면 `numbering.next` 를 안 타고, PR ④에서야 `DEFAULT_PREFIX` 에 `GOODS_ISSUE: 'GI'` 가 없어 **부르는 즉시 `Error`(→500)** 인 것이 드러난다(`numbering.service.ts:9-16`·:141-146 실측 — `GI` 없음 확인). ⇒ **`DEFAULT_PREFIX` 한 줄을 PR ③으로 당긴다**(1줄 · ③이 `transactionNo` 로 그 번호를 원장에 싣는다).
  ② **모양이 갈릴 수 있다.** ③의 픽스처가 만드는 헤더/라인 조합을 ④의 등록이 실제로 만들어 내는지 아무도 검사하지 않는다. ⇒ ③의 직접 INSERT 를 **e2e 파일 안 헬퍼 하나**(`insertRegisteredIssue()`)로 두고, ④에 `등록 결과가 ③ 픽스처와 같은 모양이다` 한 줄을 넣는다.
  ③ ⚠ `source_document_id` 에 **FK 가 없다**(다형 · `goods_issue` 모델에 관계 없음 실측) ⇒ 직접 INSERT 가 존재하지 않는 입고를 가리켜도 DB 가 안 막는다. 픽스처는 **실제 `goods_receipt` 행**을 가리키게 한다(④의 FK 손검사와 같은 데이터).
- ✏ **누락 테스트 둘** — ⓐ PR ⑤ 치환: `uq_goods_issue_line (goods_issue_id, line_no)` 는 psql 실측 **`condeferrable = f`** 다. 1↔2 맞바꾸기는 P/O 선례(`purchase-order.service.ts:27-29`·:234 `LINE_NO_SHIFT`)처럼 **밀었다 되돌려야** 한다 ⇒ `치환 — line_no 를 맞바꿔도 uq_goods_issue_line 을 안 깬다`. ⓑ PR ③: 위 §3 ③ 의 합산 검사 한 줄.
- **가드 덮개 ✅** — `STATE_LOCKED`·404·409·`LINE_REQUIRED`·`APPROVAL_IN_PROGRESS`·`NEGATIVE_BALANCE`·2행+ `INVALID` 전부 이름이 붙은 테스트가 있다. `error-codes.ts` 실측: `NEGATIVE_BALANCE`·`APPROVAL_REQUIRED` **둘 다 없다** ⇒ 「새로 더하는 코드 둘」이 맞다. `derived-permissions.ts:50·51·169·170·171` 5건 실재, `manual-permissions.ts` 에 `goods-issues` **0건** ⇒ §6-1 「1건만 더한다」도 맞다.
- ✏ **§7-1 「타입만 export」의 근거를 바꾼다.** `server-architecture.md` §1(「⛔ 도메인이 다른 도메인의 service 를 부르지 않는다」)은 **모듈을 계약 최상위 경로로 정의**한다(같은 문서 「모듈 배치 — 계약 경로를 따른다 · `/logistics` 82」). I-23 출하도 `/logistics` ⇒ **shipment 가 `postIssue()` 를 불러도 §1 위반이 아니다.** 실제로 막는 것은 `plan-integration.md` 399~400행이 §2 2단계 기준 5 로 내린 판정(「새 코어를 만들지 않는다 · 데이터 «모양»만 재사용」)이다. 문장을 그렇게 고쳐야 I-23 에서 「§1 때문에 못 부른다」는 잘못된 인계가 안 남는다. **결론(타입만 export)은 그대로 ✅.**
- **I-8 인계 ✅** — `goods_issue_line.picking_line_id BigInt?` + `picking_line` 관계 실재. `ck_picking_qty CHECK (picked_qty <= planned_qty)` 는 `picking_line` 쪽 제약이라 I-8 몫이 맞다. **예약 축 인계도 정확하다** — `available_qty` 를 보므로 `reserved_qty` 가 걸린 재고는 I-4 경로로 안 나가고, 코어 주석(:24-25)대로 I-4 는 예약을 안 건드린다.
- **모델 배분 ✅**(① sonnet · ②~⑤ opus) — MEMORY 의 배분 정책과 같다.

## 7. 자기 관점 계획서와 어긋나는 자리 — 구현에 영향 주는 것만

| `plan-integration.md` | 실측 | 조치 |
|---|---|---|
| 240행 LOT 차단 잠정 판정 | 폐기·반품 전건 400 · 통제표가 정본이고 비었다 | **철회 · §5-3 안으로 교체** |
| 242행 M-c 선행 마이그 | `20260901090000` 로 이미 적용(DB 실측) | **삭제** |
| 597행 §6-3 M-c 행 | 같음 | **삭제(8→7건)** |
| 373행 I-20 「정본으로 바꾼다」 | 바뀌는 것은 코드가 아니라 **표의 행** | 문장 교정 |
| 237행 원장 `from`/`to` 모양 | ⭕ 맞다. 다만 `from` 의 품질·재고·소유 **출처**가 없다 | §3-2 되읽기 + 문의 031 보탬 |
| 399~400행 I-23 재사용 | ⭕ 판정 유지 · 근거를 §1 이 아니라 이 행으로 | I-4.md §7-1 문장 교정 |
| 잠금 순서(§3-4 계승) | `to`-행이 순서 밖 · 교차곱 SQL | I-4.md §3-4 재작성 |

- ⚠ **cross-slice 잔여 위험 하나(문의 아님, 「알려둘 것」감)** — 순서 불변식은 **출고끼리만** 선다. `postReceipt`(`receipt-posting.ts:110`)는 잔액을 **라인 순서대로** 만지므로(선잠금 없음), 같은 순간 같은 두 차원을 건드리는 입고·출고가 반대 순서로 잡으면 교착이 가능하다. 오늘 e2e 는 `--runInBand` 직렬이라 안 터진다 — 「알려둘 것」에 한 줄로 남기고 I-5(역트랜잭션)에서 코어 차원의 순서를 한 번에 정한다.
- **e2e 시퀀서 의존 ✅ 실측 일치** — `logistics-goods-issue` < `logistics-goods-receipt`(`i`<`r`)이고 GR 스위트 `cleanup()` 첫 줄이 `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`(`logistics-goods-receipt.e2e-spec.ts:575-577`)라 역순이면 조용히 깨진다. `alphabetical-sequencer.js` 가 고정한다.
- cleanup 순서 ⑥(`approval_request_id = NULL` 로 FK 끊기) ✅ — `goods_issue:20·24` FK 실재. ⚠ `goods_issue` 에는 `shopfloor_receipt`·`subcontract_issue` 자식도 붙는다(모델 :29-30) — I-4 가 안 만들지만 cleanup 주석에 「행 0건」한 줄을 `goods_issue_spare_line` 과 같이 둔다.

---

**재수립 결과 — I-4.md 에 반영할 수정 8건**: ① §3-4 잠금 SQL 을 7칸 행생성자로(교차곱 제거) ② `to`(LOCATION) 잔액 행을 같은 정렬 문장에 넣거나 `LOCATION` 도착지를 범위 밖 선언 ③ §3-3 에 차원별 합산 검사 + `available_qty` null 시 던짐 ④ §3-8 에 「등록·`:post` 가 같은 멱등키」 경로 명시 ⑤ §4-1 「`ix_approval_request_target` 2칸 + 유형 필터」로 정정 ⑥ §5-3 판정문을 「`lot_status_code` 다대일 · `blocks_issue=true` 가 하나라도 있으면 400 · distinct 1회 조회」로 ⑦ §7-1 근거를 아키텍처 §1 → `plan-integration.md` 399~400 판정으로 교체(결론 유지) ⑧ §9 에 `DEFAULT_PREFIX GI` 를 PR ③으로 당김 + 테스트 2줄(`line_no` 맞바꾸기 · 같은 차원 라인 합산) + ③ 픽스처 헬퍼화.
**plan.md 에 반영할 것**: §1 5행(마이그 «—» · PR 3→5 · 코어 열 `assertApproved`) · §4 M-c 「✅ 적용됨(`20260901090000`·#44≡#147)」 · §3 코어표에 `assertApproved` 한 행 · §7 문의표 I-4 2행.
**plan-integration.md 에 반영할 것**: 240행 LOT 차단 판정 철회·교체 · 242행 M-c 삭제 · 597행 §6-3 M-c 삭제(8→7) · 373행 I-20 문장 교정 · 237행 원장 절에 `from` 두 칸 출처 보탬.
**문의 최종 건수**: **2건(030·031) 유지** — 030 은 갈래 ①②③만 남기고 ④는 「알려둘 것」으로 내린다. 022 는 정정만(권고안 ② 실측 불가 · 갈래 ④), 023·026 은 인용만.
**「알려둘 것」**: 9건 → **11건**(+030 갈래 ④ · +입고↔출고 잔액 잠금 순서 cross-slice 위험).
