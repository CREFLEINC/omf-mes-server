# 레인 B 업무 지시서 — 설비 · 보전 · 발행 · 알림 (슬라이스 **7** · **52건**)

> 읽는 사람: **이 프로젝트를 처음 맡는 새 세션.** 커버리지 100 루틴을 모른다고 전제하고 썼다.
> 순서대로 읽고 그대로 하면 된다. 모르는 규칙이 나오면 지어내지 말고 여기 적힌 정본을 찾아 읽는다.

---

## 1. 무엇을 하는 일인가

`omf-mes-server` 는 베트남 하노이 공장의 MES 백엔드다(NestJS 11 + Prisma 6 + PostgreSQL 16).
**설계팀이 확정한 OpenAPI 계약 487 오퍼레이션**이 `contracts/*.json` 에 있고, 서버는 그것을 하나씩 구현한다.
「커버리지」란 **계약 오퍼레이션 중 실제 핸들러가 붙은 것의 수**다 — 컨트롤러 메서드에 `@Contract('GET /planning/production-plans')` 데코레이터를 달면 1건으로 센다.

- 2026-09-07 현재 **342/487**. 목표는 483/487(건너뛰기로 합의된 4건 제외).
- 이 루틴을 **세 세션이 병렬로** 돈다. **너는 레인 B** 다. 공유 규칙은 `docs/coverage-100/lanes.md`.
- 범위는 **DB 안에서 끝나는 것만**. 실제 외부 전송·프린터 출력·바이너리 저장은 하지 않는다(아웃박스 테이블에 쌓는 데까지, 발행 이력은 기록만 — 이건 범위 안이다).

## 2. 네 담당 — 슬라이스 **7개** · **52건**

레인 안에서 **화살표 순서를 지킨다**(선행이 병합돼야 다음을 시작한다). `∥` 는 동시에 해도 된다.

| 순 | 슬라이스 | 건 | 선행 | 마이그레이션 | 모델 | 예상 PR |
|---:|---|--:|---|---|---|--:|
| 1 | **I-30** 설비 점검·고장 | 9 | 없음(바로 시작) | A15 — `maintenance.breakdown` 3칸 | sonnet | 3 |
| 2 | **I-32** 비가동 | 6 | I-11(끝남) — **1과 동시 가능** | V — `equipment_downtime.version_no` | sonnet | 2 |
| 3 | **I-31** 보전 지시·실적 | 8 | I-30 | **A16~A19 · V** — 오더 5칸 · 실적 9칸 · **신설 표 2**(`maintenance_result_line`·`maintenance_result_part`) | opus(이 레인 최대 마이그) | 3 |
| 4 | **I-33** 툴 사용·계측기·수집 채널 | 12 | I-31 | **A20~A22 · M-g · V · T** — 칸 4·5·8 · 부분 유일 인덱스 · **신설 표**(`collection_channel_observation`) | sonnet | 3 |
| 5 | **I-26** 제품 개체 발번 | 2 | I-7(끝남) — 언제든 | 없음 | sonnet | 1 |
| 6 | **I-27** 발행 이력·프린터 | 7 | I-26 | A9·A10 — 인쇄 결과 3칸 · 프린터 5칸 | sonnet | 2 |
| 7 | **I-28** 알림 | 8 | I-1(끝남) — 언제든 · **6과 동시 가능** | A7·A8 — `zalo_enabled` · **신설 표** `notification_subscription_recipient` | sonnet | 2 |

**권장 순서**: I-30 ∥ I-28 → I-32 ∥ I-26 → I-31 → I-27 → I-33.
계약 파일은 주로 `contracts/equipment-05설비툴.json` 과 `contracts/app-공통.json` 이다.
배정의 정본은 **`docs/coverage-100/assignment.tsv`** 다 — 슬라이스별 오퍼레이션이 한 줄씩 있으니 시작 전에 자기 슬라이스를 `awk -F'\t' '$1=="I-30"' docs/coverage-100/assignment.tsv` 로 뽑아 **건수를 대조**한다.

