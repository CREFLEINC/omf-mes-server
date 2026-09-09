# I-16 재수립 — 「UI/UX 설계」 관점 독립 리뷰

> 대상: `.backend-dev/lane-a2/I-16-draft.md`(1032줄) 전문 · 브리프 `.backend-dev/lane-a2/brief-I-16-review.md` §4 「UI/UX 설계」.
> ⛔ 다른 관점의 리뷰 파일(`I-16-review-api.md` · `-integration.md`)은 **열지 않았다**(존재 여부도 확인하지 않았다).
> ⛔ 코드·계약·다른 문서 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 전체 게이트 재실행 0.
> 실측 시각 2026-09-09 · 워크트리 `designer-worktree-workspace-ff88ca` · `HEAD = 1a27fa6` · **`origin/main = e6e68d6`**(초안 기준 `1df7042` 에서 **21커밋** 이동).

---

## ① 무엇을 «직접» 읽었나

### 계약 (`contracts/logistics-01자재창고.json` · `COMMIT.txt = a6a87e1`) — `node` 파싱
- 5 path / 7 오퍼레이션 전수: 질의 칸 · `parameters` · `responses` · `headers` 키.
- 스키마 전수: `HandlingUnit`(required 4 · 프로퍼티 7) · `HandlingUnitContent`(6) · `HandlingUnitDetailResponse`(2) · `HandlingUnitContentListResponse`(1) · `HandlingUnitRepackEvent`(5) · `HandlingUnitRepackEventLine`(6) · `HandlingUnitPack`(3/5) · `HandlingUnitCreate`(1/5) · `HandlingUnitContentUpsert`(4/4).
- `PUT …/contents` 요청 본문 원문 · `HandlingUnitPack.contents.minItems` · `HandlingUnitCreate.contents` · `qty.exclusiveMinimum` · `statusCode` 의 `x-no-code-key` 원문 **두 곳**.
- `contracts/app-공통.json` — `/app/document-issues` 계열 **7 오퍼레이션**의 질의 칸 · `ConflictResponse`.

### UI/UX 자료
- `docs/coverage-100/plan-uiux.md` — **:61**(U27 행) · **:393-403**(U27 오퍼레이션 7 × 화면 매핑) · :605-608(설계 미정) · :653 · :697 · :763·:775·:779·:782(화면별 집계) · **:850**(호출 셸 — `/app/document-issues` 계열 5 + P-04-04) · :884 · **:1115-1120**(오프라인 큐 · 202 금지) · **:1165**(자식 치환 PUT 의 If-Match 부모) · **:1190-1205**(§9-1 요청서 후보 A~K — 특히 **F**).
- `docs/design-inquiries/` — **141**(전문) · **142**(머리·ⓐ) · **143**(전문) · **144**(전문) · **145**(전문). `ls` 전수(139건).
- `docs/coverage-100/slices/I-16.md`(레인 C · ⛔ 한 줄도 고치지 않았다) — :8 · **:29(R-2)** · :32(R-5) · :36(R-9) · **:42(R-15)** · **:44(R-17)** · :47(R-20) · **:372-395(§3-2 전문)** · :674-676(§8-4) · :899 · :946.

### 코드·물리 (SELECT / grep / `git show` 만)
- `src/app/document-issue/document-issue-simple-lock.ts:102-133`(`lockUnits`) · `document-issue-create-rules.ts:155-172·240-258` · `document-issue-query.service.ts:54·114·117·120` · `document-issue.controller.ts:55·75·83·91·110`.
- `src/common/permissions/derived-permissions.ts:40·41·42·165·166·264` · `manual-permissions.ts`(286줄) · `permission.guard.ts:35-43` · `operation-permissions.spec.ts:51·56·61`.
- `src/common/contract/validation-error.mapper.ts:12-29` · `src/app.module.ts:23-38` · `src/common/master/master-write.ts:29-45·58-71` · `src/common/optimistic-lock/optimistic-lock.ts:14-26` · `src/common/pagination/pagination.ts:10-48`.
- `src/core/document-state/transitions.ts`(431줄 · `handling_unit` 0건) · `document-state.spec.ts:519` · `src/core/numbering/numbering.service.ts`(`DEFAULT_PREFIX` 21종) · `src/mdm/logistics/warehouse.service.ts:24` · `location.service.ts:15` · `assertWorkerNo` 정의 **8곳** 전수.
- 테스트 — `test/logistics-stock-transfer.e2e-spec.ts:1305-1317` · **`test/app-document-issue-query.e2e-spec.ts:470-485`** · `test/quality-disposition.e2e-spec.ts:274·278·835·837` · `test/production-production-result.e2e-spec.ts:178·292·471·818` · `test/logistics-document-progress.e2e-spec.ts:561`.
- 마이그 — `prisma/migrations/` ls 전수 · `20260727000000_baseline_physical_model_v3/migration.sql:2646·3190-3191` · `20260908220249_b_i27_document_issue_print_outcome/migration.sql` 전문 · `git diff 1df7042..origin/main`.
- psql(SELECT 만 · `omf-mes-lane-a2-postgres`) — `handling_unit` 12칸 전수 · `handling_unit` 인덱스 4건 · `handling_unit_reconfiguration` 제약 6건 · `_line` 8칸 + `uom_id is_nullable` · `to_regclass` 2건 · `numbering_rule` 13행 · `fk_inventory_transaction_line_hu` · `uq_inventory_balance_dim` 원문 · `document_issue_log` 인덱스 4건 · `handling_unit` 0행.
- `docs/coverage-100/plan-api.md:1108-1112`.

