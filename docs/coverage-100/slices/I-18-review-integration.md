# I-18 3관점 재수립 — **통합 관점** 독립 리뷰

> 대상: `.backend-dev/lane-a2/I-18-draft.md` **499줄 전문**. 브리프: `.backend-dev/lane-a2/brief-I-18-review.md`.
> 관점: 브리프 §3 「통합 관점」 하나. 정본 — `plan-integration.md` §I-18(359~367행) · `plan.md` §1 18행 · §5 규칙 9·12 · `lanes.md` §0-1·§1-4·§2-2.
> 독립성 — `I-18-review-api.md`·`I-18-review-uiux.md` **열지 않았다**. 코드·계약·다른 문서 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · 게이트 0.
> 실측일 2026-09-08 · 워크트리 HEAD **f931561** · `origin/main` **1db490c**(HEAD 보다 10 커밋 앞).

---

## ① 무엇을 직접 읽었나

**정본 문서**
`docs/coverage-100/plan-integration.md:359-367`(§I-18) · `:646`(회신 매핑표 12행) · `:152` ·
`docs/coverage-100/plan.md` §1 **표 18행**(`I-18` · 5건 · 선행 I-1 · 마이그「—」· 코어「—」· sonnet · PR 2 · ∥ I-19) · §5 규칙 **9**(147~160행 · 예외를 «손으로 셌다» — 열 자리) · 규칙 **12** · §7(문의 019 행) · §8 진행표 ·
`docs/coverage-100/lanes.md` **전문 187줄**(§0-1 · §1-3 · §1-4 + 공용 등록부 규칙 4항 · §1-5 · §2 1~5 · §2-1 · §2-2 · §3) ·
`docs/coverage-100/README.md:1-60`(§0 회신 12·13·14 · §1-2 · §2 0~1-1단계) ·
`docs/coverage-100/plan-api.md` **§S08**(220~240행 전건) ·
`docs/coverage-100/slices/I-20.md:40`(R-9) · `:61`(R-20) · `:67`(R-24) · `:91` · **`:175`** · `:216` · `:694` · `:788` · `:825` ·
`docs/coverage-100/slices/I-19.md:1015`·`:1119` ·
**`docs/design-inquiries/재정리-2026-09-08-레인A.md:1-45`** · `docs/design-inquiries/019-IQC_SKIP-승인-화면과-screenId.md` **전문** ·
`docs/server-architecture.md:60-75` · `docs/coverage-100/assignment.tsv`(I-18 5행 전건).

**코드·물리(실재 확인)**
`src/trace/trace.module.ts` **전문 23줄** · `src/trace/lot/lot.controller.ts` **전문 108줄** · `lot-lifecycle-event.controller.ts` **전문 21줄** · `lot-view.ts:95-159` · `lot.service.ts:130-160` · `lot-complete.service.ts:62-72`·`:155-168` · `lot-rules.ts` export 목록 ·
`src/quality/lot-hold/lot-hold-query.service.ts:40-90` · `src/core/lot/lot-registry.service.ts:80-110` ·
`src/core/approval/approval.module.ts`·`index.ts` · `src/core/numbering/numbering.module.ts`·`index.ts` ·
`src/logistics/goods-issue/goods-issue-update.service.ts:40-50`·`:54-90`·`:135-215` ·
`src/common/contract/contract-validator.ts:90-100`·`:200-212` ·
`src/common/permissions/derived-permissions.ts:259` · `manual-permissions.ts:80-90` · `operation-permissions.spec.ts:25-70` ·
`prisma/schema.prisma` — `lot_external_identifier`(3601~) · `lot_status_event`(4634~) · `lot_hold` 인덱스 · `lot`(3518~) ·
`prisma/migrations/20260727000000_baseline_physical_model_v3/migration.sql:1080-1092` ·
`test/trace-lot.e2e-spec.ts`(보류·R-9 단언 부분 · 597줄) · `test/*.e2e-spec.ts` **92파일** 목록.

**읽기 전용 조회**
`git log`(HEAD·origin/main·파일별) · `git merge-base --is-ancestor` · `gh issue list --label Lane-A --state open`.

---

## ② §0 다섯 자리 판정

### 자리 1 — `:request-iqc-skip` 의 자격 판정 축 → **PASS**(조건부: 인용 교체)

통합 관점이 볼 것은 「이 판정이 다른 레인의 자리를 앞지르는가」다. **앞지르지 않는다.**
`source_type_code`·`status_code` 를 **읽기만** 하고 옮기지 않으므로(§5 · §3-1 ⓓ) I-19 의 품질 전이표도, I-20 의 보류 축도, I-21 의 처분도 잠그지 않는다. ⓒ(열린 `INCOMING_INSPECTION_WAIT` 보류)를 배제한 것은 통합적으로도 옳다 — 그 축을 보면 I-19 `:confirm` 의 보류 해제 «타이밍»에 결합되어 **레인 A 의 미병합 코드에 의존하는 판정**이 된다.

⚠ 다만 **0단계 선례 인용이 틀렸다** — findings mi-1.

### 자리 2 — `X-Worker-No` 부재 = 400 `REQUIRED` → **PASS**(공용 문서 반영 «시점»만 조건부)