⛔ **`POST /maintenance/breakdowns/{breakdownId}/attachments` 는 네 것이 아니다.** 배정은 I-34 이고, 더구나 **`plan.md` §6 의 「건너뜀」**으로 확정돼 **아무도 구현하지 않는다**(바이너리 저장소가 DB 밖 + `CD-ATTACHMENT-TARGET-TYPE` 에 고장 값이 없어 설계 문의 대상). 계획안에 「고장 첨부는 I-34 건너뜀분이라 이 슬라이스가 만들지 않는다」 한 줄만 남긴다.

⚠ 이 레인은 **마이그레이션이 가장 많다**(신설 표 4개 포함). 마이그는 `README.md` 와 `CLAUDE.md` 규칙을 그대로 따른다 — **추가·완화만, 삭제 0, forward-only, 별도 선행 커밋**.

## 3. 환경 구성 (한 번만)

```bash
# 1) 저장소
git clone git@github.com:CREFLEINC/omf-mes-server.git
cd omf-mes-server
corepack enable && pnpm install          # Node ≥ 20, pnpm 11.17.0

# 2) 설계 화면 사본(3관점 재검토의 uiux 관점이 읽는다 — 필수)
#    ⭐ bootstrap 은 «받아 오지 않는다» — 로컬 상태를 기록할 뿐이다. 사본이 없으면 「없어서 회차를 못 봤다」고
#       한 줄 흘리고 그냥 끝난다(bootstrap.mjs:85). --sync-design 도 클론은 안 하고 명령만 알려 준다(:111).
#       그러니 새 PC 에서는 클론이 «먼저»다.
git clone git@github.com:CREFLEINC/omf-mes.git .design-reference/omf-mes
pnpm workflow:bootstrap                  # 설계 고정 커밋·변경 회차를 .workflow-state 에 기록한다

# 3) PostgreSQL 16 을 로컬에 띄운다(도커든 네이티브든 상관없다)
#    DB 이름은 아무거나 — 네 PC 안에서만 쓴다

# 4) .env — .env.example 을 복사해 채운다
cp .env.example .env
#    DATABASE_URL 을 네 로컬 DB 로
#    JWT_SECRET 은 32자 이상: openssl rand -base64 48

# 5) 스키마·시드 (⭐ 시드는 이 «최초 1회»만 허용된다. 이후 절대 금지)
set -a; . ./.env; set +a
node_modules/.bin/prisma migrate deploy
node_modules/.bin/prisma generate
pnpm db:seed

# 6) 시운전 — 여기서 전부 초록이어야 시작할 수 있다
set -o pipefail                          # ⭐ 없으면 grep 이 매치되는 한 jest 실패가 종료코드 0 으로 가려진다
node_modules/.bin/eslint "{src,test}/**/*.ts"
node_modules/.bin/tsc --noEmit -p tsconfig.all.json
node_modules/.bin/jest 2>&1 | grep -E "Tests:|커버리지"
FORCE_COLOR=0 node_modules/.bin/jest --config test/jest-e2e.json --no-colors --runInBand test/production-work-order.e2e-spec.ts 2>&1 | grep -E "Tests:|FAIL"
```

시운전에서 **「계약 구현 커버리지: 342/487」** 과 단위 758 passed 가 나오면 정상이다.
⛔ 6번의 e2e 전체(`pnpm test:e2e`)는 돌리지 마라 — 시간이 오래 걸리고 간헐 실패 추적 중이다. 항상 **파일을 지정해서** 돌린다.

## 4. 반드시 읽을 정본 (이 순서로)

