# I-25 재수립 — 독립 리뷰 **② 통합 관점**

> 대상: `.backend-dev/lane-a2/I-25-draft.md` **592줄 전문**. 브리프: `brief-I-25-review.md` §3 「통합」.
> 정본: `docs/coverage-100/plan-integration.md` §I-25 · `plan.md` §1 14행(48행)·§4·§5 규칙 9·§7 230행·§8 · `lanes.md` §1-1·§1-4·§2·§2-1·§2-2·§3 · `README.md` §2·§6.
> ⛔ 독립성 — `I-25-review-api.md` · `-uiux.md` 를 **열지 않았다**. 수정 0 · DB 쓰기 0 · `git`/`gh` 쓰기 0 · `pnpm exec` 0 · 게이트 재실행 0.
> ⚠ 실측 기준이 초안과 다르다 — 초안은 `docs/coverage-100-a2-i34-close`(HEAD `b9db122`)에서 쟀고, **지금 `main` HEAD 는 `cdf7d69`**(#431 = 그 docs 커밋의 병합)다. 소스·계약·물리는 같다.

---

## ① 무엇을 직접 읽었나 (파일 : 줄)

**계획 정본**
- `docs/coverage-100/plan.md` — **48행**(§1 표 14행 I-25) · **83행**(M2 「전개분은 NULL」) · **109~140행**(§4 마이그 목록 전건) · **158행**(§5 규칙 9 전문) · **191~241행**(§7 문의 후보 표 · **230행**) · **243~270행**(§8 진행표) · 17행(I-21) · 12행(I-11)
- `docs/coverage-100/plan-integration.md` — **158~192행**(§3 슬라이스 표 + 범례 160행 · **189행 I-25**) · **387~392행**(§I-21) · **421~426행**(§I-25) · **534~535행**(M2·M3) · **977~987행**(I-25 오퍼레이션 6건)
- `docs/coverage-100/plan-api.md` — **411~443행**(§S16 전문 · 416·417행 · 표 **429·430·434·437·442·443행**) · **1117행**(채번 표)
- `docs/coverage-100/plan-uiux.md` — **382~391행**(§U26) · **915~922행**(§7-1 갈래 ①②③) · **1128~1140행** · **1190~1215행**(§9-1 D · §9-2 재투입)
- `docs/coverage-100/README.md` — **전문 165행**(§0 12~19 · §1-2 · §2 44~83 · §3 · §5 · §6 **120행** · §6-1 129~142 · §6-2)
- `docs/coverage-100/lanes.md` — **전문 195행**(§0·§0-1 · §1-1 · §1-4 + 공용 등록부 규칙 · §1-5 · §2 · §2-1 · §2-2 · §3 · §4)

**문의**
- `ls docs/design-inquiries/` **132파일** · `grep -E '^1[5-7][0-9]'` = **150·151·152·154·155·156**
- `docs/design-inquiries/052-계보가-시작되는-지점이라-…md` **1~50행**(⭐ **회신 실려 있다**)
- `docs/design-inquiries/151-X-Worker-No-를-담을-칸이-0-…md` **1~25행**

**소스·물리 (초안이 인용한 자리를 직접 열었다)**
- `prisma/schema.prisma` **2795~2825**(`operation_handover_line`) · **2914~2922**(`work_order`) · **3148~3165**(`defect_record`)
- `src/production/production.module.ts` **1~101행**(특히 **68~99행** controllers/providers)
- `src/core/numbering/numbering.service.ts` **9~52행**(`DEFAULT_PREFIX` 전건)
- `src/common/permissions/derived-permissions.ts` **1~20 · 108~115 · 228~240행**
- `src/common/idempotency/idempotency.service.ts` **40~55 · 115~130행**
- `wc -l` — `material-return/*` · `material-consumption/*` · `work-session/*` · `production.module.ts` **전 파일**
- `grep -rn assertWorkerNo src` (비-spec) · `ls src/production/` · `ls src/production/production-result/` · `ls src/quality/` · `ls src/quality/defect/` · `ls test/`(**105항목**)
- `test/permission-gate.e2e-spec.ts` **25~60행** · `src/common/contract/contract-coverage.spec.ts`(단언 4줄) · `src/core/numbering/numbering.service.spec.ts`(`DEFAULT_PREFIX` 단언 **0건**)

**git · gh (읽기 전용)**
- `git log --oneline -3` · `git branch --show-current` · `git show --stat b9db122` · `git log main | grep '#238…#242'`
- `gh issue view 334`(state·labels) · `gh issue view 337 --json body` **전문**

**미수행** — §④ 참조.

---

## ② §0 다섯 판정 (통합 축)

| # | 자리 | 판정 | 한 줄 근거 |
|:-:|---|---|---|
| **1** | 인계 라인 위치 두 칸 | **PASS**(통합 축만) | ⓐ 가 **마이그 0 을 지키는 유일한 후보**이고 세 계획서와 어긋나지 않는다. 물리 두 칸 NOT NULL(`schema.prisma:2810·2811`) · `work_order.default_wip_location_id` nullable(`:2918`) · `plan.md:83` 「전개분은 NULL」 **전건 실측 일치**. ⛔ 계약 문구·화면 요구는 **미수행**(다른 관점) |
| **2** | 계약 밖 칸 넷 | **조건부** | 통합 축에 걸리는 것은 ⓑ 채번 한 자리뿐이다 — `numbering.service.ts` 에 `OPERATION_HANDOVER: 'OH'` 를 더하는데 **레인 A 의 I-21 이 같은 표에 `NC` 를 더한다**(`plan.md:17`). 조율·선보고가 빠졌다 ⇒ **M-4**. ⓐⓒⓓ 는 통합 축 영향 0 |
| **3** | 구간형 `repair_execution` | **미수행(관점 밖)** | 정렬·여집합·409·멱등은 API/UIUX 몫이다. 통합 축에서 볼 것은 「ⓑ 가 뒤집히면 예산이 −20」 하나인데, 뒤집혀도 인계 3 = 365 로 **여전히 350 초과** ⇒ **자리 5 의 결론과 독립**이다(초안이 그렇게 적지 않았으므로 여기 적는다) |
| **4** | 재투입 LOT | ⭐ **뒤집는다 — 결론은 유지, «질의»를 «통보»로 내린다** | ⓐ README §2 1-1 이 질의의 선례로 든 **문의 052 가 이미 회신됐다** — 「LOT 단위 정밀 추적은 1차에 필요 없다」. 초안은 052 를 **한 번도 인용하지 않았다**(**M-1**) ⓑ 초안 스스로 「미루는 자리 **0**」이라 적었는데 README §2 1-1 표·`lanes.md` §2-1 표는 질의를 「**그 자리만 미룬다**」로 정의한다(**M-2**). ⛔ 영구 NULL 이라는 **구현 결론은 옳다**(계약에 쓰기가 0건) |
| **5** | PR 2 → 3 · 배치 · 공용 파일 | **조건부 — 결론 유지 · 근거 셋 수정** | PR **3 은 선다**(인계 3 ≈ 385 가 예산+리뷰마진으로 400 을 깬다 · 쓰기 3 합본은 438). 그러나 ⓐ 「자원 축으로 갈라도 **둘 다** 350 초과」는 과장이다 — 수리 3 = **356**, 6줄 차이이고 400 한도 안이다(**m-1**) ⓑ 「**②③ 은 파일이 겹치지 않아 병렬**」은 **거짓** — 둘 다 `production.module.ts:76-99` providers 를 고친다(**M-3**) ⓒ 공용 파일 실측이 **`numbering.service.ts`(M-4)·#337 `assertWorkerNo`(M-5)** 둘을 놓쳤다 |

### 브리프가 지정한 나머지 통합 항목

| 항목 | 판정 | 근거 |
|---|---|---|
| **마이그 0 이 세 계획서와 일치하나** | ✅ **PASS**(넷 다 확인) | `plan.md:48`(마이그 열 **—**) · `plan.md:109~140` §4 목록에 **I-25 행 0건** · `plan-integration.md:189`(마이그 **✕** — 「있음」은 **표** 열이다, 범례 `:160`) · `plan-api.md:416·417`(쓰는 표 「전부 있음」 · 마이그 **2** 는 **D1·D2 = I-7 몫**) · `plan-uiux.md` 에 `operation_handover`·`repair_execution` 언급 **0** |
| **선행 I-7 이 `main` 에 병합됐나** | ✅ **PASS** | `git log main` 에 `#238`(`a86c1c3`)·`#239`(`e143209`)·`#240`(`8e75863`)·`#241`(`e7fa784`)·`#242`(`b17d160`)·마감 `#243`(`d72b09e`) **전건 실재** · `src/production/production-result/` **실재** · `plan.md` §8 「I-7 ✅ 2026-09-07」 |
| **자리 4 가 I-19·I-21 품질 축을 앞지르나** | ✅ **앞지름 없음** · ⚠ 대조 누락 1 | 스키마 충돌 0 — I-21 마이그 **M-h** 는 `mdm.code_value`·`disposition_decision`·`nonconformance_lot` 셋뿐(`plan.md:109~140`)이고 `defect_record`·`repair_execution` 을 안 건드린다. 단 `plan-integration.md:389` 의 **처분 REWORK → 재작업 W/O** 축을 157 이 언급하지 않는다(**m-3**) |
| **공용 파일과 병합 창** | ⚠ **뒤집는다** — Major 3건 | M-3(`production.module.ts`) · M-4(`numbering.service.ts` ∥ I-21) · M-5(#337 `assertWorkerNo`). `manual-permissions.ts` 0줄 · `error-codes.ts` 0 · `transitions.ts` 0 · `schema.prisma` 0 은 **전건 실측 PASS** |
| **회귀 범위** | ⚠ **절 자체가 없다** | 초안에 회귀 범위 절이 없다. 실측으로 표면 넷을 아래 **m-2** 에 세웠다(셋은 안전, 하나는 브리프에 명시 필요) |
| ⚠ **「§5 규칙 9 에 I-18 항목 미반영」이 맞나** | ✅ **맞다 — 초안이 정확하다** | `plan.md:158` 예외 목록 = **열 자리**, `:request-iqc-skip` **없다**. `docs/design-inquiries/151-….md` 머리글이 「이 통보로 **열한째**가 된다」라 적었는데 I-18 은 이미 병합됐다(`620e680`). 「열둘째~열넷째」 산술도 맞다 |
| **문의 157 을 «질의»로 판정한 것** | ❌ **오판 — 통보로 내린다** | M-1 · M-2 |
| **통보 158~161 · 대역** | ✅ **PASS** | `ls` 실측 150·151·152·**154**·155·156 ⇒ **153 결번 · 다음 157** ✓ · A2 대역 **150~179**(`lanes.md` §1-1) 안 ✓ · `lanes.md` §2-1 의 「머리 표에 구분」 형식 준수 ✓ |
| **커버리지 407 → 413/487** | ✅ **PASS** | `git show b9db122` 커밋 제목 「main **407/487**」 · 그 커밋과 `cdf7d69` 는 **docs 전용** ⇒ 현재도 407 · 407+6=413 ✓ · 「PR 직전 재측정」은 `lanes.md` §1-5·§2-1 과 일치 |

---

## ③ Findings — **Blocker 0 · Major 5 · Minor 5 · Nit 6**

### ⭐ M-1 (Major) — 자리 4 의 질의 판정이 **문의 052 의 «회신»을 안 봤다**

**무엇이 틀렸나.** `README.md` §2 1-1(69~71행)이 질의/통보를 가르는 **선례 두 건을 이름으로** 든다. 그 첫째가 **문의 052 — LOT 계보** 이고, 물었던 이유가 「본질(추적성) + 투입 시점에 안 적으면 **소급 영구 불가**(ⓐ)」다. 초안 자리 4 의 논증은 **글자 그대로 같은 문장**이다(§0 자리 4 · §9-1 #13).

그런데 `docs/design-inquiries/052-….md` 머리에 **회신이 실려 있다**(2026-09-08):

> 「현행 유지. **LOT 단위 정밀 추적은 1차에 필요 없다.**」 ⇒ W/O 단위 계보로 간다 · `lot_relation`·`material_usage_allocation` **0행 유지** · **추가 구현 없음.**

초안은 052 를 **한 번도 인용하지 않았고**, §9-2 말미는 「**1~15번** 회신 대기 중인 것 중 이 슬라이스에 걸리는 것 0건」이라고만 적어 **16번 이후의 «회신이 온» 문의를 아예 보지 않았다**.

**실패 예.** 질의 157 이 `lanes.md` §3 마지막 줄에 따라 사용자를 거쳐 설계팀에 먼저 나간다 → 설계팀이 052 와 **같은 답**(「1차에 LOT 단위 정밀 추적 불필요 · 현행 유지」)을 되돌려 준다 → README §0 이 「회신을 기다리지 않는다」로 규칙을 바꾼 **뒤 처음 나가는 질의**가 **중복 질의**가 된다. 사용자가 설계팀에 쓰는 신용을 이미 답이 있는 물음에 쓴다.

**고칠 것.** 구현 결론(`reintroduced_lot_id` 영구 NULL)은 유지하되 **구분을 «통보»로** 내리고, 본문에 「**052 회신이 이 자리를 덮는가**」를 한 줄로 남긴다. 그래도 「질의」를 고집한다면 **157 본문이 052 회신을 인용하고 «그 답으로는 안 덮이는 이유»를 대야** 한다.

---

### ⭐ M-2 (Major) — 「질의인데 미루는 자리 0」이 절차의 정의를 만족하지 않는다

**무엇이 틀렸나.** 두 정본이 질의를 **미루는 자리로** 정의한다.

- `README.md` §2 1-1 표 57행 — 「⭐ **묻는다**(그리고 **답이 올 때까지 그 자리만 미룬다**)」 · 67행 — 「묻는 것으로 가면 **그 자리만 미루고** 나머지는 진행」
- `lanes.md` §2-1 141행 — 「⭐ **질의** — 그 «자리만» 미루고 나머지는 진행」

초안은 §0 자리 4 에서 「⚠ 「묻는다」로 가도 **미루는 자리가 0**이다 — 6 오퍼레이션 전건을 그대로 구현한다」, §10-1 #1 에서 「회신을 기다리는 것이 아니라 **미루는 자리가 0**」이라 적었다. 즉 **자기 판정이 자기 분류의 정의를 만족하지 않는다**고 스스로 적어 놓았다.

**실패 예.** `lanes.md` §3 마지막 줄 — 「⭐ §2-1 에서 「질의」로 판정했을 때 — **그것만 사용자가 설계팀에 먼저 보낼 수 있다**」. 사용자가 선전달을 판단하는 근거는 「무엇을 멈춰야 하는가」인데, 멈추는 자리가 0인 문서를 선전달로 올리면 사용자는 판단할 것이 없는 결정을 요구받는다. 통보로 내리면 루틴 끝 일괄이고 **구현 변화는 0** — 초안이 §0 자리 4 「뒤집히면」 열에 이미 「구현 변화 0」이라 적었다.

**고칠 것.** **157 을 통보로** 내린다. 그러면 §9-2 가 「질의 1 · 통보 4」에서 「**통보 5**」가 되고, §10-1 #1 의 「루틴 밖」 행과 「사용자 경유 선전달」 문장이 함께 지워진다. `plan.md` §7 230행 이행은 그대로 성립한다(통보도 요청서다).

---

### ⭐ M-3 (Major) — 「②③ 은 파일이 겹치지 않아 병렬」이 **거짓**이다

**실측.** `src/production/production.module.ts`

```
68:  controllers: [ … 6개 … ],
76:  providers: [
77-98:   … 22줄 …
97:    MaterialReturnService,          ← 알파벳 순이 아니다
98:    PrecheckDecisionService,        ← «추가한 순서»로 끝에 붙었다
99:  ],
```

② 는 `OperationHandoverService`(+constants) 를, ③ 은 `RepairExecutionService`·`RepairExecutionReturnService` 를 **같은 배열의 같은 끝자리**에 붙인다. 초안 §8 스폰 순서 문단은 「둘 다 `production.module.ts` 의 **providers 줄만** 더한다」로 스스로 인정하면서, §0 자리 5 는 「**②③ 은 파일이 겹치지 않아** 서로 병렬」로 단정한다 — **한 문서 안에서 두 문장이 어긋난다.**

**선례가 실재한다.** `plan.md` §1 **12행(I-11)** 병렬 열 — 「∥ I-13 · ⚠ **I-10 과 `production.module.ts` 같은 줄**」. 같은 파일 같은 자리에서 이미 한 번 났다.

**실패 예.** ②③ 이 ① 위 스택으로 동시에 열린다 → ① 병합 → `lanes.md` §2-5 대로 둘 다 `--base main` 재지정 → ② 병합 → ③ 이 `git merge origin/main` 에서 providers 배열 끝 줄 충돌. 계획서가 「병렬 · 안 겹친다」라고 적어 두면 구현자가 `lanes.md` §1-4 **공용 등록부 규칙 2·3**(최신 main merge → 충돌 해소 → **게이트 재실행** · 「타입 검사만으로 통과 처리하지 않는다 · 영향 범위 **파일 단위 e2e** 실행」)을 밟지 않는다.

**고칠 것.** 「②③ 는 **소스 디렉터리**가 겹치지 않는다. `production.module.ts` 는 **겹치므로**, 나중에 병합하는 쪽이 `lanes.md` §1-4 공용 등록부 규칙 2·3 을 탄다」로 좁힌다.

---

### ⭐ M-4 (Major) — 채번 `DEFAULT_PREFIX` 를 **레인 A 가 지금 같은 창에서 만진다**

**초안이 적은 것**(§10-2 말미) — 「`numbering.service.ts` 의 `DEFAULT_PREFIX` **+1줄**은 **코어 파일**이지만 추가만이고 **레인 B 가 같은 표에 3줄(`EQI`·`MLF`·`MO`)을 이미 넣은 선례**가 있다 — 같은 줄을 만지지 않으므로 **자동 병합된다**」.

**실측이 뒤집는 것** — `plan.md` §1 **17행(I-21)** 코어 열:

> `transitions.ts` 키 신설 1 · 전이 5(`C17`·`C18`·`C19` 신설) · `document-state.spec.ts`·`document-state.e2e-spec.ts` · **`numbering` `NC` 1줄**

**I-21 은 레인 A 가 «지금» 돌리는 슬라이스**다(#332 · `lanes.md` §0-1 배분 「A: I-20 → **I-21**」). 초안이 든 「레인 B 3줄」은 **이미 병합된 과거**이고, 지금 열려 있는 창은 **레인 A 의 `NC` 한 줄**이다.

**실측 물리** — `DEFAULT_PREFIX` 는 `numbering.service.ts` **9~47행 한 객체 리터럴**이고 마지막 세 항목이 **42·44·46행**(`EQI`·`MLF`·`MO`)으로 **끝에 덧붙는 형태**다. A2 의 `OPERATION_HANDOVER: 'OH'` 와 A 의 `NONCONFORMANCE: 'NC'` 는 **둘 다 46행 뒤 `};` 앞**에 붙는다 ⇒ **같은 자리 충돌.**

**실패 예.** A2 PR ②(인계 확정 · `OH`)와 레인 A 의 I-21 부적합 등록 PR(`NC`)이 겹친 창에 열린다 → 나중 쪽이 `git merge origin/main` 에서 `DEFAULT_PREFIX` 끝 줄 충돌. 해소 자체는 결정적이라 데이터 손상은 없다. **진짜 손실은 절차다** — `lanes.md` §3 첫 줄 「**코어 파일을 건드려야 할 때 — 하기 전에** 사용자에게 한 줄 보고」를 A2 가 밟지 않는다(초안 스스로 이 파일을 「코어 파일」이라 불렀다). 그리고 §10-2 조율 항목이 **1건**으로 남아 A 가 이 창을 모른다.

**고칠 것.** §10-2 를 **조율 항목 2건**으로 늘리고, PR ② 를 **열기 전에** 「A2 가 `DEFAULT_PREFIX` 에 `OH` 한 줄을 더한다 — I-21 의 `NC` 와 같은 자리」를 사용자 경유로 한 줄 보고한다. ⚠ 안전한 사실도 함께 적어 두면 리뷰가 다시 안 본다 — **`numbering.service.spec.ts` 에 `DEFAULT_PREFIX` 개수 단언(`toHaveLength`)이 0건**이라 `transitions.ts` 와 달리 **spec 은 안 깨진다**(실측).

---

### ⭐ M-5 (Major) — **#337 이 `assertWorkerNo` 공용화를 잡고 있는데 초안은 사본을 둘 더 만든다**

**실측** — `gh issue view 337`(**OPEN · `Lane-A`·`status:in-progress`**) 본문 「그 밖」 절:

> 후속 소형 PR 후보 — … **공용화 `worker-no.ts`·`assertWorkerNo` 사본 5+**

**초안이 계획한 것** — §5 걸음 ① 「`assertWorkerNo`(**6번째 사본**)」 · §6 걸음 ① 「`assertWorkerNo`(**7번째 사본**)」. 즉 **사본을 걷어내려는 레인과 사본을 더하는 레인이 같은 창에 있다.** 초안은 **#337 을 한 번도 인용하지 않았다**(브리프도 「레인 A 가 I-21(#332)·부채(#337)를 동시에 돌린다」라 적었다).

실측 사본 자리 — `src/trace/lot/lot-rules.ts:154` · `src/production/work-session/work-session.service.ts:181`(주석이 스스로 「**다섯째 사본**」) · `src/production/material-return/material-return.service.ts:160` · `src/logistics/putaway/putaway-complete.service.ts:239` · `src/logistics/stock-transfer/stock-transfer.service.ts:169`. 초안 실측 부록 #20 「5번째 사본까지 존재」는 **맞다**.

**실패 예.** ⑴ A 가 `worker-no.ts` 로 사본 다섯을 걷어낸 PR 을 먼저 병합 → 그 뒤 A2 의 PR ②③ 이 병합되면 **걷어낸 자리에 새 사본 둘이 되살아난다**. #337 의 완료 조건(「각 항목이 상환되거나 «안 한다» 판정이 남는다」)이 반쯤 무효가 되고 이슈가 다시 열린다. ⑵ 반대 순서면 A2 의 두 사본이 **A 의 리팩터 diff 범위 밖**이라 A 가 놓친다 — 리팩터가 「사본 5」로 끝났는데 실제로는 7이 된다.

**고칠 것.** §10-2 조율 항목 **3건째**로 올린다. 계획을 「**`src/core/…/worker-no.ts` 가 먼저 서면 그것을 import 한다**(사본을 안 만든다)」로 열어 두고, 안 서 있으면 사본을 만들되 **그 사실을 사용자 경유로 A 에게 알린다**(`lanes.md` §3 「다른 레인의 코드에서 결함을 발견했을 때」의 이웃 자리다).

---

### m-1 (Minor) — 「자원 축으로 갈라도 **둘 다** 350 초과」가 한쪽만 참이다

**규칙 실측** — `README.md` **120행**: 「비테스트 diff 예산은 구현 브리프에 **350** — 리뷰 수정분(**+20~30**)이 들어갈 자리를 남겨 400 맞추기 왕복을 없앤다. **한도 400 자체는 그대로다.**」 ⇒ 초안의 규칙 인용은 **정확하다.**

**원본 실측**(`wc -l` · 초안 §8 「줄 추정의 근거」 표와 대조)

| 초안이 든 원본 | 초안 | 실측 | |
|---|--:|--:|:-:|
| `material-return-view.ts` | 50 | **50** | ✓ |
| `material-return-query.service.ts` | 81 | **81** | ✓ |
| `material-return.controller.ts` | 70 | **70** | ✓ |
| `material-consumption-view.ts` | 49 | **49** | ✓ |
| `material-return.service.ts` | 219 | **219** | ✓ |
| `production.module.ts` | 101 | **101** | ✓ |
| `work-session-end.service.ts` | ~90 | **86** | ≈ |
| `work-session-query.service.ts` | 135 | **133** | ✗ |

⇒ **원본 여덟 중 여섯이 정확**하다. 산술도 내부적으로 맞다(① 55+75+40+45+70+28+10 = **323** ✓ · 인계 3 = 55+75+40+175+30+10 ≈ **385** ✓ · 수리 3 ≈ **356** ✓).

**그런데 결론 문장이 과장이다.** 400 한도에 실제로 걸리는 것은 **인계 3 하나**다:

| 갈래 | 비테스트 | +리뷰 마진 20~30 | 400 한도 |
|---|--:|--:|:-:|
| 쓰기 3 합본 | 438 | 458~468 | ❌ **깬다** |
| 자원 축 — **인계 3** | **385** | **405~415** | ❌ **깬다** |
| 자원 축 — **수리 3** | **356** | 376~386 | ✅ **안 깬다** |

수리 3 은 350 예산을 **6줄** 넘을 뿐이고, 그 6줄은 초안 자신의 측정 오차 폭 안이다(`work-session-query` 2줄 · `DEFAULT_PREFIX` 항목 수 4 · 합본 5줄 — n-1·n-2·n-5). 「**둘 다** 350 을 넘어 400 맞추기 왕복이 돌아온다」는 **수리 쪽에서는 성립하지 않는다.**

**다른 자르는 선을 찾아봤다 — 초안의 3분할이 최선이다.** ⑴ ①조회3 + ②쓰기3 = 323 / 438 → 실패 ⑵ ①인계3 + ②수리3 = 385 / 356 → 인계가 400 을 깬다 ⑶ ①인계 조회2(180) + ②인계 쓰기1(220) + ③수리 전건(356) → 3개인데 최대가 **356** ⑷ **초안안** ①조회3(323) + ②인계쓰기(220) + ③수리쓰기(218) → 3개이고 최대가 **323**. ⇒ **⑷ 가 최대값이 가장 작다. 초안의 분할이 옳다.**

**고칠 것.** 결론은 그대로 두고 근거 문장만 「**인계 3(385)이 리뷰 마진까지 얹으면 400 을 깬다** — 자원 축 2분할은 그래서 못 쓴다. 수리 3(356)은 예산을 6줄 넘을 뿐이다」로 좁힌다. 「둘 다」라고 적으면 재수립 뒤 실제 구현이 356 을 밑돌 때 「그럼 2분할이 됐잖아」라는 되물음이 그대로 돌아온다.

---

### m-2 (Minor) — **회귀 범위 절이 없다** (실측으로 넷을 세웠다 · 셋은 안전)

초안에 회귀 범위 절이 없다(§7 은 새 e2e, §7-5 는 변이 점검, §11 은 「코어 전부 0」). 실측한 표면 넷:

| # | 표면 | 판정 | 실측 |
|:-:|---|:-:|---|
| 1 | **`production.module.ts`(:68-99)** — controllers +2 · providers +6 | ⚠ **브리프에 명시 필요** | `lanes.md` §1-4 공용 등록부 규칙 **3** 이 「타입 검사만으로 통과 처리하지 않는다 · **부팅되는 영향 범위의 파일 단위 E2E** 실행」을 요구한다. 그 범위가 `test/production-work-order` · `-production-result` · `-material-consumption` · `-material-return` · `-work-session` · `-precheck-decision` **6파일**이다. 초안이 이 목록을 안 적었다 |
| 2 | `numbering.service.ts` `DEFAULT_PREFIX` +1 | ✅ **안전** | `src/core/numbering/numbering.service.spec.ts` 에 `DEFAULT_PREFIX`·`toHaveLength` 단언 **0건**(grep). `transitions.ts` 와 달리 개수 단언이 없다 |
| 3 | `src/common/contract/contract-coverage.spec.ts` | ✅ **안전** | 단언 넷뿐 — `:16` phantom `toEqual([])`(계약 안 6건이라 무관) · `:27` duplicated · `:39` `expect(implemented).toBeLessThanOrEqual(registry.size)` — **하드 숫자 407 이 없다** ⇒ 413 이 돼도 안 깨진다 |
| 4 | `test/permission-gate.e2e-spec.ts:33-45` | ✅ **안전** | 계약 전체에서 「403 선언 **×** `OPERATION_PERMISSIONS` 미등록」 하나를 골라 탐침을 단다. I-25 의 403 둘은 `derived-permissions.ts:230·235` 에 **이미 등록**돼 있어 후보 집합이 안 바뀐다 |

**고칠 것.** §7 뒤에 「회귀 범위」 한 표를 넣고 위 넷을 그대로 싣는다. 특히 **#1 의 e2e 6파일**은 PR ①·②·③ 각 브리프에 들어가야 한다.

---

### m-3 (Minor) — 157 이 **I-21 처분 REWORK 축**을 언급하지 않는다

`plan-integration.md:389`(§I-21) — 「부적합 → 처분(**REWORK**·SCRAP·NORMAL) → 각각 다른 하류로 갈린다. … **REWORK 은 I-6 의 재작업 W/O 를 부른다**」 · 「도착 상태가 계약에 표로 있다(**재작업→`INSPECTION_PENDING`**)」.

즉 「불량품을 고쳐서 되돌린다」의 **다른 경로가 레인 A 의 I-21 에 이미 서 있다.**

**실패 예.** 157 이 「수리 반출 뒤 재투입 등록처가 없다」만 물으면 설계팀이 「**REWORK 처분으로 재작업 W/O 를 내면 된다**」로 답한다 → I-25 의 물음(`repair_execution.reintroduced_lot_id` 를 채울 «쓰기»가 없다)은 **그대로 남는다.**

**앞지름은 아니다** — 물리·마이그가 갈라져 있다(I-21 의 M-h 는 `mdm.code_value`·`disposition_decision`·`nonconformance_lot` 셋뿐 · `plan.md` §4). **고칠 것**: 157 본문에 「`repair_execution` 왕복(M-02-02)과 I-21 처분 REWORK(재작업 W/O)은 **서로 다른 경로**이고, 재투입은 전자 쪽 물음이다」 한 줄.

---

### m-4 (Minor) — #337 ⓐ 가 `idempotency.service.ts` 를 여는 창

`gh issue view 337` 본문 I-19 ⓐ — 「409 봉투의 `code` 결손 — `IdempotencyService` 지문 불일치 분기가 `code` 없이 던져 …를 못 채운다. **`POST`·`PUT` 둘 다.** ⛔ **공용 파일이라 `app`·`logistics`·`mdm`·`equipment` 4도메인이 함께 바뀌고** `test/app-notification.e2e-spec.ts:749·766` 이 깨진다」.

I-25 의 쓰기 **3건 전부**가 `runIdempotent(…, FAMILY_CONFLICT_CODE)` 를 타고 e2e **A15·B15** 가 `code='DUPLICATE_KEY'` 를 단언한다(실측 `idempotency.service.ts:45-48` 에 `FAMILY_CONFLICT_CODE = {duplicate:'DUPLICATE_KEY', inProgress:'INVALID_STATE'}` 실재 ✓ — 초안 인용 정확).

A2 가 코드를 **명시로 넘기는** 쪽이라 대개 무해하지만, A 가 ⓐ 를 상환하면 그 분기의 봉투가 바뀐다. ⇒ 회귀 범위 표에 한 줄.

---

### m-5 (Minor) — 「남은 **슬라이스** 중 `production.module.ts` 를 만지는 레인 없음」이 **부채 레인을 안 셌다**

초안 §0 자리 5 · §10-2 말미의 판정은 **슬라이스 축에서는 참**이다(실측: A = `trace.lot_hold`·`quality/` · B = `maintenance/`·`trace/serial`·`app/` · C = `logistics/`·`inventory/` — `src/production/` 밖).

그러나 **#337 은 슬라이스가 아니라 부채이고 `src/production/` 을 실제로 만진다** — 본문에 「**I-7 §11-2 미완**」(= `src/production/production-result/`) · 「R-7 잠금 중복 합치기」 · `assertWorkerNo` 사본(= `work-session/`·`material-return/`)이 들어 있다. **고칠 것**: 문장을 「남은 슬라이스 **+ #337 부채**」로 넓히고, `production.module.ts` 자체는 여전히 A2 단독이라는 결론을 유지한다(부채 항목 중 providers 를 고치는 것은 없다).

---

### Nit 여섯 (전부 실측 오기 — 판정은 안 바뀐다)

| | 초안 | 실측 |
|:-:|---|---|
| **n-1** | `work-session-query.service.ts` **135** (§8 추정 근거표) | **133** |
| **n-2** | 실측 부록 #16 — `DEFAULT_PREFIX` 「**15개** 등재 · `numbering.service.ts:11-47`」 | 항목 **19개** · 리터럴 **9~47행**(항목은 10~46행) |
| **n-3** | §5 「물리는 nullable 이다(실측 `schema.prisma:3153`)」 — `defect_record.work_order_id` | **3153 은 `inspection_result_id`**, `work_order_id` 는 **3154**. 실질(둘 다 nullable)은 맞다 |
| **n-4** | §8-1 「`production-result*.ts` **5파일**이 서 있다」 | `ls` 실측 **12파일**(비-spec **7**) |
| **n-5** | §0 자리 5 「쓰기 3 을 한 PR 에 담으면 ≈ **433**」 | 자기 표의 220+218 = **438** |
| **n-6** | `plan-integration.md:189` 의 PR 열도 **2** 인데 §10-1 #4 는 `plan.md:48` 만 고친다 | **고치지 않아도 된다** — 최근 슬라이스가 그 열을 갱신하지 않는 것이 관행이다(I-19 = plan.md **7** ↔ integration **4** · I-20 = **11~12** ↔ **3**). 단 「일부러 안 고친다」를 한 줄 적어라 |

**⭐ 초안이 정확했던 인용**(직접 열어 확인 · 재수립이 다시 안 봐도 된다) — `schema.prisma:2810·2811`(위치 두 칸 NOT NULL) · `:2918`(`default_wip_location_id` nullable) · `plan.md:83`(전개분 NULL) · `plan.md:48`(I-25 행 전건) · `plan.md:158`(규칙 9 열 자리) · `plan.md:230`(§7 재투입 소유) · `plan-integration.md:189·421~426` · `plan-api.md:416·417·437·442·443·1117` · `plan-uiux.md:382~391·920·1131·1134·1195·1210` · `derived-permissions.ts:112·230·235·236` · `idempotency.service.ts:45-48` · `work-session.service.ts:181`(다섯째 사본) · `README.md:120`(예산 350/400) · 문의 대역 실측(153 결번 · 다음 157) · 커버리지 407 · 이슈 #334 라벨.

---

## ④ 미수행 (수행하지 않은 것을 PASS 로 적지 않는다)

1. **계약 `contracts/production-02생산실행.json` 을 파싱하지 않았다** — §1-1~§1-6 의 실측표(질의 축·본문·required·`x-internal-note` 원문·`x-no-code-key` 문구·409 enum)는 **API 관점의 몫**이라 검증하지 않았다. 통합 판정은 계약 원문이 아니라 **세 계획서·물리·소스·이슈**에만 기댔다.
2. **화면 정본(M-02-01·M-02-02 §5-4·§8-3·§9-2)은 저장소 밖**이라 열지 못했다 — UI/UX 관점의 몫.
3. **자리 3 ⓐⓑⓒⓓ 를 판정하지 않았다**(정렬 축·여집합·409·`:return` 멱등) — 관점 밖. 통합 축 영향만 적었다(예산 −20 이어도 자리 5 불변).
4. **e2e 33건의 「반증 방법」을 한 건씩 검증하지 않았다** — 브리프 §2 의 ⓐⓑⓒ 방어 검증은 세 관점 공통이나, 통합 관점에서는 **DB 직접 단언(A9)이 응답 밖 네 칸의 유일한 그물**이라는 구조만 확인했다. 개별 변이의 RED 여부는 **미수행**.
5. **게이트를 돌리지 않았다**(README §6). 커버리지 407 은 `b9db122` 커밋 메시지의 값을 인용했고 **재측정하지 않았다** — 다만 그 뒤 `main` 에 들어온 커밋(`cdf7d69`)이 **docs 전용**임은 `git show --stat` 으로 확인했다.
6. **DB 를 관측하지 않았다**(`psql` 0회) — 초안 실측 부록 #4~#8(마이그 64건 · 세 표 0행 · 인덱스 · CHECK 8건)은 README §6-1 #1 의 「재측정하지 않는다」 대상이고, **내 네 판정이 그 값을 뒤집지 않았다**.
7. **`I-25-review-api.md`·`-uiux.md` 를 열지 않았다.**

---

## ⑤ 한 줄 결론

**PR 3 분할·마이그 0·선행 I-7·문의 대역·커버리지 산술·「규칙 9 미반영」은 실측으로 전건 PASS 이고, 뒤집히는 것은 둘이다 — ⓐ 재투입 LOT 을 «질의»로 올린 것(회신이 이미 온 문의 052 를 안 봤고, 「미루는 자리 0」이 질의의 정의를 만족하지 않는다 ⇒ 통보 157 로 내린다) ⓑ 「②③ 이 파일이 안 겹쳐 병렬」과 「공용 파일 실측」(`production.module.ts` providers · 레인 A I-21 의 `numbering` `NC` · #337 의 `assertWorkerNo` 공용화 — 조율 항목을 1건에서 3건으로 늘려야 한다).**