---

## ② §0 다섯 자리 — 판정

| # | 자리 | 판정 | 근거(직접 실측) |
|:-:|---|:-:|---|
| **①** | 마이그 표 2 신설 | **PASS** | UI/UX 축에서 뒤집을 근거 0. `plan-uiux.md:61`(N-2 신설)·`:608`(「계약이 「기다리지 않는다」라 적었다 → 헤더+라인 두 표」)와 일치. 이 표를 부르는 화면은 `M-04-03` 하나(`plan-uiux.md:401`)이고, 화면이 요구하는 열 중 「유형」·「새 포장」은 **표를 어떻게 만들어도 안 선다**(계약 결손 · 145ⓑ) — 표 신설 결론과 무관하다. psql 로 재확인: `_line` 8칸에 `handling_unit_id`·`role_code`·`qty_before`·`qty_after` 전부 없음 · `ck_handling_unit_reconfiguration_distinct CHECK ((source_handling_unit_id <> target_handling_unit_id))` 실재 · `to_regclass` 둘 다 NULL · `handling_unit_reconfiguration` **0행** |
| **②** | 잠금 순서(I-27 교차) | **PASS** | `document-issue-simple-lock.ts:102-133` `lockUnits` 를 직접 읽었다 — `inventory.handling_unit … ORDER BY handling_unit_id **FOR NO KEY UPDATE**` → `handling_unit_content … ORDER BY handling_unit_id,handling_unit_content_id **FOR SHARE**`. **부모→자식** 확정. `hasContent` 게이트는 `document-issue-create-rules.ts:161-167` — `facts.hasContent !== true` 면 `ERROR_CODE.STATE_LOCKED`「내용물이 있는 포장만 출고 QR을 발행할 수 있습니다.」 **`GOODS_ISSUE_QR` 갈래에만** 있다. `1df7042..origin/main`(21커밋)에서 이 **두 파일 diff 0** ⇒ 오늘 `origin/main` 에서도 유효. ⚠ 초안이 못 적은 것 하나 — **`PACKING_LABEL` 갈래는 `case "PACKING_LABEL": break;` 로 게이트가 «0»** 이다(`:169-170` · 대상 유형은 `:249` 대로 `HANDLING_UNIT` 하나). 이것이 Major-2 의 열쇠다 |
| **③** | PR 5 | **PASS(UI/UX 영향 0)** | 화면 흐름이 PR 경계에 걸리는 자리 없음. 산술만 Nit-2 |
| **④** | `status_code` 상수 둘 | **조건부 PASS** | 계약·물리 근거 전건 재확인 — `HandlingUnit.required` 4칸에 `statusCode` 실재 · `x-no-code-key` 원문이 질의 파라미터와 스키마 **두 곳에 동일** · psql `handling_unit.status_code` **CHECK·DEFAULT 둘 다 없음**(12칸 전수) · `mdm.code_group` 해당 그룹 0건. **결론은 선다.** ⛔ 그러나 **화면 절반이 빠졌다**(Minor-1) — 문의 141 이 「두 화면 필터에 각각 어느 값이 들어가는가」를 물었고 C 가 답을 냈는데(「「포장 가능」 = `'OPEN'`」) 초안 §3-2 는 그 매핑을 안 적는다. 픽스처 수도 틀렸다(Minor-2 — `'ACTIVE'` 는 1건이 아니라 **2건**) |
| **⑤** | 이벤트 «언제나» + 빈 배열 허용 | **조건부** | 「언제나」 = **PASS**(계약 `:1448` 에 조건절 0 · 통보 144ⓑ 가 이미 부작용까지 적었다). 「빈 배열 허용」 = **결론 유지 · 근거 보강 필수**. 계약 신호 재확인 ✅(`PUT` 본문 `{required:['items']}` **minItems 없음** / `HandlingUnitPack.contents.minItems = 1`) · 화면 찬성 근거도 실재(`M-04-03:206` 「분할 잔량 0 ⚠ **허용**」 · 143ⓓ 인용) · 통보 143ⓓ 로 **이미 확정**(회신 대기 아님)이라 뒤집지 않는다. ⛔ 그러나 초안은 **반대편 화면 근거 셋과 `plan-uiux.md:1197`(요청서 후보 F)을 한 줄도 안 실었고**, 통보 163 이 그 대가를 「I-27 게이트」로만 좁게 적는다 ⇒ **Major-2** |

> 「뒤집는다」로 간 자리 **0** ⇒ 마이그·PR 분할·e2e 갈래·예산의 **구조는 그대로**다. 바뀌는 것은 §3-2·§5-1·§9-3(e2e 32·39·11)·§9-5(변이 6 + 신설 1행)·통보 **163·164 의 본문**이다.

---

## ③ 「낡음 14 / 유효 12」 표 검산

### A-1 유효 12 — 전건 재실측

