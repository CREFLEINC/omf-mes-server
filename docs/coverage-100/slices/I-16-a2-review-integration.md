# I-16 개별 계획안 — **통합 관점** 독립 리뷰

> 대상: `.backend-dev/lane-a2/I-16-draft.md`(1032줄) 전문 · 브리프: `.backend-dev/lane-a2/brief-I-16-review.md`
> ⛔ 다른 관점 리뷰 파일(`I-16-review-api.md`·`-uiux.md`)은 **열지 않았다.**
> ⛔ 코드·계약·다른 문서 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 전체 게이트 재실행 0.
>
> **관측 기준** — 워크트리 `HEAD = 1df7042`(초안의 기준선과 같다) · ⭐ **`origin/main = ee6b8b6`(오늘 더 나갔다)** ·
> 계약 사본 `contracts/COMMIT.txt = a6a87e144116ebaa32c01df5a12a0fd2924427e7` ·
> DB 관측 `omf-mes-lane-a2-postgres`(SELECT 만 · 2026-09-09).

---

## ① 무엇을 직접 읽었나 (파일 · 줄)

### DB (psql · SELECT 만 · `omf-mes-lane-a2-postgres`)
- `information_schema.columns` — `inventory.handling_unit` **12** · `handling_unit_content` **8** · `handling_unit_reconfiguration` **9** · `_reconfiguration_line` **8**(칸 이름 전수)
- `pg_constraint` — `ck_handling_unit_reconfiguration_distinct CHECK ((source_handling_unit_id <> target_handling_unit_id))` · `source`/`target` FK 둘 · `reconfiguration_no` UNIQUE · `performed_by` FK · `fk_inventory_transaction_line_hu` · `stock_transfer_line_handling_unit_id_fkey`
- `pg_indexes` — `uq_inventory_balance_dim` 원문 **11칸** · `handling_unit`/`_content` 인덱스 **6개 전수**
- `pg_type`(도메인) — `app.qty_t numeric(20,6) CHECK (VALUE >= 0)` · `app.code_t varchar(50) CHECK (<> '')` · `business_no_t varchar(100)` · `signed_qty_t`(CHECK 없음)
- `to_regclass` — `handling_unit_repack_event`/`_line` 둘 다 **NULL** · 행 수 `handling_unit` 0 · `_content` 0 · `_reconfiguration` 0 · `app.document_issue_log` 0
- `app.numbering_rule` **13행**(`document_type_code` 전수) · `is_identity=ALWAYS`(기존 `_line` PK)

### 계약 (`node` 직접 파싱 · `contracts/logistics-01자재창고.json`)
- `HandlingUnitRepackEvent.required` 5 / `…Line.required` 6(`uomId` 없음) · `HandlingUnit.required` 4 · `HandlingUnitContent(.Upsert)` · `HandlingUnitCreate.required` 1 · `HandlingUnitPack.required` 3 · `ConflictResponse.required` 2(`code` 없음)
- `PUT …/contents` 요청 본문 원문 = `{required:['items'], items:{type:'array', items:$ref}}` — ⭐ **`minItems` 없음**
- 응답 `headers` 키 실재 = `POST` 201 · `GET …/{id}` 200 **둘뿐**(`PUT` 200 · `:pack` 200 은 `null`) · `:pack` 응답 5(200/400/403/404/409) · `PUT` 4(409 있음) · `repack-events` 200 하나 · **파라미터 0**
- `HandlingUnit.statusCode.x-no-code-key` 원문

### 저장소 코드 (HEAD)
`src/app/document-issue/document-issue-simple-lock.ts:30-135`(`lockUnits` 전문) · `document-issue-create-rules.ts:140-185`·`:240-258` · `document-issue-target-lookup.ts:6·50·89` ·
`src/app.module.ts:22-40` · `src/common/master/master-write.ts:26-71` · `src/common/contract/validation-error.mapper.ts:10-30` ·
`src/common/permissions/derived-permissions.ts:40·41·42·165·166·264` · `manual-permissions.ts`(286줄 · `handling` 0건) · `operation-permissions.spec.ts:55-63` · `permission.guard.ts:33-45` ·
`src/core/numbering/numbering.service.ts:9-56`(`DEFAULT_PREFIX` **21종**) · `src/core/document-state/transitions.ts`(431줄 · `handling_unit` 0건) · `document-state.spec.ts:515-520` ·
`src/mdm/logistics/warehouse.service.ts:23-30` · `location.service.ts:14-20` · REFERRERS 상수 **15개 전수 목록** ·
`src/logistics/stock-transfer/stock-transfer.service.ts:120-126·190-200·250-263` · `transfer-arrive.service.ts:66·259` · `assertWorkerNo` 정의 **8곳** ·
`src/inventory/inventory.module.ts`(43줄 전문) · `prisma/schema.prisma:429-475`(`handling_unit`·`_content` 모델) ·
`prisma/migrations/20260908002517_stock_transfer_line_handling_unit/migration.sql:18-26` · `prisma/migrations/` **69 엔트리 전수 ls**

### 테스트
`test/app-document-issue-query.e2e-spec.ts:472-485·208·271·628-634·763-765` · `test/logistics-stock-transfer.e2e-spec.ts:1300-1318` · `test/mdm-location.e2e-spec.ts:19·105-107` · `src/app/document-issue/document-issue-simple-lock.spec.ts:93·113·115·162` · `src/logistics/stock-transfer/stock-transfer-lock.spec.ts`(99줄) · 잠금 키워드 spec 파일 전수 계수

### 계획 문서 (⛔ **한 줄도 고치지 않았다**)
`docs/coverage-100/plan.md:52·55·58-64·109·130-136·148·158·243-262` · `plan-integration.md:129·176-184·347-350·537·606·866-880` · `plan-uiux.md:58-63·400·403` · `plan-api.md:1090-1114` ·
`lanes.md:39-60·62-68·93-135·152-196` · `README.md:24-45·46-70·85-116·117-180` · `lane-C.md:24-30·41` ·
⛔ **레인 C 문서(읽기만)** `docs/coverage-100/slices/I-16.md:5·223·256·889·930` · **레인 A 문서(읽기만)** `slices/I-22.md:35·51·1039·1228·1283` ·
`docs/design-inquiries/README.md`(HEAD `:143-165` · `origin/main` `:143-170`) · `ls docs/design-inquiries/`(HEAD·`origin/main` 양쪽)

### git
`git log --oneline -30 origin/main` · `git diff --stat 1df7042 origin/main` · `git diff 1df7042 origin/main -- docs/coverage-100/* docs/design-inquiries/README.md src/app/document-issue/*` · `git merge-base --is-ancestor` ×2

---

## ② §0 다섯 자리 판정

