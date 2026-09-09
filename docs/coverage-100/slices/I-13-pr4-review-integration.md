# I-13 PR ④ 독립 리뷰 — **통합 관점**

> 대상: `.backend-dev/lane-a2/I-13-pr4-draft.md`(510줄 전문) · 브리프: `brief-I-13-pr4-review.md`
> 워크트리 `.claude/worktrees/designer-worktree-workspace-ff88ca` · HEAD `1a27fa6` · 계약 사본 `a6a87e1` · 리뷰일 **2026-09-09**
> ⛔ 이 파일 하나만 썼다 — 코드·계약·문서 수정 0 · `git`/`gh` 쓰기 0 · DB 쓰기 0 · `pnpm exec` 0 · 전체 게이트 재실행 0
> ⛔ 독립성 — `I-13-pr4-review-api.md` · `-uiux.md` 를 **열지 않았다**

---

## 1. 무엇을 «직접» 읽었나 (초안 인용을 믿지 않고 연 것만)

### 1-1. 정본 계획서 · 루틴 규칙
| 자리 | 확인한 것 |
|---|---|
| `docs/coverage-100/plan-integration.md:322-329` · `:177` · `:839-845` | §I-13 전문 · 마디표 행 · 오퍼레이션 6건 목록 |
| `docs/coverage-100/plan.md:58`(§1 21번) · `:131`(A4) · §8 진행표 | 선행 I-5 · 마이그 A4 · 코어 `transitions.ts` · PR 4 · §8 에 I-13 행 **없음** |
| `docs/coverage-100/lanes.md` **전문 195줄** | §0-1(A/A2 · 이슈 라벨 점유) · §1-1(대역) · §1-3(브랜치 접두어·PR 소유 4규칙) · §1-4(소유 파일표) · §2 · §2-2 · §3(알려야 할 순간) · §4 |
| `docs/coverage-100/README.md:27,29,121,128-142` | 재수립 «기본값» · §6-1 ①③④ · §6-2 |
| `docs/coverage-100/slices/I-13.md` (C · 1114줄) | 절 구조 전체 · **§6-2 코드 스케치** · §12 PR 분할 4행 · §13 인계 7행 · §13-1 대조표 20행 |
| `docs/coverage-100/slices/I-12.md` · `I-24.md` · `I-18.md` · `I-5.md` · `I-11.md` | 절 번호 관행(마감 절이 §11·§12·§14 로 갈린다) · I-12 §12·§12-1 마감 형상 |

### 1-2. 코드·물리 (초안의 근거 줄을 «그 파일에서» 확인)
`src/common/permissions/manual-permissions.ts:255-260` · `src/logistics/putaway/putaway-posting.ts:1-60` ·
`src/core/document-state/transitions.ts:392-412`·`:205-235` · `src/logistics/stock-transfer/transfer-posting.ts:125-145`·`:295-315` ·
`src/logistics/stock-transfer/stock-transfer.service.ts:95-120` · `.controller.ts:20-26,47-125` · `transfer-arrive.service.ts`(grep) ·
`src/logistics/document-progress/document-progress-query.service.ts:70-100`·`:215-250` · `document-type-registry.ts:60-81` ·
`cancel-eligibility.service.ts:45-60`·`:148-190` · `src/common/idempotency/idempotency.service.ts:100-150` ·
`src/common/master/master-write.ts:26-62` · `src/logistics/goods-issue/goods-issue.controller.ts:144-156`·`goods-issue-update.service.ts:25-35` ·
⭐ **`src/inventory/adjustment/` 전체**(`inventory-adjustment.controller.ts:95-122` · `-update.service.ts:1-30,57,67,144-207` · `-rules.ts:103-119` · `wc -l`) ·
`src/inventory/transaction/inventory-transaction.service.ts:16-32`·`:238-252` · `src/app.module.ts:20-35` ·
`prisma/schema.prisma` `inventory_transaction` 모델 전문 · `src/common/permissions/derived-permissions.ts:44-54`

### 1-3. 테스트·스위트
`test/logistics-stock-transfer.e2e-spec.ts:20-35,120-135,935-970,1135-1180` + `it(` 실측 **39** / 1216줄 ·
`test/logistics-document-progress.e2e-spec.ts`(`STOCK_TRANSFER` grep **0**) ·
`src/logistics/document-progress/document-progress-query.service.spec.ts:51-310`(`it(` 실측 **14**) · `:190-211` `tableStub` ·
`grep -rn "expect(500)" test/` · `package.json` `test:e2e = --runInBand`

### 1-4. 계약 · git · gh (읽기만)
`contracts/logistics-01자재창고.json` `node -e` 직접 파싱(`document-progress` path 4 · enum 9값) ·
`contracts/shipment-04제품출하.json` `POST /logistics/stock-reinstatements` description + x-internal-note 전문 ·
`git log -- src/logistics/document-progress/`(8건) + 그중 두 「fix」 커밋의 본문·병합 PR · `git show --stat 08b92b8` ·
`git log -S` (manual-permissions) · `git branch -r` **전건** + 각 브랜치의 `merge-base --is-ancestor` · `git diff --name-only origin/main...<앞선 브랜치>` ·
`gh pr list --state open` · `gh pr view 421` · `gh pr view 455 --json files` · `gh issue view 403`·`337` · `gh issue list --state open`

---

## 2. §0 다섯 판정 (초안 §0-1 의 「반드시 볼 자리 5」를 그대로)

### ① 「도달 불가」의 뜻 — **PASS**