| # | 문서 | 무엇 |
|:-:|---|---|
| 1 | **`docs/coverage-100/README.md`** | ⭐ **루틴 규칙 정본.** §0 범위 · §1 작업 방식 · **§2 설계 미정 갈림길 판정 절차** · §3 멈춤 조건 · §4 모델 배분 · §5 제약 · §6·§6-1 속도 규칙 |
| 2 | **`docs/coverage-100/lanes.md`** | 3레인 공유 규칙(문의 번호 대역 · 마이그 이름 · 소유 파일 · 병합 절차) |
| 3 | `CLAUDE.md` | 저장소 규칙(PR 크기 · 주석 · 마이그 · 도메인 규칙) |
| 4 | `docs/coverage-100/plan.md` | 통합 계획서 — §1 슬라이스 표 · §2 마일스톤 · §4 마이그 목록 · §5 공통 규칙 |
| 5 | `docs/coverage-100/plan-api.md` · `plan-uiux.md` · `plan-integration.md` | 3관점 계획서. 자기 슬라이스 절을 찾아 읽는다 |
| 6 | **`docs/coverage-100/slices/I-24.md`** | ⭐ **개별 계획안의 본보기.** 형식·깊이를 이대로 맞춘다. 특히 맨 위 **§0-재수립 R-n 표**와 맨 아래 **§12 마감표** |
| 7 | `docs/server-architecture.md` | 코어 6건·모듈 배치. 도메인 구현 전 필독 |

## 5. 슬라이스 한 바퀴 (이 절차를 슬라이스마다 반복한다)

### ⑴ 개별 계획안
`docs/coverage-100/slices/I-30.md` 를 쓴다. **`I-24.md` 형식 그대로**. 담을 것:
계약 오퍼레이션 전건 읽기 표(질의 칸·응답 칸·에러 코드) · 물리 모델 대조와 **마이그레이션 SQL 전문** · 핵심 오퍼레이션의 트랜잭션 순서 · 상태기계 · 모듈 배치 · **e2e 테스트 이름 목록** · **설계 미정 자리 전건 판정**(§2 절차로) · **PR 분할안** · 통합 계획서와 다른 자리.
⭐ **조각별 줄 수는 «예상치」가 아니라 비슷한 기존 파일의 실측으로 잡는다**(레인 A 가 예상치로 잡았다가 PR 이 두 배로 나와 갈랐다).
계획안은 opus 서브에이전트에게 맡긴다(`README.md` §4).

### ⑵ 3관점 재수립 — **기본값이다**
계획안이 나오면 **api · uiux · integration** 세 관점 리뷰어(opus)를 **병렬로** 띄워 재검토시킨다. 산출물은 `slices/I-30-review-{api,uiux,integration}.md`(각 130줄 이내).
- 계획안 §0 에는 「리뷰가 반드시 볼 자리 5개」를 적고, 그게 곧 리뷰 브리프의 판정 항목이 된다.
- ⭐ **리뷰어에게 재측정을 시키지 마라.** 계획자가 실측 부록(사실 + `파일:줄`)을 붙이고, 브리프에 「이 표의 값은 재측정하지 않는다. 단 네 판정이 그 값을 뒤집는다면 반드시 재측정한다」를 명시한다. 리뷰어의 몫은 **계획자가 «보지 않은» 자리**다.
- 리뷰 셋을 네가 통합해 계획안 맨 위에 **§0-재수립 R-1~R-n 표**를 채운다. 이후 본문과 어긋나면 **R-n 이 이긴다**.

### ⑶ 계획 PR
계획안 + 리뷰 3 + `plan.md` 정정을 한 PR 로. **문서만이면 리뷰 없이 바로 병합**한다.

### ⑷ 구현 PR
- 비테스트 diff **≤ 400줄**(`git diff -w --numstat origin/main...HEAD -- src prisma | grep -v spec.ts` 합). 브리프 예산은 350 으로 잡아 리뷰 수정분 자리를 남긴다. 코어 파일을 고치는 PR 은 **≤ 200**.
- **마이그레이션은 별도 선행 커밋.** 마이그 SQL 앞에 사전 대조 SELECT 를 주석으로 적고 **실제로 돌려** 결과를 PR 본문에 넣는다.
- 구현자는 새 컨텍스트의 서브에이전트. **조회·CRUD 복제는 sonnet, 코어·마이그·심장은 opus**.
- 조회 PR 은 3관점 리뷰가 도는 동안 **나란히 시작해도 된다**(뒤집히는 판정이 거의 안 닿는다). ⛔ 마이그·코어·심장 PR 은 R-n 확정 뒤에만.

### ⑸ 리뷰 — **크레플 `pr-review` 스킬을 쓴다**

