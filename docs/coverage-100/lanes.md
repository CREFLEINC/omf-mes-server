# 3레인 병렬 운영 — 공유 규칙 (2026-09-07)

> 커버리지 100 루틴을 **세 세션이 서로 다른 PC 에서 동시에** 돌린다. 이 문서는 세 레인이 **모두 지켜야 하는 것**만 담는다.
> 각자의 범위·첫 할 일은 `lane-B.md`(설비·보전·발행·알림) · `lane-C.md`(물류·재고·출하)에 있다. 레인 A(품질·인계)는 기존 세션이 맡는다.
> 루틴 자체의 규칙 정본은 **`README.md`** 다. 이 문서는 그 위에 「병렬이라서 생기는 것」만 얹는다.

## 0. 레인 배분

| 레인 | 담당 | 슬라이스 | 건수 | 세션 |
|:-:|---|---|--:|---|
| **A** | 품질 · 공정 인계 · 첨부 | I-19 → I-20 → I-21 · I-18 · I-25 · I-34 | 47 | 기존 세션(통합자 겸임) |
| **B** | 설비 · 보전 · 발행 · 알림 | I-30 → I-31 → I-33 · I-32 · I-26 → I-27 · I-28 | 52 | 새 세션 |
| **C** | 물류 · 재고 · 출하 | I-13 · I-14 → I-15 · I-16 · I-17 · I-22 → I-23 · I-35 | 45 | 새 세션 |
| — | **I-29 통합 대시보드 · M2~M4 체인 e2e** | 전부 끝난 뒤 | 1+ | **A 가 맡는다** |

세 축은 서로 **선행 관계가 없다**(전부 이미 끝난 I-1~I-12·I-24 에 매달려 있다). 레인 안에서만 순서를 지킨다.

## 1. 겹치지 않게 미리 나눠 둔 것

### 1-1. 설계 문의 번호 — 레인마다 대역이 다르다

`docs/design-inquiries/NNN-제목.md`. **062 까지 파일 실재 · 063~068 은 I-24 가 예약**했다.

| 레인 | 대역 |
|:-:|---|
| A | **069 ~ 089** |
| **B** | **090 ~ 119** |
| **C** | **120 ~ 149** |

⛔ 대역 밖 번호를 쓰지 않는다. 대역이 모자라면 사용자에게 알리고 새 대역을 받는다.

### 1-2. 마이그레이션 파일 이름

`prisma/migrations/<YYYYMMDDHHMMSS>_<내용>/migration.sql` — **만드는 시각을 초까지** 넣는다(같은 초에 두 레인이 만들 확률은 사실상 0).
- 세 레인의 마이그가 **뒤섞인 순서로** main 에 들어온다. `prisma migrate deploy` 는 «적용 안 된 것」을 이름 순으로 적용하므로, 남의 레인이 나보다 «이른» 타임스탬프로 나중에 병합돼도 그대로 적용된다. ⛔ 단 `prisma migrate dev` 를 쓰면 그 상황에서 초기화를 제안한다 — **`migrate dev` 는 절대 금지**(아래 §4).
- 그래서 마이그는 **순서에 의존하지 않아야** 한다: 추가·완화만, 삭제 0, 백필 0.

### 1-3. ⭐ PR 소유 — 세 레인이 **같은 git 계정**을 쓴다

커밋 author 와 PR 작성자가 셋 다 같아서 **누가 올린 PR 인지 GitHub 화면으로 구별되지 않는다.** 브랜치 이름으로 가른다.

| 레인 | 브랜치 접두어 | PR 제목 접두어 |
|:-:|---|---|
| A | `feat/coverage-100-a-…` · `docs/coverage-100-a-…` | `[A] ` |
| **B** | `feat/coverage-100-b-…` · `docs/coverage-100-b-…` | `[B] ` |
| **C** | `feat/coverage-100-c-…` · `docs/coverage-100-c-…` | `[C] ` |

예: `feat/coverage-100-b-i30-a` · 제목 `[B] feat(equipment): 설비 점검 조회 3 (I-30 PR ①)`

**규칙 — 네가 «연» PR 번호만 다룬다.**
1. `gh pr create` 가 돌려준 **번호를 그 자리에서 기록**한다(슬라이스 계획안 §12 마감표에 누적).
2. `gh pr merge` · `close` · `edit` · `review` 등 **바꾸는 명령을 쓰기 «전에» 반드시 확인**한다:
   ```bash
   gh pr view <N> --json number,headRefName,title --jq '"\(.number) \(.headRefName) \(.title)"'
   ```
   `headRefName` 이 **네 레인 접두어로 시작하지 않으면 그 PR 은 남의 것이다 — 손대지 않는다.**
3. `gh pr list` 로 남의 레인 PR 이 보여도 **읽기만** 한다. 리뷰·병합·닫기 모두 그 PR 을 연 레인의 몫이다.
4. 남의 레인 PR 에서 결함을 발견하면 고치지도 코멘트하지도 말고 **사용자에게 한 줄 보고**한다.

⛔ 번호는 저장소 전체에서 하나씩 늘어난다 — 다른 레인이 먼저 PR 을 열면 네 다음 번호가 건너뛴다. **번호가 연속이 아닌 것은 정상이다.**

### 1-4. 소유자가 정해진 파일

