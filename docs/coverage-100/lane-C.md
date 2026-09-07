# 레인 C 업무 지시서 — 물류 · 재고 · 출하 (45건)

> 읽는 사람: **이 프로젝트를 처음 맡는 새 세션.** 커버리지 100 루틴을 모른다고 전제하고 썼다.
> 순서대로 읽고 그대로 하면 된다. 모르는 규칙이 나오면 지어내지 말고 여기 적힌 정본을 찾아 읽는다.

---

## 1. 무엇을 하는 일인가

`omf-mes-server` 는 베트남 하노이 공장의 MES 백엔드다(NestJS 11 + Prisma 6 + PostgreSQL 16).
**설계팀이 확정한 OpenAPI 계약 487 오퍼레이션**이 `contracts/*.json` 에 있고, 서버는 그것을 하나씩 구현한다.
「커버리지」란 **계약 오퍼레이션 중 실제 핸들러가 붙은 것의 수**다 — 컨트롤러 메서드에 `@Contract('GET /logistics/stock-transfers')` 데코레이터를 달면 1건으로 센다.

- 2026-09-07 현재 **342/487**. 목표는 483/487(건너뛰기로 합의된 4건 제외).
- 이 루틴을 **세 세션이 병렬로** 돈다. **너는 레인 C** 다. 공유 규칙은 `docs/coverage-100/lanes.md`.
- 범위는 **DB 안에서 끝나는 것만**. 실제 외부 전송·프린터 출력·바이너리 저장은 하지 않는다(ERP 적재는 아웃박스 테이블에 쌓는 데까지 — 이건 범위 안이다).

## 2. 네 담당 — 슬라이스 7개 · 45건

레인 안에서 **화살표 순서를 지킨다**(선행이 병합돼야 다음을 시작한다). `∥` 는 동시에 해도 된다.