| # | 검산 | 결과 |
|:-:|---|:-:|
| V-1 | psql `_line` 8칸 = `…_line_id`·`…_reconfiguration_id`·`line_no`·`item_id`·`lot_id`·`moved_qty`·`uom_id`·`created_at` — 계약 필수 4칸 전부 없음 | ✅ |
| V-2 | `pg_constraint` — `CHECK ((source_handling_unit_id <> target_handling_unit_id))` 실재 | ✅ |
| V-3 | 계약 `…Line.required` 6칸에 `uomId` 없음(파싱) · psql `_line.uom_id` `is_nullable = NO` | ✅ |
| V-4 | 계약 `HandlingUnit.required` = 정확히 그 4칸 | ✅ |
| V-5 | `HandlingUnitPack.contents.minItems = 1` · `RANGE_KEYWORDS`(`validation-error.mapper.ts:12-22`)에 `minItems` 실재 → `codeFor`(:24-29)가 `RANGE` | ✅ |
| V-6 | `HandlingUnitContentUpsert.qty.exclusiveMinimum = 0` · 같은 Set 에 실재 | ✅ |
| V-7 | `app.module.ts:26-27` 주석 원문 「인증 → 권한 → 계약 검증 → 멱등 → 낙관적 잠금」 + 등록 순서 일치 | ✅ |
| V-8 | `master-write.ts:44` `return outcome.body;`(setEtag 없음) · `runVersioned` `:69` 만 `setEtag` | ✅ |
| V-9 | `ConflictResponse` = `{required:['conflictCause','message']}` · `code` 프로퍼티 **없음** | ✅ |
| V-10 | `pg_constraint` `fk_inventory_transaction_line_hu` **1건** · 마이그 주석 오기(ⓕ)도 실재 | ✅ |
| V-11 | `uq_inventory_balance_dim` 원문 11칸 — `handling_unit_id` 없음 | ✅ |
| V-12 | `pg_indexes` — `inventory.handling_unit` 인덱스 **4건뿐**(pkey · `handling_unit_no` UNIQUE · `ix_handling_unit_warehouse` · `ix_handling_unit_location`) ⇒ `status_code`·`handling_unit_type_code` 인덱스 **0** · `uq_handling_unit_content` 선두 칸 확인 | ✅ |

⇒ **유효 12 는 전건 참이다.** 「그대로 서니 안 봤다」로 살아남은 C 의 낡은 판정은 이 12칸에는 **없다.**

### A-2 낡음 14 — UI/UX 축에서 닿는 것 전건 + 나머지 실측

| # | 검산 | 결과 |
|:-:|---|:-:|
| S-1 | psql `handling_unit` **12칸** (C 의 13 은 오기) | ✅ 낡음 확정 |
| S-2 | psql `handling_unit_reconfiguration` **9칸** | ✅ |
| S-3 | `app.numbering_rule` **13행** · `HANDLING_UNIT` **0행** | ✅ |
| S-4 | `DEFAULT_PREFIX` **21종** · `HANDLING_UNIT` 없음 (`ST`·`IA`·`NC` 병합됨) | ✅ |
| S-5 | `transitions.ts` **431줄** · `handling_unit` **0건** · `document-state.spec.ts:519` `toHaveLength(47)` | ✅ |
| S-6 | `assertWorkerNo` 정의 **8곳** — 초안 목록 그대로. ⚠ `stock-transfer.service.ts:196` 은 `private async` **메서드**라 `function` grep 으로는 7건만 나온다(초안이 맞다) | ✅ |
| S-7 | 미검산(통합 관점 · `plan.md` §5 규칙 9 목록) | 미수행 |
| S-8 | UI/UX 몫 **전건 확인** — `plan-uiux.md:61` U27 행이 「N-2 … PR **4**」 · `:400` 에 「⛔ `P-04-04` 삭제 …」 · `:403` 에 「P-02-08,**P-04-01**」. ⭐ C 의 R-17 은 `:396`·`:399` 라 적었는데 초안이 **오늘 줄번호로 다시 쟀다**(:400·:403) — 옳다 | ✅ |
| S-9 | `plan-api.md:1110` 원문 「재포장 \| ~~`reconfiguration_no`~~ **`repack_event_no`** \| ❌ \| 신설 표(N-2)의 헤더 번호 — I-16 §4-3 · 재수립 R-1 \| S07」 — **삭제가 아니라 개명으로 적용됨** | ✅ |
| S-10 | I-27 잠금 — ② 판정 참조 | ✅ |
| S-11 | `'ACTIVE'` 픽스처 실재 ✅ — 그러나 **1건이 아니라 2건**(Minor-2) | ✏ 부분 |
| S-12 | `warehouse.service.ts:24` `['inventory.handling_unit','warehouse_id']` · `location.service.ts:15` `['inventory.handling_unit','location_id']` | ✅ |
| S-13 | `derived-permissions.ts:40·41·42` 에 목록·상세·contents 실재 · `repack-events` **없음** · `:165`(M-04-03,P-02-08,P-04-01)·`:166`(P-02-08,P-04-01)·`:264`(M-04-03) — **`plan-uiux.md:400·402·403` 의 화면 매핑과 정확히 일치** | ✅ |
| S-14 | `permission.guard.ts:39` 주석 「선언 253 · 미선언 237」 · `operation-permissions.spec.ts:61` `toHaveLength(250)` — 불일치 실재 | ✅ |

### ⛔ 표에 «없는데 있어야 할» 항목 하나 — 이것이 이 검산의 핵심 발견

**C 의 R-2 ⓑ 가 「§3-2 의 「화면이 푼다」 한 줄을 «삭제»하고 R-15 로 대체」라 판정했다**(`slices/I-16.md:29`). C 의 §3-2 원문(`:372` 이하)이 바로 그 문장이었다 — 「「포장 가능」 = `'OPEN'`, **「발행 대기」 = 「이벤트가 있는데 라벨 기록이 없다」로 화면이 푼다**」. 3관점 리뷰가 「**풀 수단이 계약에 0**(R-15)」이라 판정해 **죽인 문장**이다.

