# I-16 재수립 — 독립 리뷰 ①「API 설계」

> 대상: `.backend-dev/lane-a2/I-16-draft.md`(1032줄) 전문. 브리프: `.backend-dev/lane-a2/brief-I-16-review.md` §4「API 설계」.
> ⛔ 다른 관점의 리뷰 파일(`I-16-review-uiux.md`·`-integration.md`)은 **열지 않았다**(존재하지도 않았다 — `ls .backend-dev/lane-a2/` 실측).
> ⛔ 코드·계약·다른 문서 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 게이트 재실행 0.
> 실측 시각 2026-09-09 · 워크트리 `designer-worktree-workspace-ff88ca` · 워크트리 `HEAD` = `1df7042` · ⚠ **오늘 `origin/main` 은 `ee6b8b6`(+19커밋)**.

---

## ① 무엇을 «직접» 읽었나

### 계약 — `node` 로 전수 파싱(문서 인용 0)

| 대상 | 어떻게 |
|---|---|
| `contracts/logistics-01자재창고.json`(`COMMIT.txt` = `a6a87e1`) 7 오퍼레이션 | `paths` 5경로 × 메서드 전수 — `parameters`·`requestBody`·`responses`(코드·`headers` 키)·`description`·`x-internal-note` 를 키로 직접 덤프 |
| 스키마 10종 | `HandlingUnit`·`HandlingUnitContent`·`…DetailResponse`·`…ContentListResponse`·`HandlingUnitCreate`·`HandlingUnitContentUpsert`·`HandlingUnitPack`·`HandlingUnitRepackEvent`·`…EventLine`·`ConflictResponse` — `required`·프로퍼티·`enum`·`minItems`·`exclusiveMinimum`·`x-*` 전건 |
| 파라미터 컴포넌트 5종 | `IdempotencyKey`·`WorkerNo`·`WorkerNoOptional`·`IfMatchVersion`·`IfMatchVersionOptional` · `PageMeta` |

### 코드 — 파일:줄

`src/app.module.ts:23-38`(가드 순서) · `src/common/contract/contract-validator.ts:84-88·112·167·205-212`(무엇을 검증하나) · `contract-validation.guard.ts:36-48` · `validation-error.mapper.ts:13-29` · `src/common/errors/error-codes.ts:8-15` · `src/common/master/master-write.ts:26-71` · `src/common/master/code-reference.ts:24-52` · `src/common/optimistic-lock/optimistic-lock.ts:20-22` · `src/common/pagination/pagination.ts:13-48` · `src/common/idempotency/idempotency.service.ts:109-158` · `src/common/permissions/permission.guard.ts:33-45` · `derived-permissions.ts:40·41·42·165·166·264` · `manual-permissions.ts`(`handling` 0건) · `operation-permissions.spec.ts:61` · `src/auth/session-resolver.service.ts:14-58` · `src/core/numbering/numbering.service.ts:9-54·70-99` · `src/core/document-state/transitions.ts`(431줄·`handling_unit` 0건) · `document-state.spec.ts:519` · `src/app/document-issue/document-issue-simple-lock.ts:102-133` · `document-issue-create-rules.ts:161-167·250` · `document-issue-target-lookup.ts:49-51·89` · `src/logistics/stock-transfer/stock-transfer.service.ts:196` · `transfer-arrive.service.ts:66-71` · `src/logistics/putaway/putaway-task.controller.ts:43-57` · `putaway-task.service.ts:64-70` · `src/logistics/stock-transfer/stock-transfer-lock.spec.ts:1-30` · `src/mdm/logistics/warehouse.service.ts:23-24` · `location.service.ts:14-15` · `test/logistics-stock-transfer.e2e-spec.ts:1308-1317`

### DB — `omf-mes-lane-a2-postgres` **SELECT 만**

칸 수 4표(12·8·9·8) · `handling_unit` 전 칸 nullable·DEFAULT · `pg_constraint` 3표 21건(`ck_handling_unit_reconfiguration_distinct` 원문 포함) · `to_regclass` 신설 2표 = NULL · `app.numbering_rule` 13행 · `mdm.code_group` 4그룹 조회 · 행 수(HU·content·reconfiguration·`document_issue_log` 전부 0) · `handling_unit` 을 가리키는 FK 3건 · `uq_inventory_balance_dim` 원문 · `pg_indexes`(HU·content 6건) · 도메인 `app.qty_t`·`code_t`·`business_no_t`·`name_t`

### 문서

