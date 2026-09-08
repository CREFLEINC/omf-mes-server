# 84. `LotStatusTransition.allowed` — 전이표 판정만 하는가, 실행 가능성까지 보는가 (R-13)

**구분: 통보**(회신을 기다리지 않는다 — README §2 1-1단계 「본질 아님 × 비용 낮음」)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/lot-status-transitions` (I-20 PR ①c) |
| 구현 상태 | 구현함 — `allowed = transition.from.includes(currentLotStatusCode)` **한 축만** 본다 |
| 판정 | §2 1단계(가장자리 — 열린 보류가 둘 이상이거나 이미 전량 보류인 LOT 에서만 갈린다) → 1-1단계(본질 아님 · 비용 낮음) ⇒ 정하고 통보 |
| 되돌릴 때 | PR ④·⑤(쓰기)가 서고 `lotHoldId` 를 선택 질의로 받게 늘리면, 그 보류 하나 기준으로 재계수하는 축을 추가할 수 있다(사용처 하나) |

## 재수립 R-13 이 짚은 것

`allowed=true` 인데 실제로 `:release` 를 부르면 ⓐ **열린 보류가 둘이라 하나를 풀어도 LOT 이 안
움직이는데 200**(§0 #2 ⓑ) ⓑ **이미 열린 전량 보류가 있어 `POST /quality/lot-holds` 가 409
`DUPLICATE_HOLD`** 인 경우가 있다 — 조회의 「간다」와 실행의 결과가 갈린다.

## 판정 — `allowed` 는 전이표 `from` 판정만 한다

**0단계 선례** — 계약 `actionCode` 설명 자신이 이 오퍼레이션의 몫을 좁혀 뒀다: 「⛔ 어느 보류를
풀지는 여기서 정하지 않는다 — 열린 보류가 여럿일 수 있어 사용자가
`GET /quality/lot-holds?lotId=…&open=true` 에서 고른다」(`:4410` 인접). **계산 자체는 가능하다**
— R-13 이 든 두 자리(열린 보류 «개수» · 열린 전량 보류의 존재)는 «양쪽 다» `lotId` 하나로
계산된다(「어느 보류인가」를 몰라도 된다: 한 번의 `:release` 는 `lotHoldId` 하나만 닫으므로 열린
보류가 n≥2 면 어느 것을 고르든 n−1≥1 이 남아 LOT 이 절대 안 움직이고, 이미 열린 전량 보류가
있으면 그것과 무관하게 `POST /quality/lot-holds` 가 409 다). **그런데도 안 하는 이유는** ⓐ 조회
한 건에 질의 둘(열린 보류 count · 전량 보류 존재)을 더 붙이는 값이 크지 않고 ⓑ **최종 판정은
실행측이 409/200 으로 낸다** — 이 조회는 「갈 수 있는 상태 목록」을 그리는 화면용이지 실행을
대신하지 않는다.

**1단계** — 가장자리다: 열린 보류가 정확히 1건이고 다른 열린 보류·중복이 없는 LOT 에서는
`allowed`(from 판정)와 실행 결과가 항상 일치한다. 갈리는 것은 열린 보류가 2건 이상이거나 이미
전량 보류가 있는 소수 LOT 뿐이다.

**1-1단계**:
- **MES 본질인가** — 아니다. 이 칸은 「전이가 원장·계보·재고를 옮기는가」가 아니라 미리보기 화면의
  정밀도 문제다. 실제 상태 이동·이력 적재는 쓰기 오퍼레이션(④·⑤)이 `moveWithin()` 으로 그대로
  판정한다 — 이 조회가 낙관적으로 봐도 원장이 잘못 쓰이지 않는다.
- **바꾸는 비용이 높은가** — 아니다. ⓐ 소급 불가 데이터 아님(조회는 저장하지 않는다) ⓑ 이미 쌓인
  행을 정정 못 하는 것도 아님 ⓒ 계약이 광범위하게 바뀌지도 않는다(같은 `boolean` 칸에 계산만
  정밀해진다).
  ⇒ **본질 아님 × 비용 낮음 ⇒ 통보.**

## 두 축을 억지로 맞추지 않는 이유

`allowed=false`(from 불일치) 자리는 이미 실행측과 맞다 — 그 전이는 `moveWithin()` 이 0건을
옮기면 400 `STATE_LOCKED` 를 내는 자리와 같은 축이다(`§3-2` 선례). 어긋나는 자리는
`allowed=true` 인데 실행이 실패/무변화하는 쪽이다 — 위에서 본 대로 그 계산 자체는 `lotId`
하나로 가능하고(선택과 무관 — 어느 보류를 고르든 값이 같다) 「틀린 예측」위험도 없다. 그래도
안 붙이는 이유는 비용 대비 값이다: 이 조회는 이미 3질의(lot·picking·goods_issue)를 하는
미리보기 화면이고, 여기서 정밀도를 하나 더 올려도 **최종 판정은 결국 실행측이 409/200 으로
낸다** — 조회가 아무리 정확해져도 쓰기 오퍼레이션의 상태기계 판정을 대신하지 못하므로, 지금
당장 두 질의를 더 붙이기보다 쓰기 PR(④·⑤)이 서서 `lotHoldId` 를 선택 질의로 받게 될 때 같이
늘리는 편이 낫다.

## ⭐ 2026-09-08 재검토 — **PR ④(`POST /quality/lot-holds`)가 서고 나서** (I-20 §12-1 ⓐ)

**결론은 그대로다. 근거 한 줄이 「예측」에서 「실측」으로 바뀌었다.**

R-13 이 든 어긋남 ⓑ 를 **실물로 쟀다**(dev DB · LOT 7162 — `status_code='NORMAL'` 이고
해제되지 않은 **전량 보류**가 하나 열려 있다):

| 축 | 값 |
|---|---|
| `GET /quality/lot-status-transitions?lotId=7162` | `CREATE_HOLD` 두 줄이 **`allowed: true`**(→`DEFECTIVE` · →`INSPECTION_PENDING`) · `RELEASE_HOLD` 두 줄은 `allowed: false` |
| `POST /quality/lot-holds` (그 LOT · 올바른 `versionNo`) | **409** `{"code":"DUPLICATE_HOLD","conflictingLotId":7162}` |

⇒ 어긋남은 **실재한다.** 그리고 실측이 그 범위를 **좁혔다**:

- 어긋나는 것은 **`CREATE_HOLD` 두 줄뿐**이다. `RELEASE_HOLD` 축은 이 LOT 에서 `allowed=false`
  이고 실행도 막히므로 두 축이 맞는다(R-13 이 「`allowed=true` 축 전부」라 적은 것은 넓었다).
- 그 두 줄은 **같은 사실 하나**(열린 전량 보류의 존재)로 함께 갈린다 — `targetLotStatusCode` 와
  무관하다. 즉 붙일 질의는 **`EXISTS(lot_hold WHERE lot_id=? AND released_at IS NULL AND hold_qty IS NULL)`
  한 줄**이고, 스키마·계약 변경은 0이다(`allowed=false` 로 내리면 `blockedReason` 칸이 이미 있다).

**그래도 지금 안 붙인다** — 이유가 하나 줄고 하나 남았다.
- ⛔ **죽은 이유**: 「`lotHoldId` 를 선택 질의로 받게 될 때 같이 늘린다」. `DUPLICATE_HOLD` 축은
  `lotHoldId` 와 **무관**하다(등록은 보류를 고르지 않는다) ⇒ 그 시점을 기다릴 근거가 없다.
- ✅ **남은 이유**: 이 조회는 이미 3질의(lot·picking·goods_issue)를 하는 **미리보기**고, 최종
  판정은 실행측이 낸다. 그리고 이 축을 조회에 넣으면 **조회와 실행이 같은 규칙을 두 곳에 적는다** —
  `plan.md` §5-6 이 막으려던 것이 정확히 그 이중 기재다. 등록 실행(PR ④)이 409 를
  `DUPLICATE_HOLD` 라는 **구조화 코드**로 내리므로 화면은 그 값으로 문구를 고를 수 있다.

⇒ **`allowed` 는 계속 전이표 `from` 판정만 한다.** 되돌린다면 위 한 줄짜리 `EXISTS` 를
`CREATE_HOLD` 행에만 걸고 `blockedReason` 에 「이미 열려 있는 전량 보류가 있습니다」를 담는다.

## 관련

- `src/quality/lot-status/lot-status-transition.service.ts` `rowOf()` 코드 주석은 이 판정을
  본문에 직접 담지 않았다 — `allowed` 계산이 `from.includes()` 한 줄이라 코드가 스스로 좁은 축임을
  보인다. 근거는 이 문서가 정본이다.
- `docs/design-inquiries/078-LotStatusTransition-impact-진행중피킹-이미출고수량-정의.md` — 같은
  오퍼레이션의 자매 판정.
- `docs/coverage-100/slices/I-20.md` §0-재수립 R-13.
