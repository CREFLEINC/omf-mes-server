# 154. `GET /trace/lot-status-events` 가 **계약 enum 밖 `transitionCode`** 를 그대로 싣는다 — 재등록(I-23)이 병합되는 순간 열리는 구멍

> ⛔ **값을 고르는 자리가 아니다.** 재등록 전이 코드는 **문의 089(발행 예정 · 레인 C 재등록용 예약 · `lanes.md:47`)** 의 몫이고 우리는 고르지 않는다. 이 통보는 「**그 값이 정해질 때 계약 enum 도 함께 열려야 한다**」를 알리는 것이다.

| 칸 | 내용 |
|---|---|
| **구분** | ⭐ **통보**(§2 1-1 — 2026-09-08 규칙) · 회신을 기다리지 않는다 |
| 걸리는 오퍼레이션 | `GET /trace/lot-status-events` (⚠ 원인은 **`POST /logistics/stock-reinstatements`**(I-23 · 레인 C)가 쓰는 이력 행이다) |
| 구현 상태 | **구현 예정(I-18 · 계획 PR 만 · 오늘 코드 0줄)** — 계획서 `docs/coverage-100/slices/I-18.md` §5-1 · §9-1 #10 · §0-재수립 **R-4** |
| 판정 | `coverage-100/README.md` §2 **0단계** — 형제 `GET /trace/lot-lifecycle-events` 가 같은 물음에 이미 답했다(「enum 밖 값을 **떨어뜨리지 않는다** — 떨어뜨리면 감사 조회가 오히려 «넓어진다»」) → **2단계 기준 5**(새 개념 0 · 서버가 감사 조회에 필터를 지어 넣지 않는다) |
| 되돌릴 때 | 「그런 행은 감춰라」로 오면 `where` 에 `transition_code: { in: ENUM9 }` **한 줄** + 단위 1건(≈ +8줄). 그러나 그러면 **감사 조회가 사건 일부를 조용히 숨긴다** — 되돌리기는 싸지만 방향이 위험하다. 반대로 「enum 을 연다」면 서버 코드는 **0줄**이다 |

## 무엇이 문제인가

ⓐ **계약은 `transitionCode` 를 닫힌 enum 으로 잠갔는데, 물리는 안 잠겼다.**

- 계약 `LotStatusHistoryEvent.transitionCode` = **required + enum 9값**(`C4·C5·C6·C7·C8·C9·C10·C14·C15` · `contracts/logistics-01자재창고.json:11970`). 질의 파라미터 쪽 enum 도 같은 9값이다.
- 물리 `trace.lot_status_event.transition_code` 는 **NOT NULL 이지만 enum 이 없다**(`prisma/schema.prisma:4634-4657`). 코드값 그룹 `LOT_STATUS_TRANSITION` 도 오늘 9행으로 계약과 전건 일치한다(DB 실측 2026-09-08).
- ⇒ **오늘은 문제가 없다.** 문제는 아래 ⓑ 다.

ⓑ **재등록(I-23 · 레인 C)이 그 enum 에 «없는» 전이를 쓰기로 이미 예약돼 있다.**

전이표에 자리가 잡혀 있고, 코드 칸만 비어 있다:

> ```
> // ── I-23(레인 C · 재고 재등록)이 쓴다 ──
> // ⛔ `transitionCode` 가 없다 — 이력 칸은 NOT NULL 인데 계약 enum 9값(C4~C15)에 재등록을
> //    가리키는 코드가 «없다». 지어내지 않고 호출자가 넘기게 둔다. 설계 미정 — 문의 089(발행 예정).
> 'stock-reinstate': { from: ['DEFECTIVE'], to: 'NORMAL',
>   sourceOperation: 'POST /logistics/stock-reinstatements' },
> ```
> (`src/core/document-state/transitions.ts:215-219`)

`plan-integration.md:406` 도 같은 사실을 적고 **I-23 의 재등록 1건만 파킹**해 두었다 — 「지어내지 말고 문의 089 의 답을 기다린다」.

⇒ **089 의 답이 「값은 `C16` 이다」처럼 값만 오고 계약 enum 이 안 열리면**, 그 값을 실은 이력 행이 이 조회로 나가는 순간 **응답이 계약을 위반한다.**

ⓒ **서버는 그것을 막지 못하고, 막아서도 안 된다.**

- 응답 본문에는 **런타임 검증이 없다**(`src/common/contract/contract-validation.guard.ts` 에 response 경로 0 · grep 실측). 즉 서버가 조용히 계약 밖 값을 내보낸다.
- 그렇다고 **행을 떨어뜨릴 수도 없다.** 형제 조회가 그 판정을 이미 적어 두었다 — 「떨어뜨리면 감사 조회가 오히려 «넓어진다». 가드가 이미 400 을 냈다」(`src/trace/lot/lot-lifecycle-event.service.ts:33-36`). 감사 조회가 사건을 **숨기는** 쪽이 더 나쁘다.
- 질의 쪽은 안전하다 — `transitionCode=<enum 밖>` 으로 «묻는» 것은 계약 검증 가드가 400 으로 막는다. **새는 것은 응답뿐**이다.

## 지금 서버는

**아직 없다.** 계획이 정한 동작:

- 조회는 `occurredFrom`/`occurredTo`(반열림) · `lotId` · `transitionCode` 로만 거른다. ⛔ **`transition_code` 값이 enum 안인지 대조하지 않는다**(필터를 지어 넣지 않는다).
- 그래서 I-23 재등록이 병합되면 그 행이 **그대로 응답에 실린다.**
- 이 슬라이스는 `lot_status_event` 에 **한 줄도 쓰지 않는다**(오늘 유일한 writer 는 `src/core/lot/lot-quality-status.service.ts:80-93`). 즉 새는 값을 만드는 쪽도 우리가 아니다.
- ⛔ `src/core/document-state/transitions.ts` **0줄** — 이 슬라이스는 전이 0건이고, 그 파일은 다른 레인이 쓰는 중이다.

## ⇒ 알리는 것

1. **조회는 enum 밖 값을 떨어뜨리지 않는다** — 감사 조회가 사건을 숨기지 않게 하기 위해서다. 그 대가로 응답이 계약 enum 을 벗어날 수 있다.
2. **문의 089 로 재등록 전이 코드를 정하실 때, `LotStatusHistoryEvent.transitionCode` 와 질의 파라미터의 enum 도 «함께» 열어 주십시오.** 값만 정하고 enum 을 그대로 두면 이 조회의 응답이 계약을 위반한 채 나가고, 서버에는 그것을 막을 런타임 검증이 없다.
3. 값 자체는 **레인 C(I-23)의 판정**이다 — A2 는 고르지 않는다.

## 흔적

`docs/coverage-100/slices/I-18.md` §1-5 · §5-1 · §9-1 #10 · §9-2(통보 154) · §11-1 ⑦ · **§0-재수립 R-4**(리뷰 API 관점이 잡았다) · `I-18-review-api.md` · `contracts/logistics-01자재창고.json:11970` · `prisma/schema.prisma:4634-4657` · `src/core/document-state/transitions.ts:215-219` · `src/trace/lot/lot-lifecycle-event.service.ts:33-36` · `src/common/contract/contract-validation.guard.ts` · `docs/coverage-100/plan-integration.md:406` · `docs/coverage-100/lanes.md:47` · **문의 089**(발행 예정 · 레인 C) · 문의 084(`lot-status-transitions` allowed 축).