리뷰는 사내 표준 스킬 **`crefle-agent-skills` 의 `pr-review`** 정책을 따른다. 세션에 그 플러그인이 있으면 **`/pr-review <PR번호>`** 로 부르고, 없으면 아래 요약대로 한다(정책 내용은 같다).

**스킬이 정한 것 — 그대로 지킨다**

| | |
|---|---|
| 리뷰 원칙 | 근거 우선(모든 지적에 `파일:줄` + 왜 + 어떻게) · 심각도로 말한다 · 변경 범위(diff) 안에서 · 코드에 대해 말하고 사람에 대해 말하지 않는다 · **불확실하면 머지하지 말고 올린다** |
| 점검 영역 **넷을 순서대로** | ① 버그/정확성 ② 보안 ③ 테스트 ④ 컨벤션/가독성. ④ 는 `coding-rules` 스킬의 TypeScript·커밋 규칙을 **실제로 열어 대조**한다 |
| 심각도 4단계 | 🔴 **Blocker**(사고·데이터 손상·보안·빌드 깨짐 → 머지 불가) · 🟠 **Major**(엣지 오동작·핵심 로직 무테스트·잘못된 예외 처리 → 머지 불가) · 🟡 **Minor**(가독성·중복 → 막지 않음) · ⚪ **Nit**. **애매하면 한 단계 높게** |
| 승인 기준 | **Blocker 0 AND Major 0** |
| 자동 머지 안전 조건 | 승인 기준 + CI 통과 + 충돌 없음 + base 가 의도한 대상 + Draft 아님. **하나라도 확신할 수 없으면 머지하지 않는다** |
| 시크릿이 diff 에 있으면 | **무조건 Blocker**, 즉시 알린다 |
| 가드레일 | diff 를 실제로 읽지 않고 「이상 없음」으로 통과시키지 않는다 · 머지했으면 결과(머지 커밋·삭제된 브랜치)를 명확히 보고한다 |

**이 저장소·이 루틴에서 스킬과 «다르게» 하는 것 — 이쪽이 이긴다**

1. **머지 방식은 `--merge`(머지 커밋)** 다. 스킬 기본값인 squash 를 쓰지 않는다 — 저장소 정책이 우선한다고 스킬 자신이 적어 뒀다.
2. **`gh pr comment` 를 쓰지 않는다.** 리뷰 결과는 **파일**로 남긴다(예: `tmp/review-<번호>.md`). 이 환경에서 코멘트가 차단돼 있다.
3. **리뷰어 ≠ 구현자.** 리뷰는 **구현자와 다른 새 컨텍스트의 opus 서브에이전트**에게 맡긴다.
4. **「CI 통과」를 GitHub 로 판정하지 않는다.** GitHub Actions 가 **전부 비활성**이라 `mergeStateStatus: CLEAN` 은 검증을 뜻하지 않는다 — **로컬 게이트가 유일한 근거**다.
5. **게이트를 두 번 돌리지 않는다.** 구현자가 PR 본문에 실측(명령·숫자)을 적고, 리뷰어는 **단위 전체 + 그 PR 이 바꾼 e2e 파일만** 돈다. 회귀 e2e(다른 파일)는 **네가 병합 직전 한 번**.
6. 리뷰어에게 **계획 정본**(`slices/I-nn.md` 의 §0-재수립 R-n + 본문 해당 절)을 함께 주고 「계획과 어긋난 자리」도 판정하게 한다. 이 루틴에서 Major 는 대부분 그 대조에서 나온다.

### ⑹ 병합 — **네가 연 PR 만**

- 승인 기준(Blocker 0 · Major 0)을 만족하고 충돌이 없으면 **네가 바로 병합**한다: `gh pr merge <N> --merge`.
- ⭐ **바꾸는 `gh` 명령 전에 소유를 확인한다** — 세 레인이 같은 git 계정이라 화면으로 구별되지 않는다:
  ```bash
  gh pr view <N> --json number,headRefName,title --jq '"\(.number) \(.headRefName) \(.title)"'
  ```
  `headRefName` 이 네 레인 접두어(`…-b-` / `…-c-`)로 시작하지 않으면 **남의 PR 이다. 손대지 않는다.** 상세는 `lanes.md` §1-3.