`plan.md` §5 규칙 9 의 예외를 **손으로 셌다**: `production-results` · `:complete` · `:pick` · `shopfloor-receipts` · `material-consumptions` · `material-returns` · `work-sessions` · `…/{id}/events` · `…/{id}:end` · `precheck-decisions` = **정확히 열 자리**. 초안의 「열 자리 → 열한째」 산술 ✓. 같은 자원의 형제(`lot-complete.service.ts:159-168`)가 「담을 칸 0 · 계약 `required:true` · 부재는 거부」를 그대로 적어 둔 것도 실측 확인 ✓.

조건부 둘 — 공용 문서 반영을 마감 커밋으로 미룬 판단(mi-3) · `assertWorkerNo` 가 사설 함수라 재사용 경로가 예산 밖(mi-8).

### 자리 3 — `PUT …/external-identifiers` 넷 → **PASS**

통합 리스크가 **0**인 자리다. `trace.lot_external_identifier` 를 참조하는 자식 관계가 물리에 0개고(`schema.prisma:3601-3614` 실측 — 관계는 `lot`·`partner` 부모 둘뿐), 이 표를 쓰는 다른 레인이 없다.

ⓑ「부모 `version_no` 를 올린다」의 갈래 근거를 **양쪽 다** 열어 확인했다:
- 올리는 쪽 — `goods-issue-update.service.ts:47-48`「응답에 ETag 가 없다(계약 미선언). 그래도 부모 `version_no` 는 «올린다» — 라인이 바뀌면 부모 상세의 내용이 바뀐다」 + `:139-144` 조건부 UPDATE + `assertUpdated`.
- 안 올리는 쪽 — 같은 파일 `:163-167`「202 에 ETag 가 없어 … 올리면 다음 쓰기가 영원히 409 다」.
- 가름의 축은 「응답 ETag 유무」가 **아니라** 「부모 상세의 내용이 바뀌는가」이고, `lot.service.ts:146` 이 `externalIdentifiers` 를 상세 본문에 싣는 것을 실측 확인 ⇒ 초안의 배치가 맞다.

ⓓ 5칸 표현식 유일 인덱스 — baseline `migration.sql:1082-1089` 에서 **문자 그대로** 확인(`lot_id, identifier_type_code, COALESCE(partner_id,0), COALESCE(external_system_code,''), external_identifier`).

### 자리 4 — `GET …/{lotId}/holds` 가 `trace` 의 `holdView` → **조건부 PASS**

**뷰 선택 자체는 옳다.** 도메인 경계 근거 `server-architecture.md:67`(「⛔ 도메인이 다른 도메인의 service 를 부르지 않는다」)를 그 줄에서 확인했고, 「같은 보류가 두 경로로 나가면 모양이 같아야 한다」는 `lot.service.ts:148` 이 이미 `holdView` 로 상세를 그리는 것으로 성립한다.

**그러나 그 뷰의 «출력»이 레인 A 의 미병합 PR 로 바뀐다** — Major M-1. 뷰 판정은 유지하되 **e2e 단언 형태를 바꾸어야 판정이 완결된다.**

`activeOnly=false` = 「전체」(필터를 안 건다) — `lot-hold-query.service.ts:66-75` 의 R-1 주석과 `whereOf` 구현에서 확인 ✓. 정렬 `held_at desc, lot_hold_id desc` 도 같은 파일 `:45` 에서 확인 ✓, 인덱스 `ix_lot_hold_held_at`·`ix_lot_hold_lot` 둘 다 실재 ✓.

### 자리 5 — PR 2 · 파일 배치 · 레인 A 와 겹치는 파일 → **조건부 PASS**

**ⓐ 전용 컨트롤러 — PASS.** 형제 주석이 실제로 이 슬라이스를 예고한다:
`lot-lifecycle-event.controller.ts:8-9`「경로가 `trace/lots` 와 달라 `LotController` 에 얹지 않는다. 오퍼레이션 하나에 디렉터리를 새로 만들지도 않는다(R-13 · **I-18 이 같은 축을 더한다**)」 — 문장은 정확하고 **줄 번호만 틀렸다**(초안 `:5-6` → 실제 `:8-9`, n-1).

**ⓑ 배치 — PASS.** `lot.service.ts` **293줄** · `lot.controller.ts` **108줄** · `lot-view.ts` **159줄** · 형제 셋 21/57/30/79줄 — **전부 `wc -l` 로 일치**. `LotController` 생성자 의존이 지금 **3**(`LotService`·`LotCompleteService`·`IdempotencyService`)인 것도 확인 ⇒ 3→6 ✓.
⭐ 초안이 안 적은 배선 하나를 확인해 뒀다 — **`ApprovalModule`·`NumberingModule` 은 `@Global` 이 아니다**(둘 다 `@Module` 에 `exports` 만 있다). PR ② 는 두 모듈을 `TraceModule.imports` 에 **반드시** 넣어야 한다. 이는 `lanes.md` §1-4 1(「자기 기능의 import·`@Module`의 imports/controllers/providers/exports 등록만」)이 **허용하는 범위 안**이다 ⇒ 규칙 위반 아님.

**ⓒ 겹치는 파일 셋 — 조건부.** 셋 중 §1-4 가 실제로 다루는 것은 **하나뿐**이다.