초안의 「오퍼레이션은 도달한다 · 도달 불가인 것은 «치환 본체» 하나」가 실측으로 선다.

| 초안 주장 | 내가 연 자리 | 판정 |
|---|---|:-:|
| `POST` 가 `shipped_at` 을 무조건 채운다 | `stock-transfer.service.ts:101` `shipped_at: occurredAt`(주석 「생성과 반출이 한 오퍼레이션이라 태어나는 순간 반출이 끝나 있다」) · `:112` `shipped_qty: line.requestedQty` | ✅ |
| 둘째 생성처(`POST /logistics/stock-reinstatements`)도 반출 전을 안 만든다 | 계약 04 파일 직접 파싱 — description 「반출·도착·보류 해제·Lot Status 전이를 **한 트랜잭션으로**」 · 「⛔ 창고 간 이동의 **2단계 스캔을 쓰지 않는다**」 | ✅ |
| 그 오퍼레이션은 미구현이다 | `@Contract('POST /logistics/stock-reinstatements')` **0건**(`grep -rn "@Contract('PUT\|stock-reinstatements" src/`) · 있는 것은 `transitions.ts:224` LOT 축과 `derived-permissions.ts:187` 뿐 | ✅ |
| `shipped_at` 을 널로 되돌리는 코드 0 | `transfer-arrive.service.ts` 는 `received_at`·`status_code`·`version_no` 만 UPDATE(`:142-149`) | ✅ |

⭐ **초안이 안 쓴 지지 근거 하나** — 계약 04 의 `x-internal-note` 가 「**201 에 ETag 를 두지 않는다 — 만들어진 «이동 문서»를 이 화면이 다시 고치지 않는다**」라 적었다. 「재등록이 `stock_transfer` 를 만든다」의 **계약 문자 물증**이고, 초안 §11 ⑤ 인계의 근거가 여기 있다.

### ② `shipped_at IS NULL` 갈래를 **500** 으로 닫는 것 — **조건부 PASS**(통합 관점)

이 자리의 주 판정은 API 관점 몫이라 계약 응답 선언은 다루지 않는다. **통합이 볼 두 축**만 답한다.

**⑴ 「저장소가 500 을 e2e 로 재는가」 — 잰다.** 초안이 안 쓴 실측이다:
`test/error-envelope.e2e-spec.ts:121`(`/api/probe/boom` → 500) · `test/maintenance-inspection.e2e-spec.ts` **7건** · `test/app-document-issue-report.e2e-spec.ts` **2건**.
⇒ e2e 42 의 `.expect(500)` 은 새 관행이 아니다. **초안의 결론을 강화한다.**