- Major 를 고칠 때는 **구현자에게 되돌리거나 네가 직접** 고친다(작으면 직접이 빠르다). 고친 뒤 **바뀐 e2e 파일을 다시 돌린다**.
- 병합 **성공을 확인한 «뒤에»** 브랜치를 따로 지운다 — ⛔ `gh pr merge --delete-branch` 는 쓰지 않는다(`lanes.md` §2-5).

### ⑺ 슬라이스 마감
계획안 맨 아래에 **§12 마감표**(PR 목록 · 커버리지 · 마이그 · 리뷰가 잡은 것 · 미완 목록 · **계획서가 틀렸던 자리**)를 쓴다. **별도 마감 PR 을 내지 말고 마지막 구현 PR 에 얹는다.**

## 6. 게이트 명령 (복붙)

```bash
set -a; . ./.env; set +a
set -o pipefail                              # ⭐ 필수 — 아래 파이프가 jest 실패를 0 으로 덮는다
node_modules/.bin/prisma migrate deploy      # 남의 레인 마이그가 딸려 왔을 때
node_modules/.bin/prisma generate
node_modules/.bin/eslint "{src,test}/**/*.ts"
node_modules/.bin/tsc --noEmit -p tsconfig.all.json
node_modules/.bin/jest 2>&1 | grep -E "Tests:|FAIL|✕|커버리지"
FORCE_COLOR=0 node_modules/.bin/jest --config test/jest-e2e.json --no-colors --runInBand test/<파일>.e2e-spec.ts 2>&1 | grep -E "Tests:|FAIL|✕"
# 드리프트(마이그 PR 필수) — --exit-code: 빈 diff 0 · 오류 1 · 차이 있으면 2
node_modules/.bin/prisma migrate diff --exit-code --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma
```
⛔ `-t` 로 테스트를 골라 돌리지 마라(파일 단위로만). ⛔ `--shadow-database-url` 에 개발 DB 금지.
⛔ **종료코드만 보고 「통과」라고 하지 마라.** `set -o pipefail` 을 빼면 `jest … | grep` 이 **매치되는 순간 0 을 돌려줘 실패가 사라진다**(실측 재현). 파이프를 걸었으면 `Tests:` 줄에 `failed` 가 없는지 **눈으로도** 확인한다.

## 7. 설계가 미정인 자리를 만나면

계약이 답을 안 주는 갈림길이 **자주** 나온다. 임의로 고르지 말고 `README.md` §2 절차를 그대로 밟는다:
**0단계 선례**(계약 본문 · 이미 구현된 다른 전표 · 화면 사본) → **1단계 가장자리냐 본길이냐** → **2단계 뒤집는 비용이 싼 쪽**(기준 1~5) → **3단계 흔적**(에러 코드에 이름 · 테스트 이름 · 요청서에 「몇 단계 몇 번으로 골랐음」).

판정하고 나면 **검토 요청서**를 쓴다 — `docs/design-inquiries/NNN-제목.md`, 단건, **네 번호 대역은 090~119**. 루틴 끝에 사용자가 설계팀에 일괄 전달한다. ⛔ 설계 저장소에 직접 이슈·코멘트를 달지 않는다.

## 8. 커밋·PR 형식

⭐ **세 레인이 같은 git 계정을 쓴다** — 브랜치·제목 접두어가 유일한 구별 수단이다(`lanes.md` §1-3).

| | 네 레인(B) 형식 | 예 |
|---|---|---|
| 브랜치 | `feat/coverage-100-b-<슬라이스>-<조각>` · 문서는 `docs/coverage-100-b-…` | `feat/coverage-100-b-i30-a` |
| PR 제목 | **`[B] `** 로 시작 | `[B] feat(equipment): …` |
| 소유 | `gh pr create` 가 준 **번호를 기록**하고 **그 번호만** 다룬다 | |

