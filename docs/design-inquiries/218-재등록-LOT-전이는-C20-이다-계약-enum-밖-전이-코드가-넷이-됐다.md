# 218. 재등록 LOT 전이는 **`C20`** 이다 — 그리고 계약 enum 밖 전이 코드가 **넷**이 됐다

**구분: 통보**(회신을 기다리지 않는다) · ⭐ **통보 089 의 짝이다** — 089 가 처분 셋(`C17`~`C19`)을 정하며 재등록 하나를 「레인 C 의 판정」으로 남겼고, 그 슬라이스(I-23)를 A2 가 인수했다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/stock-reinstatements`(I-23) · `GET /trace/lot-status-events` |
| 구현 상태 | **구현함**(I-23 PR ③ — 코드값 마이그 1행 · 시드 · 전이표 한 줄) |
| 판정 | §2 **0단계**(089 가 번호 규칙을 이미 정했다) → **1-1단계 통보**(바꾸는 비용 ✕ — `lot_status_event` 에 불변 트리거가 없다 · 089 실측) |
| 되돌릴 때 | 다른 번호로 오면 `trace.lot_status_event.transition_code` `UPDATE` 한 문장 + 코드값 한 행 + `transitions.ts` 한 줄 |

## ⓐ 번호 — `C20`

| 근거 | 내용 |
|---|---|
| 통보 089 `:69-70` | 도식이 **C1~C16 을 쓴다**(`W-03-02` §5-5) — 시드 9값은 그중 «상태 전이인 것»만 담았다 ⇒ C11~C16 재사용은 도식과 충돌한다 · 처분이 `C17`~`C19` |
| ⇒ | 비어 있는 다음 번호가 **`C20`** 「재등록 → 정상」 |

⛔ **「시드의 빈 첫 번호」는 근거가 «아니다»** — 시드는 `C11`·`C12`·`C13`·`C16` 을 비워 두고 있다. 초안 계획서가 이것으로 셌다가 3관점 재수립(R-11)에서 바로잡았다.

구현 — `prisma/migrations/20260910055154_a2_i23_reinstatement_transition_code`(코드값 1행) · `prisma/seed.ts:538-540` · `src/core/document-state/transitions.ts:223-235`.

## ⓑ 전이표 — `from` 이 **셋**, `SCRAPPED` 는 409

`stock-reinstate` — `from` = `DEFECTIVE` · `NORMAL` · `INSPECTION_PENDING` → `NORMAL`.

| 출발 | 판정 | 왜 |
|---|---|---|
| `DEFECTIVE` | 본길 | OQC 불합격(`C6`) 뒤 처분이 정상인 LOT |
| `NORMAL` · `INSPECTION_PENDING` | 받는다 | 반품 갈래가 원 LOT 을 그대로 써 그 값으로 들어온다(`W-04-07` §5-4 · 처분 전이 셋과 같은 이유) |
| ⛔ `SCRAPPED` | **409 `INVALID_STATE`** | 폐기된 LOT 을 되살리는 오퍼레이션이 아니다 |

⭐ **`from` 을 좁히면 안 되는 이유** — 코어 `moveWithin` 은 `from` 밖이면 **던지지 않고 건너뛴다.** 그러면 재고는 판매 가능 창고로 옮겨졌는데 응답 `lotStatusCode`(required · 「전이 결과」)가 **조용히 거짓**이 된다. ⇒ 서버는 건너뜀을 감지하면 409 로 **전체를 되돌린다**(`stock-reinstatement-posting.ts:248-252`).
⚠ 계획서 e2e 61 은 「`SCRAPPED` 로도 성공」이었다 — 재고를 옮기면서 LOT 만 `SCRAPPED` 로 두면 둘이 모순이라, 형제(보류 해제)를 따라 409 로 바꿨다.

## ⓒ ⛔ `C20` 은 계약 enum **밖**이다 — 그런데 **선반영하지 않았다**

`LotStatusHistoryEvent.transitionCode` 는 **required + enum 9값**(`C4`~`C10`·`C14`·`C15` · `logistics-01자재창고.json:11972`~)이고, `GET /trace/lot-status-events`(`:6332`~)의 `transitionCode` 질의 축도 같은 9값이다.

| 무엇이 나나 | |
|---|---|
| 응답 | 재등록이 남긴 이력 행이 그 조회에 실리는 순간 **계약 enum 밖**이다 |
| 질의 | 화면이 `?transitionCode=C20` 으로 거르면 **우리 계약 검증 가드가 400** 을 낸다 |

⛔ **계약 사본에 선반영하지 않았다**(계획서는 「I-17 선례대로 선반영」이라 적었고, 구현에서 뒤집었다).
- I-17 이 `RECYCLE_ENTRY` 를 선반영한 것은 **답이 온 질의**(213)였다. 여기는 **우리가 정하고 통보한** 값이다.
- 같은 간극의 `C17`~`C19` 는 **I-21 이 선반영 없이 이미 병합했다.** `C20` 만 넣으면 넷 중 하나만 가려져 **간극이 더 안 보인다.**

⇒ 대신 **간극 자체를 센다** — `src/common/contract/contract-lot-transition-enum.spec.ts`(`KNOWN_GAP = C17 · C18 · C19 · C20`). 이 표가 빨개지는 경우는 둘이다 — ⓐ 우리가 다섯째 코드를 몰래 더했다 ⓑ 설계 변동 공지가 enum 에 실었다(그때 `KNOWN_GAP` 에서 뺀다).

### 📨 청하는 것
`LotStatusHistoryEvent.transitionCode` **응답 enum** 과 `GET /trace/lot-status-events` 의 `transitionCode` **질의 enum** 에 **`C17` · `C18` · `C19` · `C20`** 을 함께 더해 주십시오(089 와 한 번에). 같은 스키마 `sourceDocumentTypeCode` 설명의 「전이 9종에서 도출」 대응표에도 넷을 실어 주십시오.

## 흔적
- `src/core/document-state/transitions.ts:223-235` · `src/core/document-state/document-state.spec.ts` · `test/document-state.e2e-spec.ts`
- `src/core/lot/lot-quality-status.service.ts:33`(호출자가 코드를 넘기던 인자가 비었다) · `src/core/lot/lot-quality-status.service.spec.ts:117`
- `src/logistics/stock-reinstatement/stock-reinstatement-posting.ts:248-252`
- `src/common/contract/contract-lot-transition-enum.spec.ts`
- 통보 089 `:69-70` · 계획서 `docs/coverage-100/slices/I-23.md` R-11 · §5-2