| 파일 | §1-4 가 다루나 | 초안의 처리 | 판정 |
|---|:-:|---|:-:|
| `src/trace/trace.module.ts` | ✓ **공용(A·B)** | 등록 줄만(+8 ①, +6 ②) | **PASS** — §1-4 1 그대로. B 의 `SerialNumber*` 등록이 이미 들어 있는 것 실측 확인 |
| `src/trace/lot/lot-view.ts` | ✕ **어느 행에도 없다** | **0줄 — 안 만진다** | PASS(판단은 옳다) · 단 근거가 §1-4 가 아니다 |
| `test/trace-lot.e2e-spec.ts` | ✕ **어느 행에도 없다** | §0 「등록 줄만」 ↔ §7-2·§9 **+13** | **모순**(mi-5) |

⭐ **드러난 규칙 공백** — `lanes.md` §1-4 는 **A·B·C 사이의** 소유를 정한 표다. **A 와 A2 사이에는 파일 소유 규칙이 아예 없다** — §0-1 이 정한 것은 이슈 점유 라벨·브랜치/PR 접두어·문의 대역·병합 주체 넷뿐이다. 초안은 §1-4 를 `lot-view.ts`·e2e 까지 끌어 썼는데, **확장 자체는 실무적으로 옳지만 근거가 §1-4 가 아니다.** 통합자가 이 슬라이스를 계기로 §0-1 에 한 줄(「A2 는 A 가 진행 중인 슬라이스가 만진 파일을 읽기만 한다 — 겹치면 PR 본문에 목록으로 적는다」)을 세우기를 권한다.

**PR 분할 2 · 직렬 제약 · 예산 — PASS.**
`plan-api.md` §S08 「예상 PR 수 2 — ① 조회 GET 3건 ② `:request-iqc-skip`·외부식별자 PUT + e2e」와 **문자 그대로** 같다 ✓. 직렬 판정도 맞다 — ①② 가 `lot.controller.ts`·`trace.module.ts` 를 둘 다 만지므로 배치를 어떻게 바꾸든 직렬이다. 예산은 한도 350 안에서 여유 있다(n-3 의 10줄 어긋남은 판정을 안 바꾼다). ② 만 opus 로 올린 근거(`lanes.md` §3-1 판단 밀도 축)도 선다 — ② 는 승인 코어 호출 + `FOR UPDATE` + 낙관적 잠금 + 판정 축 둘을 한 트랜잭션에 넣는다.

---

## ③ findings

### Blocker — **0건**

### Major — **2건**

---

#### **M-1. I-20 은 「선행 완료」가 아니라 진행 중이고, 그 남은 PR ③ 이 이 슬라이스의 e2e 를 빨갛게 만든다** (자리 4 · §9-1 행 5 · §10 ②)

**초안이 적은 것.** 머리글 「선행 결과물: … **`I-20`**(`src/quality/lot-hold/` · 마이그 `20260908110558` · R-9)」 · §2 「I-20 이 … 를 **이미 더했다**(main 병합 확인)」 · §9-1 행 5 「I-7·I-20 도 사실상 선행이다」.

**실측.**
- `gh issue list --label Lane-A` → **`#331 [A] I-20 … [status:in-progress, Lane-A]`** — 남이 잡고 있다(`lanes.md` §0-1).
- `plan.md` §1 행 16 — I-20 은 PR **~~3~~ 11~12**(I-20 R-17).
- 병합된 것은 **넷**뿐이다 — M-f(`20260908110558`) · M-g(`1eb113c`) · ①c(`4cfa65c`) · ②a(`544a596`). `src/quality/lot-hold/` 에 파일이 **3개(조회 전용)**, 쓰기 서비스 **0개**.
- 남은 것 중 **PR ③(코어)** 이 이 슬라이스에 직접 닿는다 — `docs/coverage-100/slices/I-20.md:175`:
  > ⭐ PR ③(코어)이 `lot-registry.service.ts:96-101` 에 한 줄 더해 **앞으로 태어나는 입하 보류는 채운다**(값이 확정적이다 — `INITIAL_LOT_STATUS='INSPECTION_PENDING'`)
- 지금 상태 확인 — `src/core/lot/lot-registry.service.ts:96-104` 는 `target_lot_status_code` 를 **안 쓴다**. `src/trace/lot/lot-view.ts:127-131` 주석이 「**아직(PR ③ 전)** 그 칸을 안 채워, «오늘 새로 만든» 보류도 포함해 전부 여기 해당한다 … 그 행들이 **키 생략**으로 후퇴한다」.
- 그리고 그 상태를 **기존 회귀가 못 박아 두었다** — `test/trace-lot.e2e-spec.ts:159`:
  ```
  expect(hold).not.toHaveProperty('lotStatusCode'); // 코어가 아직 안 채운다(PR ③ 전) — 널 금지로 키 생략
  ```