- 커밋 메시지: 한국어. 제목은 `feat(equipment): …` 형태. 본문에 **왜**를 적는다.
- ⛔ **다른 도구의 서명을 베끼지 않는다.** 이 저장소의 기존 커밋에는 `Co-Authored-By: Claude …` · `Claude-Session: …` 트레일러와 PR 푸터 `🤖 Generated with [Claude Code](…)` 가 붙어 있는데 그건 **레인 A 세션 전용**이다. 네가 Claude 를 쓰지 않는다면 **그대로 베끼지 마라 — 허위 기재다.** 네가 실제로 쓴 도구·모델 표기로 **대체하거나 생략**한다(예: `Co-Authored-By: Codex (gpt-6-astra) <noreply@openai.com>`). 생략해도 무방하다.
- ⭐ **`[B] ` 제목 접두어만은 생략하지 마라** — 세 레인이 같은 git 계정을 써서 그것과 브랜치 이름이 유일한 구별 수단이다.
- PR 본문에 반드시: 여는 오퍼레이션 목록 · **게이트 실측(명령 + 숫자)** · 비테스트 diff 합계 · 「계약 미수정 · 새 error code 0」 · 마이그가 있으면 사전 대조 SELECT 결과와 드리프트 0.
- 병합은 **merge commit**(`--merge`). ⛔ squash·rebase 안 쓴다.

## 9. 멈춤 조건 — 이 셋 «외에는» 멈추지 않는다

1. 물리 모델 수정이 **두 릴리스 규칙**(컬럼·테이블 삭제)에 걸릴 때
2. 게이트가 **원인 불명으로 3회 실패**할 때(간헐 실패는 1회 재실행 · 두 번 연속 실패만 1회로 셈)
3. **계약끼리 모순돼 어느 쪽도 맞출 수 없을** 때

그 밖에는 판정하고 진행한 뒤 요청서에 남긴다.

## 10. 보고

- **PR 병합마다 한 줄** — 번호 · 오퍼레이션 수 · `n/487`
- **슬라이스 끝마다 짧은 절** — PR 목록 · 마이그 · 리뷰가 잡은 것 · 남긴 것
- **마이그레이션이 든 PR 은 병합 직전 한 줄 보고**(멈추지는 않는다)
- 코어 파일(`transitions.ts`·`error-codes.ts`)을 건드려야 하면 **하기 전에** 보고

## 11. 첫 번째로 할 일

1. §3 환경 구성을 끝내고 시운전이 초록인지 확인한다(**342/487** 이 나와야 한다).
2. §4 정본 7건을 읽는다. 특히 `README.md` §2 와 `slices/I-24.md` 는 정독한다.
3. **I-30(설비 점검·고장 · 9건)** 의 개별 계획안 브리프를 써서 opus 계획자를 띄운다.
   - 계약: `contracts/equipment-05설비툴.json` 의 해당 7 path
   - 화면: `.design-reference/omf-mes/design/wiki/screens/05/` 의 **`M-05-01-설비점검입력.md`** · **`M-05-02-설비고장현장보고.md`** · **`W-05-04-설비고장상세처리.md`**
     (⭐ 화면 **ID** 가 정본이고 파일 이름은 실제 파일을 따른다 — 이 지시서에 적힌 이름과 다르면 **실제 파일이 이긴다**. `PUT …/{breakdownId}`·`:start-handling`·`:complete` 는 `W-05-04` 소관일 가능성이 크다)
   - 마이그: A15(`maintenance.breakdown` 3칸 — `plan.md` §4 134행)
4. 계획안이 나오면 3관점 재수립 → **계획 PR**(브랜치 `docs/coverage-100-b-i30-plan` · 제목 `[B] docs(coverage-100): I-30 계획안 + 3관점 재검토` · 문서만이라 리뷰 없이 병합) → 구현 PR(`feat/coverage-100-b-i30-a` …).
5. **첫 PR 을 열면 그 번호를 기록**하고, 이후 `gh pr merge`·`close` 전에 `headRefName` 이 `…-b-` 로 시작하는지 확인한다(`lanes.md` §1-3).

막히면 지어내지 말고 **실측**(`파일:줄`)으로 판정하고, 판정할 수 없으면 사용자에게 묻는다.
