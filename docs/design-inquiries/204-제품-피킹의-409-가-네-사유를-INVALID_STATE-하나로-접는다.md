# 204. 제품 피킹의 **409 가 네 거부 사유를 `INVALID_STATE` 하나로 접는다** — 화면이 문구를 가를 축이 0이다

**구분: 통보**(회신을 기다리지 않는다)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | `POST /logistics/shipment-requests/{id}/lines/{lineId}:pick` |
| 구현 상태 | **구현 예정(I-22 PR ⑥)** — `message` 문구 규약을 세운다 |
| 판정 | §2 **0단계**(계약 409 description 이 사유 셋을 직접 적었다) → 코드가 모자라 **`message` 로 가른다** |
| 되돌릴 때 | enum 이 늘면 `code` 를 갈아 끼우는 네 줄 |

## 계약이 요구하는 것

`:pick` 의 409 description: 「충돌 — **LOT 이 Hold 이거나 가용이 모자라거나 배정을 넘는다**」
`x-internal-note`: 「서버가 막는 것 셋 — ① `lot_hold` 가 걸린 LOT ② 가용 수량 초과 ③ `allocatedQty − pickedQty` 초과. **잔여 유효기간 하한도 서버가 판정한다**」

`M-04-01` §6 이 그릴 문구는 **넷**입니다:

| 상황 | 화면 문구 |
|---|---|
| Hold LOT | 「⛔ Hold — 집을 수 없습니다」 **+ 보류 사유 표시** |
| 가용 0 | 「다른 출하에 배정됐습니다」 |
| 배정 초과 | 「배정 **300** 을 넘을 수 없습니다」 |
| 잔여 유효기간 미달 | 「고객 요구 **180일** 미달(실제 **92일**)」 |

## ⛔ 봉투가 그 넷을 못 담습니다

`ShipmentConflictResponse` 는 **`code` + `message`**(+`currentVersion`·`conflictCause`) 뿐입니다 — **`errors[]` 도 `field` 도 없습니다.**
`code` 의 enum 은 `VERSION_CONFLICT`·`DUPLICATE_KEY`·`INVALID_STATE`·`ALREADY_CONFIRMED`·`CANCEL_IN_PROGRESS` **다섯**이고 **네 사유를 가를 값이 하나도 없습니다.**

⚠ 그런데 **같은 계약의 `ErrorItem.code` example 이 `QTY_EXCEEDS_ALLOCATION`** 이고 `field` example 이 `shippedQty` 입니다 — 04 스스로 「배정 초과」를 **400 필드 오류의 코드 이름**으로 한 번 적어 두었습니다.

## ⇒ 우리가 정한 것

- 세 업무 거부는 **409 `code='INVALID_STATE'`** 입니다(01 자재 피킹의 409 는 «저장 충돌» 봉투 `ConflictResponse` 라 결이 다릅니다 — 계약 `x-internal-note` 가 그 가름을 직접 적었습니다).
- **잔여 유효기간 미달은 400 `RANGE`** 로 옮겼습니다 — 계약 409 사유 셋에 없고, 「재로드하면 풀린다」는 409 의 뜻과 반대입니다(시간이 갈수록 나빠집니다).
- ⭐ **`message` 가 넷을 가르고 숫자·사유를 싣습니다:**

| 사유 | `message` 규약 |
|---|---|
| 보류 LOT | `보류 중인 LOT 입니다. (사유: {holdReasonCode})` |
| 가용 부족 | `가용 재고가 모자랍니다. (가용 {available})` |
| 배정 초과 | `배정 수량을 넘습니다. (배정 {allocated} · 이미 피킹 {picked})` |
| (400) 유효기간 | `잔여 유효기간이 모자랍니다. (요구 {min}일 · 실제 {actual}일)` |

- 검사 순서는 계약 문장 순서 그대로 **① Hold → ② 가용 → ③ 배정**입니다(셋에 동시에 걸리면 **첫 사유**가 나갑니다).

## 📨 알려 드리는 것

**`ShipmentConflictResponse` 에 사유를 가를 축을 주십시오** — 셋 중 하나면 됩니다:
ⓐ `code` enum 에 `LOT_HELD`·`INSUFFICIENT_AVAILABLE`·`QTY_EXCEEDS_ALLOCATION` 을 더한다 ·
ⓑ `errors[]`(=`ErrorResponse` 모양)를 함께 허용한다 ·
ⓒ 이 셋을 **400 `ErrorItem`** 으로 내리게 한다(그러면 `field`·`code` 가 그대로 살아납니다).

지금은 **POP 화면이 자유 텍스트 `message` 를 파싱하지 않고는 네 문구를 가를 수 없습니다.**

## 흔적

`docs/coverage-100/slices/I-22.md` §1-6 · §3-2 · §3-4 · §8-4 **P-16~P-26·P-37** · §0-재수립 **R-4·R-18** ·
`contracts/shipment-04제품출하.json`(`ShipmentConflictResponse`·`ErrorItem`·`:pick` 409 · python) ·
`M-04-01` §6(설계 사본) · `src/common/errors/conflict.exception.ts:55` · **통보 077**(409 `code` 자리).
