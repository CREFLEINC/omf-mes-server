# I-16 3관점 재검토 — **integration**(통합 · 체인 · 원장 · 트랜잭션)

> 대상 `docs/coverage-100/slices/I-16.md`(934줄) · 브리프 `brief-I-16-review.md` · worktree `.claude/worktrees/i16-plan`(base 771c541) · 2026-09-07.
> ⛔ 반대 **2건**(G-1 · G-2 — 둘 다 트랜잭션·잠금) · 「반드시 볼 자리 5」는 **①②③④ ✅ · ⑤ ✏**(PR 수 4 는 유지, **스택 의존이 틀렸다**).
> 재측정한 것은 **판정 ① 을 떠받치는 물리 3건뿐**(README §6-1 ① 예외 — 내 판정이 그 값에 걸린다). 나머지 실측 부록은 그대로 뒀다.

---

## 1. 「반드시 볼 자리 5」 판정

### ① `HandlingUnitRepackEvent(+Line)` — 표 2 신설 — ✅ **동의**(근거 하나 보강)

재측정 3건 전부 계획안대로다.
- `handling_unit_reconfiguration_line` 8칸에 `handling_unit_id`·`role_code`·`qty_before`·`qty_after` **전부 없다** — `20260826000000_data_model_v4/migration.sql:539-545`.
- 헤더 `reconfiguration_no`(NOT NULL UNIQUE)·`source/target_handling_unit_id`(둘 다 NOT NULL)·`reason_code`(NOT NULL) — 같은 파일 `:527-531`.
- `CONSTRAINT ck_handling_unit_reconfiguration_distinct CHECK (source_handling_unit_id <> target_handling_unit_id)` — 같은 파일 `:534-535`. psql `pg_indexes` 로 그 표의 인덱스가 PK+`_no` UNIQUE+`uq_…_line` 셋뿐임도 확인.