초안은 그 삭제를 **§0-A 표 어느 칸에도 적지 않은 채**, §3-2(`:408`)와 통보 164ⓑ 에서 **같은 문장을 되살린다** — 「이제는 그 축이 다른 표에 있다 … **화면이 두 조회를 겹쳐 쓴다**」. 유효/낡음 어느 쪽으로도 분류되지 않았으므로, **C 의 «유효한» 판정 하나가 표를 통과하지 않고 조용히 뒤집혔다.** ⇒ **Major-1(c)**.

---

## ④ Findings

### 🔴 Major-1 — 통보 **164ⓑ** 의 근거가 틀렸고 결론이 과하다 (세 겹)

**(a) 사실 오류 — `document_issue_log` 와 `ix_document_issue_target` 은 I-27 이 병합한 것이 아니다.**
둘 다 **baseline** 이다 — `prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:2646`(`CREATE TABLE app.document_issue_log`) · `:3190-3191`(`CREATE INDEX ix_document_issue_target ON app.document_issue_log(target_type_code, target_id, issued_at DESC)`). psql `pg_indexes` 도 같다. I-27 의 마이그(`20260908220249_b_i27_document_issue_print_outcome/migration.sql` **전문 확인**)는 `print_outcome_code`·`print_failure_reason`·`print_reported_at`·`issued_worker_id`·`print_reported_worker_id`·`print_reported_by` **6칸 추가와 CHECK 2건**뿐이고, **표도 인덱스도 만들지 않는다.**
⇒ 「I-27 이 … 을 **병합해**」·「「라벨 발행 대기」의 원천이 **통보 141 이후 바뀌었다**」는 **사실이 아니다.** 그 데이터 축은 C 가 141·145 를 쓸 때(2026-09-08) **이미 있었다.** 2026-09-09 에 새로 선 것은 **코드**다 — `src/app/document-issue/*`(`git log`: `f841edf`·`d2d38e6`·`daab416`·`cf8cc0c` 전부 2026-09-09) · `GET /app/document-issues` 구현(`document-issue.controller.ts:75` · `document-issue-query.service.ts:114·117·120` 이 `document_type_code`·`target_type_code`·`target_id` 로 거른다).
게다가 계약이 지목한 축은 그 표가 아니다 — `x-no-code-key` 원문이 「**라벨 발행 여부는 boolean 축이면 충분하다(`InboundReceiptLine.labelIssued` 선례)**」라 적었는데, psql `handling_unit` **12칸에 그런 칸이 없다**(오늘도).

**(b) 범위 오류 — 「여전히 못 서는 것은 145ⓐ뿐이다」가 145ⓒ 를 지운다.**
C 의 **R-15**(`slices/I-16.md:42`)는 ⓐ(HU 가로지르는 이벤트 조회 0) · ⓑ(「유형」 고정 · 「새 포장」 원천 0) · **ⓒ(「⭐ 함께 **중첩 포장의 «자식» 조회 축이 0** 이라 `P-01-02` §6:213 이 **정상 파렛트를 차단**한다」)** 를 **한 판정으로** 묶었고 문의 145 가 그대로 셋을 실었다. `document_issue_log` 는 ⓑ·ⓒ 어느 쪽과도 무관하다. 오히려 **ⓒ 는 오늘 병합된 코드로 굳었다** — `document-issue-create-rules.ts:161-167` 이 `hasContent !== true` 면 `STATE_LOCKED`. 초안 자신도 §12-2 에서 「`PACKING_LABEL`·`GOODS_ISSUE_QR` 의 유일한 대상 행을 만드는 것이 I-16 의 `POST`」라 적었다 — 즉 **I-16 이 그 차단을 처음으로 «실재»하게 만드는 슬라이스**다. 그런데 초안 전문에 `P-01-02`·`파렛트`·`하위 포장` 이 **0건**(grep 전수)이다.

**(c) C 의 유효 판정 되살리기 — §3-2:408 「화면이 두 조회를 겹쳐 쓴다」.**
위 §③ 마지막 절 그대로. C 의 R-2ⓑ 가 삭제한 「화면이 푼다」의 부활이고, 삭제 사실이 §0-A 표에 **없다**. 그리고 나머지 반쪽이 **결정적인 반쪽**이다 — 「발행 대기」는 `후보집합 − 이미 발행`인데, `GET /app/document-issues` 는 **이미 발행된 쪽만** 준다. 후보 집합을 만들 조회가 0(145ⓐ)이면 뺄셈의 피감수가 없어 교집합이 성립하지 않는다.

**실패 예(구체)** — POP `P-04-04` 개발자가 164 를 읽고 「대기 목록 = `GET /app/document-issues?documentTypeCode=PACKING_LABEL&targetTypeCode=HANDLING_UNIT` 로 발행분을 빼고, 후보는 HU 목록으로」 구현한다.
`GET /inventory/handling-units` 의 질의는 계약 파싱 실측으로 `warehouseId`·`locationId`·`handlingUnitTypeCode`·`statusCode`·`q`·`page`·`size` **뿐**이고 「재구성 이벤트가 있는가」 축이 없다. 게다가 초안 §5-5 대로 `PUT …/contents` 는 `status_code` 를 안 옮긴다.
⇒ 후보 집합이 **전체 HU** 가 된다. 입력 「창고 W1 에 HU 300건(그중 재구성을 한 것 5건 · 라벨을 낸 것 2건)」 → 출력 「발행 대기 **298건**」. 정답은 3건이다. 포장조차 안 한 `OPEN` HU 와, 재구성과 무관한 파렛트가 전부 대기 목록에 뜬다.