| # | 자리 | 판정 |
|:-:|---|---|
| ① | 마이그 표 2 신설 | **PASS**(정정 3 · 전부 Minor 이하) |
| ② | 잠금 순서 — I-27 교차 | **PASS**(사실 기반 오늘자 `origin/main` 까지 재확인 · 표현 정정 1 · 보강 2) |
| ③ | PR 분할 5 | **조건부 PASS** — 결론 유지, **ⓑ 갈래의 예산 셈이 틀렸다**(Major-1) |
| ④ | `status_code` 상수 둘 | **PASS**(사실 보강 1 — `'ACTIVE'` 픽스처가 둘이다) |
| ⑤ | 이벤트 언제나 + 빈 배열 허용 | **PASS** |

### 자리 ① — 마이그 표 2 신설 · **PASS**

**직접 검산한 것**

- 계약 헤더 5칸(`repackEventId`·`repackTypeCode`·`performedBy`·`occurredAt`·`lines`) ↔ 초안 DDL 헤더 5칸(위 넷 + `created_at`). **모자란 칸 0 · 남는 칸은 감사칸 하나**(저장소 전 표 공통형).
- 계약 라인 6칸(`handlingUnitId`·`roleCode`·`itemId`·`lotId`·`qtyBefore`·`qtyAfter`) ↔ 초안 DDL 라인 10칸(위 여섯 + PK + 이벤트 FK + `line_no` + `created_at`). **모자란 칸 0.** `uomId` 는 계약 라인에 **정말 없다**(파싱 실측) ⇒ 안 만드는 판정 ✅.
- 재사용 불가의 결정타 셋 전건 psql 실측 — `_line` 이 필수 4칸(`handling_unit_id`·`role_code`·`qty_before`·`qty_after`)을 **정말 갖고 있지 않다** · `ck_…_distinct` 가 **실재**하고 `source`/`target` 이 **둘 다 NOT NULL** 이라 한 HU 사건(`source ≡ target`)이 **구조적으로 INSERT 불가** · `moved_qty` NOT NULL `CHECK (> 0)` 라 「0 이 사실인 이력」을 못 담는다. ⇒ ⚠ 브리프가 물은 「`ck_…_distinct` 가 대표 경로를 구조적으로 막는가가 psql 로 확인된 사실인가」 → **그렇다.**
- `app.qty_t` = `numeric(20,6) CHECK (VALUE >= 0)` ⇒ **0 이 담긴다** ✅(초안 DDL 주석의 전제). `handling_unit_content.qty` 는 별도 `CHECK (qty > 0)` 라 「이쪽만 0 허용」이 맞다.
- `GENERATED ALWAYS AS IDENTITY` 는 저장소 관행이다(`is_identity=ALWAYS` 실측) · README §5 「**FK 제약 이름은 Prisma 기본형**」 ⇒ 초안 DDL 이 FK 에 이름을 안 붙인 것이 **옳다**(`20260908002517/migration.sql:18-19` 이 「`fk_*` 로 지으면 `migrate diff` 가 드리프트를 낸다」고 이미 적었다).
- **파일명 충돌 0** — `prisma/migrations/` 69 엔트리 전수에 `i16`·`repack`·`handling_unit_repack` 없음(있는 것은 `20260908002517_stock_transfer_line_handling_unit` 하나).
- 삭제 0 ⇒ CLAUDE.md 두 릴리스 규칙 · README §3 멈춤 조건 **미해당** ✅. forward-only ✅. 「별도 선행 커밋」 ✅(§2-4).
- 통합 계획서와 **일치** — `plan.md:133`(§4 N-2 행) · `plan-integration.md:180`(신설 2) · `plan-uiux.md:61`(N-2) · `plan-integration.md:350`(재사용 반증 서술) · `plan-integration.md:606`(`src/inventory/handling-unit/` 를 I-16 자리로 이미 배정) 전건 갱신 상태 확인.

⇒ **뒤집지 않는다.** 정정은 Minor-7·8 과 Nit-2·3·5.

### 자리 ② — 잠금 순서(I-27 교차) · **PASS** ⭐ 최우선 자리

**⭐ 오늘도 병합 중인 I-27 을 `origin/main` 에서 직접 봤다.**
`origin/main = ee6b8b6` 는 초안 기준선 `1df7042` 보다 **앞서 있다**. 그 사이에 들어온 것:

