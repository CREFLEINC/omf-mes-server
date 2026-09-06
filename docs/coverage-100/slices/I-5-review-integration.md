# I-5 개별 계획안 3관점 재검토 — **integration 관점**

> 대상 `docs/coverage-100/slices/I-5.md`(1,019줄) · 브랜치 `docs/coverage-100-i5-plan`(b101bd2) · 실측일 2026-09-06.
> 실측 수단: `psql` SELECT(로컬 `omf_mes`) · `jq`(계약 읽기 전용) · 코드·마이그레이션 SQL 직접 읽기. 구현·쓰기 0건.

## 1. 문의 032·033·034 가 새 문의인가 — ✏

- **032 ✅ 새 문의다.** C-8 은 「서버가 «수신 시각»으로 다시 잡지 않는다」이지 「어느 값을 쓰는가」를 말하지 않고, 026 은 입하 상태 축이라 겹치지 않는다. 실측이 대비를 세운다 — `jq` 로 `ShipmentCancel.required = ["businessDate","occurredAt"]`(3칸 중 둘) 확인. ⚠ 단 README §0 「값 정의·확실한 권고안이면 권고안대로 구현하고 요청서에 적는다」에 정확히 해당하므로 **회신을 기다리지 않는다**는 문장을 §9-2 에 한 줄 덧붙일 것.
- **033 ✏.** 문의감은 맞으나 «어느 쪽에 묻나»가 갈린다. `W-01-13` §5-7 「취소 요청 철회」 ↔ 계약 경로 0건은 **계약 축 불일치**이고, 「반려 뒤 문서가 영구히 잠긴다」는 그 결과다. 제목을 결과가 아니라 원인(철회 오퍼레이션 부재)으로 세우고 결과를 본문에 두는 편이 회신 가능성이 높다. integration 영향: 잠긴 문서를 푸는 길이 **DB 직접 수정뿐**이라 「알려둘 것」에 그 사실을 반드시 적어야 한다(§9-3 에 없다).
- **034 ✏ — 판정은 유지, 근거를 바꿔라.** §2-4 2단계가 「NOT NULL 해제도 스키마 변경이라 기각」이라 적었는데, I-3 은 **정확히 같은 모양**(`inbound_variance.reason_code` NOT NULL vs 계약 선택)에서 README §5 「물리와 계약이 다르면 물리를 고친다」를 들어 **완화 마이그를 냈다**(I-3.md §0). 같은 자리에 반대 판정이 서면 다음 슬라이스가 갈린다. 다행히 실측이 «다른 이유»를 준다 — `document_cancellation` 의 FK 는 `cancelled_by → app_user` **하나뿐**이고(`\d` 실측) `reason_code` 를 읽는 계약 응답이 0건이라, 값이 어떤 판정에도 안 걸린다. ⇒ 근거를 「계약이 그 칸을 쓰지도 읽지도 않아 완화의 이득이 0」으로 바꿔 적을 것.
- 「알려둘 것」 12건 중 문의로 올릴 것: **없다**(ⓚ·ⓛ 는 계약 enum 이 닫은 자리다). §9-1 20자리의 §2 절차 적용은 단계·기준 인용까지 타당하다 ✅.

## 2. 마이그레이션 0 — ✏ (실측 동의, 수 하나가 틀렸다)