**실패 예(구체적 입력 → 잘못된 출력).**
초안 §4-3 이 「이 자리가 「되돌려도 안 깨지는 단언」이 나기 쉬운 곳이다 ⇒ e2e 는 **배열 통째 단언**」이라 못 박았고, §7-2 #11·#12 가 **서버가 등록 때 건 `INCOMING_INSPECTION_WAIT` 보류**를 그대로 쓴다. PR ① 이 이렇게 병합된다:
```
GET /trace/lots/{lotId}/holds
expect(body.items).toEqual([
  { lotHoldId: h, lotId: L, lotNo: 'MLOT-…', itemId: I, reasonCode: 'INCOMING_INSPECTION_WAIT',
    statusCode: 'HELD', heldAt: '…', releasedAt: null, … }   // lotStatusCode 키 없음
]);
```
그 뒤 레인 A 가 **I-20 PR ③** 을 병합하면 같은 요청이 `lotStatusCode: 'INSPECTION_PENDING'` 을 **한 칸 더** 실어 `toEqual` 이 깨진다. 깨지는 파일은 **A2 가 이미 손 뗀 `test/trace-lot.e2e-spec.ts`** 이고, 빨개지는 것은 **A 의 PR** 이다 — `lanes.md` §1-3 4 에 따라 A 는 A2 의 코드를 고치지 못하고 사용자를 통해 되돌아온다.

