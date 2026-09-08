# I-13 재검토 — **integration**(체인·원장·트랜잭션)

> 대상 `slices/I-13.md`(1080줄) · 관점 계획서 `plan-integration.md` 177·301·320~327·588·823~830 ·
> 선행 `I-12.md`(059·R-3) · `I-5.md` · `I-4.md` R-1 · `I-9.md` R-17.
> ⭐ 실측 부록(#1~67)은 재측정하지 않았다. **예외 2** — 판정 ① 의 전제(CHECK)와 되짚기 FK 형상은
> 내 지적이 그 값에 걸려 psql 로 다시 쟀다(아래 근거에 결과를 적었다). 나머지는 그대로 받는다.

## A. 「반드시 볼 자리 5」 판정

### ① 창고 간 제한을 서버가 400 `INVALID`(`toWarehouseId`)로 막는다 — ✅ 동의

전제를 psql 로 재확인했다(내 판정이 걸려 있어 예외 적용). `logistics.stock_transfer` 의 CHECK 는
`stock_transfer_version_no_check` **하나**뿐이고 `ck_stock_transfer_warehouses` 는 **없다**.
`ck_stock_transfer_locations CHECK (from_location_id <> to_location_id)` 는 **라인 표**에 있다
(`pg_constraint` · `20260826000000_data_model_v4/migration.sql:90-95`). ⇒ §2-2·0-1 ① 그대로 참이다.
통합 관점에서 더할 것 없음 — CHECK 를 되살리지 않는 판정(§2-5)도 `lanes.md` §1-2 「추가·완화만」과 맞다.

### ② 도착이 `from_inventory_status_code` 로 되돌린다 — ✅ 동의 · ✏ **손검사 자리에 결함 1**

되돌림 자체는 옳다(`putaway-posting.ts:52-53`·`issue-posting.ts:196-198`). 다만 §3-3 의
「도착도 **같은 손검사를 태운다**」가 `issue-posting.ts:96-165` 를 그대로 복제하면 **정상 호출이 400 이 된다**.

- **R-A(치명·구현 결함)** `lockBalancesInOrder` 의 키는 **7칸**이고 `quality/inventory_status·소유`를
  **안 가른다**(`balance-lock.ts:4-12,55-62`). `issue-posting.ts:131-136` 은 그 키로 잡은 행이
  `rows.length > 1` 이면 400 `INVALID`(문의 031)다. 그런데 도착의 `from` 키 =
  {도착 창고, 계획 위치, 품목, LOT} 에는 **이미 도착해 `AVAILABLE` 로 선 잔액**이 함께 걸린다 —
  같은 품목·LOT 을 같은 위치로 **두 번째** 이동시키면 `AVAILABLE`+`IN_TRANSIT` **2행** ⇒ 언제나 400.
  ⇒ 도착의 손검사는 「행이 하나인가」가 아니라 **반출 원장 라인이 준 11칸(품질·재고 상태·소유)으로
  잠근 행 중 하나를 고르는** 형태여야 한다(`LockedBalanceRow` 가 그 4칸을 이미 싣는다 ·
  `balance-lock.ts:16-23`). §3-3 ⚠ 문장과 §3-5 에 이 문장을 못 박고 단위 ②에 갈래를 더한다.

### ③ `:arrive` 는 한 번만 — ✅ 동의 · ✏ 근거 한 줄 보강

거부가 §2 2단계 기준 2·5 로 옳다. 다만 §3-1 의 「결정적 멱등키가 둘째 그물」은 **부분적으로만 참**이다 —
`uq_inventory_idempotency` 는 `(idempotency_key, **business_date**)` 다(부록 #23 · baseline `:1157-1158`).
두 번째 `:arrive` 가 **다른 `businessDate`** 를 실으면 키가 갈려 원장이 흡수하지 않는다.
⇒ 재도착을 막는 그물은 **`FOR UPDATE` 안의 `received_at IS NOT NULL` 하나뿐**이다. §5-1 ③ 이 그 자리에
있어 결론은 안 바뀌지만, 「둘째 그물」이라는 §3-1 문장은 **지우거나 「같은 영업일에 한해」로 조인다**.

### ④ `PUT …/lines` 는 자물쇠까지만 — ✅ 동의

도달 불가 근거(생성=반출 한 오퍼레이션 · 반출 전 상태를 만드는 경로 0)가 통합 관점에서도 성립한다.
치환 본체는 `LINE_NO_SHIFT`·소유·중복 검사 + 부모 `version_no` 범프까지 딸려 와(`goods-issue-update.service.ts:20,50-153,268-289`)
PR ④ 예산을 세 배로 만든다. `version_no` 를 안 올리는 판정(§6-2)도 옳다 — 바뀌는 행이 0이다.

### ⑤ 판별자 겹침을 이 슬라이스가 고친다 — ✅ 동의 · ✏ **닿는 곳이 셋이 아니라 다섯**

`transaction_no` 접두 축(≈6줄)은 맞는 처방이다. `DOCUMENT_TYPES.STOCK_TRANSFER.noColumn = 'stock_transfer_no'`
(NOT NULL)이라 `mapping.noColumn !== null` 가드가 실제로 통과하고, `steps()` 가 받는 `row` 는
`delegate.findFirst({include})` 의 전체 행이라 그 칸이 있다(`document-progress-query.service.ts:88-90,218-231`).
적치는 `PT-` 접두라 갈린다. **다만 §3-8 「닿는 곳 셋」 표에 둘이 빠졌다.**

- **R-B(추가 · 「알려둘 것」)** `cancel-eligibility.service.ts:170-186` `lotAxis` 는 입하·입고 문서의
  **후속**을 「그 LOT 을 실은 다른 원장 행」으로 센다. I-13 뒤로는 그 LOT 을 한 번 이동시키면
  원장이 **둘**(`ST-…`·`ST-…-A`) 늘어 `successorCount += 2` ⇒ 그 입고의 `:request-cancel`·`:cancel` 이
  400 `SUCCESSOR_EXISTS` 로 **영구히** 막힌다. I-12 R-3 이 적치로 이미 연 자리이고 업무적으로도 옳지만,
  **이동은 건당 2행**이라 `successors` 목록에 같은 전표가 두 줄로 보인다. 회귀 스위트에
  `logistics-document-progress.e2e-spec.ts` 를 이미 넣은 것은 잘한 것이다(§10-3).
- **R-C(추가 · 「알려둘 것」 또는 e2e 38 단언)** `steps()` 의 `posted` 는
  `orderBy: { occurred_at: 'asc' }` 라 **반출 원장**을 집는다 ⇒ 반출 직후 전표가 `REGISTERED` 인데
  진행 조회는 **「전기 완료」 단계를 이미 지난 것으로** 그린다. 2단 전표라서 생기는 어긋남이고,
  `processedColumn: 'received_qty'`(`document-type-registry.ts:68-70`)와도 짝이 안 맞는다.
  판정을 바꾸자는 것이 아니라 **사실로 적고 e2e 38 에 한 줄 단언**을 붙이라는 지적이다.
- `document-cancel-execute.service.ts:141` 은 `cancelable:false` 라 도달 불가 — §3-8 표 셋째 행 그대로 ✅.

## B. 통합 관점에서 «계획자가 안 본» 자리

- **R-D(치명 · 500 누출)** §5-1 ⑥ 의 `toLocationId` 재정의 검사가 **위치 그물 셋뿐**이다.
  그런데 재정의 값이 그 라인의 `from_location_id` 와 같으면 §5-1 ⑨ 의
  `UPDATE stock_transfer_line SET to_location_id = …` 이 **라인 CHECK `ck_stock_transfer_locations`
  (psql 실측)** 를 깨 500 이 샌다. §4-2 ⑥ 은 `POST` 에만 있다.
  ⇒ `:arrive` 의 위치 그물에 **`≠ from_location_id`(400 `INVALID`)를 넷째로** 더한다. e2e 1건.
- **R-E(추가 · 흔적)** 이 슬라이스는 **한 위치가 재고 상태 차원 둘을 갖는 첫 자리**다 —
  계획 도착 위치에 `IN_TRANSIT` 행이 서면, 그 위치에서 나가는 **출고·다음 이동**의
  `from` 키가 2행을 잡아 `issue-posting.ts:131-136` 의 400 `INVALID`(문의 031)에 걸린다.
  지금까지 그 갈래는 사실상 도달 불가였는데 **I-13 이 본길로 만든다.** 새 문의를 열 자리는 아니고
  (031 이 그 물음이다) **031 에 한 줄 + e2e 1건**(도착 전 위치에서의 출고가 400 `INVALID` 라는 사실)으로
  못 박는다. §11-1 #9 를 「복제」에서 「복제 + 도달 형상이 이 슬라이스로 생긴다」로 고친다.
- **R-F(⚠ 공용 자원 · 레인 안 충돌)** §13 인계 ② 가 `transitions.ts` 의 **레인 A 소유**만 적었다.
  **같은 레인의 I-14 도 새 축(`inventory.inventory_adjustment.status_code` · `document-post`)을 연다**
  (`plan-api.md:745-747` · `lane-C.md:25,33` 「I-13 ∥ I-14」). 둘 다 `document-state.spec.ts` 의
  축 목록과 `toHaveLength(28)` 를 올린다 ⇒ **같은 두 줄에서 반드시 부딪힌다.**
  ⇒ §12 에 「PR ③ 의 코어 커밋과 I-14 의 전이 커밋을 **레인 안에서 직렬화**한다(먼저 병합한 쪽 기준으로
  뒤가 `origin/main` 을 merge 하고 숫자를 다시 센다)」를 명시한다. `lanes.md` §1-4 공용 등록부 규칙과 같은 처방.
- **R-G(✏ 조직 축)** §3-1 이 `plantId` 만 두 창고로 갈랐는데, 잔액 행의 조직 축은 **3칸**
  (`legal_entity_id`·`business_unit_id`·`plant_id`)이고 `move()`·`balanceKeys()` 가 **끝점 창고마다 따로**
  푼다(`inventory-posting.service.ts:206-224,295-302`). 손검사의 키도 같아야 한다 —
  `issue-posting.ts:103-110` 이 `orgAxis(source)` 와 `destinationAxis` **둘**을 쓰는 이유가 그것이다.
  §3-2·§3-3 에 「`from` 키는 출발 창고, `to` 키는 도착 창고에서 조직 3축을 푼다」를 적는다.
  ⇒ 「알려둘 것」 ⓑ 를 「`plant_id` 가 갈린다」에서 **「법인·사업장·공장 3축이 갈릴 수 있다」**로 넓힌다.
- **✅ 확인해 준 것**: `stock_transfer_line.{issue,receipt}_transaction_line_id` 의 FK 는
  `inventory_transaction_line(inventory_transaction_line_id)` **단일 칸**이고 그 표는 파티션이 아니다
  (`relkind='r'` · `inventory_transaction_line_pkey PRIMARY KEY (inventory_transaction_line_id)` · psql).
  ⇒ §3-6 되짚기 UPDATE 가 `business_date` 없이 안전하다. §10-2 의 `TRUNCATE … CASCADE` 가
  `stock_transfer_line` 까지 비운다는 것도 이 FK 로 성립한다.
- **✅** 잠금 순서(`stock_transfer` 헤더 1행 → 코어의 잔액 id 오름차순)는 교착 창이 없다
  (`balance-lock.ts:25-40` · I-4 R-1 ①②). 두 전기를 두 트랜잭션으로 가른 §3-0 도 옳다.
- **✅** 에러 코드 신설 0 성립 — 여섯 코드 전부 `src/common/errors/error-codes.ts:9-55` 에 있다.

## C. 나머지 판정 항목

- **문의 6건(120~125)** — 전부 새 물음이다(001~062 · 대기 15 · `계약-되돌림-mdm.md` 대조). §2 절차 판정도 동의.
  121 은 psql 로 직접 확인했다(위 ①). 124 는 `ck_stock_transfer_qty (received_qty <= shipped_qty)` 가
  부분 도착을 받고 닫는 오퍼레이션이 0건인 것으로 성립한다 — **잔여가 `IN_TRANSIT` 에 영구 잔류**가 맞다.
  ⇒ **신규 6건 유지.** 기존에 한 줄 더하는 것은 059·031·문의 14·060 그대로 **4** (031 에 R-E 를 얹는다).
- **e2e 39 → 42 를 권한다** — 빠진 갈래 셋: ⓐ 도착 위치에 같은 품목·LOT 의 `AVAILABLE` 잔액이 이미
  있어도 도착이 200(R-A) ⓑ `IN_TRANSIT` 이 선 위치에서의 출고가 400 `INVALID`(R-E · 031 흔적)
  ⓒ `:arrive` 의 `toLocationId` 재정의가 `fromLocationId` 와 같으면 400 `INVALID`(R-D).
- **PR 4 분할** — ✅ 성립. ②③ 합산 ≈600 은 형제 파일 실측과 맞고, 자르는 선을 **전기 축**으로 잡은 것이
  통합 관점에서 가장 깨끗하다(`transfer-posting.ts` 를 두 함수로). **PR ① 병행 스폰 ✅** — 다섯 자리 중
  ① 에 닿는 것이 없다는 판단이 맞다. ⛔ 단 **PR ④ 는 `document-progress-query.service.ts` 를 만지므로**
  그 스위트 회귀를 PR ④ 자체에서 돈다(§12 게이트 문장에 이미 있다 ✅).
- **자기 관점 계획서와의 어긋남** — `:324`(`AVAILABLE` 고정) → §3-5 정정 ✅ · `:325`(`to_location_id`) 유지 ✅ ·
  `:177` PR 3 → 4 ✅ · `:322` 「I-9 선례」·「체인 마디 없음」 둘 다 실측과 맞다(§10-5).

## D. 5줄 요약

1. **`I-13.md` 반영 수정 7건** — R-A(도착 손검사를 11칸 차원 매칭으로 · §3-3·§3-5·단위 ②) ·
   R-B(§3-8 「닿는 곳」에 `cancel-eligibility` `lotAxis` 추가 · 이동 1건 = 후속 2행) ·
   R-C(§3-8·e2e 38 — 진행 조회가 반출 직후 「전기 완료」로 그린다) · R-D(§5-1 ⑥ 에 `≠ from_location_id` 넷째 그물) ·
   R-E(§11-1 #9 · 031 에 한 줄 — `IN_TRANSIT` 이 「차원 둘」을 본길로 만든다) ·
   R-F(§12·§13 ② — I-14 와 `transitions.ts`·`document-state.spec.ts` 레인 안 직렬화) ·
   R-G(§3-1~3-3 조직 3축 · 「알려둘 것」 ⓑ 확장). 덤: §3-1 「멱등키가 둘째 그물」 문장 조이기 · e2e 39 → 42.
2. **`plan*.md` 반영** — `plan-integration.md:324`(`AVAILABLE` → 반출 라인의 `from_inventory_status_code`) ·
   `:177`(PR 3 → 4) · `plan-api.md:748`(`transfer-issue` 는 전이가 아니다) · `:752`(부분 도착 「합」 → 1회 확정) ·
   `plan-uiux.md:48`(마이그 「없음」 → A4) · `:250-253`(응답 ETag 둘뿐).
3. **문의 최종 — 신규 6건(120~125) 유지** + 기존에 한 줄 더하는 것 4(059·031·문의 14·060).
4. **⛔ 반대 0건.**
5. **멈춤 조건 — 미해당**(물리 삭제 0 · 게이트 미실행 · 계약 모순 없음). ⚠ 사용자 보고 2건은 그대로다 —
   `transitions.ts` 착수 전 알림(레인 A 소유 + **I-14 와의 레인 안 충돌**) · 마이그 PR ② 병합 직전 한 줄.