| 파일 | 소유 | 규칙 |
|---|:-:|---|
| `src/core/document-state/transitions.ts` · `document-state.spec.ts` | **A** | B·C 가 상태 전이 키를 더해야 하면 **먼저 사용자에게 알린다**. 그 spec 의 개수 단언(`toHaveLength(n)`)이 매번 충돌하는 자리다 |
| `src/common/errors/error-codes.ts` | 공용 | ⛔ **새 코드 추가 금지**(기존 값만 쓴다 — 이건 원래 루틴 규칙이다) |
| `src/common/permissions/manual-permissions.ts` | 공용 | 각자 자기 오퍼레이션 줄만. **단독 커밋**으로 내고 바로 병합해 충돌 창을 줄인다 |
| `prisma/schema.prisma` | 공용 | 각자 자기 모델 블록만 만진다 — 대부분 자동 병합된다 |
| `docs/coverage-100/plan.md` | 공용 | 자기 슬라이스 행만 |
| 도메인 모듈(`quality.module.ts`·`equipment.module.ts`·`logistics.module.ts` …) | 축별 | 서로 안 겹친다 |

### 1-5. 커버리지 숫자

`n/487` 은 **`main` 에서 센 값만** 공식이다. 자기 브랜치에서 센 값은 「이 PR 이 +k」를 말할 때만 쓴다.
```
node_modules/.bin/jest contract-coverage    # 콘솔에 「계약 구현 커버리지: n/487」
```
2026-09-07 기준 main = **342/487**.

## 2. 병합 절차 (병렬이라 달라지는 부분)

1. PR 을 열기 **직전에** `git fetch origin && git merge origin/main`(⛔ rebase·force-push 금지) → 충돌을 풀고 → **게이트를 다시 돌린다**.
2. 남의 레인 마이그가 딸려 오면 `node_modules/.bin/prisma migrate deploy` 로 자기 DB 를 따라잡힌 뒤 `prisma generate`.
3. 드리프트 0 확인 — `node_modules/.bin/prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma` 가 **`No difference detected`**. 종료코드로 자동 판정하려면 `--exit-code` 를 붙인다(빈 diff 0 · 오류 1 · 차이 있으면 2).
4. 병합은 **merge commit** — `gh pr merge <N> --merge`.
5. ⭐ **브랜치는 병합 성공을 확인한 «뒤에» 따로 지운다.** ⛔ `gh pr merge --delete-branch` 를 쓰지 않는다 — 지워진 브랜치를 base 로 둔 **자식 PR 이 재지정되지 않고 CLOSED 된다**(이 저장소에서 실제로 났다 · #153 병합 → #154 닫힘. 닫힌 PR 은 base 변경도 reopen 도 안 돼 새 PR 을 열어야 했다). 순서: `gh pr merge <N> --merge` → 병합 확인 → 스택이면 `gh pr edit <N+1> --base main` → `git push origin --delete <브랜치>`. 실수로 지웠으면 `refs/pull/<N>/head` 에서 되살린다.
   ⚠ 「`gh pr merge && git branch -D …` 는 실패해도 지워진다」고 적었던 옛 문장은 **틀렸다** — `&&` 는 앞이 성공해야 뒤를 돈다(레인 C 지적, 2026-09-07). 위험한 것은 `&&` 가 아니라 `--delete-branch` 다.

## 3. 서로에게 알려야 하는 순간 (사용자를 통해)

직접 소통 수단이 없다. 아래는 **사용자에게 한 줄 보고**한다.
- 코어 파일(`transitions.ts`·`error-codes.ts`)을 건드려야 할 때 — **하기 전에**
- 마이그레이션이 든 PR 을 병합하기 직전 — **한 줄 보고만 하고 멈추지 않는다**
- 다른 레인의 코드에서 결함을 발견했을 때(고치지 말고 보고)
- 문의 번호 대역이 모자랄 때
- 멈춤 조건 셋 중 하나에 걸렸을 때(`README.md` §3)

## 3-1. 모델 배분과 커밋 서명 — 레인마다 도구가 다를 수 있다

- `README.md` §4 의 **opus/sonnet/fable 은 「역할」이지 제품명이 아니다.** 「판단 밀도가 높은 일(계획·코어·마이그레이션·리뷰·심장 구현)에 큰 모델, 패턴을 베끼는 일(조회·CRUD 복제·e2e)에 작은 모델」이라는 축만 지키면 된다. 다른 도구(Codex 등)를 쓰는 레인은 자기 쪽 대응 모델로 바꿔 읽는다 — 예: 큰 모델 `gpt-6-astra` · 작은 모델 `gpt-5.6-sol`.
- ⛔ **커밋 트레일러·PR 푸터를 «자기가 쓰지 않은 도구» 이름으로 적지 않는다.** 저장소 기존 커밋의 `Co-Authored-By: Claude …`·`Claude-Session: …`·`🤖 Generated with [Claude Code](…)` 는 **레인 A 세션 전용**이다. 다른 도구를 쓰면 자기 표기로 대체하거나 **생략**한다. 허위 기재는 금지다.
- ⭐ 다만 **PR 제목의 레인 접두어(`[A]`·`[B]`·`[C]`)와 브랜치 접두어는 생략하지 않는다**(§1-3).

## 4. 절대 금지 (레인 공통)

- `contracts/*.json` 수정 · `pnpm contracts:update` · `contracts:check` — 계약 사본은 **`a6a87e1` 고정**이다(`contracts/COMMIT.txt`). 이게 분모 487 의 기준이다.
- `prisma migrate reset` · `prisma migrate dev` · `pnpm db:seed`(최초 환경 구성 1회 제외)
- `prisma migrate diff --shadow-database-url` **에 개발 DB 를 주는 것** — DB 가 초기화된다. 드리프트 검사는 `--from-schema-datasource` 로만.
- `git push --force`(어떤 형태든)
- `CREFLEINC/omf-mes`·`omf-mes-client` 저장소에 이슈·코멘트 — 설계 문의는 **문서로만** 쓴다
- 새 `ERROR_CODE` 추가
- `main` 에 직접 push