| 커밋 | 무엇 | `handling_unit` 잠금에 영향 |
|---|---|:-:|
| `fba2b51`(#471) `7755b0d` | 단말 프린터 매핑 모델 + **새 마이그 `20260909010202_b_i27_printer_mapping`** | **없다** |
| `3883606`(#472) `df4a496` · `cb36bc5`(#473) `4c3783f` | 프린터 조회 + e2e | **없다** |
| `document-issue-write.service.ts` +14/−11 | `assertWriterReady`(성적서 잠금 미조율 422) **제거** + `lockDocumentIssueInspectionTargets` 추가 | **없다** |
| 신설 `document-issue-inspection-lock.ts`(109줄) | `inspection_result`·`inspection_request`·`lot` 을 **`FOR SHARE`** 로만 잠근다(`:43·:53·:68`) | **`handling_unit` 을 안 만진다** |

⇒ **`lockUnits` 의 순서·세기는 오늘도 그대로다.** 자리 ② 의 사실 기반은 유효하다.

**실측 원문**(`src/app/document-issue/document-issue-simple-lock.ts`)

- `:101-135` `lockUnits(tx, ids, needsContents, facts)`
- `:110-113` 부모 — `SELECT handling_unit_id … FROM inventory.handling_unit WHERE … ORDER BY handling_unit_id **FOR NO KEY UPDATE**`
- `:116-121` 자식 — `SELECT handling_unit_id FROM inventory.handling_unit_content WHERE … ORDER BY handling_unit_id,handling_unit_content_id **FOR SHARE**`
- ⇒ **부모 → 자식** ✅. 초안 §3-1 ⑤ · §5-2 ④ 의 순서와 **같다.** `FOR UPDATE`(I-16) vs `FOR NO KEY UPDATE`(I-27) 는 **부모 행에서 서로 충돌**하므로 두 트랜잭션은 부모에서 직렬화된다 ⇒ **교착 없음.** 판정 유지.
- `hasContent` 게이트 — `document-issue-create-rules.ts:161-167`: `facts.targetTypeCode === 'HANDLING_UNIT'` 이고 `facts.hasContent !== true` 면 `ERROR_CODE.STATE_LOCKED` 로 `failTarget`. `PACKING_LABEL` 은 `:170-171` 이 **`break;` 하나** ⇒ 게이트 0. `supported` 표 `:246`(`GOODS_ISSUE_QR: ['GOODS_ISSUE_LINE','HANDLING_UNIT']`)·`:249`(`PACKING_LABEL: ['HANDLING_UNIT']`) ✅ 초안 인용 정확.

**⭐ 초안이 안 적은 것 둘 (보강)**

1. **자식 잠금은 조건부다** — `:49-51` 이 `needsContents = documentTypeCode === 'GOODS_ISSUE_QR'` 를 넘기고 `:115` 가 그때만 자식을 잠근다. ⇒ `PACKING_LABEL` 발행은 **부모만** 잠근다. 결론(교착 없음)은 **오히려 더 강해진다**(자식을 아예 안 잠그는 갈래가 있으므로 자식에서 만나는 경우 자체가 좁다). Minor-4.
2. **`hasContent === true` 는 e2e 로 한 번도 통과된 적이 없다** — `test/` 전수에 `handling_unit_content` 를 만드는 곳이 **0곳**이다(grep). 그 게이트를 지키는 것은 e2e 가 아니라 단위 `document-issue-simple-lock.spec.ts:93·96·99·115` 와 `document-issue-create-rules.spec.ts:168-215` 다. ⇒ 초안 §12-2 의 「그 발행 경로 둘은 한 번도 통과된 적이 없다」는 **쓰기 경로에 한해 맞다.** 다만 그 근거로 든 「오늘 `handling_unit` 0행이라」는 정확하지 않다 — 조회·대상조회 경로는 `test/app-document-issue-query.e2e-spec.ts:476·208·628-634` 가 HU 픽스처로 **이미 지난다.**

**빈 배열 PUT 이 게이트를 「깬다」 — 절반만 맞다 (Minor-2)**

게이트는 발행 트랜잭션 «안»에서 부모·자식 잠금을 쥔 채 평가된다(`lockSimpleDocumentIssueTargets` → `qualifyDocumentIssueTarget`). ⇒ **게이트 자체는 안 깨진다.**
깨지는 것은 **이미 발행된 QR 의 사후 불변식**이다: `GOODS_ISSUE_QR` 발행(내용물 있음 · 통과) → 그 뒤 `PUT …/contents {items: []}` → `handling_unit_content` 0행 ⇒ **내용물 0 인 포장의 출고 QR 이 유통 중**이다. `PACKING_LABEL` 은 게이트가 아예 없어 처음부터 그 상태가 가능하다.
⇒ 통보 163ⓑ 의 문장을 「게이트를 사후에 깬다」 → 「**이미 발행된 QR 을 사후에 무효 상태로 만든다**」로 바꾸면 ⓐ(교착·순서)와 ⓑ(불변식)가 안 섞인다. 그러면 통보 163 은 **자리 ② 와 자리 ⑤ 를 잇는 하나의 사실**로 읽힌다.

⇒ **뒤집지 않는다.** 자리 ② 는 이 계획안에서 가장 단단한 자리다.

### 자리 ③ — PR 분할 5 · **조건부 PASS**(결론 유지 · 근거 산술 정정)

**부품 합은 정확하다.** §8-1 표 13행 = 155+70+100+45+45+135+150+120+14+14+9+38+58 = **953** ✅.

**그런데 배분에 구멍이 있다.**

- 컨트롤러 **155**줄의 배분 = 60(①) + 12(②) + 32(③) + 22(④) + 22(⑤) = **148**. **7줄이 어느 PR 에도 안 실렸다.**
- 그 결과 네 갈래의 PR 합이 전부 **949**(= 953 − 7 + `numbering` 3)여야 하는데 —
  ⓐ 437+370+142 = **949** ✅ · ⓒ 239+198+198+314 = **949** ✅ · ⓓ 239+198+198+172+142 = **949** ✅ · **ⓑ 239+348+198+142 = 927** ⛔
- ⇒ **ⓑ② 는 348 이 아니라 370** 이다(949 − 239 − 198 − 142). 부품으로 다시 세도 같다: 마이그 58 + schema 38 + repack 뷰 45 + repack 서비스 45 + `PUT` 150 + 컨트롤러 34 + 모듈 1 = **371**. → **Major-1**

**결론은 뒤집히지 않는다 — 오히려 강해진다.** ⓑ 는 「예산 350 에 여유 2줄」이 아니라 **예산 350 을 20줄 초과**한다(한도 400 은 안 넘는다). ⓓ 채택 근거가 더 분명해진다.

**ⓓ 자체를 초안 부품으로 다시 셈한 값**: 235 / 199 / 199 / 173 / 143(초안 239/198/198/172/142). 차이는 위 7줄과 모듈 배분(+5/+1×4)의 반올림뿐이다.
⇒ **max 239 · 전건 250 이하 · ④⑤ ≤ 200** 판정 전부 그대로. **PR 5 채택 유지.**

**「코어 전용 PR ≤ 200」 판정도 선다** — CLAUDE.md 의 코어 셋(재고 posting · lot 계보 · 전표 상태기계)을 전건 안 지난다. 원장 미경유는 psql `uq_inventory_balance_dim` 11칸으로 확인 ✅ · `transitions.ts` `handling_unit` 0건 확인 ✅ · `handling_unit_content.lot_id` 는 참조뿐 ✅. `numbering.service.ts` 는 `src/core/` 이지만 CLAUDE.md 코어 셋도 `lanes.md` §1-4 소유 파일도 아니다 ⇒ **사용자 통지 불필요** ✅.

### 자리 ④ — `status_code` 상수 둘 · **PASS**

사실 다섯 전건 재실측 ✅ (psql `status_code` NOT NULL · **CHECK 도 DEFAULT 도 없다** · `mdm.code_group` 에 그룹 0건 · 계약 `required` 4 에 `statusCode` 포함 · `x-no-code-key` 원문).

⭐ **보강 — `'ACTIVE'` 픽스처가 «둘»이다.** 초안 S-11 · 통보 164ⓐ · §13 #30 은 `test/logistics-stock-transfer.e2e-spec.ts:1314` 하나만 든다. **`test/app-document-issue-query.e2e-spec.ts:482` 도 `status_code: 'ACTIVE'` 로 HU 픽스처를 만든다.** 그것이 **I-27(레인 B)의 e2e** 라, 자리 ②(I-27 교차)와 자리 ④(세 번째 상태값)가 **같은 파일에서 만난다**. → Minor-1. 판정(상수 둘 · 목록 질의 값 검증 0)은 그대로.

⭐ 덤 — 계약 `x-no-code-key` 원문이 「**라벨 발행 여부는 boolean 축이면 충분하다(`InboundReceiptLine.labelIssued` 선례)**」라고 스스로 적었다. 초안이 「셋으로 늘리지 않는다」를 화면(`M-04-03` §8)으로만 세웠는데, **계약 본문이 같은 결론을 더 강하게 말한다.** §3-2 에 그 문장을 인용해 두면 판정이 0단계(선례)로 내려간다.

### 자리 ⑤ — 이벤트 언제나 + 빈 배열 허용 · **PASS**

- `PUT` 본문 스키마 **원문 파싱**: `{"type":"object","required":["items"],"properties":{"items":{"type":"array","items":{"$ref":"…HandlingUnitContentUpsert"}}}}` — **`minItems` 가 정말 없다** ✅. `HandlingUnitPack.contents.minItems = 1` ✅. ⇒ 「계약이 `minItems` 를 `:pack` «에만» 걸었다」는 **명시 신호 판정 성립**.
- `validation-error.mapper.ts:12-23` `RANGE_KEYWORDS` 에 `minItems`·`exclusiveMinimum` 실재 ⇒ `:pack` 빈 배열이 `RANGE` ✅ · `qty<=0` 이 `RANGE` ✅(`LINE_REQUIRED` 아님).
- 부작용은 자리 ② 의 표현 정정(Minor-2)만.

---

## ③ ⭐⭐ 「낡음 14 / 유효 12」 표 — **전건 검산**

> ⛔ 「초안이 그렇게 적었다」를 근거로 쓰지 않았다. **26건 전부 내가 다시 쟀다.**
> **결과: 오류 0.** 초안 표는 신뢰할 수 있다. 보강 2건(S-11 · S-6)과 표현 정정 1건(S-6 계수 방법)만 있다.

### A-1 「지금도 참」 12 — 전건 ✅

| # | 내 재실측 | 결과 |
|:-:|---|:-:|
| V-1 | psql `_line` 8칸 = `_line_id`·`_reconfiguration_id`·`line_no`·`item_id`·`lot_id`·`moved_qty`·`uom_id`·`created_at`. 계약 필수 4칸(`handling_unit_id`·`role_code`·`qty_before`·`qty_after`) **전부 없다** | ✅ |
| V-2 | `pg_constraint` — `CHECK ((source_handling_unit_id <> target_handling_unit_id))` 실재 · 양쪽 NOT NULL | ✅ |
| V-3 | 계약 `…Line.required` 6칸에 `uomId` **없음**(파싱) · psql `uom_id is_nullable=NO` | ✅ |
| V-4 | 계약 `HandlingUnit.required` = 4, `statusCode` 포함 | ✅ |
| V-5 | `HandlingUnitPack.contents.minItems=1` + `validation-error.mapper.ts:12-23` `RANGE_KEYWORDS ∋ minItems` | ✅ |
| V-6 | `HandlingUnitContentUpsert.qty.exclusiveMinimum=0` + 같은 집합 | ✅ |
| V-7 | `src/app.module.ts:26-27` 주석 + 등록 순서 = 인증 → 권한 → 계약 검증 → 멱등 → 낙관적 잠금 | ✅ |
| V-8 | `master-write.ts:26-45` `runIdempotent` 는 `return outcome.body` 뿐 · `setEtag` 는 `runVersioned` **:69** 에만 | ✅ |
| V-9 | 계약 `ConflictResponse` props = `conflictCause`·`message` — `code` **프로퍼티 자체가 없다** | ✅ |
| V-10 | `pg_constraint` 에 `fk_inventory_transaction_line_hu` **실재** · ⚠ `20260908002517/migration.sql:**20-21**` 이 「오늘도 FK 가 «없다»(late FK 미적용)」라 적고 있다(초안은 `:22-23` — 두 줄 차) | ✅ |
| V-11 | `uq_inventory_balance_dim` 원문 11칸 — `handling_unit_id` **없다** | ✅ |
| V-12 | psql 인덱스 6개 전수 — `uq_handling_unit_content(handling_unit_id,item_id,lot_id)` 선두 칸 ✅ · `handling_unit_handling_unit_no_key` UNIQUE ✅ · `status_code`·`handling_unit_type_code` 인덱스 **0** ✅ (`ix_handling_unit_warehouse`·`ix_handling_unit_location` 은 실재) | ✅ |

### A-2 「낡았다」 14 — 전건 ✅ (오류 0)

| # | 내 재실측 | 결과 |
|:-:|---|:-:|
| S-1 | `handling_unit` **12칸**(C 의 13 은 오기) | ✅ |
| S-2 | `handling_unit_reconfiguration` **9칸** | ✅ |
| S-3 | `app.numbering_rule` **13행** · 초안이 적은 13개 코드 목록과 **문자 그대로 일치** · `HANDLING_UNIT` 0행 | ✅ |
| S-4 | `DEFAULT_PREFIX` **21종** · `STOCK_TRANSFER:'ST'`·`INVENTORY_ADJUSTMENT:'IA'`·`NONCONFORMANCE:'NC'` 전부 병합돼 있다 · `HANDLING_UNIT` 없음 ⇒ **3중 충돌 소멸** | ✅ |
| S-5 | `transitions.ts` **431줄** · `handling_unit` grep **0** · `document-state.spec.ts:519` = `toHaveLength(**47**)`(바로 위 주석이 +2/+1/+1/+5 내역을 적어 둔다) | ✅ |
| S-6 | 정의 **8곳** ✅ — ⚠ 그중 `stock-transfer.service.ts:196` 은 **`private async` 메서드**라 `function assertWorkerNo` grep 으로는 안 잡힌다(내 첫 grep 이 7 로 나왔다가 재확인). 나머지 7 은 초안 목록과 파일·줄까지 일치 | ✅ |
| S-7 | `plan.md:158` 규칙 9 원문 — 예외 목록이 **열한째 `POST /trace/lots/{lotId}:request-iqc-skip`(I-18 · 통보 151)** 에서 끝난다 · **I-13 의 두 자리 없음** | ✅ |
| S-8 | 11행 중 내가 직접 연 6곳 전부 갱신본이었다 — `plan.md:61`(PR 4 · N-2) · `:133`(§4 N-2 행 실재) · `plan-integration.md:180`(신설 2 · ✕ 확정 · PR 4) · `plan-uiux.md:61`(N-2 · PR 4) · `plan-api.md:1109`·`:1110` | ✅ |
| S-9 | ⭐⭐ **C 원문을 직접 열어 대조했다** — `slices/I-16.md:889` = 「`plan-api.md` **1099행** … **삭제**(그 표를 안 쓴다)」. 적용본 `plan-api.md:**1110**` = 「~~`reconfiguration_no`~~ **`repack_event_no`** ❌ 신설 표(N-2)의 헤더 번호」. **삭제 지시가 개명으로 적용됐다** — 초안 지적이 정확하다. 그 표의 첫 칸 제목이 「**필요한 번호 칸**」이라(`plan-api.md:1094` 헤더) 그대로 두면 구현자가 「신설 표에 번호 칸이 필요하다」로 읽는다 | ✅ |
| S-10 | 위 자리 ② 전건 재확인 + **`origin/main` 최신까지** | ✅ |
| S-11 | `logistics-stock-transfer.e2e-spec.ts:1314` ✅ — ⭐ **그리고 `app-document-issue-query.e2e-spec.ts:482` 가 하나 더 있다**(초안 누락) | ✅ + 보강 |
| S-12 | `warehouse.service.ts:24` `['inventory.handling_unit','warehouse_id']` · `location.service.ts:15` `['inventory.handling_unit','location_id']` 실재 | ✅ |
| S-13 | `derived-permissions.ts:165·166·264`(쓰기 3) · `:40·:41·:42`(조회 3) · **`GET …/repack-events` 만 없다** ✅ · `manual-permissions.ts`(286줄) `handling` **0건** ✅ | ✅ |
| S-14 | `operation-permissions.spec.ts:61` `toHaveLength(**250**)` · `permission.guard.ts:39` 주석 「선언 **253** · 미선언 237」 — 다르다 ✅ | ✅ |

### A-3 브리프 §2 ① 네 물음 — 전건 ✅

- A4 적용 ✅(`stock_transfer_line_handling_unit_id_fkey` psql 실재).
- `stock_transfer_line.handling_unit_id` 첫 채움처 = **I-13 자신** ✅ — `stock-transfer.service.ts:**123**`(`handling_unit_id: line.handlingUnitId ?? null`) · `:**254**`(`handling_unit.count`) · `:**263**`(`if (handlingUnit === 0) bad('handlingUnitId', …)`) **줄 번호까지 정확**.
- 권한 등록 0줄 ✅ · 채번 한 줄 필요 ✅ · 충돌 소멸 ✅.
- 원장 미경유 ✅ · `transitions.ts` 미접촉 ✅.

### ⭐ 선행 I-12 — **병합됐다**

`plan.md:260` — `| I-12 | ✅ 2026-09-07 | #266·#267·#268·#269 | **332** (4/4) |`. `src/logistics/putaway/putaway-complete.service.ts` 실재. ⇒ `plan.md:61`·`lane-C.md:27` 의 선행 조건 **충족** ✅.

### ⭐ 문의 번호 163·164 — **선다**

- HEAD `ls docs/design-inquiries/` — A2 대역 실재 = **150·151·152·154~162**(12건 · **153 없음** — 브리프의 「153 영구 미사용」과 일치) ⇒ **다음은 163** ✅.
- ⭐ **`origin/main` 에서도 재확인**: 그 사이 I-22(레인 A)가 **190~208 열아홉**을 냈지만(`origin/main` 의 **`design-inquiries/README.md:146-164`**) **163·164 는 여전히 비어 있다** ✅. A 대역 잔여는 `209` 하나뿐이고 A2 둘째 대역 `210~239` 와 겹치지 않는다(`lanes.md:48`).
- 1-1단계 판정 ✅ — 163(잠금 순서·이미 통보한 결정의 파생) · 164(사실 정정) 둘 다 「MES 본질 × 비용 높다」 **양쪽에 걸리지 않는다** ⇒ **통보 · 회신 안 기다림** 맞다(`README.md:55-58`).
- C 대역 140~145 를 **고치지 않고 가리키기만** 했다 ✅(§10-2 문두 ⛔ 명시 · 본문도 인용뿐).
- ⚠ 참고 — `origin/main` 의 **`design-inquiries/README.md:168`** 이 「⛔ **번호는 통합자가 하나씩 준다** — 레인이 스스로 집지 않는다(2026-09-08 에 마지막 남은 089 를 두 에이전트가 동시에 집는 사고)」라 적었다. 문맥은 **A 대역**이고 `lanes.md:60` 은 「150~179 는 A2 몫」이라 A2 자율 배정으로 읽힌다. 잔여가 17개라 위험은 낮지만, **PR ⑤ 마감 커밋에서 파일을 만들기 직전 통합자에게 163·164 를 한 줄로 확인**하면 089 사고가 되풀이되지 않는다.

---

## ④ findings

### Major-1 — ⓑ 갈래의 예산 셈이 틀렸다 (자리 ③ 의 기각 근거)

**어디** §11-2 표 ⓑ 행(각 PR `239 / 348 / 198 / 142`).
**사실** 네 갈래는 같은 953(+3)줄을 나눈 것이므로 합이 같아야 한다. ⓐⓒⓓ 는 전부 **949**, ⓑ 만 **927** — 22줄이 증발했다. 부품으로 다시 세면 ⓑ② = 마이그 58 + `schema.prisma` 38 + repack 뷰 45 + repack 서비스 45 + `PUT` 150 + 컨트롤러 34 + 모듈 1 = **371**(≈370).
**실패 예** 통합자가 리뷰 뒤 「ⓑ 가 예산 350 에 **여유 2줄**이니 PR 하나 줄이자」로 판정하고 4분할로 되돌린다 → PR ② 를 열자마자 비테스트 **370줄**, 예산 350 을 **20줄 초과한 채 시작**한다. README §6 이 350 으로 낮춘 이유(리뷰 수정분 +20~30)가 통째로 사라지고, 리뷰 한 바퀴 뒤 400 을 넘겨 **분할 재작업**이 난다.
**정정** ⓑ 행을 `239 / **370** / 198 / 142`(최대 **370**)로 고치고, 기각 사유를 「여유 2줄」이 아니라 「**예산 350 을 20줄 초과**」로 적는다. 덧붙여 컨트롤러 155 의 배분(60+12+32+22+22=148)에서 **7줄이 어디로 갔는지** 적는다(예: 골격 60 → 67).

### Major-2 — 마이그 PR ② 의 «병합 전 한 줄 보고»와 «드리프트 0»이 계획에 없다

**어디** §11-3 게이트 줄 · §11-3 PR ② 행 · §12-3 마감표 · §12-2 「사용자 통지 불필요」.
**사실** **`lanes.md:175`**(§3 셋째 항목) = 「**마이그레이션이 든 PR 을 병합하기 직전 — 한 줄 보고만 하고 멈추지 않는다**」. **`README.md:38`** §1-5 도 같다. `lanes.md:126`·`:127`(§2 2·3) = 마이그가 딸리면 `node_modules/.bin/prisma migrate deploy` → `migrate diff --from-schema-datasource --to-schema-datamodel` 이 **`No difference detected`**. 초안은 게이트를 「단위 전체 + `inventory-handling-unit.e2e-spec.ts` 만」으로 적었고 §12-2 코어 행의 「사용자 통지 불필요」가 **마이그 보고까지 덮는 것처럼 읽힌다**(그 문장의 근거는 `transitions.ts`·`error-codes.ts` 미변경이다).
**실패 예** PR ② 를 손으로 쓴 SQL + 손으로 쓴 Prisma 모델로 열고 드리프트 검사를 건너뛴다 → `@@unique([handling_unit_repack_event_id, line_no], map: "uq_handling_unit_repack_event_line")` 의 `map:` 을 빠뜨렸다 → Prisma 는 제약 이름을 `handling_unit_repack_event_line_handling_unit_repack_event_id_line_no_key` 로 기대하고 DB 에는 `uq_…` 가 있다 → `migrate diff` 가 차이를 낸다. **병합된 뒤** 다른 레인이 §2 3 을 돌릴 때 처음 붉어지고, 원인을 찾는 몫이 남의 레인에 간다.
**정정** §11-3 PR ② 행과 §12-3 마감표에 두 칸을 만든다 — ⓐ 「병합 직전 사용자 한 줄 보고(`lanes.md` §3 · 멈추지 않는다)」 ⓑ 「`migrate deploy` + 드리프트 `No difference detected` 실측값」. §2-4 에 `schema.prisma` 의 `map:` 두 곳(UNIQUE·INDEX)을 명시.

### Major-3 — 회귀 e2e 범위를 한 건도 지목하지 않았다

**어디** §11-3 게이트 줄 · §12-3 마감표.
**사실** README §6 = 「**회귀 e2e(다른 파일)는 통합자가 병합 직전에 한 번 돌린다**」. 이 슬라이스는 저장소에서 **처음으로 `handling_unit`·`handling_unit_content` 를 «업무 경로»로 만드는** 슬라이스이고, 창고·위치를 채운 HU 를 만든다(S-12). 그런데 초안은 어느 파일을 돌려야 하는지 **한 줄도 안 적었다.**
**실패 예** I-16 e2e 가 중간에 실패해 `${PREFIX}` HU 가 남는다 → 다음 실행에서 `test/logistics-stock-transfer.e2e-spec.ts` 의 `warehouse.deleteMany` / `test/mdm-location.e2e-spec.ts` 의 위치 정리가 **mdm 삭제 가드가 아니라 FK 위반**으로 붉어진다(둘 다 `handling_unit` 을 통해 창고·위치를 참조한다). 원인이 남의 파일에서 드러나 진단이 한 바퀴 늘어난다.
**정정** §12-3 에 회귀 목록을 못박는다 — 최소 `test/logistics-stock-transfer.e2e-spec.ts`(HU 픽스처) · `test/app-document-issue-query.e2e-spec.ts`(HU 픽스처 + I-27 대상조회) · `test/mdm-warehouse.e2e-spec.ts` · `test/mdm-location.e2e-spec.ts`(REFERRERS 정합) · `contract-coverage`(+7).
**⭕ 내가 확인해 둔 안전 자리** — 신설 FK 넷은 `inventory.handling_unit`·`mdm.item`·`trace.lot`·`app.app_user` 를 가리킨다. 저장소의 REFERRERS 상수는 **15개**(`WORK_CALENDAR`·`SPARE_PART`·`MOLD`·`EQUIPMENT`·`EQUIPMENT_GROUP`·`WAREHOUSE`·`LOCATION`·`PROCESS`·`ROLE`·`INSPECTION_PLAN`·`PLAN_VERSION`·`CAUSE_CODE`·`DEFECT_CODE`·`ROUTING`·`PUTAWAY_RULE`)뿐이고 `ITEM_`·`LOT_`·`APP_USER_`·`HANDLING_UNIT_` 은 **없다** ⇒ `test/mdm-location.e2e-spec.ts:105` 의 **`toEqual` 정합 단언은 안 깨진다.** 이 문장을 §12-3 에 적어 두면 통합자가 다시 안 재도 된다.

### Minor-1 — `'ACTIVE'` 픽스처가 «둘»이고 그중 하나가 I-27 의 e2e 다

**어디** S-11 · §3-2 사실 5 · 통보 164ⓐ · §13 #30 · §9-1 ⚠.
**사실** `test/app-document-issue-query.e2e-spec.ts:476-484` 가 `handling_unit_no: '${PREFIX}-HU'` · `status_code: '**ACTIVE**'` 로 HU 를 만든다(레인 B · I-27 의 e2e).
**실패 예** 통보 164ⓐ 를 받은 설계팀이 「픽스처 한 곳만 고치면 되는 사소한 자리」로 읽는다 → 실제로는 **레인 둘이 각자 `'ACTIVE'` 를 쓰고 있어** 「세 번째 값이 우발적 오타」가 아니라 **관행**임을 못 본다.
**정정** 통보 164ⓐ · §13 #30 에 그 줄을 더한다. §9-1 의 「저장소 다른 e2e 가 `'ACTIVE'` 인 HU 를 남길 수 있다」는 「**둘이 남긴다**」로.

### Minor-2 — 「빈 배열 PUT 이 게이트를 사후에 «깬다»」가 두 사고를 섞는다

**어디** §0 자리 ⑤ · §10-1 #11 · 통보 163ⓑ.
**사실** 게이트는 발행 tx 안에서 부모·자식 잠금을 쥔 채 평가된다 ⇒ **게이트는 안 깨진다.** 깨지는 것은 **이미 발행된 QR 의 사후 불변식**이다.
**실패 예** 구현자가 「게이트가 깨진다」를 읽고 `PUT …/contents` 에 **「발행 이력이 있으면 빈 배열 거부」 가드를 지어낸다** → 계약에 그 규칙이 0이고 `PUT` 은 `ERROR_CODE` 를 새로 못 만들며(`lanes.md` §4), 무엇보다 **I-16 이 `document_issue_log` 를 읽지 않는다는 §3-2 판정과 정면으로 충돌한다.**
**정정** 「이미 발행된 QR 을 **사후에 무효 상태로 만든다**(발행 시점 게이트는 정상 작동한다)」로. 그리고 통보 163 에 「⇒ 서버는 막지 않는다 — 막을 축이 계약에 0이다」를 한 줄 덧붙인다.

### Minor-3 — 「오늘 `src/inventory/` 를 만지는 다른 레인은 없다」가 거짓이다

**어디** §8-2 마지막 ⚠ · §11-2 비용 문단.
**사실** 오늘 병합된 I-22(레인 A · `origin/main` `ee6b8b6`)의 계획서가 `slices/I-22.md:**1228**` 에서 「`inventory-reservation.service.ts:41-42` 의 「⚠ **오늘 언제나 빈 목록이다**」도 거짓이 된다 — **함께 고친다**」라 적었다. 그 파일은 `src/inventory/balance/inventory-reservation.service.ts` 다. `plan.md:55` 도 I-22 를 「예약 `reserve()` 신설 · 전용 PR ≤200 · **8 PR**」로 갱신했다.
**실패 예** 초안 문장을 믿고 PR ①~⑤ 를 `origin/main` 동기화 없이 연달아 스택으로 쌓는다 → I-22 PR 이 먼저 병합되면 `src/inventory/` 아래 파일이 바뀌어 §2 1(「PR 을 열기 직전 `merge origin/main` + 게이트 재실행」)을 밟지 않은 PR 이 뒤늦게 충돌한다.
**정정** 「`inventory.module.ts` 를 만지는 레인은 없다 — I-22(레인 A)가 같은 디렉터리의 **다른 파일**(`balance/inventory-reservation.service.ts`)을 고치므로 파일 충돌은 0이지만, `lanes.md` §2 1 의 병합 직전 동기화는 **PR 다섯 개 전건**에 그대로 적용한다」로.

### Minor-4 — I-27 의 자식 잠금은 «조건부»다

**어디** §0 자리 ② · §3-1 ⑤ · §5-2 · §13 #27.
**사실** `document-issue-simple-lock.ts:49-51` 이 `needsContents = documentTypeCode === 'GOODS_ISSUE_QR'` 를 넘기고 `:115` 가 그때만 자식을 `FOR SHARE` 로 잠근다. `PACKING_LABEL` 발행은 **부모만** 잠근다.
**실패 예** 리뷰어·구현자가 「I-27 이 언제나 부모→자식 둘을 잠근다」로 읽고, `PUT …/contents` 가 부모를 안 잠그고 자식만 바꿔도 「어차피 저쪽이 자식을 잠그니 직렬화된다」고 안심한다 → `PACKING_LABEL` 발행과 겹칠 때 **부모 잠금이 없어 두 치환이 서로를 덮는다.**
**정정** §13 #27 에 「자식 잠금은 `GOODS_ISSUE_QR` 일 때만」을 덧붙인다. 결론(교착 없음)은 **더 강해진다**.

### Minor-5 — 교차 잠금 순서를 지키는 시험이 **0**이다

**어디** §9-4 단위 2·3 · §9-5 #18·#19.
**사실** 단위 2·3 은 I-16 자기 SQL 만 본다. I-27 쪽 순서는 `document-issue-simple-lock.spec.ts:93` 이 따로 보지만, **두 순서가 «같다»는 것을 보는 자리는 저장소 어디에도 없다.**
**실패 예** 레인 B 후속 조각이 `lockUnits` 에서 자식 `FOR SHARE` 를 부모보다 앞으로 옮긴다(가독성 리팩터) → 양쪽 단위 시험이 **각자 초록**이고 e2e 도 초록인데, 현장에서 발행과 포장이 동시에 들어오면 **교착으로 한쪽이 40x/50x** 를 받는다.
**정정** 단위 2·3 의 주석에 **`src/app/document-issue/document-issue-simple-lock.ts:101-135`(부모 `FOR NO KEY UPDATE` → 자식 `FOR SHARE`)** 를 파일:줄로 못박고, 「이 순서가 바뀌면 여기도 바꾼다」를 적는다. 통보 163ⓐ 에도 같은 한 줄.

### Minor-6 — 컨트롤러 155 의 배분이 148 밖에 안 된다

§11-2 첫 줄. 60+12+32+22+22 = 148 ≠ 155. 7줄이 어느 PR 에도 안 실려 네 갈래 합이 전부 949(=953−7+3)가 됐다.
**실패 예** 구현자가 PR ① 을 「골격 60줄」로 잡고 짜다가 실제 컨트롤러 골격이 67줄이 되면 「계획이 틀렸다」로 읽고 예산 초과를 보고한다.
**정정** 배분 합을 155 로 맞춘다(골격 60 → 67 이 가장 자연스럽다 — `contextOf`·import 가 거기 있다).

### Minor-7 — §0 「5칸 영구 NULL」 vs §2-3 「6칸」

§0 자리 ① = 「그러고도 **5칸이 영구 NULL**」 · §2-3 = 「`_no`·`reason_code`·`source`·`target`·`uom_id`·`moved_qty` 가 영구히 빈 채 남는다」(**6**). C 원문(`slices/I-16.md:256`)은 `source/target` 을 **한 항목**으로 세어 5 다.
**실패 예** 통합자가 §0 만 읽고 리뷰 브리프에 「6칸」이라 적었다(실제로 그렇게 적혀 있다) → 재수립 R-n 표에서 5 와 6 이 함께 돌아다녀 어느 쪽이 실측인지 알 수 없게 된다.
**정정** §0 을 6 으로 통일하거나 「`source`·`target` 을 한 항목으로 세면 5」를 괄호로 적는다.

### Minor-8 — 「신설 비용 … FK **4**」는 실제 **5**다

§2-3 판정 문단. 초안 DDL 의 FK 는 헤더 `performed_by → app.app_user` 1 + 라인 `event_id`·`handling_unit_id`·`item_id`·`lot_id` 4 = **5**. (§2-4 의 「역방향 관계 4개」는 «외부 표 4종»이라 별개로 맞다.)
**실패 예** 「신설 = 10건 추가」와 「재사용 = 10건」을 나란히 놓아 **무승부**로 읽히게 만든 셈이 한 항목 어긋난다 — 결론은 기준 5 로 갈리므로 안 바뀐다.

### Minor-9 — 잠금 단위 스펙 «선례 수»가 초안 안에서 서로 다르다

§13 #42 = 「spec **19파일**」 · §9-5 #18 = 「선례 **12파일 23단언**」. 내 실측: 잠금 키워드(`FOR UPDATE`/`FOR SHARE`/`FOR NO KEY UPDATE`)를 담은 spec = **`src/` 17파일**(`src/`+`test/` 22파일) · 언급 줄 41.
**실패 예** 구현자가 「12파일」을 근거로 선례를 찾다가 못 채우고 「선례가 부족하니 단위 대신 e2e 로」로 되돌아간다 — I-13 이 정확히 그 자리에서 Major 를 받았다.
**정정** 한 숫자로 통일하고 측정 명령을 적는다. 형(`stock-transfer-lock.spec.ts` **99줄** — 실측 일치)은 그대로 유효하다.

### Minor-10 — `lane-C.md:27` 은 「PR 3」만 낡은 게 아니다

§12-1 말미 ⚠. 그 행 원문은 `| 4 | **I-16** … | 7 | I-12(끝남) — 언제든 | **없음** | opus | **3** |` 로, **마이그 칸이 「없음」**이다. N-2 신설이 확정된 지금 그 칸도 낡았다.
**실패 예** 통합자가 「PR 3 → 5」만 고치고 넘어간다 → 레인 C 문서는 여전히 「I-16 은 마이그 없음」이라 적고 있어, 나중에 C 대역을 다시 여는 사람이 마이그 PR 의 존재를 못 본다.
**정정** 통합자 보고 한 줄을 「`lane-C.md:27` — PR **3 → 5** · 마이그 **없음 → N-2 신설 2**」로.

### Minor-11 — `plan.md:158`(규칙 9)은 한 «줄»짜리 공용 문단이라 레인 A 와 겹친다

§12-1 ③. 그 예외 목록은 `plan.md` **158행 한 줄**에 전부 들어 있고, `lanes.md` §1-4 의 「`plan.md` 는 공용 — 자기 슬라이스 «행»만」이 이 경우엔 **행이 하나라서 보호가 안 된다.** I-22 의 `POST …/lines/{…}:pick` 도 사번 required 라(`plan-uiux.md:436`) 레인 A 가 같은 줄을 늘릴 가능성이 높다. 게다가 초안은 그 줄에 **남의 슬라이스(I-13) 두 자리까지 채워 넣겠다**고 적었다.
**실패 예** PR ⑤ 마감 커밋이 그 줄을 다시 쓰는 사이 레인 A 가 I-22 항목을 더한다 → `plan.md:158` 한 줄 전체가 충돌하고, 자동 병합이 되면 **한쪽 목록이 통째로 사라진다**(diff 가 한 줄이라 리뷰에서 안 보인다).
**정정** ⓐ 그 줄만 담은 **단독 커밋**으로 내고 바로 병합한다(`manual-permissions.ts` 규칙과 같은 형) ⓑ I-13 두 자리를 채우는 것은 **남의 슬라이스 행**이 아니라 A2 자기 것이지만, 통합자에게 한 줄 보고한다.

### Nit-1 — §13 #49 의 「마이그 최신 타임스탬프 `20260909010052`」가 `origin/main` 기준으로 낡았다
현재 최신은 **`20260909010202_b_i27_printer_mapping`**(오늘 병합). 결론(「오늘 만들면 반드시 그 뒤다」)은 그대로.

### Nit-2 — §2-3 「재사용 비용 = 10건」 뒤에 11번째 항목이 붙어 있다
문장이 「추가 4 + 완화 5 + CHECK 삭제 1 + **채번 신설 1**」을 나열하면서 라벨은 10 이다. §0 은 채번을 뺀 10 이라 맞다. 셈 기준을 한 곳에 적는다.

### Nit-3 — `schema.prisma` 의 `map:` 두 곳
§2-4 가 「모델 2 + 역관계 4」만 적는다. 드리프트 0 을 위해 `@@unique([...], map: "uq_handling_unit_repack_event_line")` 와 `@@index([handling_unit_id, handling_unit_repack_event_id], map: "ix_handling_unit_repack_event_line_hu")` 가 필요하다(기존 `handling_unit_content` 모델 `:473` 이 같은 형).

### Nit-4 — `plan-api.md:1109`·`:1110` 의 교차 참조가 「I-16 **§4-3**」인데 초안의 채번 절은 **§4-2** 다
:1110 은 삭제 대상이니 남는 것은 :1109 하나다. §12-1 ① 에 「:1109 의 `§4-3` → `§4-2`」를 덧붙이면 한 번에 끝난다.

### Nit-5 — `plan.md:133`(N-2) 서술이 「복합 인덱스 1」만 적는다
초안 DDL 은 `ix_…_line_hu`(INDEX 1) **와** `uq_handling_unit_repack_event_line`(UNIQUE 1)을 만든다. §12-1 에 그 한 마디를 더할지 판정이 필요하다(안 고쳐도 해는 없다).

### Nit-6 — 줄 번호 미세 오차 셋
`master-write.ts` `runIdempotent` **:26**-45(초안 :29-45) · `20260908002517_stock_transfer_line_handling_unit/migration.sql` FK 오기 주석 **:20-21**(초안 :22-23) · `validation-error.mapper.ts` `RANGE_KEYWORDS` **:12-23**(초안 :13-23). 전부 ±3 이내이고 사실은 정확하다.

---

## ⑤ 미수행

1. ⛔ **커버리지 `431/487` 재측정** — `prisma generate && jest contract-coverage` 는 브리프의 「전체 게이트 재실행 금지」와 §2-2 2(생성물 공유 · 남의 레인 `tsc` 를 가짜로 붉힌다)에 걸린다. §13 규칙대로 **내 판정이 그 값을 뒤집지 않으므로 재지 않았다.** `plan.md` §8 진행표의 최근 값들(I-27 `414/487` · I-32 `378/487`)과 모순되지 않는다. **미수행.**
2. ⛔ **`@Contract` 7건 실제 바인딩 확인** — 코드가 0줄이라 잴 것이 없다. 계약 오퍼레이션 7건은 `plan-integration.md:870-880` 목록과 계약 파싱으로 확인했다.
3. ⛔ **화면 원문(`P-04-01`·`P-02-08`·`M-04-03`·`P-04-04`)** — 저장소 밖이다. UI/UX 관점 몫이라 판정하지 않았다. **미수행.**
4. ⛔ **계약 7 오퍼레이션의 400/404/409 «순서» 선언 전수 대조** — API 관점 몫이다. 나는 응답 코드 집합·`headers` 키·본문 스키마·파라미터만 파싱했다.
5. ⛔ **e2e 39 · 단위 11 의 개별 반증 가능성 전수 점검** — 자리 ② 에 걸리는 단위 2·3·(잠금)과 자리 ③·⑤ 에 걸리는 것만 봤다. `toBeUndefined()` 대신 `!== String(version_no)` 의 성립 여부(브리프 ⓒ ⭐)는 **express 실행 없이는 못 단다** — **미수행**(API 관점이 계약 `headers` 부재로 판정할 자리다).
6. ⛔ **다른 관점 리뷰 파일** — 열지 않았다.
7. ⛔ **`origin/main` 병합·게이트** — 워크트리 HEAD 는 `1df7042` 그대로다. `origin/main`(`ee6b8b6`)은 `git show`/`git diff` 로 **읽기만** 했다.

---

## ⑥ 한 줄 결론

**⭕ 통과 — 자리 ②(I-27 교차)는 `origin/main` 최신까지 재확인해도 단단하고, 「낡음 14 / 유효 12」 26건은 전건 재실측에서 «오류 0»이다.** 다만 **자리 ③ 의 ⓑ 갈래 예산이 22줄 틀렸고(348 → 370 · 결론은 오히려 강해진다)**, **마이그 PR ② 의 「병합 전 한 줄 보고 + 드리프트 0」과 「회귀 e2e 범위」가 계획에 없다** — Major 셋을 §11-2·§11-3·§12-3 에 반영한 뒤 구현으로 넘긴다.