**고칠 것** — 통보 164ⓑ 를 다시 쓴다: ① 표·인덱스는 **baseline(2026-07-27)** 이고 141·145 를 쓸 때 이미 있었다 · 2026-09-09 에 선 것은 I-27 의 **조회 API** 다 ② 계약이 지목한 축(`labelIssued` 형 boolean)은 **오늘도 없다** ③ 145 는 **ⓐ 와 ⓒ 가 남고 ⓒ 는 코드(`document-issue-create-rules.ts:161-167`)로 굳었다** — 「뿐이다」를 지운다 ④ C 의 R-2ⓑ 가 삭제한 「화면이 푼다」를 되살리지 않는다. §3-2 `:408` 의 「화면이 두 조회를 겹쳐 쓴다」는 삭제하거나 「후보 집합을 만들 조회가 0 이라 오늘은 못 겹친다」로 바꾼다. §0-A 표에 「S-15 — C 의 R-2ⓑ(「화면이 푼다」 삭제)는 **여전히 유효**하다」를 **유효 쪽**으로 한 행 더한다.

---

### 🔴 Major-2 — 자리 ⑤(빈 배열) + §5-5(`PACKED` 도 치환)가 합쳐져, 화면 셋과 통합 계획서가 「만들 수 없다」로 닫은 **포장 해체**를 API 로 연다. 초안은 그 대가를 I-27 게이트로만 적는다

**근거(전건 저장소 안 원문)**
- `plan-uiux.md:1197` §9-1 요청서 후보 **F** — 「**P-02-08** 포장 작업 \| 포장 «해체»(되돌리기) \| 계약에 없음 \| **만들 수 없다. 요청서 후보** (화면 §8 기반 — 추측 아님)」.
- 문의 142ⓐ 가 인용한 `P-02-08:162` — 「⚠ 가장 가까운 것은 `M-04-03` 포장 재구성(`PUT …/contents`)이나 **수량 합 = 원 수량 합** 제약이 걸려 포장 밖으로 빼지 못한다 — **해체가 아니다**」 · `P-04-01:241` 「포장 해체 \| ⛔ **두지 않는다**」 · `P-02-08:194` 「되돌릴 수 없는 담기는 현장에서 반드시 문제가 된다」.
- 문의 143ⓓ — 「**허용하면 화면이 닫아 둔 해체 경로가 API 로 열린다**」 · `M-04-03:195` 「재구성 확정 \| 새 구성 유효 AND **수량 합 = 원 수량 합**」 · `:204` 「수량 합 불일치 \| ⛔」.

초안 §3-2 `:407` 은 「⛔ **되돌리는 전이 0** — 해체 화면이 0건이다(문의 142)」라 적는다. 그것은 **`status_code` 축만의 이야기**다. 화면이 지키는 불변식은 상태가 아니라 **수량 합**이고, 초안 설계는 그 불변식을 **서버 어디에서도 보지 않는다**(§5 전체에 「수량 합」이 0건). ⇒ 「전이 0」이라 적어 두고 실제로는 **내용물이 완전히 가역**이다.

**실패 예(구체)**
1. `P-02-08` 에서 작업자가 HU#1 을 `:pack` 으로 확정 → `status_code='PACKED'` · `handling_unit_content` 2행.
2. POP 이 `PACKING_LABEL` 을 발행한다 — ⚠ `document-issue-create-rules.ts:240-258` 의 지원표에 `PACKING_LABEL: ["HANDLING_UNIT"]` 이고, `:169-170` 의 갈래는 **`case "PACKING_LABEL": break;`** 즉 **게이트가 하나도 없다**. 통과.
3. 오프라인 큐에 남아 있던 `PUT /inventory/handling-units/1/contents {"items":[]}` 가 뒤늦게 도착한다(계약이 이 경로를 오프라인 대상이라 못박았다).
4. 초안 설계상 **200 · contents 0행 · `status_code` 는 `PACKED` 그대로** — 초안 e2e **30** 이 정확히 그것을 단언한다.
⇒ 「라벨은 붙었는데 내용물이 0 인 확정 포장」이 남는다. 이제 `P-01-02` 출고 QR 은 `hasContent !== true` 로 **`STATE_LOCKED`**(`:161-167`) — 라벨은 있는데 출고가 안 되는 포장이고, **되돌릴 오퍼레이션은 0건**(문의 142ⓐ).

**고칠 것(결론은 유지)** — 계약 신호(minItems 를 `:pack` 에만)와 통보 143ⓓ 가 이미 정한 결정이므로 뒤집지 않는다. 대신:
1. §5-1 과 §0 자리 ⑤ 에 **반대 근거 넷**(`plan-uiux.md:1197` · `P-02-08:162` · `P-04-01:241` · `M-04-03:195·204`)을 찬성 근거(`M-04-03:206`)와 **나란히** 싣는다 — 지금은 찬성 쪽만 있어 「깨끗한 판정」으로 읽힌다.
2. 통보 **163 에 ⓓ 를 더한다** — 「빈 배열 허용과 「`PACKED` 도 치환된다」가 합쳐져 화면 셋이 닫아 둔 «해체»가 API 로 열린다. 게다가 `PACKING_LABEL` 은 발행 게이트가 «0» 이라 라벨이 먼저 나갈 수 있다(`document-issue-create-rules.ts:169-170`)」. 지금 163ⓑ 는 `GOODS_ISSUE_QR` 의 `hasContent` 만 적어 **라벨 쪽 무게이트를 놓친다**.
3. §12-2 인계표의 **I-27** 행에 한 줄 — 「`PACKING_LABEL` 은 게이트 0 · `GOODS_ISSUE_QR` 만 `hasContent`」. (⛔ I-16 e2e 에서 `document_issue_log` 를 만지지는 않는다 — 그 표를 안 쓴다는 초안 판정은 옳다.)