`docs/coverage-100/README.md` §2 전문(42-84) · `plan.md:20`(§0 #9) · `:61` · `:133` · `:158`(§5 규칙 9) · `:225` · `plan-api.md:186-196·1105-1115` · `plan-integration.md:180` · `plan-uiux.md:61` · `docs/coverage-100/lanes.md:62-66` · `docs/design-inquiries/143·144·145` 전문 · `186` 머리말 · `ls docs/design-inquiries/` · `ls prisma/migrations/`(68) · `git log 1df7042..origin/main`

---

## ② §0 다섯 자리 판정

### 자리 ① 마이그 — 표 2 신설 · 칸·제약·인덱스 범위 → **PASS(조건부 · A-2)**

**계약 ↔ 신설 DDL 을 한 줄씩 맞췄다.**

| 계약 required | 신설 칸 | 판정 |
|---|---|:-:|
| `repackEventId` | `handling_unit_repack_event_id` PK | ✅ |
| `repackTypeCode`(enum 3 · `CD-REPACK-TYPE`) | `repack_type_code app.code_t`(varchar(50)·CHECK `<>''`) | ✅ |
| `performedBy` int64 | `performed_by bigint NOT NULL REFERENCES app.app_user` | ✅ |
| `occurredAt` date-time | `occurred_at timestamptz NOT NULL` | ✅ |
| `lines[]` | 자식 표 FK | ✅ |
| 라인 `handlingUnitId`·`roleCode`(enum 2)·`itemId`·`lotId`·`qtyBefore`·`qtyAfter` | `handling_unit_id`·`role_code`·`item_id`·`lot_id`·`qty_before`·`qty_after` | ✅ **6/6** |

**모자란 칸 0.** 남는 칸은 PK 2 · FK 1 · `line_no` · `created_at` 2 뿐이고 전부 근거가 있다(정렬 축·감사). `qty_before/after` 에 `app.qty_t`(numeric(20,6) · CHECK `VALUE >= 0`)를 쓴 것도 맞다 — 계약 라인의 `qtyBefore`/`qtyAfter` 에 `minimum` 이 **없어** 0이 합법이다(파싱 확인).

**재사용 비용 10건도 psql 로 전건 확인.** 라인 결손 4(`handling_unit_id`·`role_code`·`qty_before`·`qty_after` 전부 없음) · 완화 5(`moved_qty` NOT NULL + `CHECK ((moved_qty)::numeric > 0)` · `uom_id` NOT NULL FK · `source_handling_unit_id`/`target_handling_unit_id` **둘 다 NOT NULL** · `reason_code` NOT NULL) · CHECK 삭제 1.

**⚠ `ck_…_distinct` 가 「대표 경로를 구조적으로 막는다」 — psql 로 확인된 사실인가: 절반은 사실, 절반은 «추론»이다.**
제약의 실재는 사실이다 — `CHECK ((source_handling_unit_id <> target_handling_unit_id))` 원문 확인. 「막는다」는 그 제약 + `source`·`target` **둘 다 NOT NULL**(psql) + 계약 대표 경로가 한 HU 사건이라는 세 사실의 **연역**이지 실행 관측이 아니다(⛔ 브리프가 DB 쓰기를 금했으므로 INSERT 를 쏘아 보지 않았다). 세 전제가 모두 실측이라 연역은 선다 — 「추론이다」를 초안이 명시하지 않은 것만 흠이다(Nit).

**⚠ 초안 내부 불일치(Nit)** — §0 표는 「그러고도 **5칸**이 영구 NULL」, §2-4 판정은 「`_no`·`reason_code`·`source`·`target`·`uom_id`·`moved_qty` 가 영구히 빈 채」 = **6칸**. 실측은 6. §0 표의 5가 오기다(브리프도 6으로 적었다).

**마이그 파일명 충돌** — `ls prisma/migrations/`(68개) 전수에 `i16`·`repack` **0건**, `handling` 은 `20260908002517_stock_transfer_line_handling_unit` 하나뿐. `_a2_i16_handling_unit_repack_event` 는 충돌하지 않는다. ✅ 다만 최신 타임스탬프는 초안이 적은 `20260909010052` 가 아니라 **`20260909010202_b_i27_printer_mapping`**(오늘 `origin/main`)이다 — 결론(오늘 만들면 뒤다)은 그대로.

**CHECK 0 · 인덱스 복합 1 · `_no`/`reason_code`/`uom_id`/`moved_qty` 안 만든다** — 앞의 셋은 선다. `uom_id` 하나가 **안 선다** → **A-2**.

### 자리 ② 잠금 순서(I-27 교차) → **PASS**

직접 확인했다 — `src/app/document-issue/document-issue-simple-lock.ts` `lockUnits`(102-133):

- `:108-113` `SELECT handling_unit_id … FROM inventory.handling_unit WHERE … ORDER BY handling_unit_id **FOR NO KEY UPDATE**`
- `:115-120` `SELECT handling_unit_id FROM inventory.handling_unit_content WHERE … ORDER BY handling_unit_id,handling_unit_content_id **FOR SHARE**`(`needsContents` 일 때만)

**잠금 «세기»**: 부모는 `FOR NO KEY UPDATE` — 초안의 `FOR UPDATE` 와 **상호 충돌**하므로 두 트랜잭션이 직렬화된다. 자식은 `FOR SHARE` — 초안 §3-1 ⑨ / §5-2 ⑧ 의 `DELETE`+`INSERT` 와 충돌하므로 역시 직렬화된다. **양쪽 다 부모 → 자식 순서**라 교착 창이 없다. 초안의 「⛔ 자식을 먼저 만지면 교착한다」도 맞다. ✅

**`hasContent` 게이트**: `document-issue-create-rules.ts:161-167` — `GOODS_ISSUE_QR` 의 대상이 `HANDLING_UNIT` 일 때 `facts.hasContent !== true` 면 `ERROR_CODE.STATE_LOCKED`「내용물이 있는 포장만 출고 QR을 발행할 수 있습니다.」. `:250` 이 `PACKING_LABEL: ["HANDLING_UNIT"]`(유일 대상 유형) — 초안이 `:249` 로 적었다(한 줄 어긋남 · Nit).

**「빈 배열 PUT 이 그 게이트를 사후에 깬다」 — 검산 결과 참.** 게이트는 **발행 «생성» 시점에만** 돈다(`create-rules`). 이미 나간 `GOODS_ISSUE_QR` 을 되돌리는 축이 없고, 그 뒤 빈 배열 `PUT` 이 `handling_unit_content` 를 0행으로 만들면 「내용물이 있는 포장만」이라는 불변식이 **이미 발행된 QR 에 대해** 깨진다. 통보 163 의 근거가 선다. ✅
(⚠ 정확히는 「이미 발행된 QR 이 취소된다」가 아니라 「나간 QR 이 빈 포장을 가리키게 된다」다 — 163 본문의 문장이 그 뜻으로 읽히는지 구현자가 한 번 더 다듬으면 좋다.)

### 자리 ③ PR 5 → **PASS(조건부 · A-6)**

갈래 넷 중 ⓓ 를 고른 결론은 선다(최대값 최소). 다만 **산술 둘이 틀렸다**(A-6) — ⓑ 의 348 은 **370** 이고, §8-1 합계 953 과 다섯 PR 합 949 의 차 4를 초안이 설명하지 않는다. **결론은 안 바뀐다**(ⓑ 가 오히려 예산 350 을 20 초과해 더 확실히 탈락).

### 자리 ④ `status_code` 상수 둘 → **PASS**

계약 실측 전건 일치: `HandlingUnit.required` = 4 이고 `statusCode` 포함(nullable 퇴로 없음) · `x-no-code-key` 원문이 **질의 파라미터와 스키마 두 곳에 같다**(「코드 그룹을 세우지 않는다 … 해체 업무가 서면 그때 세운다」) · `:pack` operation description 에 「**이미 확정된 포장은 409 다**」 실재 ⇒ 확정 전/후를 가릴 축이 필요하고 상수 하나로는 못 선다. psql: `status_code` NOT NULL · **CHECK·DEFAULT 0** · `mdm.code_group` 에 대응 그룹 0건. 병합 픽스처의 세 번째 값 `'ACTIVE'` 도 `test/logistics-stock-transfer.e2e-spec.ts:1314` 에서 확인. **목록 질의에 값 검증을 안 거는 판정**도 계약과 맞는다(`statusCode` 에 enum·`x-code-key` 가 없다). ✅

한 가지 곁가지(Nit): 같은 목록의 `handlingUnitTypeCode` 는 **`x-code-key` 가 있는데도** 검증을 안 건다. 저장소 선례가 「쓰기에서만 `assertCodeValues`」로 우세하므로 통과지만 반례가 하나 있다(`work-session-query.service.ts`). 초안이 그 갈림을 한 줄로 적어 두면 리뷰가 다시 안 묻는다.

### 자리 ⑤ 「언제나 만든다」 + 빈 배열 허용 → **조건부(A-1 · A-4)**

- **「언제나」** — `PUT …/contents` operation description 원문에 조건절이 **없다**(「⭐ 결정 13 되살림(2026-08-30) — 이 치환은 서버가 `HandlingUnitRepackEvent`(헤더) + Line(수량 변경 전/후)을 함께 기록한다」). 계약 문자 그대로 ⇒ PASS.
- **빈 배열** — 요청 본문 = `{required:['items'], items: HandlingUnitContentUpsert[]}` 이고 `minItems` **없음**, `HandlingUnitPack.contents` **에만** `minItems: 1`. 통보 143ⓓ 로 이미 나간 결정이라 재개봉 사유 없음 ⇒ PASS.
- **조건 둘**: `:pack` 이 같은 전량 치환을 하면서 이벤트를 0건 만드는 **비대칭**(A-1) · 「빈 HU + 빈 배열」이 만드는 **라인 0건 이벤트**가 설계·시험 어디에도 없다(A-4).

---

## ③ 「낡음 14 / 유효 12」 검산

### 유효 12 — **전건 참**(내가 다시 쟀다 · 「그대로 서니 안 봤다」 없음)

| # | 재검 근거 |
|:-:|---|
| V-1 | psql — `_line` 8칸에 `handling_unit_id`·`role_code`·`qty_before`·`qty_after` 전부 없음 ✅ |
| V-2 | `pg_constraint` — `CHECK ((source_handling_unit_id <> target_handling_unit_id))` 원문 ✅ |
| V-3 | 계약 `…EventLine.required` 6칸 파싱 — `uomId` 없음 / psql `_line.uom_id` `is_nullable=NO` ✅ |
| V-4 | `HandlingUnit.required` = `handlingUnitId`·`handlingUnitNo`·`handlingUnitTypeCode`·`statusCode` ✅ |
| V-5 | `HandlingUnitPack.contents.minItems=1` + `validation-error.mapper.ts:13-23` 의 `RANGE_KEYWORDS` 에 `minItems` ✅ |
| V-6 | `HandlingUnitContentUpsert.qty.exclusiveMinimum=0` + 같은 Set ✅ |
| V-7 | `app.module.ts:23-38` 「인증 → 권한 → 계약 검증 → 멱등 → 낙관적 잠금」 ✅ |
| V-8 | `master-write.ts:44` `return outcome.body;` — `setEtag` 없음. `setEtag` 는 `runVersioned:69` 에만 ✅ |
| V-9 | `ConflictResponse.required` = `conflictCause`(enum `user`/`erpSync`/`workerLease`)·`message` · `code` 프로퍼티 **부재** ✅ |
| V-10 | psql — `fk_inventory_transaction_line_hu FOREIGN KEY (handling_unit_id) REFERENCES inventory.handling_unit` 실재 ✅ |
| V-11 | `uq_inventory_balance_dim` 원문 11칸 — `handling_unit_id` 없음 ✅ |
| V-12 | `pg_indexes` — `uq_handling_unit_content(handling_unit_id,item_id,lot_id)` 선두 칸 · `handling_unit_handling_unit_no_key` UNIQUE · `status_code`·`handling_unit_type_code` 인덱스 0 ✅ |

### 낡음 14 — **전건 참**

S-1 12칸(psql **그리고** `prisma/schema.prisma` 모델 전수 — 둘 다 12라 C 의 13은 어느 축으로도 오기) · S-2 9칸 · S-3 `numbering_rule` **13행**·`HANDLING_UNIT` 0행 · S-4 `numbering.service.ts:35 ST`·`:40 IA`·`:53 NC` 병합 완료(남은 것은 `HU` 한 줄) · S-5 `transitions.ts` 431줄·`handling_unit` 0건·`document-state.spec.ts:519` `toHaveLength(47)` · S-6 정의 **8곳**(⚠ 7곳은 자유 함수, 여덟째는 `stock-transfer.service.ts:196` 의 **private 메서드**라 함수 grep 으로는 안 잡힌다 — 초안이 맞다) · S-7 `plan.md:158` 규칙 9 예외 목록이 **열한째(I-18 · 통보 151)** 에서 끝나고 I-13 두 자리 없음 · S-8 `plan.md:61`(PR 4·N-2)·`:133`(N-2 행)·`plan-integration.md:180`(신설 2·원장 ✕ 확정·PR 4)·`plan-uiux.md:61`(N-2·PR 4) 전부 적용 확인 · S-9 `plan-api.md:1110` = 「재포장 \| ~~`reconfiguration_no`~~ **`repack_event_no`** \| ❌ \| 신설 표(N-2)의 헤더 번호」 — **삭제 지시가 개명으로 적용됐다**(초안이 맞다) · S-10 위 자리 ② 참조 · S-11 `:1314` `status_code:'ACTIVE'` · S-12 `warehouse.service.ts:24`·`location.service.ts:15` 에 `inventory.handling_unit` · S-13 `derived-permissions.ts:40·41·42·165·166·264`, `repack-events` 만 부재 · S-14 `permission.guard.ts:37-41` 주석 「선언 253」 vs `operation-permissions.spec.ts:61` `toHaveLength(250)`

**⇒ 26건 중 26건 참. 재수립 근거는 흔들리지 않는다.** 오류는 §13 부록의 한 건뿐(A-7의 fact 42).

---

## ④ Findings

### 🔴 Major

**A-1. `:pack` 이 «전량 치환»을 하면서 재구성 이벤트를 0건 만든다 — 그리고 초안의 0단계 근거 하나가 자리를 잘못 짚었다.**

초안 §3-4 / §10-1 #5 는 「0단계 — **계약 두 곳이 반대로 못 박음**」으로 닫았다. 근거 둘을 각각 확인했다.
- (i) 「계약이 이벤트를 `PUT …/contents` 에만 걸었다」 — **참**(operation description 전수 파싱: `:pack` description 에 이벤트 문자열 0).
- (ii) 「`HandlingUnitRepackEvent` description 이 반대 방향까지 못 박았다」 — **자리가 틀렸다.** 원문은 「**신규 생성분(신규 발번)은** 이 이벤트가 아니라 **`POST /inventory/handling-units`** 가 별도로 만든다」다. 이 문장이 배제하는 것은 **`POST`** 이지 `:pack` 이 아니다.

⇒ 「두 곳이 반대로 못 박음」은 성립하지 않는다. 계약은 `:pack` 에 대해 **침묵**한다. 그런데 `:pack` 은 `PUT` 과 **똑같은 전량 치환**을 한다 — `HandlingUnitPack.contents` 의 원소가 같은 `HandlingUnitContentUpsert` 이고 그 description 이 「구성 **전체 치환** 항목. **요청에서 빠진 기존 행은 삭제한다.**」다(초안 §3-1 ⑨ 도 DELETE 전건 → INSERT N행으로 그렇게 적었다).

README §2 로 다시 태우면: 0단계 닫힘 ✗ → 1단계 본길(모든 `:pack` 호출이 갈린다) → 계약 침묵 → **1-1단계** → 「MES 본질(추적성·계보)」 ✓ × 「바꾸는 비용 높다 ⓐ(그 시점 전/후 수량은 소급 불가)」 ✓ ⇒ **표의 「묻는다」 칸**이다. 초안은 통보조차 안 냈다.

*실패 예* — `POST {handlingUnitTypeCode:'BOX', contents:[{itemId:A, lotId:1, qty:10, uomId:EA}]}` → 201. 이어서 `POST …/{id}:pack {contents:[{A,1,4,EA},{B,2,6,EA}], businessDate, occurredAt}` → 200, contents 가 전량 치환된다. 그 뒤 `GET …/{id}/repack-events` = **`{"items":[]}`**. 「10이 4로 줄고 B가 어디서 왔나」를 답할 행이 **영구히** 없다. 같은 변화를 `PUT` 으로 했으면 라인 3행이 남는다 — **경로에 따라 계보가 있고 없다.**

*권고(조건부)* — 판정(안 만든다)을 유지해도 좋다. 다만 ⓐ §3-4 의 근거에서 (ii)를 빼고 「계약 침묵 + `PUT` 이 이벤트의 유일한 원천이라는 계약의 배치」로 다시 세울 것 ⓑ 1-1단계 표에서 「묻는다」로 가는 자리이므로 **문의(질의) 한 건**을 열 것 — 통보 143·144·145 어디에도 이 축이 없다(전문 확인). ⓒ 열지 않기로 하면 §10-1 #5 에 「1-1단계 표의 «묻는다» 칸인데 통보로 내린 이유」를 명시할 것.

---

**A-2. 이벤트 라인에 «단위»를 안 남겨 「수량 변화 없음」이 거짓이 될 수 있다(자리 ①).**

초안 §2-4 는 「⛔ `uom_id` 를 만들지 않는다 — 계약 라인에 `uomId` 자체가 없다(기준 3)」로 닫았다. 계약 사실은 맞다(라인 required 6에 `uomId` 없음). 그러나 **물리가 그 가정을 안 받쳐 준다.**

- `uq_handling_unit_content` 는 **(handling_unit_id, item_id, lot_id)** 뿐이다(psql 원문). `uom_id` 는 유일 축에 없다.
- 요청 `HandlingUnitContentUpsert.uomId` 는 required 이고, 치환은 전량 DELETE+INSERT 다 ⇒ **같은 (품목·LOT)의 `uom_id` 가 치환으로 바뀔 수 있다.**
- 초안 §5-3 의 라인 규칙은 `(item_id, lot_id)` 로만 전·후를 맞춘다.

*실패 예* — 전 구성 `{itemId:A, lotId:1, qty:10, uomId:EA}` → `PUT {items:[{A,1,10,BOX}]}`. 초안 규칙대로면 라인은 `role RESULT · qty_before 10 · qty_after 10` 한 줄. **이력이 「변화 없음」이라고 말한다.** 실제로는 10 EA 가 10 BOX 가 됐다. 그리고 이 정보는 **백필이 불가능하다** — 옛 `uom_id` 는 DELETE 로 사라진다(ⓐ).

브리프 ⓐ 의 경고와 정확히 겹친다(「⚠ 안 만든 칸을 나중에 만들려면 마이그가 또 필요하다」). 지금은 **표가 0행이라 칸 하나가 공짜**이고, 나중에는 마이그 + 백필 불가다.

*권고* — 라인에 `uom_id bigint NOT NULL REFERENCES mdm.uom(uom_id)` 를 **저장만** 하고 응답 뷰에는 안 싣는다(계약 라인 6칸 그대로 · 여분 칸 0 유지 · e2e 16 의 「응답에 `uomId` 가 없다」 단언도 그대로 선다). 안 만들기로 하면 **통보 한 건**으로 남긴다 — 「전·후 수량을 단위 없이 남긴다」는 소급 불가라 「알려둘 것」으로는 부족하다.

---

**A-3. 「선언하지 않은 응답」의 범위가 초안이 적은 것보다 «넓다» — 조회 4건의 400 이 어디에도 없다.**

브리프 §4 API 초점의 「선언하지 않은 응답을 만들지 않는가」를 계약 전수로 다시 쟀다.

| 오퍼레이션 | 계약이 선언한 것 | 서버가 낼 수 있는 것 | 초안이 적었나 |
|---|---|---|:-:|
| `GET /inventory/handling-units` | **200 하나** | **400**(계약 가드) | ✗ **없다** |
| `GET …/{handlingUnitId}` | 200 · 404 | **400** | ✗ **없다** |
| `GET …/{id}/contents` | **200 하나** | **400** · 404 | 404만 (ⓐ) |
| `GET …/{id}/repack-events` | **200 하나** | **400** · 404 | 404만 (ⓐ) |
| `PUT …/{id}/contents` | 200·400·403·409 | **404** | ✅ ⓐ |

400 이 어디서 나오나 — 계약 검증 가드가 **path·query 파라미터를 ajv 로 검증한다**(`contract-validator.ts:205-212` 가 `parameterSchema(…, 'path')`·`'query'` 를 컴파일하고 `:167` 이 `query` 를 돌린다 · `contract-validation.guard.ts:36-39`). `coerceTypes` 는 `"abc"` 를 integer 로 못 바꾼다.

*실패 예* — `GET /api/inventory/handling-units?warehouseId=abc` → **400 `{errors:[{field:'warehouseId', code:'INVALID'…}]}`. 계약에는 그 응답이 없다.** 클라이언트가 이 오퍼레이션에 대해 200 만 처리하도록 생성됐다면 파싱이 깨진다.

저장소 선례는 이 부류를 **번호 붙은 통보**로 낸다 — `docs/design-inquiries/186-…`(「조회 **다섯 건이 400 을 선언하지 않았는데** 서버가 400 을 낸다 · **구분: 통보**」, I-20 문의 074 와 묶으라고 적혀 있다) · `201-출하-조회-넷이-400-미선언인데-…`. 초안은 §10-3 ⓐ 에 **404 셋만 번호 없이** 적었고 **400 은 §6-1 마지막 불릿 한 줄**(「숫자 축에 글자가 섞이면 400 `INVALID`」)로 지나간다.

*권고* — 조회 4건의 400 + 쓰기·자식 3건의 404 를 **한 통보**로 묶어 A2 대역 **165** 로 낸다(163·164 다음). 074·186·201 을 같이 가리키면 설계팀이 한 번에 본다.

### 🟡 Minor

**A-4. 「빈 HU + 빈 배열 `PUT`」 = 라인 0건 이벤트 — 설계에도 시험에도 없다(자리 ⑤).**

초안 §5-3 의 라인 규칙은 「치환 «전» 맵과 «후» 맵의 **합집합**」이다. 둘 다 비면 합집합이 공집합이다 ⇒ **라인 0행 이벤트**가 남는다. 계약은 `lines` 를 required 로 두었으나 `minItems` 가 **없어**(파싱 확인) `{"lines":[]}` 가 스키마로는 통과한다 — 즉 **ajv 가 못 잡는 갈래**다(브리프 ⓒⓐ).

e2e 28은 「최초 채움(빈 HU + 내용 있는 배열)」, 29는 「변화 없는 치환(내용 있는 HU)」, 30은 「빈 배열(내용 있는 HU)」이다. **셋 다 이 갈래를 안 지난다.**

*실패 예* — `POST {handlingUnitTypeCode:'BOX'}`(contents 생략 → 빈 HU) → `PUT {items:[]}` 를 **서로 다른 멱등키**로 3회 → 200 셋. `GET …/repack-events` 가 `{"items":[{…,"lines":[]},{…,"lines":[]},{…,"lines":[]}]}` 를 내린다. 그 조회에는 페이지 축이 **0** 이므로(계약 파싱 · 통보 144ⓐ) 응답이 상한 없이 는다. 통보 144ⓑ 는 「`qtyBefore === qtyAfter` 인 빈 이벤트」를 적었지만 **「라인 자체가 0건인 이벤트」는 안 적혀 있다**(144 전문 확인).

*권고* — e2e 한 줄 추가(빈 HU + 빈 배열 → 이벤트가 생기나 · 라인이 0인가)와, 「라인 0건 이벤트를 만들지 않는다/만든다」를 §5-3 에 명시. 만들지 않기로 하면 「언제나 만든다」에 유일한 단서가 생기므로 통보 144ⓑ 를 가리켜야 한다.

---

**A-5. ETag 「지켜보는 단언」이 저장소 표준형보다 약하고, 어느 `version_no` 인지 안 적혀 있다.**

초안 e2e 11·32·39 의 단언은 「`etag` 헤더가 `version_no` 와 «다르다»」(§9-3 :751-752 · :779 · :789)다. 브리프가 검산을 지시한 자리다.

- **전제는 참이다** — 이 앱은 express ETag 를 끄지 않는다(`src/main.ts` 전문 · `app.setup.ts` 에 etag 설정 없음). `plan.md:225` 에도 「(I-7) … Express 약한 ETag」가 이미 적혀 있다. ⇒ `toBeUndefined()` 는 실제로 빨개진다. 초안의 경고는 맞다.
- **그러나 못박은 형이 저장소 관행과 다르다.** 실측: `expect(res.headers.etag ?? '').not.toMatch(/^(W\/)?"?\d+"?$/)` 형이 **13개 e2e 파일**에 있다(`logistics-goods-issue.e2e-spec.ts:232·313·621·695` · `inventory-adjustment.e2e-spec.ts:194·564` · `logistics-inbound-receipt.e2e-spec.ts:379·601` · `logistics-stock-transfer.e2e-spec.ts:398·799` · `maintenance-inspection.e2e-spec.ts:468` · `production-material-consumption.e2e-spec.ts:183` 등).

*실패 예* — e2e 32(`PUT …/contents` 200)에서 `version_no` 를 **요청 «전»** 상세 GET 으로 읽으면(초안이 어느 쪽인지 안 적었다), §9-5 변이 6「`setEtag` 추가(`PUT`)」를 넣었을 때 서버가 싣는 값은 **올라간 새 `version_no`**(초안 §5-2 ⑩ 이 +1 한다)라 옛 값과 다르다 ⇒ **단언이 초록으로 남고 변이가 안 잡힌다.** 정규식 형은 「숫자면 무조건 빨강」이라 이 함정을 안 탄다.

*권고* — 정규식 형으로 바꾸거나, 최소한 「치환 «뒤» 상세 GET 의 ETag 와 비교한다」를 e2e 32·39 에 못 박는다.

---

**A-6. PR 예산 산술 둘이 어긋난다(결론은 유지).**

- §8-1 파일 합계 **953** ↔ §11-2 ⓓ 다섯 PR 합 **949**(239+198+198+172+142). 차 4의 정체: 컨트롤러 155줄을 §11-2 가 60+12+32+22+22 = **148** 로만 배분(−7)하고, §8-1 표에 없는 `numbering.service.ts +3` 을 ③에 얹었다(+3) ⇒ 953−7+3 = 949. **초안이 이 조정을 한 줄도 안 적었다.** 그리고 ①은 자기 구성요소(60+70+100+5 = **235**)보다 **+4** 다.
- **ⓑ(C 의 4분할) ② = 348 이 아니라 370 이다.** ⓑ② 는 「마이그+schema+`PUT`+repack」이므로 ⓓ②(198) + ⓓ④(172) = **370** 이다. 348 은 컨트롤러 `PUT` 22 와 모듈 +1 을 빠뜨린 값이다(198+150 = 348). ⇒ 「예산 350 에 **여유 2줄**」은 사실이 아니라 **20 초과**다.

*결론* — ⓓ 채택은 그대로다(오히려 ⓑ 탈락 근거가 강해진다). 다만 구현 브리프가 「PR ① 239」를 그대로 예산 검사에 쓰면 실제 구성요소와 4줄 어긋난 채 시작한다.

### ⚪ Nit

**A-7. 인용 잔가지 — 전부 결론 무영향.**

| 초안 | 실측 |
|---|---|
| §1-1 「`master-write.ts:62` 가 던져 500」 · fact 24 `:60-63` | 던지는 줄은 **`:59`**(`throw new Error(…)`), 조건은 `:58` |
| fact 28 `document-issue-create-rules.ts:…:249` | `PACKING_LABEL: ["HANDLING_UNIT"]` 는 **`:250`** |
| §6-1 「`putaway-task.service.ts:63-69` `numeric()` 형」 | 실제 **`:64-70`** |
| fact 42 「`FOR UPDATE`/`FOR SHARE` 를 담은 spec **19파일**」 | 실측 **17파일**. §9-5 #18 의 「12파일 23단언」은 `stock-transfer-lock.spec.ts:9-10` 주석의 «인용»이라 그 자체는 정확하지만, 같은 문서가 19와 12를 나란히 적는다 |
| §0 자리 ① 「그러고도 **5칸**이 영구 NULL」 | §2-4 판정·브리프와 같이 **6칸**(`_no`·`reason_code`·`source`·`target`·`uom_id`·`moved_qty`) |
| §1-3 · §4 ③ `assertCodeValues(prisma, [{groupCode:'HANDLING_UNIT_TYPE'}])` | 시그니처는 `{field, value, groupCode}` — `value` 가 문자열이 아니면 **조용히 통과한다**(`code-reference.ts:29-31`). fact 41 은 맞게 적었다 |
| 실측 기준 「`HEAD == origin/main == 1df7042`」 · fact 49 최신 마이그 `20260909010052` | 오늘 `origin/main` 은 **`ee6b8b6`**(+19커밋 — I-27 프린터 3PR `#471`·`#472`·`#473`, I-22 계획 `#458`, 문의 **190~208** 신설). 최신 마이그는 **`20260909010202_b_i27_printer_mapping`**. `origin/main` 의 `printer.controller.ts` 에 `@Contract` 1건이 늘어 **커버리지 기준선 431/487 도 이미 낡았을 가능성이 크다**. 초안이 「PR 직전 재측정」을 적어 두어 결론은 안 바뀐다 |

**곁가지 확인(문제 없음)** — 브리프 ⓓ 의 문의 번호: `ls docs/design-inquiries/` 실측으로 A2 대역 150~179 에 **150·151·152·154~162** 만 있고 153 은 없다 ⇒ **다음은 163** 이 맞다(180~189·190~208 은 다른 대역). C 대역 140~145 는 **읽기만** 했고 초안도 가리키기만 했다 ✅. 그리고 163·164 의 1-1단계 판정(「정하고 통보」)은 표에 맞다 — 163 은 구현 순서(잠금)와 기존 결정의 파생, 164 는 사실 정정이라 「MES 본질 × 비용 높다」 둘 다에는 안 걸린다. ✅ (⇒ A-1 만 그 표의 「묻는다」 칸이다.)

**API 초점 나머지 — 전건 PASS**

- **멱등/If-Match/ETag/403 선언**: `responses.headers` 가 있는 것은 `POST` 201 · `GET …/{id}` 200 **둘뿐**(파싱) ⇒ `setEtag` 2자리 · `PUT`·`:pack` 에 안 붙인다 ✅. If-Match 는 `PUT`·`:pack` 만 `IfMatchVersionOptional`(required=false) ⇒ `runVersioned` 사용 불가(`master-write.ts:57-60`) · `putaway-task.controller.ts:43-45` 가 같은 주석을 이미 달았다 ✅. `Idempotency-Key`(required) 3건 · `WorkerNo`(required) 3건 · `WorkerNoOptional` **0건** ✅. 403 선언은 쓰기 3건뿐이고 `permission.guard.ts:37-41` 이 미선언 자리를 안 본다 ✅.
- **`X-Worker-No` 를 핸들러가 검사하는 것이 맞나** — 맞다. 계약 검증기는 **헤더 파라미터를 컴파일하지 않는다**(`contract-validator.ts:205-212` 는 `'path'`·`'query'` 만). `stock-transfer.service.ts:192-194` 주석도 「헤더는 계약 검증 가드가 안 본다」라 적었다 ✅.
- **`performed_by` NOT NULL 이 안전한가** — 안전하다. 세션 쿠키는 `typ === 'session'` 이 아니면 **거부**되므로(`session-resolver.service.ts:52`) 인증된 요청의 주체는 언제나 `app.app_user` 다. 403 선언이 있어 권한 가드가 세션을 요구한다 ⇒ `session.userId` 가 없는 경로가 없다 ✅. FK 대상 `app.app_user(app_user_id)` 도 실재(`handling_unit_reconfiguration_performed_by_fkey` 로 확인) ✅.
- **새 `ERROR_CODE` 0** — `error-codes.ts:9·10·13·15` 에 `REQUIRED`·`RANGE`·`INVALID`·`UNIQUE_VIOLATION` 실재 · `PERMISSION_DENIED` 실재 · 409는 `ConflictResponse`(코드 칸 없음) ⇒ **추가 0** ✅. `LINE_REQUIRED` 사용처 0 도 맞다(`minItems` → `RANGE`).
- **400/404/409 순서** — `:pack` 이 「이미 확정 409」를 「낡은 토큰 409」보다 먼저 판정하는 것은 계약 409 설명(「다시 읽어 오면 풀린다」)과 맞다 ✅. FK 미존재 400 을 409 «뒤»에 두는 배치도 계약이 순서를 안 정했으므로 서버 재량이고 e2e 37 이 지킨다.
- **응답 스키마** — `:pack` 200 = `HandlingUnitDetailResponse` · `PUT` 200 = `HandlingUnitContentListResponse` · `POST` 201 = `HandlingUnitDetailResponse` · 목록 200 = `{items:HandlingUnit[], page:PageMeta{page,size,total}}` · repack 200 = `{items:HandlingUnitRepackEvent[]}` — **초안 §1-4·§3-1 ⑬·§5-2 ⑪·§4 ⑩ 전건 일치** ✅.

---

## ⑤ 미수행 (안 본 것은 「미수행」이다)

1. **게이트·`jest`·`prisma generate` 재실행 0**(브리프 ⛔). 커버리지 **431/487 을 재측정하지 않았다** — A-7 은 「낡았을 가능성」을 커밋 사실로만 적은 것이지 새 수치가 아니다.
2. **`docs/coverage-100/slices/I-16.md`(C 의 969줄)를 읽지 않았다.** 그래서 「C 가 그렇게 적었다」의 **문면**은 확인하지 않았고, 26건은 전부 **지금 실측**으로만 판정했다(=사실은 참, C 의 원문 대조는 미수행). 단 C 대역 통보 **143·144·145 는 전문**, **140·141·142 는 제목만** 읽었다.
3. **화면 원문 0** — `M-04-03`·`P-04-04`·`P-02-08`·`P-01-02` 를 열지 않았다(UI/UX 관점 몫). 문의 143·145 가 인용한 화면 줄은 그 문의 파일 «안»에서만 읽었다.
4. **다른 관점 리뷰 파일 0** — `I-16-review-uiux.md`·`-integration.md` 는 존재하지 않았고 열지도 않았다.
5. **DB 쓰기 0 · 마이그 0 · 시드 0.** `ck_…_distinct` 가 「INSERT 를 실제로 막는가」는 **연역**이지 실행 관측이 아니다(자리 ① 참조).
6. **e2e·단위 실행 0.** A-5 의 express 약한 ETag 판정은 `src/main.ts`·`app.setup.ts` 에 etag 설정이 없다는 사실 + 저장소 13파일 선례 + `plan.md:225` 로만 세웠다.
7. **`plan-integration.md`·`lanes.md` 전문 대조 0**(통합 관점 몫) — 인용된 줄(`:180`·`:62-66`)만 확인했다.
8. `git`·`gh` **쓰기 0** · `pnpm exec` 0(모든 관측은 `git log`/`ls`/`grep`/`node`/`psql SELECT`).

---

## ⑥ 결론

**조건부 승인** — 자리 ②④는 실측으로 완전히 서고 ①③⑤ 와 「낡음 14 / 유효 12」 26건도 전건 참이나, 계약이 침묵하는 `:pack` 의 이력 비대칭(A-1 · 초안의 0단계 근거 하나가 `POST` 를 배제한 문장을 `:pack` 에 갖다 붙였다) · 이벤트 라인의 단위 축 부재(A-2 · 지금은 칸 하나, 나중은 마이그+백필 불가) · 미선언 400 의 누락(A-3)을 반영한 뒤 진행하라.