**⑵ ⚠ 그러나 지뢰가 «같은 레인 다음 슬라이스»에 있다.** 초안이 든 선례 둘(`master-write.ts:56-59` · `goods-issue.controller.ts:148-154`)은 **「가드가 이미 막았으니 여기 오면 값이 있다」 — 코드 불변식**이다. 이번 것은 **데이터 상태**다. 데이터는 미래 오퍼레이션·백필·수기 정정이 만들 수 있고, 초안 스스로 §11 ⑤ 에 「I-23 이 `shipped_at` 을 안 채우면 4단계 파열이 실제로 터진다」라 적었다. **I-23 은 남이 아니라 A2 인수 대상**(#410 `Lane-C`)이다. ⇒ 표의 한 행으로는 약하다(Minor-3).

⇒ **PASS 하되 조건 둘**: ⓐ I-23 브리프에 「`stock_transfer` 를 만들면 `shipped_at` 을 반드시 채운다 — I-13 PR ④ §4-3 파열」을 **문장으로** 박을 것 ⓑ 문의 162 ⓓ 에 그 문장을 함께 실을 것.

### ③ 판별자 축의 «식» — **PASS**

「이 전표 번호로 양성 판별」이 맞고, 초안이 안 쓴 **안전성 증명**을 내가 확인했다.

- 원장 번호는 `transactionNo: input.stockTransferNo`(`transfer-posting.ts:136`)와 `` `${input.stockTransferNo}${ARRIVE_NO_SUFFIX}` ``(`:303`) **둘뿐**이다 ⇒ `startsWith(전표번호)` 가 **둘 다** 집는다. ✅
- ⭐ **접두 충돌이 원천적으로 불가능하다** — 질의가 이미 `source_document_id: documentId` 로 좁힌 뒤라, 후보는 ⓐ 이 전표의 두 행 ⓑ `putaway_task_id == stock_transfer_id` 인 적치 행뿐이다. 적치는 `PT-`(`putaway-posting.ts:49` `transactionNo: move.putawayTaskNo`)라 `ST-` 로 시작할 수 없다. **다른 전표와의 4자리 SEQ 접두 충돌은 애초에 후보 집합에 없다.** 초안이 이 논거를 안 썼는데, 이것이 「양성 판별」의 진짜 안전근거다.
- `noColumn` 은 `string | null`(`document-type-registry.ts:18`)이고 `STOCK_TRANSFER` 는 `'stock_transfer_no'`(`:69`) ⇒ 초안의 `mapping.noColumn !== null` 가드가 타입상 필요하다. ✅
- `row` 는 `detail()` 의 `delegate.findFirst({ where, include })`(`:93`) — `select` 가 없어 스칼라 전건이 실린다. ✅

### ④ `PUT …/lines` 를 «어느 파일»에 두는가 — **조건부**(결론은 살 수 있으나 **근거를 반드시 교체**)

**결론(=`stock-transfer.service.ts` 에 메서드 하나)은 뒤집지 않는다** — 32줄짜리 자물쇠는 CLAUDE.md 「사용처 하나뿐인 추상화 금지」에 걸린다.
⛔ **그러나 초안이 든 근거가 반증된다.** 초안: 「형제 `goods-issue-update.service.ts` 는 등록·전기가 **이미 300줄을 넘어** 갈린 파일이다」.

| 형제 | 본 서비스 | 갈린 파일 | 갈린 시점 |
|---|--:|--:|---|
| 출고 | `goods-issue.service.ts` **341** | `goods-issue-update.service.ts` 293 | 300 초과 ✅ 초안 말대로 |
| ⭐ **재고 조정(I-14)** | `inventory-adjustment.service.ts` **109** | `inventory-adjustment-update.service.ts` **251** | **2026-09-08 병합** — 109줄에서 갈랐다 |

즉 저장소의 실제 관행은 **「라인 치환은 `*-update.service.ts`」**이고 줄 수는 이유가 아니다(그 파일 헤더 주석: 「출고 `goods-issue-update.service.ts` 의 **거울상**이다」). ⇒ **자리 ④ 는 「300줄 규칙」이 아니라 「자물쇠 32줄은 «치환 본체»가 아니다」로 논증해야 선다.** 상세는 Major-2.

### ⑤ 판별자 수정이 «누구의» 파일인가 — **PASS(결론) · 근거 한 줄이 거짓**

**결론 「A 조율 불필요」는 맞다.** 다만 초안이 세 자리에 실은 「열린 PR 0건」은 **틀렸다**(Major-3). 내가 결론을 **대신 세웠다**:

| 축 | 내 실측 | 판정 |
|---|---|:-:|
| 소유 | `git log -- src/logistics/document-progress/` **8건 · 전부 I-5**(#219~#223 · 작성자 hj.cho · 2026-09-06). 제목에 I-5 가 없는 두 「fix」 커밋(`2dd24b6`·`e185dd3`)도 본문이 「#220 리뷰 반영」·「#219 리뷰 반영」이라 **I-5 PR 리뷰 반영분**이다 | ✅ 초안대로 |
| `lanes.md` §1-4 | 소유표 8행 어디에도 `document-progress/` 가 없다. 마지막 행 「그 밖의 도메인 모듈(`logistics.module.ts` …)」은 **모듈 등록부** 규칙이고 서비스 파일이 아니다 | ✅ 무소유 |
| 열린 PR | ⛔ **#455 `feat/coverage-100-a-i21-5`(2026-09-08T17:14Z OPEN)** — 초안 측정일(09-09) 이전부터 열려 있었다. 단 파일은 `src/quality/concession/*`·`quality.module.ts`·`test/quality-concession.e2e-spec.ts` **뿐** | ⛔ 근거 거짓 · **결론 유지** |
| 원격 브랜치(초안이 안 봄) | `git branch -r` 전건에 `merge-base --is-ancestor` — **main 보다 앞선 것 3개**(`docs/client-local-api-guide` · `feat/coverage-100-a-i19-c` · `feat/coverage-100-a-i20-core`). 셋 다 `document-progress/`·`stock-transfer/` **0파일**. `feat/coverage-100-c-i14-c`·`-c1` 은 **이미 main 에 들어갔다** | ✅ 충돌 창 0 |
| I-12 회귀 | 문서진행 `documentTypeCode` enum **9값**(계약 직접 파싱 — `PUTAWAY_TASK` 없음 · `:cancel`/`:request-cancel` 은 3값) ⇒ 적치는 이 조회의 대상이 아니다. `putaway-posting.ts` 무변경 | ✅ 0 |

---

## 3. 브리프 §4 「통합」 초점 — 판정

### ⓑ 「C 의 판정 넷이 낡았다」 — **넷 다 참(4/4)**

| # | 초안 주장 | 내 실측 | 판정 |
|:-:|---|---|:-:|
| 1 | 권한이 `manual-permissions.ts:260` 에 이미 등록(`852294a`) | `grep -n` → **정확히 260행** `'PUT /logistics/stock-transfers/{stockTransferId}/lines': ['M-01-10'],` · `git log -S` → `852294a feat(logistics): 재고 이동 :arrive·라인 치환 권한 등록`. C 의 §6-2 마지막 줄은 아직 「`manual-permissions.ts` 에 **한 줄 신설**」이다 | ✅ **낡았다** |
| 2 | 059 가 2026-09-08 «통보»로 확정 | `docs/design-inquiries/059-…md` 머리 「## ✅ 결정 (2026-09-08 · 통보)」 + 판별 규칙 정본 블록 · 구분 칸 「⭐ **통보** … 회신을 기다리지 않는다」 · `putaway-posting.ts:6-17` 주석에 같은 규칙 · `git show --stat 08b92b8` = `docs(design-inquiries): 059·051·030·069 를 통보로 확정한다`(2026-09-08 · `putaway-posting.ts` +7 포함) · `plan-integration.md:324` 에도 반영 | ✅ **낡았다** |
| 3 | 파일 배치가 틀림 | `I-13.md` §12 PR ④ 행 파일 칸에 **`transfer-arrive.service.ts`(+40)** 가 실재. 그 파일(266줄)은 `lockHeader` FOR UPDATE → 전이 → 도착 전기 → `received_at`/`version_no` UPDATE 뿐 — 라인 치환과 인과 0 | ✅ **낡았다** |
| 4 | PR ③ 병합으로 `transitions.ts` 제약 소멸 | `gh pr view 421` → **MERGED 2026-09-08T15:00:14Z** (`feat/coverage-100-c-i13-c`) · `transitions.ts:404` `'logistics.stock_transfer.status_code'` 축 실재(커밋 `ff32496`) · C 의 §12·§13 ② 는 아직 「PR ③ 착수 **전**에 알린다」 | ✅ **낡았다** |

⇒ **재수립을 돌린 판단이 선다.** 넷 중 어느 것도 흔들리지 않았다.

### ⓒ 판별자 축이 「남의 슬라이스가 아닌가」 — **맞다**(위 자리 ⑤ · 근거 하나만 교체)

⭐ 추가로 확인한 것: `(STOCK_TRANSFER, id)` → 원장을 푸는 자리가 저장소에 **셋뿐**이다(`grep -rn "source_document_type_code" src/` 전수) —
`document-progress-query.service.ts:227`(고칠 자리) · `cancel-eligibility.service.ts:164,179`(하류 판정 · `LOT_SOURCE_TYPES` 가 `['INBOUND_RECEIPT','GOODS_RECEIPT']` 라 STOCK_TRANSFER 에 안 돈다 · `:51,156`) · `inventory-transaction.service.ts:104`(질의 축 · 문의 162 ⓑ).
`document-cancel-execute.service.ts:141` 은 **계약 enum 3값**(`INBOUND_RECEIPT`·`GOODS_RECEIPT`·`GOODS_ISSUE`)이 STOCK_TRANSFER 를 아예 못 받아 **이중으로** 도달 불가다(초안은 `cancelable:false` 하나만 들었다). ⇒ **초안의 「고칠 자리는 `steps()` 하나」가 맞다.**

### ⓓ C 의 문서에 새 절 §14 를 더해도 되는가 — **선다**

| 축 | 실측 | 판정 |
|---|---|:-:|
| 금지 규정이 있나 | `lanes.md` §1-4 소유표는 `docs/coverage-100/plan.md` **한 줄만** 「자기 슬라이스 행만」이고 **슬라이스 문서는 항목 자체가 없다**. §1-3 네 규칙은 전부 **PR**에 관한 것이고, §3 「다른 레인의 코드에서 결함을 발견했을 때(고치지 말고 보고)」는 **코드**다 | 금지 없음 ✅ |
| 문서가 스스로 지목했나 | `I-13.md` §12 PR ④ 행 「**§12 마감표를 이 PR 에 얹는다**(README §6-1 ④)」 · README:141 「마감 docs PR 을 따로 내지 않는다 — 그 슬라이스 마지막 구현 PR 에 커밋 하나로 얹거나」 | ✅ |
| §12 에 넣으면 뜻이 바뀌나 | `I-13.md` §12 = **PR 분할**. 절 번호 관행은 실제로 갈린다 — I-12 §12「구현·리뷰가 계획과 달리 한 것」+§12-1「미완 목록」 · I-24 §12「구현 뒤 남은 것」 · I-18 §12「구현 뒤 남은 것」 · **I-5 는 §11 이 마지막** · **I-11 은 §14 가 PR 분할**. ⇒ 「§12=마감」은 규칙이 아니라 다수 관행 | ✅ 새 절이 옳다 |
| 슬라이스 소유 | `lanes.md` §1-1 A2 행 「레인 C 8슬라이스 중 **6(21 오퍼)을 인수**」 + `plan-integration.md:177` I-13 6오퍼 | ✅ |

⇒ **ⓐ(순수 추가) 판정 유지.** 삽입 위치만 Nit-1.

### A 사전통지가 정말 불필요한가 — **불필요가 맞다**

- `lanes.md` §3 이 「하기 전에」를 요구하는 것은 **코어 파일 둘**(`transitions.ts`·`error-codes.ts`)뿐이다. PR ④ 가 만지는 파일 목록(`stock-transfer.service.ts`·`.controller.ts`·`document-progress-query.service.ts`·e2e·docs)에 둘 다 **없다**. ✅
- §3 둘째 항목(마이그 든 PR 병합 직전 보고)도 **마이그 0** 이라 미해당 — 아래에서 별도로 검증했다. ✅
- `manual-permissions.ts`(§1-4 공용 · 단독 커밋 규칙)도 **diff 0줄**이라 안 걸린다. ✅
- ⇒ **사전 통지 0. 초안 §11 ①ⓑ 가 맞다.** 다만 «보고»는 하나 더 필요하다 → Minor-2.

### I-12(적치) · I-14 와의 충돌 · 회귀 범위

| 대상 | 판정 | 근거 |
|---|:-:|---|
| **I-12 적치** | **충돌 0 · 회귀 0** | 코드 0줄 변경 · 문서진행 enum 에 `PUTAWAY_TASK` 없음(계약 파싱) · `putaway-posting.ts` 무변경 · 적치 e2e 는 문서진행을 안 부른다 |
| **I-14 재고 조정** | **파일 충돌 0 · ⚠ 선례 누락** | `src/inventory/adjustment/` 는 겹치는 파일 0. 그러나 **`PUT /inventory/adjustments/{id}/lines` 가 이미 병합돼 있다**(2026-09-08) — 이 오퍼레이션의 **가장 가까운 형제**인데 계획안에 0회 등장(Major-2) |
| `document-progress-query.service.spec.ts` | **통과** | STOCK_TRANSFER 가 그 스위트에 0건(`DOC_ROW` 는 `goods_receipt_*`) ⇒ `typeCode==='STOCK_TRANSFER'` 가드 안을 아무 테스트도 안 탄다. ⚠ 단 건수·유형 서술이 틀렸다(Minor-1) |
| `test/logistics-document-progress.e2e-spec.ts` | **통과** | `grep -c STOCK_TRANSFER` = **0** ✅ 초안대로 |
| `test/logistics-stock-transfer.e2e-spec.ts` 39건 | **통과** | `PERMISSIONS`(`:25` `['M-01-10','W-01-10']`)에 `W-01-13` 추가는 «더하는» 방향이고 이 스위트에 **403/401 단언이 0건**(grep) ⇒ 기존 검사 영향 0 ✅ |
| 스위트 간 `TRUNCATE` 간섭 | **위험 없음(조건부)** | `cleanup()` 이 `TRUNCATE inventory.inventory_transaction … CASCADE`(`:1171-1174`)로 남의 원장까지 비운다(`I-13.md` §13 ⑥ⓓ 가 예고). **`package.json` `test:e2e` 가 `--runInBand`** 라 직렬이면 안전 ✅ — 통합자가 4스위트를 **병렬로** 돌리면 깨진다. 초안 §6-4 「통합자가 병합 직전 한 번」에 «직렬»을 못박는 편이 낫다(Nit) |
| e2e 47 픽스처 실현성 | **가능** | `inventory_transaction` 의 NOT NULL·무기본값 칸 **9개**(`business_date`·`transaction_no`·`transaction_type_code`·`plant_id`·`occurred_at`·`source_document_type_code`·`source_document_id`·`status_code`·`idempotency_key`)를 초안 목록이 **전건 덮는다** ✅ (`created_by` 는 nullable). `@@unique([transaction_no, business_date])`·`@@unique([idempotency_key, business_date])` 도 `PT-20260511-9999`/`2026-05-11` 로 충돌 0 |

### 마이그 0 · 커버리지 · 예산 — **세 계획서와 맞다**

| 축 | 초안 | 내 실측 | 판정 |
|---|---|---|:-:|
| 마이그 | **0건** | 계약 `StockTransferLineUpsert` 8칸 전건이 물리에 실재 · A4 `prisma/migrations/20260908002517_stock_transfer_line_handling_unit` **디렉터리 실재**(`ls -d`) · 이 PR 은 INSERT/UPDATE/DELETE 0 · `plan.md:131`·`plan-integration.md:177` 의 A4 와 정합 | ✅ |
| 커버리지 | 424 → **425** | `@Contract` 실측 — `stock-transfer.controller.ts` 에 **5건**(`:47`·`:53`·`:68`·`:89`·`:103`) · `PUT …/lines` **0건** ⇒ **+1 이 맞다**. 424 자체는 재측정하지 않았다(README §6-1 ①) | ✅ 산술 |
| 마감표 커버리지 | `___ → 425(+6)` | I-13 6오퍼 전건(`plan-integration.md:839-845`) ⇒ 슬라이스 시작 419. 정합 | ✅ |
| 비테스트 | 코드 **≈67** · 문서 포함 **143** | 58+9 = **67** ✅ · 45+1+30 = **76** ✅ · 67+76 = **143** ✅. 예산 350 / 한도 400 대비 여유 | ✅ 산술 |
| 문의 번호 | **162** | `ls docs/design-inquiries/` — 150·151·152·154~161 실재 **11건** · 153 부재 ⇒ 다음 **162** ✅. `lanes.md` §1-1 A2 행 「150~179 (**11 사용**)」과 정확히 일치. 둘째 대역 210~239 는 「첫 대역 잔여 19개로는 모자란다」라 **잔여를 먼저 쓰는 것이 맞다** | ✅ |
| PR 수 | **1개** | 코어 0 · 마이그 0 · 비테스트 67 ⇒ 자를 선 없음 | ✅ |

---

## 4. Findings — **Blocker 0 · Major 3 · Minor 4 · Nit 3**

### ⛔ Major-1 — §4-4 가 «트랜잭션 + FOR UPDATE» 를 버렸는데, C 의 §6-2·형제 둘과 어긋나고 그 근거 문장이 **거짓**이다

**어긋난 자리 셋**
1. C 의 `slices/I-13.md` **§6-2 코드 스케치**: `[tx 안 · runIdempotent 안]` / `1 SELECT status_code, shipped_at, version_no … **FOR UPDATE**`. 이것은 R-4(3:0)로 확정된 절의 본문인데, 초안 §0-0 의 「낡은 넷 / 유효 셋」 어디에도 **이 변경이 없다**.
2. 형제 출고 — `goods-issue-update.service.ts` `lockHeader` 가 `SELECT … FOR UPDATE`.
3. ⭐ 형제 조정(**더 새 것 · 2026-09-08**) — `inventory-adjustment-update.service.ts:67` `$transaction` → `:195-207` `lockHeader(tx,…) FOR UPDATE` → `:205` 404 → `:207` `assertUpdated(0)` 409. **404 → 409 → 400 순서까지 초안과 같은데 잠금만 다르다.**

**근거 문장이 거짓** — §4-4 제목이 「읽기는 «트랜잭션 없이» 한다」인데, `runIdempotent`(`master-write.ts:26-45`) → `idempotency.service.ts:118-142` 는 `work()` 를 **언제나** `this.prisma.$transaction` 안에서 돌린다(그 파일 주석: 「한 오퍼레이션 = 한 트랜잭션 = 한 멱등 기록 … 구조설계 C-5」). 초안 **자신이 §4-4 마지막 줄에 그렇게 적었다** — 같은 절 안의 자기모순이다. 실제로 일어나는 일은 「트랜잭션이 없다」가 아니라 「**읽기가 그 트랜잭션 «밖» 커넥션으로 나간다**」이다(`this.prisma.…findUnique`).

**실패 예(구체)**
`stock_transfer` 하나가 `REGISTERED`·`version_no=1`. 클라이언트 X 가 `If-Match: 1` 로 `PUT …/lines` 를 보낸다.
- ⓐ 서비스가 잠금 없이 `version_no=1`·`shipped_at≠null` 을 읽는다.
- ⓑ 그 사이 세션 Y 의 `POST …:arrive` 가 커밋한다 — `transfer-arrive.service.ts:146` `version_no: { increment: 1 }` ⇒ **2**.
- ⓒ X 는 stale 한 1 로 대조를 통과해 **400 `STATE_LOCKED`** 를 받는다.
- ⛔ **기대(계약·C §6-2·형제 셋)**: 토큰이 이미 낡았으므로 **409 `ConflictResponse{conflictCause:'user'}`**. C 가 「③ 을 ② 뒤에 둔다」를 못박은 이유가 바로 「토큰 오류가 먼저」인데, 잠금을 빼면 그 순서 보장이 **경쟁 구간에서만 조용히 뒤집힌다**. 초안의 변이표 ⑤⑥⑦ 은 «순차» 시나리오만 재므로 **이 변이는 전부 초록**이다.

**요구** — 둘 중 하나를 **명시 판정**으로 적을 것: ⓐ 형제·C §6-2 대로 `$transaction` + `FOR UPDATE` 로 되돌린다(비테스트 +6줄 안팎) ⓑ 그대로 두되 **§0-0 표에 「낡음 5 / 계획과 달리 한 것」으로 올리고**, 제목의 「트랜잭션 없이」를 「멱등 트랜잭션 «밖» 커넥션으로 읽는다」로 고치고, 위 400/409 경쟁을 **의도된 허용 오차**로 문서화한다. ⭐ 통합 관점 권고는 **ⓐ** — 되돌림 비용이 6줄이고, 형제 셋·C 의 승인된 스케치와 어긋난 채 병합되면 다음 치환 슬라이스(I-15·I-16)가 어느 쪽을 베낄지 갈린다.

---

### ⛔ Major-2 — 이 오퍼레이션의 **가장 가까운 형제**(I-14 `PUT /inventory/adjustments/{id}/lines`)가 계획안에 **0회** 나오고, 자리 ④ 의 근거가 그 형제로 반증된다

**실측** — `src/inventory/adjustment/`(2026-09-08 병합 · 레인 C = A2 인수 범위):
`inventory-adjustment.controller.ts:104-121` `@Contract('PUT /inventory/adjustments/{inventoryAdjustmentId}/lines')` · `inventory-adjustment-update.service.ts` **251줄** · **`inventory-adjustment.service.ts` 는 109줄**.
⇒ 초안 §0-1 자리 ④ 의 「형제가 갈린 것은 등록·전기가 **이미 300줄을 넘어서**」는 **가장 새 형제에 안 맞는다** — 109줄에서 갈랐고, 그 파일 헤더는 이유를 「출고 `goods-issue-update.service.ts` 의 **거울상**이다」라 적었다. 저장소의 실제 관행은 **「라인 치환 = `*-update.service.ts`」**다.

초안이 §9 실측 부록(38행)·§4-1·§4-2·§4-4 어디에도 이 파일을 안 썼다. 놓친 것은 배치만이 아니다:
- **`runVersioned` vs `runIdempotent` 의 갈림** — 조정 컨트롤러 주석(`:99-102`)이 「200 에 ETag 를 **내린다** … **출고는 이 자리에 헤더가 미선언이라 안 내렸다 — 베끼면 빠뜨린다**」라 적었다. 이동은 출고 쪽(응답 헤더 0)이라 `runIdempotent` 가 맞지만, **그 판정 근거가 이 주석에 이미 있다**.
- **`assertReplaceable`**(`inventory-adjustment-rules.ts:103-118`) — 「치환 자물쇠」를 규칙 파일로 뺀 최신 형상. 초안의 자물쇠가 그 이름을 안 쓰더라도 대조는 했어야 한다.

**실패 예** — 구현자가 계획안의 「300줄 규칙」을 그대로 믿고 `stock-transfer.service.ts`(261 → 293)에 넣는다. 리뷰어가 「가장 새 형제는 109줄에서도 갈랐다」를 들고 오면 판정 근거가 무너지고, **다음 두 슬라이스(I-15 `PUT /inventory/counts/{id}/lines` · I-16 `PUT …/contents` — 둘 다 A2 인수 대상 #406·#405)** 가 같은 물음을 처음부터 다시 푼다. 저장소에는 「본 서비스 안」과 「`*-update.service.ts`」 두 관행이 남는다.

**요구** — 결론(본 서비스 안 메서드 하나)을 유지해도 좋으나, 근거를 **「32줄 자물쇠는 «치환 본체»가 아니다 — 치환 본체가 서면 그때 `stock-transfer-update.service.ts` 로 뺀다(형제 둘의 형상)」**로 바꾸고, **I-14 형제를 §9 부록에 한 행 추가**할 것. 그리고 §11 ⑦(후속)에 「치환 본체가 서면 파일을 가른다」를 명시.

---

### ⛔ Major-3 — 「열린 PR 0건」이 **거짓**이고, 그 한 줄에 세 자리가 기댄다

초안 §0-1 자리 ⑤ · §3-③ · §9 부록 #34 가 모두 「`gh pr list --state open` → 빈 결과(열린 PR 0건)」를 근거로 「충돌 창 0」을 말한다.

**실측** — `gh pr list --state open` → **#455 `feat/coverage-100-a-i21-5` `[A] feat(quality): 특채 조회 2 (I-21 PR ⑤)`**. `gh pr view 455 --json createdAt` = **2026-09-08T17:14:02Z** ⇒ 초안 측정 시점(2026-09-09)에 **이미 열려 있었다.** 오측정이다.

**실패 예** — 구현자·리뷰어·통합자 중 누구든 부록 #34 를 재현하려 같은 명령을 돌리면 1건이 나온다. README §6-1 ① 이 「이 표의 값은 재측정하지 않는다」를 전제로 부록을 브리프에 그대로 싣게 돼 있으므로, **부록 38행 전체의 신뢰가 이 한 줄에서 흔들린다**(직전 I-34 재수립에서 근거 넷이 틀린 것과 같은 병).

**결론은 유지된다 — 내가 대신 세웠다**: #455 는 `src/quality/concession/*`·`quality.module.ts`·`test/quality-concession.e2e-spec.ts` 만 건드린다. 추가로 `git branch -r` 전건을 `merge-base --is-ancestor` 로 걸러 **main 보다 앞선 브랜치 3개**를 찾았고(`docs/client-local-api-guide`·`feat/coverage-100-a-i19-c`·`feat/coverage-100-a-i20-core`), 셋 다 `document-progress/`·`stock-transfer/` 파일 **0건**이다.

**요구** — 부록 #34 와 자리 ⑤·§3-③ 의 문장을 **「열린 PR 1건(#455) — 파일 겹침 0 · main 보다 앞선 원격 브랜치 3건 — 겹침 0」**로 교체. ⭐ 「열린 PR 0건」이라는 **셈**이 아니라 **「그 PR/브랜치가 이 파일을 건드리나」**가 충돌 창의 진짜 축이다.

---

### Minor-1 — §6-4 회귀표의 수치 둘이 틀림

「`document-progress-query.service.spec.ts` **15건** — **전부 `GOODS_RECEIPT`**」 → 실측 **14건**(`grep -c "it("`), 그리고 전부 GOODS_RECEIPT 가 아니다. 목록 갈래 9건은 `PURCHASE_ORDER`·`INBOUND_RECEIPT`·`GOODS_ISSUE`·`PICKING_ORDER`·`SUBCONTRACT_ISSUE` 를 섞어 쓰고(`:52-181`), `DOC_ROW`(`goods_receipt_*`)를 쓰는 것은 `detail — steps` 5건(`:241-310`)이다.
**결론은 유지** — `STOCK_TRANSFER` 가 그 스위트에 0건이라 새 갈래를 아무도 안 탄다.
**실패 예** — 「전부 GOODS_RECEIPT」를 믿고 「GOODS_RECEIPT 만 안 타면 된다」로 좁혀 읽으면, 실제로는 `tableStub`(`:195-211`)이 `r[k] === v` **등호 비교**라 **어느 유형이든** `{startsWith}` 를 만나면 항상 false 가 된다는 사실을 놓친다. 축을 실수로 9유형 전건에 얹었을 때 어디가 빨개지는지(변이 ⑫)의 근거가 흐려진다.

### Minor-2 — 이슈 점유 라벨 보고가 **#403 하나**로 좁다

`lanes.md` §0-1 은 점유를 **GitHub 이슈 라벨로만** 표시하고 「`status:in-progress` 가 붙은 것은 남이 잡고 있다. 손대지 않는다」를 못박았다.
**실측**(`gh issue list --state open`) — 레인 C 이슈 **8건 전부 `Lane-C`**: #403(I-13 · `status:in-progress`) · #404(I-14 · `status:in-progress`) · #405(I-16) · #406(I-15) · #407(I-17) · #408(I-35) · #409(I-22) · #410(I-23). **A2 인수 6건을 가리키는 `Lane-A` 이슈는 0건**이다(#332·#337·#336·#338·#339 는 A 몫).
초안 §11 ①ⓐ 는 「#403 의 본문·라벨이 낡았다」만 적었다.
**실패 예** — PR ④ 병합 뒤에도 #403 은 `Lane-C`+`status:in-progress` 로 남는다. ⓐ A2 는 남의 레인 이슈를 못 떼므로 슬라이스가 **영원히 열린 채**로 보이고 ⓑ 다음 인수분(I-14 #404 등)은 라벨상 여전히 C 점유라 A2 착수가 §0-1 의 「손대지 않는다」와 정면으로 읽힌다.
**요구** — §11 ① 을 「#403 하나」가 아니라 **「인수 6슬라이스의 이슈 소유·라벨을 A 가 정리한다(#403·#404 의 `status:in-progress` 포함) — 그때까지 A2 의 점유는 라벨에 안 보인다」**로 넓힐 것.

### Minor-3 — 500 파열의 지뢰가 **같은 레인 다음 슬라이스**인데 표의 한 행이다

초안 §11 ⑤ 가 「I-23 이 `shipped_at` 을 안 채우면 이 PR 의 4단계 파열이 실제로 터진다」라 적었다. I-23 은 **#410 · A2 인수 대상**이다.
**실패 예** — I-23 구현자가 `POST /logistics/stock-reinstatements` 에서 `stock_transfer` 를 만들며 `received_at` 만 채우고 `shipped_at` 을 빠뜨린다(계약이 두 칸을 이름으로 안 적었다) → 그 전표에 화면이 `PUT …/lines` 를 부르는 순간 **운영 500**. 초안의 e2e 42 는 이 상황을 「의도된 500」으로 못박아 두었으므로 **회귀 게이트가 잡아주지 않는다.**
**요구** — ⓐ 문의 **162 ⓓ** 에 「`stock_transfer` 를 만드는 모든 오퍼레이션은 `shipped_at` 을 반드시 채운다」를 **규칙 문장**으로 적고 ⓑ 계약 04 의 x-internal-note 「201 에 ETag 를 두지 않는다 — 만들어진 «이동 문서»를 …」를 그 근거로 인용할 것(계약이 재등록의 산출물이 이동 문서임을 문자로 말한 유일한 자리다).

### Minor-4 — e2e 번호 41~49 가 실측 39건과 어긋난다

초안 §6-1 제목은 「9건(지금 **39** → 48)」인데 표의 이름은 **41~49** 다. 실측 `it(` = **39**(`test/logistics-stock-transfer.e2e-spec.ts`). 서수라면 40~48 이다.
**실패 예** — 구현자가 「41번 자리」를 찾다가 없어서 기존 테스트를 세다 시간을 쓰거나, 마감표 §14-3 의 「e2e ___건」에 48 대신 49 를 적는다.

### Nit-1 — §14 를 「§13 뒤」에 넣으면 무번호 `## ⭐ 실측 부록` **앞**에 끼워진다
`I-13.md` 의 마지막 절은 `## ⭐ 실측 부록`(§13 뒤)이다. 「순수 추가」는 지켜지지만, 삽입 위치를 **「§13 인계와 `## ⭐ 실측 부록` 사이」**로 못박아 두는 편이 구현자에게 모호함이 없다.

### Nit-2 — 같은 자리를 두 줄 번호로 적었다
§0-0 낡음 2 는 `putaway-posting.ts:6-13`, §9 부록 #3 은 `:5-17`. 실측 주석 블록은 **5-18**(059 규칙 문장은 7-12)이다. 하나로 통일할 것.

### Nit-3 — `-a2-` 접두 PR 을 A 가 병합하는 것이 §1-3 규칙 2 와 겉으로 충돌한다
`lanes.md` §1-3 규칙 2 는 「`headRefName` 이 네 레인 접두어로 시작하지 않으면 그 PR 은 남의 것이다 — 손대지 않는다」이고, §0-1 은 「A2 는 PR 을 열고 리뷰까지 · **병합은 A**」다. 초안 §7 이 접두어 변경(`-c-` → `-a2-`)만 PR 본문에 적기로 했는데, **§0-1 근거 한 줄**을 함께 적어야 통합자가 규칙 2 로 멈추지 않는다.

---

## 5. 미수행 (⛔ PASS 로 적지 않는다)

| # | 안 한 것 | 이유 |
|:-:|---|---|
| 1 | **커버리지 424/487 재측정** | README §6-1 ① — 부록 값은 재측정 안 한다. 내 네 판정 어느 것도 이 값을 뒤집지 않는다. **대신 +1 의 근거(`@Contract` 5/6 · `PUT …/lines` 0건)는 직접 셌다** |
| 2 | 게이트(`tsc`·`eslint`·단위 전체·e2e) 실행 | 브리프 금지 · `pnpm exec` 금지 |
| 3 | DB SELECT | 초안의 DB 실측 6항(0행 계열)은 **결론에 영향이 없어**(널 갈래 도달 불가는 코드·계약으로 이미 결정) 컨테이너를 건드리지 않았다. `stock_transfer` 0행 주장은 미검증으로 남긴다 |
| 4 | psql 실측 3항(트리거 `BEFORE DELETE OR UPDATE` · DEFAULT 파티션 하나 · CHECK 목록) | 위와 같음. **대신 `schema.prisma` 의 `inventory_transaction` 모델로 e2e 47 픽스처의 NOT NULL 9칸 충족 여부는 직접 검증했다** |
| 5 | 계약의 **응답 선언·400/404/409 순서·ERROR_CODE·If-Match/ETag** 정밀 대조 | **API 관점 몫**(브리프 §4). 통합에 필요한 만큼(응답 헤더 0 ⇒ `runIdempotent` · 404 미선언)만 형제 코드로 교차 확인했다 |
| 6 | 화면 `M-01-10` · `plan-uiux.md` | **UI/UX 관점 몫** |
| 7 | `optimistic-lock.guard.ts:36-60`·`:73-77` 줄 번호 검증 | API 관점 몫. 가드 «순서»(`app.module.ts`)와 409 봉투 사용처만 봤다 |
| 8 | `I-13-pr4-review-api.md` · `-uiux.md` | ⛔ 독립성 — 열지 않았다 |

---

## 6. 한 줄 결론

**통합 관점에서 이 계획안은 방향이 맞다** — C 의 「낡은 판정 넷」은 **4/4 참**이고, 판별자 축은 **남의 슬라이스가 아니며**(열린 PR·원격 브랜치·소유표·enum 전건 재검증), C 문서에 **§14 순수 추가**는 서고, **A 사전통지는 코어 0·마이그 0 으로 정말 불필요**하다. 다만 **Major 셋**을 먼저 닫아야 한다 — ⓐ 버린 `FOR UPDATE`/트랜잭션이 **C 의 승인된 §6-2·형제 셋과 어긋나는데 「계획과 달라진 것」에 없고 근거 문장이 거짓**이며(400↔409 경쟁 관측), ⓑ **가장 가까운 형제 I-14 `PUT …/lines`(2026-09-08 병합)가 계획안에 0회** 나와 자리 ④ 의 근거가 반증되고, ⓒ **「열린 PR 0건」이 오측정**이라 부록 전체의 신뢰가 걸려 있다.