---

### 🔴 Major-3 — 「지켜보는 단언」: e2e **32·39** 의 「`etag` 가 `version_no` 와 다르다」가 변이 6 을 반증하지 못한다

초안 e2e 11 이 「⛔ `toBeUndefined()` 로 재지 마라 … 재는 것은 「서버가 우리 토큰을 실었는가」다」라 못박고, e2e **32**(`PUT`)·**39**(`:pack`)가 「200 응답 `etag` 가 `version_no` 와 다르다」를 쓴다. §9-5 **변이 6** 이 「`setEtag` … 추가(`PUT`·`:pack`·contents) → e2e 9·11·32·39」로 그 단언에 기댄다.

**문제** — `PUT …/contents`(§5-2 ⑩)와 `:pack`(§3-1 ⑩)은 **`version_no` 를 +1 한다.** 테스트가 요청 «전» 값으로 비교하면, 구현자가 `setEtag(response, updated.version_no)` 를 넣어도 헤더는 «후» 값이라 비교가 참이 되어 **초록**이다. e2e 11(`GET …/contents`)만 안전하다 — 그 경로는 버전을 안 바꾼다.

**실패 예** — 변이 6 을 적용해 `PUT` 컨트롤러에 `setEtag(response, view.versionNo)` 를 넣는다. 픽스처 HU 의 요청 전 `version_no = 1`, 응답 헤더 `2`. 단언 `String(res.headers.etag) !== String(1)` ⇒ **통과(초록)**. 변이가 안 잡히고, 계약이 선언하지 않은 ETag 를 서버가 내리는 상태로 병합된다.

**고칠 것** — 저장소에 이미 이 함정을 피한 형이 **검증된 채로** 있다:
- `test/quality-disposition.e2e-spec.ts:274` 주석 「⛔ Express 가 모든 JSON 응답에 약한 해시 ETag(`W/"…"`)를 자동으로 붙인다」 + `:278` `expect(response.headers.etag).not.toMatch(/^"?\d+"?$/)` · `:835·837` 동일.
- `test/production-production-result.e2e-spec.ts:178·292·471·818` 동일 정규식.
- `test/logistics-document-progress.e2e-spec.ts:561` `expect(String(response.headers.etag)).toMatch(/^W\//)`.
e2e **11·32·39** 를 `not.toMatch(/^"?\d+"?$/)` 로 바꾸고 §9-5 변이 6 의 「닫는 값」에 그 정규식을 적는다. (초안이 「자기 불확실 ⓑ」로 표시한 자리 — express 가 `W/"…"` 를 단다는 **전제는 참**이고, 틀린 것은 그 위에 세운 **비교식**이다.)

---

### 🟡 Minor-1 — 자리 ④ 의 «화면 절반»이 빠졌다 — 「포장 가능」에 넣을 문자열

문의 141 의 **묻는 것** 이 「두 화면 필터(`P-04-01` 「포장 가능」 · `P-04-04` 「라벨 발행 대기」)에 **각각 어느 값이 들어가는가**」다. C 는 답을 냈다 — `slices/I-16.md` §3-2 「**「포장 가능」 = `'OPEN'`**」. 초안 §3-2 는 상수 둘과 「목록 질의에 값 검증을 안 건다」만 적고 그 **매핑을 안 적는다**. 낡음/유효 표에도 없다 ⇒ C 의 유효한 답 하나가 또 조용히 사라졌다.

**실패 예** — `P-04-01:172` 가 `GET /inventory/handling-units?warehouseId=7&statusCode=PACKABLE` 로 부른다(문자열 정본이 없어 클라이언트가 지어냈다). 초안 §6-1 대로 값 검증이 없으므로 서버는 **200 · `items: []` · `page.total: 0`** 을 낸다. 화면은 「포장할 것이 없습니다」로 그리고, 창고에 `OPEN` HU 가 40건 있어도 아무도 모른다. 400 도 로그도 없다.
**고칠 것** — §3-2 에 「`P-04-01` 「포장 가능」 = `HU_STATUS_OPEN` · `P-04-04` 「라벨 발행 대기」 = **오늘 서는 값 없음**(145)」 두 줄을 넣고, 같은 매핑을 통보 **164ⓐ** 본문에도 싣는다(클라이언트가 읽을 유일한 정본이 된다).

### 🟡 Minor-2 — `'ACTIVE'` 픽스처가 1건이 아니라 **2건**이다 (S-11 · §13 #30 · 164ⓐ)

`grep -rn 'prisma.handling_unit.create' test/` 전수 = **2건**이고 **둘 다 `status_code:'ACTIVE'`** 다:
- `test/logistics-stock-transfer.e2e-spec.ts:1308-1317`(초안이 적은 것)
- **`test/app-document-issue-query.e2e-spec.ts:476-485`** — I-27 자신의 e2e(`handling_unit_no: ${PREFIX}-HU` · `PALLET` · `status_code:'ACTIVE'`).
⇒ 저장소의 병합된 HU 픽스처는 **전건(2/2)이 `'ACTIVE'`** 이고 `OPEN`/`PACKED` 를 쓰는 것이 **0건**이다. 초안 결론(상수 둘 · 목록 값검증 0)은 **강화**되지만 164ⓐ 의 수와 무게가 약하다 — 서로 다른 두 레인이 독립적으로 `'ACTIVE'` 를 골랐다는 것이 요지다.
**실패 예** — 구현자가 「예외는 stock-transfer 하나」로 읽고 그 파일만 피한 채 e2e 5(`statusCode=OPEN` 필터)의 `page.total` 을 절대값으로 단언 → I-27 e2e 가 남긴 `'ACTIVE'` HU 때문에 병렬 실행 순서에 따라 붉어진다. (§9-1 의 「`PREFIX` 로 거른 뒤 센다」는 유효하나, 근거 수가 틀리면 그 지침의 힘이 약해진다.)

