# 180. 폐기(`SCRAPPED`)로 간 LOT 을 되돌릴 길이 **0**이다 — 오폐기 정정 경로가 없다

**구분: 통보**(회신을 기다리지 않는다 — `coverage-100/README.md` §2 1-1단계 「본질이지만 «되돌리는 전이를 안 만드는» 쪽은 비용이 낮다」)

> ⭐ **통보 071(C9 로 걸린 보류를 풀 길이 0)의 형제**다. 같은 모양이 LOT 품질 축의 «다른 끝»에서 한 번 더 났다.

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /quality/nonconformances/{nonconformanceId}/disposition-decisions`(폐기 판정 뒤) · `POST /quality/lot-holds/{lotHoldId}:release` · `POST /logistics/stock-reinstatements`(I-23) |
| 구현 상태 | **구현 예정(I-21)** — 계획서 `docs/coverage-100/slices/I-21.md` §6-2 · §9-1 **#9** |
| 판정 | §2 **2단계 기준 2**(거부하는 쪽 — 거부→허용이 호환 완화) · **F-6**(판정할 수 없음을 통과로 처리하지 않는다) |
| 되돌릴 때 | `transitions.ts` 에 **행 하나 + 코드값 하나**. 이미 쌓인 `lot_status_event` 는 그대로 두면 되므로 **되돌리기가 싸다** |

## 무엇이 없나

계약 `quality-03품질.json:2460` 이 처분 판정의 도착 상태를 적었다 — 폐기 → **`SCRAPPED`**.
그런데 **`SCRAPPED` 에서 «나가는» 전이가 하나도 없다.**

`src/core/document-state/transitions.ts` 의 `trace.lot.status_code` 축 전이 전건(실측)에서 `from` 에 `SCRAPPED` 가 든 것은 **0개**다:

| 액션 | from | to |
|---|---|---|
| `inspection-accepted`·`inspection-held`·`inspection-rejected`·`pqc-acceptance-exceeded` | `NORMAL`·`INSPECTION_PENDING` | `NORMAL`/`INSPECTION_PENDING`/`DEFECTIVE` |
| `lot-hold-release-accepted`·`lot-hold-release-rejected` | `INSPECTION_PENDING` | `NORMAL`/`DEFECTIVE` |
| `lot-hold-claim`·`lot-hold-suspect` | `NORMAL`(·`INSPECTION_PENDING`) | `DEFECTIVE`/`INSPECTION_PENDING` |
| `stock-reinstate`(I-23) | `DEFECTIVE` | `NORMAL` |
| **I-21 이 더하는 셋**(`C17`·`C18`·`C19`) | `NORMAL`·`INSPECTION_PENDING`·`DEFECTIVE` | `INSPECTION_PENDING`/**`SCRAPPED`**/`NORMAL` |

⇒ **`SCRAPPED` 는 도착지이기만 하고 출발지가 될 수 없다.**

## 그 필연으로 무엇이 일어나나

**오폐기 판정을 되돌릴 서버 경로가 0이다.**
새 부적합을 등록하는 것 자체는 됩니다(등록은 LOT 을 옮기지 않으므로) — 그러나 그 부적합에 **어떤 처분을 저장해도 400 `STATE_LOCKED`** 입니다(코어가 0건을 옮긴다).

**화면도 그것을 알고 있습니다:**

- `W-03-10` §6 — 「**판정을 잘못 저장했다 ⛔ 되돌릴 수 없다**」
- `W-03-10` §8 **#9**(미해소) — 「**오판정 정정 경로 안내가 없다**(G-19 미적용) … 그 정정 경로를 **04(부적합 소유)와 함께 정한다**」

## ⇒ 우리가 정한 것

⛔ **되돌리는 전이를 만들지 않습니다.**

- 계약·화면 어느 쪽에도 그 오퍼레이션이 없고, 전이를 지어내면 **그것이 사실상의 업무 규칙**이 됩니다(F-6).
- `SCRAPPED` 를 `from` 에 넣는 순간 「이미 폐기된 LOT 에 처분을 다시 저장하는 것」이 **성공**하게 되고, 그것은 **폐기 출고가 이미 나간 뒤일 수도 있는** 상태입니다.
- §2 2단계 **기준 2** — 지금 거부해 두면 나중에 여는 것은 호환 완화이고, 지금 열어 두면 닫는 것이 깨는 변경입니다.

⇒ **I-21 의 `from` 셋은 `NORMAL`·`INSPECTION_PENDING`·`DEFECTIVE` 이고 `SCRAPPED` 를 «뺍니다».** 그 요청은 400 `STATE_LOCKED` 입니다(e2e 로 잠급니다).

## ⚠ 그 대가

**오폐기는 데이터로 영구히 남습니다.** 폐기 판정이 사람의 자유 입력(`reason`) 하나로 결정되는 업무인데(`W-03-10` §2-1 「⭐ 처분 판정은 **사람이** 사유를 적고 판정자를 남기는 업무다」) 되돌림이 0인 것은 위험합니다.

📨 **오폐기 정정 경로를 정해 주십시오.** 셋 중 하나면 우리가 바로 반영합니다:
1. **되돌리는 전이를 연다** — 예: `SCRAPPED → INSPECTION_PENDING`(코드 하나 · `transitions.ts` 한 줄).
2. **처분 결정 취소 오퍼레이션을 연다** — `disposition_decision` 은 오늘 **기록 전용**(감사 칸·`version_no` 없음)이라 취소 흔적을 담을 자리부터 필요합니다.
3. **되돌리지 않는다** — 그러면 `W-03-10` §8 #9 를 「정정 경로 없음」으로 닫고 화면이 **저장 전 확인 대화**로 막는 것이 유일한 방어입니다.

## 흔적

`docs/coverage-100/slices/I-21.md` §6-2 · §9-1 **#9** · §8-3 e2e **#38** · `src/core/document-state/transitions.ts`(전이 전건) ·
`contracts/quality-03품질.json:2460`·`:4472`(「불량(Hold)은 발신 전이가 0」) ·
`.design-reference/…/screens/03/W-03-10-처분판정처리.md` §6·§8 #9 · **통보 071**(형제) · **통보 088**(400 `STATE_LOCKED` 선례) · **통보 089** §1.