| 순 | 슬라이스 | 건 | 선행 | 마이그레이션 | 모델 | 예상 PR |
|---:|---|--:|---|---|---|--:|
| 1 | **I-13** 재고 이동 2단 | 6 | I-5(끝남) — 바로 시작 | A4 — `logistics.stock_transfer_line.handling_unit_id?` | opus(원장) | 3 |
| 2 | **I-14** 재고 조정 | 7 | I-1·I-5(끝남) — **1과 동시 가능** | 없음 | opus(원장) | 3 |
| 3 | **I-15** 실사 | 6 | I-14 | 없음 | sonnet | 3 |
| 4 | **I-16** 취급 단위·포장·재구성 | 7 | I-12(끝남) — 언제든 | 없음 | opus | 3 |
| 5 | **I-17** 재생재 등록 | 1 | I-3(끝남) — 언제든 | A5 — `logistics.recycle_entry` 2칸(+ `item.mes_category_code` 부재는 #64 · 슬라이스에서 판정) | sonnet | 1 |
| 6 | **I-22** 출하지시·작업지시·제품 피킹 | 9 | I-8(끝남) — 언제든 | A13 — `logistics.shipment_request.sales_order_id?` | opus | 3 |
| 7 | **I-23** 출하·확정·취소 + 재등록 | 7 | **I-22** · I-5(끝남) | A14·M-f·U-I — `logistics.shipment` 4칸 | opus(**ERP 아웃박스 둘째 사용처**) | 4 |
| 8 | **I-35** 변경 이력·예비품 엑셀 | 2 | 없음 — 언제든 | audit jsonb 규약 | sonnet | 2 |

**권장 순서**: I-13 ∥ I-14 → I-15 ∥ I-16 → I-22 → I-23 → I-17 ∥ I-35.
계약 파일은 주로 `contracts/logistics-01자재창고.json` · `shipment-04제품출하.json` · `app-공통.json` 이다.

⚠ 이 레인은 **재고 원장에 «쓰는» 슬라이스가 많다**(I-13·I-14·I-15). 원장 posting 은 코어라 **전용 PR · 비테스트 ≤200 · 보일러플레이트와 커밋 분리**가 강제된다(`CLAUDE.md`). 기존 구현(`src/core/posting/` 과 I-8~I-12 의 사용처)을 **반드시 먼저 읽고** 같은 모양으로 쓴다 — 새 규칙을 만들지 않는다.
⚠ I-23 은 `src/core/outbox/` 의 **두 번째 사용처**다. I-6(W/O 마감 송신)과 I-24(`:resync`)가 이미 규약을 갈라 놨으니 `outbox.service.ts` 주석을 먼저 읽는다.

## 3. 환경 구성 (한 번만)

```bash
# 1) 저장소
git clone git@github.com:CREFLEINC/omf-mes-server.git
cd omf-mes-server
corepack enable && pnpm install          # Node ≥ 20, pnpm 11.17.0

# 2) 설계 화면 사본(3관점 재검토의 uiux 관점이 읽는다 — 필수)
pnpm workflow:bootstrap                  # .design-reference/omf-mes 를 고정 커밋으로 받는다

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
`docs/coverage-100/slices/I-13.md` 를 쓴다. **`I-24.md` 형식 그대로**. 담을 것:
계약 오퍼레이션 전건 읽기 표(질의 칸·응답 칸·에러 코드) · 물리 모델 대조와 **마이그레이션 SQL 전문** · 핵심 오퍼레이션의 트랜잭션 순서 · 상태기계 · 모듈 배치 · **e2e 테스트 이름 목록** · **설계 미정 자리 전건 판정**(§2 절차로) · **PR 분할안** · 통합 계획서와 다른 자리.
⭐ **조각별 줄 수는 «예상치」가 아니라 비슷한 기존 파일의 실측으로 잡는다**(레인 A 가 예상치로 잡았다가 PR 이 두 배로 나와 갈랐다).
계획안은 opus 서브에이전트에게 맡긴다(`README.md` §4).

### ⑵ 3관점 재수립 — **기본값이다**
계획안이 나오면 **api · uiux · integration** 세 관점 리뷰어(opus)를 **병렬로** 띄워 재검토시킨다. 산출물은 `slices/I-13-review-{api,uiux,integration}.md`(각 130줄 이내).
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

### ⑸ 리뷰 → 병합
- 리뷰어는 **구현자와 다른 새 컨텍스트의 opus**. 결과는 파일로 남긴다(`gh pr comment` 는 쓰지 않는다).
- 게이트를 두 번 돌리지 않는다 — 구현자가 PR 본문에 실측을 적고, 리뷰어는 **단위 전체 + 그 PR 이 바꾼 e2e 파일만** 돈다. 회귀 e2e 는 **네가 병합 직전 한 번**.
- **Blocker 0 · Major 0 · 충돌 없음**이면 **네가 바로 병합**한다(`gh pr merge N --merge`). Minor·Nit 은 막지 않는다.
- ⚠ GitHub Actions 가 **전부 비활성**이라 `mergeStateStatus: CLEAN` 은 검증을 뜻하지 않는다. **로컬 게이트가 유일한 근거**다.
- 병합 성공을 확인한 «뒤에» 브랜치를 정리한다(`lanes.md` §2-5).

### ⑹ 슬라이스 마감
계획안 맨 아래에 **§12 마감표**(PR 목록 · 커버리지 · 마이그 · 리뷰가 잡은 것 · 미완 목록 · **계획서가 틀렸던 자리**)를 쓴다. **별도 마감 PR 을 내지 말고 마지막 구현 PR 에 얹는다.**

## 6. 게이트 명령 (복붙)

```bash
set -a; . ./.env; set +a
node_modules/.bin/prisma migrate deploy      # 남의 레인 마이그가 딸려 왔을 때
node_modules/.bin/prisma generate
node_modules/.bin/eslint "{src,test}/**/*.ts"
node_modules/.bin/tsc --noEmit -p tsconfig.all.json
node_modules/.bin/jest 2>&1 | grep -E "Tests:|FAIL|✕|커버리지"
FORCE_COLOR=0 node_modules/.bin/jest --config test/jest-e2e.json --no-colors --runInBand test/<파일>.e2e-spec.ts 2>&1 | grep -E "Tests:|FAIL|✕"
# 드리프트(마이그 PR 필수)
node_modules/.bin/prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma
```
⛔ `-t` 로 테스트를 골라 돌리지 마라(파일 단위로만). ⛔ `--shadow-database-url` 에 개발 DB 금지.

## 7. 설계가 미정인 자리를 만나면

계약이 답을 안 주는 갈림길이 **자주** 나온다. 임의로 고르지 말고 `README.md` §2 절차를 그대로 밟는다:
**0단계 선례**(계약 본문 · 이미 구현된 다른 전표 · 화면 사본) → **1단계 가장자리냐 본길이냐** → **2단계 뒤집는 비용이 싼 쪽**(기준 1~5) → **3단계 흔적**(에러 코드에 이름 · 테스트 이름 · 요청서에 「몇 단계 몇 번으로 골랐음」).

판정하고 나면 **검토 요청서**를 쓴다 — `docs/design-inquiries/NNN-제목.md`, 단건, **네 번호 대역은 120~149**. 루틴 끝에 사용자가 설계팀에 일괄 전달한다. ⛔ 설계 저장소에 직접 이슈·코멘트를 달지 않는다.

## 8. 커밋·PR 형식

- 커밋 메시지: 한국어. 제목은 `feat(logistics): …` 형태. 본문에 **왜**를 적는다.
- 커밋 트레일러 두 줄(네 세션 것으로):
  ```
  Co-Authored-By: <네 모델> <noreply@anthropic.com>
  Claude-Session: <네 세션 URL>
  ```
- PR 본문에 반드시: 여는 오퍼레이션 목록 · **게이트 실측(명령 + 숫자)** · 비테스트 diff 합계 · 「계약 미수정 · 새 error code 0」 · 마이그가 있으면 사전 대조 SELECT 결과와 드리프트 0. 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)` 와 세션 URL.
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
   추가로 **`slices/I-12.md`**(적치 완료 — 원장에 쓰는 슬라이스의 본보기)와 **`src/core/posting/`** 을 읽는다.
3. **I-13(재고 이동 2단 · 6건)** 의 개별 계획안 브리프를 써서 opus 계획자를 띄운다.
   - 계약: `contracts/logistics-01자재창고.json` 의 재고 이동 path
   - 화면: `.design-reference/omf-mes/design/wiki/screens/01/M-01-10-재고이동불량반출.md`
   - 마이그: A4(`stock_transfer_line.handling_unit_id?` — `plan.md` §4 130행)
   - ⭐ **2단 이동**(출발 → 도착이 두 전표로 갈린다)이 이 슬라이스의 심장이다. 원장 두 번 전기의 순서와 취소 시 역분개를 계획안에서 못 박는다.
4. 계획안이 나오면 3관점 재수립 → 계획 PR → 구현.

막히면 지어내지 말고 **실측**(`파일:줄`)으로 판정하고, 판정할 수 없으면 사용자에게 묻는다.