### 🟡 Minor-3 — 조회 4건 중 «구성 목록»의 정렬이 §9-5 변이표에 없다

§1-2 가 **네 정렬 축**을 서버가 못박는다고 선언했다(목록 `handling_unit_id desc` · contents `handling_unit_content_id asc` · repack-events `(occurred_at desc, id desc)` · 라인 `line_no asc`). 그런데 §9-5 가 닫는 것은 **목록**(변이 1·3) · **repack-events**(변이 7) · **line_no**(변이 16) 셋뿐이고, **contents 정렬을 닫는 행이 0** 이다. e2e 11 은 「`{items[]}` 만 오고 etag 가 다르다」만 재고, e2e 8 은 상세의 `contents[]` 를 값으로 잰다.
**실패 예** — 구현자가 `handling_unit_content` 조회에서 `orderBy` 를 생략한다. 값 집합은 같으므로 e2e 8·11 통과 · §9-5 25행 전건 초록 ⇒ 변이 표에 「반증됨」으로 적혀 병합된다. 이후 `M-01-10`·`P-01-02` 의 구성 목록이 실행마다 순서가 바뀐다(Prisma 가 `orderBy` 없는 `findMany` 의 순서를 약속하지 않는다 — 초안 자신의 근거 I-24 R-7).
**고칠 것** — §9-5 에 변이 한 행(「contents `orderBy` 제거 → e2e 11」)을 더하고, e2e 11 을 「`handling_unit_content_id asc` 로 **배열 통째 단언**(2행 이상)」으로 올린다. §9-2 픽스처 표가 이미 「contents 행 수 ≥ 2」를 보장하므로 추가 비용 0.

### ⚪ Nit-1 — 마이그 최신 타임스탬프가 낡았다
§2-4·§13 #49 의 「현재 최대 타임스탬프 `20260909010052`」는 `origin/main` 기준 **`20260909010202_b_i27_printer_mapping`** 이다(`1df7042..origin/main` 21커밋). 판정(`_a2_i16_handling_unit_repack_event` 충돌 0 · `_b_i30_`·`_b_i31_`·`_b_i27_` 레인 접두 선례)은 그대로 선다 — `ls prisma/migrations/` 전수로 `a2`·`i16`·`repack` 접두 **0건** 확인.

### ⚪ Nit-2 — 예산 산술 셋이 안 맞는다 (브리프 §3ⓔ 검산)
- §8-1 13행 합 = **953** ✅(155+70+100+45+45+135+150+120+14+14+9+38+58).
- 5분할 합 = 239+198+198+172+142 = **949** ⇒ **4줄 미배분**.
- §11-2 컨트롤러 배분 60+12+32+22+22 = **148** 인데 §8-1 의 컨트롤러는 **155** ⇒ **7줄 차**.
- 갈래 합: ⓐ 437+370+142 = 949 · ⓒ 239+198+198+314 = 949 · ⓓ 949 · **ⓑ 239+348+198+142 = 927**(22 어긋남). ⓓ 의 ②198 + ④172 를 합치면(모듈 중복 1 제외) **369** 라 ⓑ 의 「348」은 **21 낮다**. 실제 369 면 ⓑ 는 예산 350 을 **넘는다** ⇒ **ⓓ 채택 결론은 오히려 강화된다.** 숫자만 맞추면 된다.
- 기준선 표기는 규격 충족 ✅ — 커밋 해시(`1df7042`) 부착 · 「PR 을 열기 직전 `main` 에서 다시 잰다」 명시.

### ⚪ Nit-3 — 「`M-04-03` §8 미결 2」의 번호를 확인할 수 없다
초안 §3-2 `:407` 은 「`M-04-03` §8 **미결 2** 가 스스로 철회했다」인데, 문의 141 이 인용한 `M-04-03:234` 원문 괄호는 「(**미결 3**)」이다. C §3-2 도 「§8 미결 2」로 적었다(초안은 C 표기를 승계했다). **화면 원문이 저장소 밖이라 어느 쪽이 맞는지 판정 불가** ⇒ 흔적에 「원문 미대조」를 붙이는 편이 낫다.

---

## ⑤ 미수행 — 「안 봤으면 미수행이다」