**처방(둘 다 필요).**
1. §7-2 #11·#12 는 `lotStatusCode` 를 **뺀** 키에 대해 `toMatchObject`/`expect.objectContaining` 으로 잠그고, 그 칸의 값은 **#13(상세 GET 과 `toEqual`) 하나에만** 맡긴다 — #13 은 두 경로가 «같은 `holdView`» 를 쓰므로 PR ③ 전후 모두 초록이고, 그것이 자리 4 를 반증 가능하게 만드는 본래 목적에도 부합한다. (「배열 통째 단언」의 «정렬»과 «건수» 반증력은 `items.map(i => i.lotHoldId)` 를 `toEqual` 하면 그대로 남는다.)
2. §10 ② 를 고친다 — 지금은 「**R-9 를 «뒤집으면»** 여기도 함께 바뀐다」만 적혀 있어, **뒤집지 않고 «채우는»** PR ③ 을 놓쳤다. 「I-20 PR ③ 이 병합되면 `trace-lot.e2e-spec.ts:159` 의 R-9 단언과 I-18 의 보류 단언이 «함께» 바뀐다 — 먼저 병합되는 쪽이 다른 쪽을 재조정한다」로 바꾼다.
3. §9-1 행 5 의 「I-20 도 사실상 선행 · 병합 완료」를 **「I-20 은 진행 중(#331) — 병합된 것은 M-f·M-g·①c·②a 넷이고 PR ③(코어)·④(등록)·⑤(`:release`)가 남았다」**로 정정한다.

---

#### **M-2. PR ② 는 ① 위의 스택인데, 병합을 넘겨받는 A 에게 「자식 PR base 재지정」을 인계하지 않았다** (§9 · §10)

**초안이 적은 것.** §9 표 스택 칸 「① 위」 · §9 마지막 「병합은 **A 에게 넘긴다**(`lanes.md` §0-1) … PR 을 열고 리뷰까지 받는 것이 A2 몫이다」. §10 인계표 6행에 이 절차가 **없다**.

**실측 근거.** `lanes.md` §2 5 가 이 저장소에서 **실제로 난 사고**를 적어 두었다:
> ⛔ `gh pr merge --delete-branch` 를 쓰지 않는다 — 지워진 브랜치를 base 로 둔 **자식 PR 이 재지정되지 않고 CLOSED 된다**(이 저장소에서 실제로 났다 · #153 병합 → #154 닫힘. **닫힌 PR 은 base 변경도 reopen 도 안 돼 새 PR 을 열어야 했다**).

그리고 §2 5-2 가 절차를 세웠다 — `state=MERGED` 확인 → **자식 PR 의 `--base main` 재지정 + `baseRefName` 확인** → 그 다음에 브랜치 삭제.

**실패 예.** A2 가 PR ①(`feat/coverage-100-a2-i18-a`)과 그 위의 PR ②(`…-i18-b`, base = `-i18-a`)를 열어 리뷰를 받는다. 병합 주체는 **다른 세션인 A** 다. A 가 ① 을 병합하고 §2 5-2 를 건너뛴 채 `-i18-a` 브랜치를 지우면 **PR ② 가 CLOSED 된다.** PR ② 는 A2 가 연 것이라 §1-3 4 에 따라 A 는 손대지 못하고, 되살리려면 A2 가 새 PR 을 열어야 한다 — 리뷰 이력이 통째로 날아간다. 이 슬라이스는 **레인 소유자와 병합자가 갈리는 저장소 최초의 스택 PR** 이라 §2 5 가 걸릴 확률이 평소보다 높다.

**처방.** §10 인계표에 행 하나:
> **레인 A(병합 주체)** — PR ② 는 PR ① 을 base 로 한 **자식**이다. ① 병합 뒤 ⓐ `gh pr view <①> --json state` = `MERGED` 확인 → ⓑ `gh pr edit <②> --base main` → ⓒ `gh pr view <②> --json state,baseRefName` 로 열린 상태·`main` 확인 → ⓓ 그 «뒤에» ① 브랜치 삭제(`lanes.md` §2 5-2). ⛔ `--delete-branch` 금지.

그리고 §9 의 「병합은 A 에게 넘긴다」 옆에 그 한 줄을 붙여, PR ① 본문에도 같은 문장을 싣게 한다.

---

### Minor — **10건**

**mi-1. 자리 1 의 0단계 선례 인용이 틀렸다.**
초안 §0 #1 · §8-1 #1 이 `goods-issue-update.service.ts:82-83` 을 「계약이 상태 조건을 안 적은 `:request-approval` 을 «무의미하므로 막는다»」의 선례로 든다. **`:82-90` 은 다른 이야기**다 — 「⛔ 승인 대기 중에는 «라인 편집»을 막는다 … `assertNoOpenRequest`」.
실제 문장은 **`:193-195`** 다:
> ⚠ 계약이 `:request-approval` 에 상태 조건을 «안 적었다» — 전기된 전표의 상신은 무의미하므로 막는다(§2 2단계 기준 2 「거부하는 쪽」 · I-4.md §8-1 ⓖ).
*실패 예*: 구현자·리뷰어가 `:82-83` 을 열면 「승인 진행 중 편집 차단」을 보고 「자리 1 의 근거가 이게 맞나」로 되돌아온다. 선례는 **존재하고 결론을 지지하므로** 판정은 유지하되 줄 번호를 `:193-195` 로 바꾼다.

**mi-2. `lot_status_event` 「17칸」이 틀렸다 — 실측 15칸.**
`schema.prisma` 의 `lot_status_event` 는 스칼라 **15칸** + 관계 3(= 필드 18). 초안 §1-4 머리와 부록 #16 이 「**17칸**」이라 적었다. 초안 자기 §1-4 표와도 안 맞는다 — 계약 11 프로퍼티 중 `lotNo` 는 조인이므로 물리 10 + 「계약에 없는」 5(`location_id`·`quality_status_code`·`inventory_status_code`·`reason_code`·`created_at`) = **15** 로 딱 닫힌다.
*실패 예*: 「채울 수 없는 칸 0」을 재검산하는 리뷰어가 17−10=7 ≠ 5 로 두 칸을 못 찾아 마이그레이션 결론을 의심한다. **결론(마이그 0건)은 바뀌지 않는다** — 표 다섯을 직접 열어 확인했다.

**mi-3. `plan.md` §5 규칙 9 열한째를 「마감 docs 커밋」으로 미룬 판단 — 레인 규칙의 «취지»와 반대다.**
`lanes.md` §1-4 가 공용 파일에 세운 처방은 **「단독 커밋으로 내고 «바로 병합»해 충돌 창을 줄인다」**이고, §1-4 공용 등록부 규칙 2 도 같은 축이다. 마감 커밋으로 미루는 것은 창을 **최대로 벌리는** 선택이다. 레인 A 의 선례도 반대다 — `I-20.md:216`:
> **공용 파일이므로 PR ④(등록) 안에서 «단독 커밋»으로** 낸다(`lanes.md` §1-4 의 `manual-permissions.ts` 규칙과 같은 취급).
초안 자신도 **같은 슬라이스에서** `manual-permissions.ts` 는 「PR ② 안 단독 커밋」으로 처리한다(§6-1·§9) — 두 공용 파일을 다르게 다루는 것이 내부적으로도 어긋난다.
*실패 예*: PR ② 리뷰어가 `plan.md` §5 규칙 9 를 펴면 「헤더가 없어도 400 을 내지 않는다」가 기본이고 예외 열 자리에 `:request-iqc-skip` 이 없다 — 구현이 규칙 위반으로 보여 지적이 한 왕복 돈다. 그 사이 A 가 I-21 에서 `plan.md` 를 만지면 마감 때 충돌이 난다.
*처방*: **PR ② 안에 `plan.md` §5 규칙 9 한 줄만 고치는 단독 커밋**을 넣는다(`manual-permissions.ts` 와 같은 취급). §1-4 의 plan.md 행(「자기 슬라이스 행만」)이 규칙 문단을 다루지 않는 것은 사실이므로, 통합자가 그 행에 한 줄을 보태 주는 것이 더 낫다.

**mi-4. `lanes.md §2-1` 인용이 틀렸다.**
§7-2 가 「병합 직전 `git merge origin/main` 뒤 게이트를 다시 돈다(`lanes.md` **§2-1**)」이라 적었다. 그 절차는 **§2 항목 1** 이다. **§2-1 은 「설계 미정 — 기본값은 「정하고 통보」다」**로 전혀 다른 절이다.
*실패 예*: 구현자가 §2-1 을 열고 병합 절차를 못 찾아 `git merge origin/main` 을 건너뛴다 — 이 슬라이스는 `test/trace-lot.e2e-spec.ts` 를 A 와 나눠 쓰므로 그 한 걸음이 충돌 해소의 전부다.

**mi-5. §0 #5 ⓒ 의 「읽기만 하고 «등록 줄»만 더한다」가 §7-2·§9 와 모순.**
§0 #5 ⓒ 는 겹치는 파일 **셋**(`trace.module.ts`·`lot-view.ts`·`test/trace-lot.e2e-spec.ts`)을 한 문장으로 묶어 「등록 줄만」이라 적는데, §7-2·§9·§10 ② 는 `test/trace-lot.e2e-spec.ts` 에 **+13줄**(① 5 · ② 8)을 넣는다. e2e 에는 「등록 줄」이라는 것이 없다.
*실패 예*: 구현자가 §0 만 읽고 「e2e 는 신 파일에만 쓴다」로 이해해 #9~#21 열세 건을 신 파일로 옮긴다 — 기존 픽스처(입하 사슬 → LOT 등록 → 서버가 거는 보류)를 통째로 복제하게 되어 예산이 100줄 넘게 는다.
*처방*: §0 #5 ⓒ 를 파일별로 가른다 — `trace.module.ts` 등록 줄만 / `lot-view.ts` **0줄** / `test/trace-lot.e2e-spec.ts` **+13**(§7-2 · 병합 직전 재동기화).

**mi-6. §8-3 이 가장 강한 근거를 안 들었다 — 회신 12 재배정은 «이미 저장소 안에 있다».**
`docs/design-inquiries/재정리-2026-09-08-레인A.md:30`(커밋 `b811b76`):
> | **12** | 한도승인 재고 상태 값 | **I-21**(특채) | **통보** | ⭐ I-21 착수 때 §2 절차로 정한다. **코드값이라 `UPDATE` 로 갈아 끼울 수 있다**(비용 낮음) |
즉 초안의 결론은 **맞고, 새롭지도 않다** — 레인 A 가 2026-09-08 에 이미 같은 판정을 내려 두었다. 초안 §9-1 행 8 은 이것을 「**다르다 ⭐**」(초안이 처음 뒤집는 것)로 적어 근거를 스스로 약하게 만들었다.
덤으로 「특채가 첫 사용처」라는 재해석에도 저장소 안 근거가 있다 — `019` 제목이 「**`IQC_SKIP`(한도승인)**」이라 한도승인 = IQC_SKIP 임을 밝히고, `I-19.md:1119` 가 「특채·한도승인은 **상태가 아니라 조건**」이라 둘을 한 축으로 묶는다.
*처방*: §8-3 · §9-1 행 8 · §10 ① 에 `재정리-2026-09-08-레인A.md:30` 을 근거로 달고, 「이 계획안이 뒤집는다」가 아니라 **「A 가 이미 내린 판정을 따르고, 낡은 포인터를 지목한다」**로 성격을 바꾼다.

**mi-7. 회신 12 의 낡은 포인터가 `plan-integration.md` 에 «둘»이다 — 초안은 하나만 지목했다.**
- `:365`(§I-18) 「예상 설계 미정: 회신 12 … 가 여기 붙는다」 ← 초안이 지목한 것
- **`:646`**(회신 매핑표) 「| 12 | 한도승인 재고 상태 값 | **I-18**(IQC 생략) · I-3 | 가장자리 | 「값 정의」라 §0 규칙대로 권고안대로 구현하고 요청서에 적는다 |」 ← **초안이 못 봤다**
*실패 예*: README §1-2 절차대로 통합자가 「통합 계획서 **해당 절**」(= §I-18, 365행)만 고치면 646행은 여전히 회신 12 를 I-18 로 가리킨다. 루틴 끝 전달 때 「I-18 이 회신 12 를 구현했다」는 잘못된 목록이 나가거나, I-21 담당이 646행을 보고 「그건 I-18 이 했다」로 건너뛴다.
*처방*: §9-1 행 8 에 「`plan-integration.md` **:365 와 :646 둘 다**」로 적는다.

**mi-8. `assertWorkerNo` 는 사설 함수다 — 「재사용」이 예산 밖 편집을 하나 만든다.**
`lot-complete.service.ts:164` `function assertWorkerNo(...)` — **`export` 가 없다.** 자리 2 의 「뒤집히면 … `assertWorkerNo` **재사용**(자리 3 참조)이 통째로 없어진다」는 재사용을 전제하는데, §6-1 파일표에 `lot-complete.service.ts` 도 `lot-rules.ts` 도 **없다**(둘 다 「0줄」로도 안 적혔다).
*실패 예*: 구현자가 `import { assertWorkerNo } from './lot-complete.service'` 를 쓰면 `tsc` 가 즉시 빨개진다. 되살리려면 ⓐ 그 파일에 `export` 를 붙이거나 ⓑ `lot-rules.ts`(143줄, 이미 `assertCompletionReason`·`bool` 등 공용 헬퍼의 집)로 올리거나 ⓒ 세 줄을 복제해야 한다.
*처방*: §6-1 표에 한 행 — `src/trace/lot/lot-rules.ts` | 수 | **+8**(②) | `assertWorkerNo` 를 여기로 올리고 `lot-complete.service.ts` 는 import 로 바꾼다(**−5**). 그리고 「자리 3 참조」는 **잘못된 교차 참조**다(자리 3 에 사번 얘기가 없다) — 「자리 2 안에서 닫힌다」로 고친다.

**mi-9. 커버리지 기준선 f931561 이 «리뷰 시점에 이미» 낡았다.**
워크트리 HEAD = **f931561** 이고 `git merge-base --is-ancestor f931561 origin/main` = **YES** — `origin/main` 이 **10 커밋 앞서 있다**(`1db490c` · I-14 PR ②a/② 3커밋 + B I-30 코어 + I-14 마이그 N-1 등). `lanes.md` §1-5 는 「`n/487` 은 **`main` 에서 센 값만** 공식이다」라 못 박았다.
*실패 예*: PR ① 본문에 「382 → 385」로 적고 병합하면, 그 시점 main 은 이미 385+α 라 §8 진행표의 누적이 어긋난다(§8 표는 이미 그런 어긋남을 여러 행에 안고 있다).
*처방*: §11-2 마감표의 「382 → 387」을 **「이 슬라이스가 +5 · 기준선은 PR 을 열기 직전 main 에서 다시 센다」**로 바꾼다(§1-5 「자기 브랜치에서 센 값은 「이 PR 이 +k」를 말할 때만 쓴다」).

**mi-10. `plan-api.md` §S08 의 선행 「S19(보류 등록)」이 §9-1 대조표에서 빠졌다.**
§S08 머리 「선행 슬라이스 | 구현된 `trace/lot` · **S19(보류 등록)**」. S19 = LOT 보류 등록 = **I-20 PR ④**, 미병합(M-1).
기능상 막히지는 **않는다** — 등록 코어가 `INCOMING_INSPECTION_WAIT` 보류를 서버가 걸고(`lot-registry.service.ts:96-104` 실측), 초안 §7-2 #11 도 해제된 보류를 prisma 로 직접 심는다. 그러나 §9-1 은 「통합 계획서 전건 대조표」를 자처하므로 빈칸이다.
*처방*: §9-1 에 행 하나 — 「`plan-api.md` §S08 선행 「S19(보류 등록)」 | **미병합**(I-20 PR ④) | 기능 영향 0 — 등록 코어가 보류를 걸고 e2e 는 픽스처를 직접 심는다 | 같다(정보 추가)」.

### Nit — **6건**

- **n-1.** `lot-lifecycle-event.controller.ts` 예고 주석 인용 `:5-6` → 실제 **`:8-9`**(§0 #5 ⓐ · 부록 #28). 문장은 정확하다.
- **n-2.** `manual-permissions.ts` 증분이 §6-1 「**+3**(②)」 vs §6-2 제목 「**한 줄**」·본문 「**+1줄**」로 갈린다. (주석 2 + 코드 1 이면 +3 이 맞다 — §6-2 를 「코드 1줄 + 근거 주석 2줄」로 적으면 닫힌다.)
- **n-3.** §9 PR ① 비테스트 「~245」 — §6-1 표를 더하면 35+60+25+50+45+32+8 = **255**. 한도 350 안이라 판정은 안 바뀐다.
- **n-4.** §8-2 「문의 022 … 9 상신 도메인 중 8자리가 `null` · **여기가 아홉째다**」 — 선례 주석은 「**9 상신자 중** P/O 만 전표 값을 준다 — 나머지 **여덟**은 공통본 널이다」(`goods-issue-update.service.ts:206-207`)라 적었고, `IQC_SKIP` 은 `approvalTypeCode` **9값 안**이다(`019:14-15`). 「열째」가 아니라 「그 아홉 중 아직 안 채운 자리」다.
- **n-5.** 머리글 「점유 라벨 `status:in-progress` 는 구현 착수 때 붙인다」 — 실측하면 **`#333` 에 이미 붙어 있다**. 문장을 「붙였다」로 갱신한다.
- **n-6.** 부록 #42 의 `contract-validator.ts:96` 은 **초안이 맞다**(`:96-97` 이 「$ref 파라미터는 … `in` 만 본다」 주석). 오히려 **저장소 주석이 낡았다** — `lot.controller.ts:91`·`lot-complete.service.ts:161` 이 `:206-207` 을 가리키는데 그 줄은 ajv 컴파일이다. 이 슬라이스 범위 밖이라 고치지 말고 §10 ⑥ 후속 소형 PR 후보로만 적어 둔다.

---

### 회귀 범위 — 어느 기존 e2e/단위가 깨질 수 있나 (브리프 §3 지정 항목)

| # | 자리 | 위험 | 근거 |
|:-:|---|:-:|---|
| 1 | **e2e 92파일 전부** | ⭐ **높다** | `test/*.e2e-spec.ts` = **92개**. `ApprovalModule`·`NumberingModule` 이 **`@Global` 이 아니어서**(실측) `TraceModule.imports` 에 넣지 않으면 앱 부팅이 죽고 92개가 모두 빨개진다. ⛔ `lanes.md` §1-4 공용 등록부 규칙 **3**(「타입 검사만으로 통과 처리하지 않는다 — 부팅되는 영향 범위의 파일 단위 E2E 를 실행」)이 정확히 이 자리를 겨눈다 |
| 2 | `test/trace-lot.e2e-spec.ts`(597줄) | ⭐ **높다** | 같은 파일 편집(+13) **＋** M-1 의 단언 뒤집힘. 병합 직전 `git merge origin/main` 필수(`lanes.md` §2 ①) |
| 3 | `test/production-production-result.e2e-spec.ts` | 낮다 | `trace/lots` 를 쓰는 **둘째** 파일(grep 실측). I-18 은 라우트만 더하므로 직접 영향 0이나, #1 이 깨지면 함께 죽는다 |
| 4 | `src/common/permissions/operation-permissions.spec.ts` | **없다** ✓ | 셋 다 실측 확인 — ⓐ `expect(declares403).toHaveLength(250)` 은 계약 고정(`a6a87e1`)이라 안 움직인다 ⓑ `expect(covered.length).toBeGreaterThanOrEqual(152)` 는 한 건 늘어도 초록 ⓒ 「수동표가 도출표를 되풀이하지 않는다」(`:27-36`)는 `PUT …/external-identifiers` 가 **도출표에 없어**(grep 0건) 통과. **초안 §6-2 의 판정 그대로다** |
| 5 | `src/quality/lot-hold/*` · `transitions.ts` · `error-codes.ts` | **없다** ✓ | 0줄 — 초안 §5·§6-4 그대로. `src/quality/lot-hold/` 를 import 하지 않는다 |
| 6 | ⚠ **간접 의존** | 감시 | `ApprovalModule` 이 **`DocumentStateModule`**(= `transitions.ts`, **A 소유** · §1-4)을 import 한다. PR ② 부터 `TraceModule` 이 그 사슬을 탄다. A 가 I-21 에서 전이 키를 넓히다 모듈 구성을 깨면 I-18 e2e 도 함께 빨개진다 — **고칠 대상이 아니라 회귀 감시 항목**이고, 걸리면 `lanes.md` §3 대로 사용자에게 한 줄 보고 |

### 마이그레이션 0건 — **PASS**(mi-2 의 칸 수 오기만 정정)

표 다섯을 직접 열어 확인했다. `trace.lot_status_event`(15칸 · 인덱스 `ix_lot_status_event_lot`·`_changed_at` 둘 다 실재) · `trace.lot_external_identifier`(8칸 · **자식 관계 0** · `uq_lot_external_identifier` 5칸 표현식 유일 인덱스 실재) · `trace.lot_hold`(`ix_lot_hold_lot`·`ix_lot_hold_held_at` 실재) · `trace.lot`(`version_no Int @default(1)` 실재 · **`approval_request_id` 없음** — §3-1 ⓓ 와 `plan.md` §5 규칙 12 가 맞물린다) · `app.approval_*`(코어 I-1). **`plan.md` §1 18행 「마이그 —」 · `plan-api.md` §S08 「마이그레이션: 없음」과 일치.**

### 커버리지 382 → 387 — 산술 ✓ · 기준선은 mi-9

`assignment.tsv` I-18 = **5행**(직접 셌다 · 403 표시가 `:request-iqc-skip`·`PUT …/external-identifiers` 둘뿐인 것도 초안 §6-2 와 일치). +5 산술 ✓. 382 자체는 **미검증**(④ 참조).

---

## ④ 미수행 목록

1. **게이트 전부 미수행** — `jest`·`tsc`·`eslint`·`prisma migrate diff` 하나도 돌리지 않았다(브리프 §5 「게이트를 새로 돌리지 마라」 · README §6).
2. **커버리지 `382/487` 미검증** — 세려면 `node_modules/.bin/jest contract-coverage` 를 돌려야 해 1 에 걸린다. 대신 `plan.md` §8 진행표의 최근 기록치(#360 후보 **378/487**)와 그 뒤 병합 흐름으로 **개연성만** 확인했다. ⚠ mi-9 대로 기준선 자체가 이미 낡았다.
3. **DB 관측 미수행** — 부록 머리(「리뷰어는 이 표의 값을 재측정하지 않는다. 단 자기 판정이 그 값을 뒤집는다면 반드시 재측정한다」)에 따랐다. 내 판정 중 부록 51·52(0행 · 코드값)를 뒤집는 것이 없다.
4. **계약 JSON 직접 파싱 미수행** — 브리프 §3 이 그것을 **API 설계 관점**에 배정했다. 내 판정에 걸리는 계약 사실(오퍼레이션 5건 · 403 선언 2건 · 멱등/If-Match 축)은 `assignment.tsv` 와 `plan-api.md` §S08 표로 **교차 확인**했고 둘이 서로 맞았다.
5. **화면 정본 미열람**(`M-01-*`·`W-01-*`·`W-03-01` · `plan-uiux.md` §U6·§U8·§U9) — UI/UX 관점의 몫.
6. **다른 관점 리뷰 파일 미열람** — `I-18-review-api.md`·`I-18-review-uiux.md` 를 열지 않았다(§0 독립성).
7. **`gh pr list` 로 A 의 열린 PR 확인 미수행** — 이슈 라벨(`#331 status:in-progress`)로 점유가 확정돼 더 볼 것이 없었고, `lanes.md` §1-3 3 이 남의 레인 PR 은 읽기만 하라 했다.

---

## ⑤ 한 줄 결론

**통합 관점에서 이 계획안은 통과시킬 만하다** — 다섯 자리 중 **뒤집는 것 0**, 자리 4·5 만 조건부이고, 선행·마이그·PR 분할·회신 12 경계는 실측으로 전부 지지된다. 다만 **「I-20 이 선행으로 끝났다」는 전제가 틀렸고**(진행 중 · #331), 그 남은 **PR ③ 이 이 슬라이스의 보류 e2e 를 나중에 빨갛게 만든다**(M-1). **스택 PR ② 의 base 재지정을 병합자 A 에게 인계하는 한 줄**(M-2)과 함께, 이 둘을 §7-2·§9-1·§10 에 반영한 뒤 구현에 들어가면 된다.
