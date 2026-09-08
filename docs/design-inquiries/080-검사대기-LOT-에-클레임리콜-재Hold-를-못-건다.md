# 080. **검사 대기(`INSPECTION_PENDING`) LOT 에 클레임·리콜 재Hold(C9)를 못 건다** — C9 의 `from` 이 `NORMAL` 하나다

**구분: 통보**(회신을 기다리지 않는다 — `coverage-100/README.md` §2 1-1단계 「본질 아님 × 비용 낮음」)
⚠ 다만 **088 과 같은 뿌리**(「불량은 발신 전이가 0」)라 **묶어 봐 달라**.

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | POST `/quality/lot-holds` (I-20 PR ④) — `targetLotStatusCode='DEFECTIVE'`(C9) |
| 구현 상태 | 구현함 — `moveWithin()` 이 0건을 옮기면 **400 `STATE_LOCKED`** 로 거절하고 트랜잭션 전체를 되돌린다(`lot_hold` 도 안 남는다) |
| 판정 | §2 **0단계 선례** — I-19 `:confirm` 이 같은 자리(`from` 밖 단건 대상)에 이미 400 `STATE_LOCKED` 를 적었다(문의 088) · 2단계 **기준 1**(아무 상태도 안 쓴다)·**기준 2**(거부하는 쪽) |
| 되돌릴 때 | `transitions.ts` 의 `'lot-hold-claim'.from` 에 `'INSPECTION_PENDING'` **한 값**을 더하고, 아래 e2e 한 건(400 → 201)을 뒤집는다. 서비스 코드 변경 **0** |

## 사실 — 실측

`src/core/document-state/transitions.ts:210`

```ts
'lot-hold-claim':   { from: ['NORMAL'],                        to: 'DEFECTIVE',           transitionCode: 'C9'  },
'lot-hold-suspect': { from: ['NORMAL', 'INSPECTION_PENDING'],  to: 'INSPECTION_PENDING',  transitionCode: 'C10' },
```

두 액션 다 **같은 오퍼레이션**(`POST /quality/lot-holds`)이 부르는데 `from` 이 다르다.
⇒ 검사 대기 LOT 은 **의심자재 등록(C10)은 되고 클레임·리콜 재Hold(C9)는 400** 이다.

⚠ 이 좁은 `from` 은 우리가 지어낸 것이 아니다 — I-19 §0-재수립 R-1 이 계약 문자를 근거로 좁혔다:
「**불량(Hold)은 발신 전이가 0**」(`contracts/quality-03품질.json:4472`) · 화면 정본 `W-03-02` §5-5
도식 「Hold 수신 C6·C8·C9 / **발신 (없음)**」. 계약이 **C9 의 출발 상태를 직접 적은 자리는 없다.**

## 현장에서 이것이 무엇을 막나

「고객 클레임이 들어와 이미 **검사 대기**로 잡아 둔 LOT 을 **불량으로 재Hold** 한다」가 안 된다.
클레임은 출하 뒤에 오므로 그 LOT 이 마침 다른 사유(의심자재·수입검사)로 검사 대기에 있는 것은
드문 일이 아니다. 오늘 서버에서 그 요청은 **400** 이고, 화면은 「지금 LOT 상태에서는 이 보류를
걸 수 없습니다」를 본다.

⚠ **우회로는 있다** — 같은 요청을 `targetLotStatusCode='INSPECTION_PENDING'`(C10)으로 보내면
보류 행은 선다. 다만 그때 LOT 은 **불량으로 안 가고** 검사 대기에 머문다.

## 왜 조용한 200 을 안 골랐나

코어(`LotQualityStatusService.moveWithin`)는 `from` 밖 LOT 을 **건너뛴다** — C14 가 W/O 의
생산LOT «전체»를 옮기므로 하나가 섞였다고 확정이 통째로 막히면 안 되기 때문이다(I-19 R-7).
그 필연으로 단건·소수 대상에서도 「안 옮겨졌다」가 조용한 성공이 될 수 있다.

고르지 않았다 — 보류 행은 「도착 상태 `DEFECTIVE`」를 적어 두는데 LOT 은 `INSPECTION_PENDING`
에 남아 **결정 10 「상태 이중 보유 없음」**(공유계약 B-8)이 깨지고, 화면은 등록 성공 토스트를 본
뒤 LOT 카드에서 검사 대기를 본다. ⇒ **400 으로 거절하고 등록 자체를 되돌린다.**

## 요청 — 셋 중 하나로 확정해 달라

1. **C9 의 `from` 을 넓힌다** — `['NORMAL', 'INSPECTION_PENDING']`. 「불량은 발신 0」은 그대로고
   **수신**이 하나 느는 것이라 계약 문자와 충돌하지 않는다. 우리가 보기에 가장 자연스럽다.
2. **그대로 막는 것이 맞다** — 검사 대기 LOT 의 클레임은 **먼저 검사를 확정**해 `NORMAL` 로 보낸
   뒤 재Hold 하는 흐름이 정본이라면 그 흐름을 화면(`W-03-03`)에 그려 달라.
3. **막되 안내가 다르다** — 400 대신 「C10 으로 걸어라」를 화면이 안내해야 한다면 그렇게 적어 달라.

⚠ **088 과 묶어 봐 달라.** 둘 다 「불량 축의 전이표를 얼마나 여느냐」 하나로 풀린다 —
088 은 `DEFECTIVE` **에서 나가는** 전이, 이것은 `INSPECTION_PENDING` **에서 불량으로 들어가는**
전이다. 답이 하나면 둘이 함께 풀린다.

## 관련

- `src/quality/lot-hold/lot-hold-write.service.ts` `stateLocked()` — 흔적 주석 `// 결정 — 통보 080`.
- e2e `test/quality-lot-hold.e2e-spec.ts` — 「INSPECTION_PENDING LOT 에 target=DEFECTIVE(C9)는
  400 `STATE_LOCKED` 이고 `lot_hold` 가 «한 행도» 안 남는다」가 이 판정을 잠근다.
- `docs/design-inquiries/088-DEFECTIVE-LOT-의-재검-합격-확정이-막힌다.md` — 같은 뿌리의 형제.
- `docs/coverage-100/slices/I-20.md` §3-1 「⚠ `from` 이 가르는 자리」.