- ✅ 물리 실측 전건 확인: `document_cancellation` 9칸 · `reason_code` NOT NULL · 유일 제약은 PK 하나(`ix_document_cancellation_target` 는 일반 인덱스) · `inventory_transaction` 역 칸 2 + `fk_inventory_transaction_reversal` + `ck_inventory_reversal_pair`(baseline `migration.sql:1139-1165`) · `uq_inventory_idempotency`·`uq_inventory_transaction_no` 둘 다 `business_date` 포함 · 3표 `status_code` NOT NULL·`version_no` DEFAULT 1 · `inbound_receipt` 에 `source_document_*` 없음 · `goods_receipt.source_document_type_code` nullable / `goods_issue` NOT NULL.
- ⛔ **seed `ENTITY_TYPES` 는 +7 이 아니라 +6 이다.** 등록부 실측 19행 중 조회 9종은 5종만(`PURCHASE_ORDER`·`INBOUND_RECEIPT`·`GOODS_RECEIPT`·`STOCK_TRANSFER`·`GOODS_ISSUE`) ⇒ 결손 4 + 후속 결손 2(`INVENTORY_TRANSACTION`·`MATERIAL_CONSUMPTION`) = **6**. §4-5 본문이 스스로 6개를 열거하고 「7행」이라 적었다. §9-3 ⓐ·PR ② 예산(`prisma/seed.ts` +~14)도 같이 정정.
- ✅ `uq_entity_type_table (schema_name, table_name)` 충돌 0 — 6쌍(`logistics.material_issue_request`·`logistics.picking_order`·`logistics.subcontract_issue`·`logistics.subcontract_receipt`·`inventory.inventory_transaction`·`production.material_consumption`) 모두 등록부에 없음을 `psql` 로 확인. 시드 행 추가는 마이그가 아니다 ✅.
- ⚠ 한 줄 보탤 것: `INVENTORY_TRANSACTION` 은 PK 가 `(inventory_transaction_id, business_date)` 복합인데 등록부 `id_column_name` 은 한 칸이다. 부팅 «대조»에만 쓰므로 무해하나 매핑 표 주석에 남길 것.
- ✅ `goods_issue` 취소 3칸을 비워 두는 것은 두-릴리스 규칙과 **무관**하다(삭제가 아니다).
- ✏ **§11 정정 목록에 2건이 빠졌다** — `plan-integration.md` **169행**(슬라이스 표 I-5 행 PR 열 `3` → `5`) · **248행**(§3-1 I-5 절의 ⌜`entity_type_registry` 표가 이미 있으니 거기서 읽는다 — 코드에 표를 박지 않는다⌝ · §9 #5 와 «같은 문장이 두 자리»다). §11 #3 은 §9 #5 와 `plan.md` 102행만 짚었다.

## 3. `reverse()` 코어 — ✏ (한 자리는 ⛔ 급 모순)

- ✅ **from/to 뒤집기**가 유일한 길인 것이 이중으로 확인된다 — 라인 `qty` 인라인 `CHECK (qty > 0)` + 도메인 `app.qty_t CHECK (VALUE >= 0)`(baseline `:59`·`:1177`). `ck_inventory_transaction_direction` 은 뒤집어도 성립. 되짚기 칸 불변도 선택이 아니라 강제다 — `trg_inventory_transaction_line_immutable` 이 라인 UPDATE 를 통째로 막는다(baseline `:2977-2993`).
- ✅ **`business_date` = 원 트랜잭션의 것**(§3-4 ⓐ). 근거가 실측으로 선다: `inventory_transaction_id` 는 파티션 부모의 `GENERATED ALWAYS AS IDENTITY` 라 전역 유일 ⇒ `uq_inventory_idempotency(REVERSAL:{원 id}, 원 영업일)` 이 원 트랜잭션당 역행 1개를 DB 로 강제한다. ⓑ 를 고르면 그 방어가 사라진다는 판정 근거에 동의한다. 「원장 마감 개념 0건」도 실측과 맞다.
- ⛔ **§3-6 의 ②와 ③이 같은 상태에서 서로 다른 결과를 낸다.** ②(멱등키 선조회)는 `alreadyReversed:true` 로 흡수, ③(손검사)은 400 `STATE_LOCKED`. 키가 원 id 에서만 파생되므로 ③이 잡을 「키가 다른 역행」은 이 코어에 존재하지 않는다 — ③은 도달 불가이고 단위 테스트 ①**8**·①**9** 는 서로 배타다. 갈래 둘: ⓐ ③을 「`reversal_of_transaction_id` 는 있는데 `idempotency_key` 가 `REVERSAL:` 로 시작하지 않는 행」(= I-14 가 `post()` 로 만든 역분개)으로 좁혀 살리고 테스트 이름을 그렇게 고친다 ⓑ ③을 지우고 ②만 남긴다. 지금 문장으로는 구현자가 갈린다 — **재수립에서 반드시 하나로 닫을 것.**
- ✏ **§3-7·§3-8 의 「7칸 키별 `available_qty`」가 틀렸다.** 차원 유일 인덱스 `uq_inventory_balance_dim` 은 **11칸**이고 `available_qty` 는 그 11칸 행마다 있다(baseline `:1091-1137`). I-4 `lockBalances` 는 7칸으로 잠근 뒤 `rows.length > 1` 이면 400 `INVALID`(문의 031)로 **포기한다**(`issue-posting.ts:124-130`) — 계약이 품질·재고 상태를 안 실어서다. **역처리는 사정이 다르다**: 원 라인이 `from_quality_status_code`·`from_inventory_status_code`·`ownership_type_code`·`owner_partner_id` 를 들고 있어 11칸이 확정된다. 「I-4 R-1 을 글자 그대로 승계」하면 차원이 둘 이상인 자리에서 **취소가 문의 031 오류로 막힌다**. ⇒ 잠금은 7칸 오름차순 한 문장 그대로(순서 불변식 유지), **판정·합산은 11칸 행 단위**로 고쳐 적고 단위 테스트 ①10·①11 이름도 맞출 것.
- ✅ **`NEGATIVE_BALANCE` 를 코어가 던지는 역전**에 동의한다. `check_balance_qty()` 첫 갈래가 `on_hand < reserved+picked+blocked` 도 막으므로(baseline `:2838-2842`) `available_qty ≥ Σ` 선검사가 트리거 두 갈래를 다 앞당긴다 — §3-8 의 「`negative_stock_allowed` 를 안 본다」가 실측으로 선다. I-4 §3-3 과 모순 아님(도메인이 되돌릴 수량을 «고르지 않는다»가 가른다) ✅.
- ✅ `{원 번호}-R` — `transaction_no` 는 `app.business_no_t` = `varchar(100) CHECK (VALUE <> '')`(baseline `:56`), 길이 안전. `transaction_type_code` 복사는 계약이 근거를 준다 — `InventoryTransaction.sourceDocumentTypeCode` 설명이 ⌜방향은 라인의 from*/to* 가 이미 말하므로 `transactionTypeCode` 를 따로 두지 않는다(L-2-1)⌝(jq 실측). 채번 코어 미호출도 결번을 안 만든다 ✅.
- ✏ ~162 ≤ 200 은 성립하나 §3-7 의 「`post()` 를 고치면 코어 PR ≤200 을 깬다」는 **수치가 안 맞는다** — 아래 6 참조.

## 4. 후속 판정 함수 — ✏

- ✅ 세 호출자·두 갈래·「함수 하나」에 동의. 축 실측 전건 확인(`psql`): `picking_order.source_document_*` NOT NULL · `material_consumption.lot_id` NOT NULL 이고 `source_document_*` 칸 **없음** · `inbound_receipt_line.lot_id` nullable / `goods_receipt_line.lot_id` NOT NULL. §4-2 의 「`INVENTORY_TRANSACTION` 은 LOT 축」 판정은 0단계로 정확히 닫힌다.
- ✏ **세지 않는 것 ②가 유형을 안 가른다.** 「후속 문서의 `status_code = 'CANCELLED'`」는 `goods_receipt`·`goods_issue` 에만 참이다. `picking_order` 는 피킹 축, `material_consumption` 은 생산 축(`status_code` 실재 — `psql` 로 31칸 중 확인 — 이나 값집합이 다르다), `inventory_transaction.status_code` 는 원장 상태다. 지금 문장대로 구현하면 **값 목록이 없는 축에 `'CANCELLED'` 를 지어 넣는 F-6 함정**에 정면으로 걸린다. ⇒ 정적 매핑 표에 유형별 `cancelledStatus`(없으면 `null` = 규칙 ② 미적용) 한 칸을 두고, 원장·투입 갈래는 규칙 ③이 대신한다고 명시할 것.
- ✏ **③의 근거 문장이 한 칸 어긋난다.** 역행이 `source_document_*` 를 복사해 생기는 자기 후속은 **규칙 ①이 이미 걸러 낸다**(같은 문서다). ③이 실제로 필요한 자리는 **LOT 축** — 하류 출고의 원장 «과» 그 역행이 둘 다 이 입고의 LOT 을 문다. §4-3 아래 ⚠ 문장을 그렇게 고칠 것(결론 불변).
- ✅ **§4-5 「등록부는 검증·매핑은 코드」 — `plan-integration.md` §9 #5 절반 기각에 동의한다.** 결정적 실측은 `\d app.entity_type_registry` 의 칸 4개다 — `DocumentProgress` required 10 중 문서번호·일자·상태·계획/처리 수량 어느 것도 못 채운다. 9종 중 4종 결손(위 2)과 `$queryRawUnsafe` 식별자 연결 금지도 이 저장소 관행과 맞다. 부팅 대조를 «로그 경고»로 둔 것(던지지 않는다)이 §9 #5 의 걱정(「유형이 늘 때 조용히 틀린다」)을 실제로 잡는다 ✅.

## 5. 조회 2건 — ✅ (한 자리 ✏)

- ✅ `documentTypeCode` required ⇒ 유니온 불필요 · 유형별 Prisma 쿼리 하나 · 정렬 선례 · 외주 2종 FK 파생 · `steps` 4값 · 「거슬러 오르지 않는다」. 상태 이력 표가 없다는 실측과 「`POSTED` 줄은 원장이 있을 때만」이 맞물린다.
- ✏ `cancellableOnly` 를 뒤에서 거르는 판정 자체는 받아들인다(상관 서브쿼리 다섯 표를 안 만드는 쪽). 다만 **페이지 크기가 요청보다 작아지는 것 + `totalElements` 가 거르기 전 수인 것**은 화면 페이저를 깨는 조합이라 「알려둘 것」 한 줄로는 약하다 — uiux 관점의 확인이 필요하다(내 관점 밖이라 표시만 한다).
- ✏ **sonnet 배분에 단서가 하나 걸린다.** README §4 는 「e2e 작성 — sonnet, **코어 슬라이스는 opus**」다. I-5 는 역트랜잭션 코어를 세우는 슬라이스이므로 PR ③의 e2e 10건이 그 단서에 닿는다. §5-6 이 그 문장을 안 짚었다 — 본문 sonnet·e2e opus 로 가르거나, 「PR ③은 코어를 안 만진다」는 근거를 한 줄 적을 것.

## 6. 상태기계·어댑터 — ✏ (한 자리는 인계가 아니라 잔여 위험)

- ✅ `transitions.ts` 실측 그대로다 — 160줄·키 6개·`logistics.goods_issue.status_code` 에 `document-post` 한 줄, `:158` 에 「I-5 가 이 키 안에 …더한다 — 키를 다시 만들지 않는다」 예약 주석 실재. `conflictStatus` 400 도 같은 파일 주석(`:143-146`)이 이미 못박았다. `transitionCode` 미사용·입하 `POSTED` 도달 불가 방치도 타당.
- ✅ **I-3 R-12 ⓑ 자물쇠 유지**에 동의 — 이 슬라이스가 여는 것은 취소 2값이고 `POSTED` 축은 여전히 없다. 걷을 조건이 안 섰다.
- ⛔ **I-4 R-12 ⓐ 가 닫히지 않는데 「인계」로만 적혔다.** ⓐ 는 「입고 `postReceipt` 의 순서(ⓚ)를 **코어 차원에서 한 번에** 정한다」인데 §3-7 은 `reverse()` 안에만 두고 `post()` 는 I-8 로 넘겼다. 실측: `receipt-posting.ts` 에 `FOR UPDATE`·`lockBalances` **0건**, `post()` 도 선잠금 없이 라인 순서대로 `move()`(`inventory-posting.service.ts:29-95`). ⇒ `:cancel`(역처리 · `inventory_balance_id` 오름차순 선잠금) ↔ 동시 `POST /logistics/goods-receipts`(라인 순서) 사이의 **교착 창이 I-5~I-8 내내 열린 채 남는다** — I-4 R-9 ⓚ 가 예고한 바로 그 자리다. 그리고 「diff 가 ≤200 을 깬다」는 근거가 수치로 안 선다: `post()` 머리에서 같은 선잠금 헬퍼를 한 번 부르는 것으로 끝나고(라인 `line_no` 는 `index+1` 이라 안 흔들린다) ≈8~12줄, 162+12 = **174 ≤ 200**. ⇒ PR ①에서 `post()` 도 같이 닫거나, 못 닫는다면 **「인계」가 아니라 「잔여 위험」으로 §8 과 「알려둘 것」에 명시**할 것(지금은 위험이 안 보인다).
- ✅ 어댑터 3. 입하 `received_qty` 되돌림의 하한 검사는 **선택이 아니라 필수**임이 실측으로 확인된다 — `purchase_order_line.received_qty` 는 `app.qty_t`(도메인 `CHECK (VALUE >= 0)`)라 음수면 400 이 아니라 **500 이 샌다**. 상한은 `ck_po_line_received`(baseline `:926-940`). 부모 `purchase_order` 오름차순 `FOR UPDATE` 불변식도 I-3 R-12 ⓐ 그대로 ✅.
- ✏ **I-3 R-12 ⓘ 가 §8 인계표·§6-4 어디에도 인용되지 않았다** — 「#204 리팩터로 등록·분리의 부모 `FOR UPDATE` 가 「없는 P/O 라인」 400 «앞»으로 갔다 … I-5 가 같은 자리를 만질 때 순서를 맞춘다」. 취소 어댑터의 잠금·검사 순서를 그 선례에 맞춘다고 한 줄 적을 것.
- ✅ `putaway_task`·LOT ⓐ 손대지 않음 · 원 트랜잭션 2행+ 던짐 · ③-2→③-3→③-4→③-5→③-6 순서(재판정 실패 시 흔적 0)에 동의. ✅ §6-5(반려 뒤 전이 미신설)는 F-6 과 정합.

## 7. 횡단·PR 분할 — ✏

- ✅ 403 추가 0 — `derived-permissions.ts:48·49·167·168` 실재(경로는 `src/common/permissions/`; 브리프의 `src/common/http/` 는 오기). If-Match 토큰 = 대상 문서 `version_no`·어댑터가 비교 · `runIdempotent` 2 · `runVersioned` 불가(ETag 미선언) · `CANCEL_IN_PROGRESS` **400** 모두 동의(`error-codes.ts:42-58` 이 `SUCCESSOR_EXISTS`·`NEGATIVE_BALANCE` 를 I-5 자리로 이미 예약해 두었다).
- ⛔ **「README §6 ② 예산 350」은 이 저장소에 없다.** `docs/coverage-100/README.md` 는 84줄이고 §5 에서 끝난다(§6 부재) · `docs/coverage-100/` 전체에 문자열 `350` **0건**. 실효 예산은 CLAUDE.md 의 비테스트 ≤400 · 코어 ≤200 이고 선례가 모두 350 을 넘겼다(I-3 ③ 348 · I-4 ① 330·③ 372·④ 340). ⇒ **PR ③ ~378 은 규칙 위반이 아니다.** 5분할·순서·스택 재베이스에 동의.
- ✏ (선택) 그래도 ③은 파일 6개·비테스트 378·e2e 10 으로 이 슬라이스 최대이고 유일한 sonnet PR 이다. **③a 목록+매퍼(~230) / ③b 상세·`steps`·`successors`+e2e(~150)** 로 쪼개면 예산·모델 배분·리뷰 부담이 함께 내려간다.
- ✅ e2e 로 못 가는 가드를 단위 테스트가 덮는다: 세 겹 ③(①8) · `NEGATIVE_BALANCE` 0행(①12) · 원 원장 2행+ 던짐(⑤7) · 5값 우선순위(②6) · 반려 뒤 머묾(④8). 단 ①8↔①9 는 위 3의 모순을 그대로 물려받는다.
- ✅ §10-1 정리 순서 ①이 맞다. `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE` 는 이미 **6스위트의 확립된 선례**다(`inventory-balance:418`·`inventory-posting:124`·`inventory-transaction:418`·`logistics-goods-issue:866`·`logistics-goods-receipt:576`·`trace-lot:528`) — 트리거가 DELETE 를 막아 다른 길이 없고 복합 FK 자기참조도 한 번에 지운다. 시퀀서 순서도 맞다(`logistics-document-progress` < `logistics-goods-issue`·`-goods-receipt`, 파일명 순).
- ✏ **문구 하나가 틀렸다** — 「CASCADE 가 `goods_receipt_line`·`goods_issue_line`·`putaway_task` 의 되짚기 **칸**을 함께 비운다」. `TRUNCATE … CASCADE` 는 칸을 비우지 않고 **참조 표를 통째로 비운다**(`inventory_transaction_line` 을 참조하는 FK 7건 — 위 셋 + `stock_transfer_line` ×2 · `inventory_adjustment_line` · `material_return_line`). `logistics-goods-issue.e2e-spec.ts:13-19` 가 그 사실과 «순서에 기댄다»는 위험을 정확히 적어 두었으니 같은 표현으로 고칠 것 — 그래야 이 스위트가 뒤 스위트보다 «앞»이어야 하는 이유가 보인다.
- ✅ ⑥의 `approval_request_id = NULL` 끊기에 `inbound_receipt` 도 필요하다고 스스로 잡았다(실측: `inbound_receipt.approval_request_id` 실재) ✅. J-8·M1 e2e 배치 동의.

## 8. `plan-integration.md` 와 어긋나는 자리 (구현에 영향 주는 것만) — ✏

- ✅ §11 대조표의 integration 행 실측 확인: #3(등록부 — 위 4) · #4(`INVENTORY_TRANSACTION` LOT 축) · #6(마이그 0 — `plan-integration.md` §6-3 의 7건 표에 I-5 행이 없다) · #8·#9·#10(문의 3건) · #13(「14표 중 2표」 → 실측은 **1표**뿐, 결론 불변).
- ✏ 위 2의 **누락 2건**(169행 PR 열 · 248행 등록부 문장)을 §11 에 행으로 더할 것.
- ✅ **§6-2 「⛔ I-5 ∥ I-8」은 유지되고 근거가 더 강해진다** — 두 슬라이스가 `inventory-posting.service.ts` 말고도 `posting.types.ts` 와 `prisma/seed.ts`(`ENTITY_TYPES`)를 함께 만진다. §8 인계 ⓒ 가 seed 중복을 이미 막아 뒀다. 다만 위 6 때문에 직렬 구간이 「I-5 → I-8」 두 슬라이스에 걸쳐 **교착 창을 안고 간다**는 사실을 §6-2 옆에 한 줄 남길 것.
- ✅ §2 코어표(역트랜잭션 = I-5 전용 PR ≤200) · §4-1 M1 체인의 「입고 취소 → 역트랜잭션 → balance 원복」 · 401·496·506행의 I-23 승계 규약과 모두 정합.

---

## 재수립 결과 — 5줄 요약

1. **I-5.md 수정 8건** — ⓐ seed `ENTITY_TYPES` **+7 → +6**(§4-5·§9-3 ⓐ·PR ② 예산) ⓑ §3-6 ②·③ 모순 해소(③을 「키가 `REVERSAL:` 이 아닌 역행」으로 좁히거나 삭제 · 단위 테스트 ①8·①9 동반 수정) ⓒ §3-7·§3-8 「7칸 키별 `available_qty`」 → 잠금 7칸·**판정 11칸 행 단위**(그대로 두면 문의 031 오류로 취소가 막힌다) ⓓ §4-3 규칙 ②에 유형별 `cancelledStatus` 칸 도입(F-6) ⓔ §4-3 ③의 근거를 문서 축 → **LOT 축**으로 정정 ⓕ §3-7·§6-4 의 `post()` 선잠금을 「인계」가 아니라 **잔여 교착 위험**으로 명시(≈12줄이면 PR ①에서 닫힌다 · 174 ≤ 200) ⓖ §10-1 ①의 「되짚기 «칸»을 비운다」 → 「참조 **표**를 통째로 비운다」 ⓗ §8 에 I-3 R-12 ⓘ(잠금·400 순서) 인용 한 줄.
2. **`plan.md` 에 반영할 것** — 102행 「유형↔표는 `entity_type_registry` 에서 읽음」 → 「매핑은 코드의 정적 표 · 등록부는 부팅 대조」 · §1 6행 PR 열 3 → 5 · 모델 열에 「③만 sonnet」. 마이그·순서·M1 표는 **불변**.
3. **`plan-integration.md` 에 반영할 것 — §11 이 빠뜨린 2건 포함 4자리**: 169행(PR 3→5) · 248행(등록부 문장) · §9 #5(절반 기각 · 부팅 대조로 남긴다) · §6-2 옆에 「I-5→I-8 직렬 구간이 `post()` 선잠금 부재로 교착 창을 안고 간다」 한 줄.
4. **문의 최종 3건 유지(032·033·034)** — 032 는 권고안(원 트랜잭션 영업일)대로 **회신 대기 없이 구현**한다고 못박고, 033 은 제목을 「취소 요청 철회 오퍼레이션 부재」로 세우며, 034 는 근거를 「NOT NULL 해제는 스키마 변경」이 아니라 「그 칸을 읽는 계약 응답이 0건이라 완화 이득 0」으로 바꾼다(I-3 `inbound_variance` 선례와의 충돌 회피). 기존 인용 026·030 그대로.
5. **PR 분할 최종안 — 5개 유지**(① 코어 ~174(선잠금 보강 포함) · ② 매핑+판정 ~265 · ③ 조회 ~378 · ④ `:request-cancel` ~258 · ⑤ `:cancel`+어댑터 ~330 · 합 ~1,405 · 마이그 커밋 0 · ⛔ I-8 직렬). 「예산 350」 규칙은 **저장소에 존재하지 않아** ③이 걸리지 않는다(실효 예산 ≤400 · 코어 ≤200). 부담이 크면 ③을 ③a 목록(~230)/③b 상세+e2e(~150)로 나누는 것은 선택 사항이다.