1. ⛔⛔ **화면 원문 전건 미수행.** `P-04-04-재구성신규라벨발행.md` · `M-04-03-포장재구성스캔.md` · `P-02-08-포장작업.md` · `P-04-01-Packing실적등록.md` · `P-01-02-출고QR발행.md` 가 **저장소에 없다**(워크트리 전수 `find` · `docs/` 하위 0건). 이 리뷰가 쓴 화면 줄 인용(`:11`·`:41`·`:106`·`:108`·`:162`·`:172`·`:173`·`:175`·`:194`·`:195`·`:204`·`:205`·`:206`·`:208`·`:213`·`:234`·`:241`·`:257`)은 **전부 `docs/design-inquiries/141~145` 안의 인용문**이거나 `plan-uiux.md`·`slices/I-16.md` 의 재인용이다. **화면 원문과의 1:1 대조는 하지 않았다** — 브리프 §4 대로 계약·`plan-uiux.md`·저장소 안 문의만으로 판정했고 추측하지 않았다.
2. **커버리지 `431/487` 재측정 미수행**(README §6 전체 게이트 재실행 금지 · 브리프 ⛔). 확인한 것은 `1df7042` 가 실재하고 `origin/main` 이 그 뒤 **21커밋**(`e6e68d6`) 이동했다는 사실뿐. 초안이 「PR 직전 재측정」을 적어 둔 것은 ✅.
3. **DB 쓰기·마이그 실행·`EXPLAIN` 미수행.** `ck_…_distinct` 가 「대표 경로를 구조적으로 막는다」는 **CHECK 실재(psql `pg_constraint` 원문)** + 계약 대표 경로(한 HU 치환 ⇒ source ≡ target)로부터의 **추론**이다. INSERT 로 재현하지 않았다(브리프 ⛔ SELECT 만).
4. **S-7 미검산** — `plan.md` §5 규칙 9 목록의 「열한째/I-13 두 자리」는 통합 관점 몫이라 열지 않았다. §12-1 ②③ 의 통합 계획서 정정 3행 중 **`plan-uiux.md:61`(PR 4 → 5)만** 실측 확인했고 `plan.md:61`·`plan-integration.md:180` 은 미확인.
5. **§8-1 예상 줄수 자체 미검증.** 복제 원본의 `wc -l`(§13 #45)만 확인했고 155/70/100/45/… 예상치는 검증 수단이 없다.
6. **e2e·단위 실행 0.** 변이 반증 여부는 코드·선례 대조로만 판정했다.
7. ⛔ **다른 관점 리뷰 파일을 열지 않았다** — `I-16-review-api.md` · `-integration.md` 는 존재 확인조차 하지 않았고 판정 근거로 쓰지 않았다.

### 확인은 했으나 findings 가 아닌 것(기록용)
- **문의 번호 163·164** — `ls docs/design-inquiries/` 워크트리 전수 **와** `git ls-tree origin/main` 양쪽에서 A2 대역 150~179 = **150·151·152·154~162**(153 없음) ⇒ **다음이 163** ✅ · 164 도 대역 안 ✅. C 대역 140~145 는 **파일로 실재**하고 초안이 **가리키기만** 했다(수정 0 — `git status` clean) ✅. 1-1단계 판정도 맞다(163 은 구현 순서·기존 결정의 파생 · 164 는 사실 정정 ⇒ 「MES 본질 × 바꾸는 비용 높다」 **둘 다**가 아니다 ⇒ 질의 아닌 통보).
- **권한 「등록 0줄」** ✅ — 403 선언 3건이 `derived-permissions.ts:165·166·264` 에 전부 있고 `manual-permissions.ts`(286줄)에 `handling` 0건. 소유 화면이 전부 `M-`·`P-`(관리웹 `W-` 0건)라는 것도 확인 ✅. `GET …/repack-events` 만 도출표에 없고 403 미선언이라 `permission.guard.ts:39`(「선언한 자리에서만 본다」)로 무해 ✅.
- **조회 4건의 페이지 축** ✅ — 계약 파싱으로 `page`/`size` 는 목록에만, contents·repack-events 는 `{items[]}` 뿐. `pagination.ts:12-14` `DEFAULT_PAGE 1`·`DEFAULT_SIZE 50`·`MAX_SIZE 200` · `:43-46` 이 범위 밖을 **자른다**(400 아님) ⇒ 초안 §6-1·e2e 7 과 일치.
- **오프라인 202 금지** ✅ — `plan-uiux.md:1117-1120` 「⛔ … 서버가 「큐 접수 202」를 만들면 안 된다」. 초안의 응답 코드에 202 **0건**(§1-1 전수).
- **If-Match 부모 지목** ✅ — `plan-uiux.md:1165` 「`PUT /inventory/handling-units/{id}/contents` → `GET /inventory/handling-units/{id}`」가 초안 §5-4 와 일치.
- **repack-events 전건 반환·정렬** ✅ — 통보 144ⓐ 의 「지금 서버는」이 이미 「`occurred_at desc`, 동률이면 id `desc`」를 적었고 초안 §6-4 와 같다. e2e 15(동률 픽스처)는 I-13 사고를 정확히 겨눈다 ✅.

---

## ⑥ 한 줄 결론

**⭕ 조건부 통과 — 다섯 자리 중 뒤집히는 것은 0(마이그·PR 분할·e2e 갈래·예산의 구조는 그대로)이고 「유효 12」는 전건 참이나, 「낡음 14」 표가 «C 의 유효한 판정 하나(R-2ⓑ)의 삭제»를 빠뜨린 채 그 문장을 통보 164 로 되살리면서 근거(baseline 을 I-27 이 병합했다고 적었다)와 범위(145 를 ⓐ 로 좁혔다)를 함께 틀렸고(Major-1), 자리 ⑤ 는 결론은 서지만 화면 셋과 `plan-uiux.md:1197` 이 닫아 둔 «해체»를 여는 대가를 안 실었으며(Major-2), e2e 32·39 의 ETag 단언은 변이를 반증하지 못한다(Major-3) — 이 셋과 Minor 3 을 반영하면 UI/UX 축에서 막는 것은 없다.**