⭐ **계획자가 안 쓴 근거 하나를 더한다** — 재사용은 «완화 9건」이 아니라 **제약 완화 2건이 더 붙는다**: `handling_unit_reconfiguration_line.uom_id bigint NOT NULL REFERENCES mdm.uom` 과 `moved_qty CHECK (moved_qty > 0)`. 계약 라인에 `uomId` 가 없으므로(부록 #7) 재사용하려면 **FK 있는 NOT NULL 칸 하나를 영구히 지어내야** 하고, 「변화 없는 줄」·「전량 이동 잔량 0」이 `moved_qty > 0` 을 깬다. ⇒ 신설이 더 작다는 결론이 더 굳는다.

### ② `status_code` 상수 «둘» — ✅ **동의**

통합 관점에서 덧붙일 것: 이 축은 **원장 축도 전이표 축도 아니고 «잠그는 행의 상태 칸»** 하나다. `transitions.ts` 12축에 `inventory.handling_unit` 이 0건인 사실(`document-state.spec.ts:276` `toHaveLength(28)` 재확인)과 §7 판정이 정합한다. nullable(⛔)로 가면 §3-3 6번(409)이 널 비교가 되어 잠금 순서표가 무너진다 — 계획안 판정이 맞다.

### ③ `PUT …/contents` 가 이벤트를 «언제나» 만든다 — ✅ **동의** · ✏ **부작용 한 줄 추가**

`app.qty_t = numeric(20,6) CHECK (VALUE >= 0)`(baseline `:59-60`)이 0 을 담는다는 전제도 맞다.
✏ **통합 부작용**: 멱등은 `idempotency_key` **하나**로 흡수하고 지문은 `method+path+body` 다(`src/common/master/master-write.ts:20-37` · `idempotency.service.ts:31·61`). 오프라인 큐(C-9)가 같은 치환을 **다른 키**로 재전송하면 흡수되지 않고 `qty_before === qty_after` 라인만 있는 **빈 이벤트**가 한 건 더 쌓인다. 판정은 안 바뀐다(계약 문자 그대로) — **문의 144 에 한 줄**(「이력이 무한히 는다」의 두 번째 원천).

### ④ `X-Worker-No` 셋 다 400 `REQUIRED` — ✅ **동의**

담을 칸 0 은 통합 관점에서도 참이다 — 신설 표에도 사번 축을 안 만들고 `performed_by` 는 `app.app_user` FK 다. 세 오퍼레이션 모두 403 선언이 있어 인증 가드를 지나므로 `performed_by NOT NULL` 이 세션 부재로 깨지는 경로가 없다(`session-resolver.ts:27-29` · `permission.guard.ts:37-53`).

### ⑤ PR 분할 4 — ✏ **수정(수는 4 유지 · 스택 의존 둘이 틀렸다)**

- ⛔ **④(`:pack`)는 ② 가 아니라 ③ 위에 서야 한다.** §11-1 그림은 `②→④` 인데, `:pack` 이 쓰는 `handling-unit-status.ts`(`HU_STATUS_PACKED`)와 `handling-unit-worker.ts`(`assertWorkerNo` 사본)를 **③ 이 만든다**(§8-1 표 · §11-2 PR ③ 범위). ⇒ 스택은 `① → ③ → ④` 이고 `② `는 ① 위 형제다. ② 와 ④ 는 서로를 안 부른다(`:pack` 은 이벤트를 0행 만든다 · §3-4).
- ⛔ **② 가 마이그를 넣는데 그 표를 지나는 테스트가 0 이다.** §11-2 는 e2e 전건을 ④ 에 뒀는데, 신설 표를 통과하는 것은 e2e 28~31 이고 그 넷은 전부 ② 의 범위(`PUT …/contents`·`repack-events`)다. **I-13 재수립 R-15 와 같은 공백**(「마이그가 만든 칸을 테스트가 한 번도 통과하지 않는다」). ⇒ **e2e 28~31 을 PR ② 로 옮긴다**(예산 밖 · 테스트).
- 조회 PR ① 을 리뷰와 나란히 스폰하는 것은 ✅ — 내 지적 어느 것도 ① 에 닿지 않는다(전부 ②③④·마이그).

---

## 2. ⛔ integration 단독 — 트랜잭션·잠금 **2건**

### G-1 ⛔ `:pack` 의 잠금 방식이 저장소 관행과 다르고, If-Match 가 없을 때 «잠기지 않는다»

§3-1 ④ 가 「`SELECT … FOR UPDATE` **대신** `UPDATE … WHERE version_no` 로」라 적었다. **If-Match 는 선택**이라(§1-1 · 부록 #18) 오프라인 큐 요청에는 대조할 `version_no` 가 아예 없다 ⇒ 그 형태로는 **행을 잠그는 문장이 성립하지 않는다.** 저장소의 「읽고 판정하고 쓰는」 자리는 예외 없이 `SELECT … FOR UPDATE` 다 — `lot-complete.service.ts:115-121` · `work-order-write.service.ts:59-70` · `work-session-end.service.ts:77-83` · `production-plan.service.ts:223-229` · `production-result-approval.service.ts:75` · `acknowledge.service.ts:85`(6곳 실측).
⇒ **§3-1 ④ 를 `SELECT … FOR UPDATE`(없으면 404)로 고친다.** ⑤(이미 `PACKED` → 409)·⑥(If-Match 대조)은 그 잠금 «안»에서 그대로 돈다. 비테스트 영향 0.

### G-2 ⛔ `PUT …/contents` 에 트랜잭션 순서표·잠금이 **아예 없다** — 이력의 `qtyBefore` 가 유실된다

§5 전체(§5-1~§5-6)에 §3-1 같은 순서표가 없고 「부모를 잠근다」는 문장이 **0건**이다. 그런데 §5-3 의 이벤트 라인은 **치환 «전» `handling_unit_content` 를 읽어** 만든다. 두 치환이 겹치면:

```
A: 전 구성 읽기(qty 80) ─┐            B: 전 구성 읽기(qty 80)
A: DELETE + INSERT(100) ─┘            B: DELETE + INSERT(60)
A: 이벤트 80→100                       B: 이벤트 80→60   ← 100 을 못 본다
```

`version_no` 낙관 잠금은 **그물이 못 된다** — If-Match 가 선택이라 둘 다 토큰을 안 실으면 §5-4 검사를 건너뛴다. `uq_handling_unit_content` 도 마지막 INSERT 만 남길 뿐 이력을 못 지킨다. ⇒ **§5 에 §3-1 형 순서표를 신설**하고 첫 단계를 **`SELECT … FOR UPDATE` 로 부모 `handling_unit` 잠그기**(없으면 404)로 못 박는다. 그다음에 전 구성 읽기 → DELETE → INSERT → 이벤트 → `version_no+1`. **단위 +1**(「전 구성 읽기가 부모 잠금 «뒤»다」) · 비테스트 +5 안쪽(PR ②).

---

## 3. 그 밖의 integration 지적 **5건**

| # | 자리 | 판정 |
|:-:|---|---|
| G-3 | **`PUT …/contents` 가 `PACKED` 포장도 무조건 치환한다** — §5-5 가 「상태를 안 옮긴다」만 적고 `PACKED` 를 막지도 않는다 | ✏ **판정은 맞다**(재구성이 곧 확정된 포장을 여는 본길 · `M-04-03` §5-3). 다만 계약 `:pack` 의 「이미 확정된 포장은 409」와 나란히 두면 읽는 사람이 헷갈린다 ⇒ §5-6 표에 「`PACKED` 여도 200」 한 줄 + **e2e +1**(「확정된 포장의 치환이 200 이고 `statusCode` 가 `PACKED` 그대로다」) |
| G-4 | **`DEFAULT_PREFIX` 3중 충돌** — I-13 `ST`(`I-13.md:532·1080`) · I-14 `IA`(`I-14.md:488`) · I-16 `HU` 가 **같은 상수 블록 13줄**을 각자 늘린다(`numbering.service.ts:9-28` 실측 13종) | ✏ §12-2 「코어」 행이 「한 줄 · 통지 불필요」로만 적었다. 통지 불필요는 맞다(`lanes.md` §1-4 소유 표에 없다). ⇒ **`inventory.module.ts` 와 같은 처방을 명시**한다 — 레인 안 순차 병합 · 병합 직전 `origin/main` merge + 게이트 재실행(`lanes.md` §1-4 공용 등록부 3·4) |
| G-5 | **신설 표의 정렬 축에 인덱스가 0** — §6-4 가 `orderBy (occurred_at desc, id desc)` 인데 인덱스는 `ix_…_line_hu(handling_unit_id)` 하나뿐이고 **응답에 `page` 가 없어 전건**을 내린다(문의 144) | ✏ 오늘 0행이라 「지금 걸 근거가 없다」는 §2-6 논리가 그대로 서지만, **`ix_handling_unit_repack_event_line_hu` 를 `(handling_unit_id, handling_unit_repack_event_id)` 복합**으로 만들면 헤더 join 축까지 덮는다(칸 수 0 증가 · 마이그 한 줄). 「알려둘 것」 ⓘ 에 이 표도 넣는다 |
| G-6 | **`plan-integration.md:129` 의 뒷절도 틀렸다** — 「포장은 차원(`handling_unit_id`)만 바꾼다」 | ✏ §12-1 이 `:180`·`:348` 만 잡았다. **`:129` 행 추가** — 잔액 차원 11칸에 그 칸이 없으므로(psql `indexdef` 재확인) 「차원을 바꾼다」가 **성립하지 않는다**. 원장 없음이라는 결론은 같지만 근거 문장이 틀렸다 |
| G-7 | **I-22 접점** — §12-2 의 「`shipment_lot_allocation.handling_unit_id` 가 이 표에 붙는다」 | ✅ 실측 확인 — `shipment_lot_allocation_handling_unit_id_fkey` 가 DB 에 실재. ⓖ(출하 배분된 포장의 재구성을 서버가 안 막는다)의 I-22 인계가 맞다 |

---

## 4. 브리프 지정 추가 항목

- **⑥ 문의 5건(140~144) 신규성** — ✅ **5건 유지.** `docs/design-inquiries/` 001~062 전수에 `handling_unit`·「취급 단위」·「포장」 **grep 0건** · 같은 회차 120~125(I-13 이동)·130~135(I-14 조정)와 주제 겹침 0 · `계약-되돌림-mdm.md` 겹침 0 · 대기 15(`businessDate`/`occurredAt` 미저장)는 141~144 와 다른 축이다. ✏ 다만 **141 은 053 의 넷째 갈래**다(「값 목록 없는 NOT NULL 코드를 서버가 잠정 문자열로 메웠다」). 갈라야 할 이유가 있다 — 053 은 ⌜**판정에는 쓰지 않는다**⌝ 로 닫았는데 `status_code` 는 **409 판정과 화면 필터에 쓴다**. ⇒ 141 본문에 「053 과 같은 모양이나 판정에 쓰는 첫 자리」 한 줄을 넣고 새로 연다(§2 절차 판정 자체에는 동의).
- **⑦ 새 에러 코드 0건** — ✅ 실측. `REQUIRED:9` · `INVALID:13` · `UNIQUE_VIOLATION:15` · `LINE_REQUIRED:24` 전건 `src/common/errors/error-codes.ts` 실재. `lanes.md` §1-4 「새 코드 추가 금지」 지켜진다.
- **⑧ 테스트에서 빠진 갈래** — 위 ⑤(e2e 28~31 을 PR ② 로) · G-2(단위 +1) · G-3(e2e +1). ⇒ **e2e 31 → 32 · 단위 9 → 10.** 신설 표를 지나는 테스트는 e2e 31 하나로 **있다**(R-15 형 공백은 «PR 배치»에만 있고 목록에는 없다).
- **⑨ 부수 발견 2건 — 둘 다 «사실»이다**(integration 이 확인):
  - **`I-13.md:1071`(부록 #24) 「`inventory_transaction_line.handling_unit_id` … FK 없다 · psql `pg_constraint` 0행」은 틀렸다.** psql 재측정 — `fk_inventory_transaction_line_hu`(contype `f`)가 실재하고 baseline `20260727000000_baseline_physical_model_v3/migration.sql:1254-1257` 이 원문이다. I-13 의 결론(그 칸을 안 건드린다)은 영향 없음 ⇒ I-16 「알려둘 것」 ⓜ **그대로 맞다.**
  - **`I-12.md:26`(R-2) 「`uq_inventory_balance_dim` 11칸 = 복제한 끝점 4 + 품목·LOT·소유 3 + **취급단위**」는 틀렸다 — 두 겹으로.** psql `indexdef` 실측 11칸은 `legal_entity_id, business_unit_id, plant_id, warehouse_id, location_id, item_id, COALESCE(lot_id,0), quality_status_code, inventory_status_code, ownership_type_code, COALESCE(owner_partner_id,0)` 다 ⇒ ⓐ **없는 `handling_unit_id` 를 넣었고** ⓑ **조직 3축(`legal_entity_id`·`business_unit_id`·`plant_id`)을 빠뜨렸다**(합이 8밖에 안 된다). I-13 재수립 **R-8** 이 그 조직 3축을 이미 못 박았으므로 **I-16 ⓝ 을 「조직 3축 누락」까지 넓혀 적는다.** I-12 의 결론(하한 판정 신설)에는 영향 없음.
- **⑩ 자기 계획서와의 어긋남 중 구현에 닿는 것** — §12-1 의 `plan-integration.md:180`·`:348` 정정에 ✅ 동의(둘 다 실측으로 뒤집혔다) · **G-6 의 `:129` 행을 더한다** · `:345-349`(체인 마디 I-22)·`:521`(M5)·`:590`(I-33 ∥ I-16 완전 분리 — `src/maintenance/` ↔ `src/inventory/handling-unit/`)·`:854-862`(전건 7)은 **고칠 것 0**.

---

## 5. 멈춤 조건 · 요약

- **README §3 멈춤 조건 미해당.** 신설 2표 · 삭제 0 · 백필 0 · 순서 의존 0(`lanes.md` §1-2 만족) · 기존 `handling_unit_reconfiguration(+_line)` 무변경(0행 · 참조 0) ⇒ 두 릴리스 규칙 미해당 · 코어 소유 파일(`transitions.ts`·`error-codes.ts`) 무변경 ⇒ 사용자 사전 통지 불필요.
- **⛔ 반대 2**(G-1 잠금 방식 · G-2 `PUT …/contents` 잠금 부재) · **✏ 수정 6**(⑤ 스택·e2e 배치 · ③ 부작용 · G-3 · G-4 · G-5 · G-6 · ⑥ 141 근거) · **✅ 동의 4**(자리 ①②③④ · 에러 코드 0 · I-22 접점).
- **예산 영향**: 비테스트 +5 안쪽(G-2 순서표) · e2e 31→32 · 단위 9→10 · **PR 수는 4 그대로**(스택 순서만 `①→③→④`, `②`는 ① 위 형제).
