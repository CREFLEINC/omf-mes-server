# 33. 취소 승인이 반려되면 `CANCEL_REQUESTED` 를 되돌릴 경로가 없다 — `W-CO-09` §5-5·J-6 은 «재상신»을 전제하는데 취소 판정 순위 3 이 영구히 막는다

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel` · `:cancel` · `POST /app/approval-requests/{id}:reject` · 조회 `DocumentProgress.cancellable`·`cancelBlockedReasonCode` |
| 구현 상태 | **구현함(계약 문자 그대로 · 되돌리는 전이 0)** — `document-cancel` 전이는 `CANCEL_REQUESTED` 에서만 열리고, 반려 뒤 `CANCEL_REQUESTED` 를 `REGISTERED`/`POSTED` 로 되돌리는 전이·오퍼레이션을 **만들지 않는다**. 그 문서는 조회에서 `cancellable=false` · `CANCEL_IN_PROGRESS` 로 보인다 |
| 판정 | `coverage-100/README.md` §2 **1단계 본길**(반려된 모든 취소) · **계약 침묵** — 되돌리는 오퍼레이션이 계약에 0건이라 「지어내지 않는다」 · 상태기계는 표에 없는 전이를 던지므로(F-6) 잠김이 우리가 만든 자물쇠가 아니라 계약의 모양이다 |
| 되돌릴 때 | 「반려 뒤 재상신 허용」으로 오면 `document-request-cancel` 전이의 `from` 에 `CANCEL_REQUESTED` 를 더하고, 취소 판정 순위 3 의 OR(「상태가 `CANCEL_REQUESTED` **또는** 열린 요청이 있다」)에서 상태 조건을 뗀다 — 두 자리 · 마이그 0. 「반려가 문서를 `REGISTERED`/`POSTED` 로 되돌린다」로 오면 `:reject` 훅에 전이 하나 |

## 무엇이 문제인가

취소는 반드시 승인을 탄다(`:request-cancel` 설명 ⌜승인 없는 취소 경로를 두면 흔적 없는 취소가 생긴다⌝). 상신하면 문서가 `CANCEL_REQUESTED` 로 옮겨지고 승인 요청이 생긴다. 승인되면 `:cancel` 이 실행한다.

**반려되면?** 승인 요청은 `REJECTED` 로 닫히지만 문서는 `CANCEL_REQUESTED` 에 머문다. 그 상태에서 —
- `:post` 는 안 된다(전이 `document-post` 는 `from:['REGISTERED']`).
- `:cancel` 은 안 된다(승인이 없다 — 400 `APPROVAL_REQUIRED`).
- **재상신도 안 된다** — 취소 판정 순위 3 이 「상태가 `CANCEL_REQUESTED`」만으로 `CANCEL_IN_PROGRESS` 를 돌려준다.

공통 승인 화면 `W-CO-09` §5-5 와 공유계약 J-6 은 반려 뒤 «재상신»을 전제한다(⌜반려는 진행 중이 아니고 다시 상신해야 한다⌝ — `error-codes.ts` 의 `APPROVAL_REQUIRED` 주석이 같은 문장을 인용한다). 그런데 문서 상태 축에서는 재상신으로 갈 길이 없다. 두 문서가 한 문서의 반려를 다르게 본다.

- 「취소 요청 철회」(`W-01-13` §5-7 액션표 ⌜결재 진행 중 — ⚠ 상신자만 · 승인된 뒤에는 불가(J-6)⌝)도 대응 오퍼레이션이 없으나, 그것은 **이미 열린 건**이다 — `W-04-10` §8 미결 5 「상신 철회 경로 없음 · 승인 계약 보강」의 둘째 사용처로 여기서는 인용만 한다.

## 지금 서버는

- `transitions.ts`: `document-request-cancel` `from:['REGISTERED','POSTED'] → CANCEL_REQUESTED` · `document-cancel` `from:['CANCEL_REQUESTED'] → CANCELLED`. 되돌리는 전이 없음. 주석 `// 반려 뒤 CANCEL_REQUESTED 를 되돌리는 오퍼레이션이 계약에 없다 — 되돌리는 전이를 만들지 않는다(I-5.md §6-5 · 문의 033)`.
- 취소 판정(조회·상신·실행이 같은 함수): 순위 3 `CANCEL_IN_PROGRESS` = 「`status_code = 'CANCEL_REQUESTED'` **또는** 열린(`PENDING`) 승인 요청이 있다」. 반려된 문서는 앞 조건으로 걸린다 — 되돌릴 경로가 없어 잠긴 상태이고, 화면은 결재함으로 안내한다.
- 단위 테스트 `취소 — 반려된 요청의 문서는 CANCEL_REQUESTED 에 머문다(되돌리는 전이가 없다)`.
- ⚠ 그래서 오늘 반려로 잠긴 문서를 푸는 길은 **DB 직접 수정뿐**이다(「알려둘 것」).

## 요청

1. **취소 승인이 반려되면 문서는 어디로 갑니까?** ⓐ 상신 전 상태(`REGISTERED`/`POSTED`)로 돌아간다 — 반려가 전이를 하나 일으킨다. ⓑ `CANCEL_REQUESTED` 에 머물되 재상신을 허용한다. ⓒ 지금처럼 머물고 잠긴다(운영이 손으로 푼다). `W-CO-09` §5-5 의 「재상신」은 ⓐ·ⓑ 어느 쪽입니까?
2. ⓐ 라면 — 그 전이를 **누가** 일으킵니까? `:reject` 가 대상 문서를 알고 되돌리는 것(승인 코어가 도메인 상태를 만진다)인지, 문서 쪽 오퍼레이션이 따로 필요한지 알려 주십시오.
3. 곁들여: 「취소 요청 철회」(`W-01-13` §5-7)는 `W-04-10` §8 미결 5 와 같은 답으로 닫아 주십시오 — 별도 오퍼레이션이 생기면 여기서도 같은 것을 씁니다.

우리 권고안(회신이 없으면 이대로 갈 값): **ⓒ — 계약 문자 그대로, 되돌리는 전이를 만들지 않는다.** ⓐ·ⓑ 어느 쪽으로 와도 두 자리 수정으로 끝나고 마이그레이션이 없어 뒤집기 쌉니다. 반대로 지금 되돌리는 전이를 지어내면 계약에 없는 상태 이동이 원장 밖에서 조용히 일어납니다.
