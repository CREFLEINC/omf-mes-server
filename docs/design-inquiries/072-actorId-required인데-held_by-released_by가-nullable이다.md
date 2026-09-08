# 072. `LotHoldEvent.actorId` 가 계약 required 인데 물리(`held_by`/`released_by`)는 nullable 이다

**구분: 통보**(회신을 기다리지 않는다 — README §2 3단계 흔적 · 「본질 아님·비용 낮음」)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/lot-hold-events` (I-20 PR ②b) |
| 구현 상태 | 구현함 — `actorId`·`actorName` 이 없으면 두 키를 함께 생략한다(0 이나 null 을 채우지 않는다) |
| 판정 | 0단계 선례 — I-19 §12-1 ⓐ 가 `QualityConflictResponse.code` 의 required 결손을 같은 모양(키 생략 + e2e 특성화)으로 남겼다. 2단계 기준 3(스키마를 안 늘리는 쪽) — nullable 물리 칸을 억지로 채우지 않는다 |
| 되돌릴 때 | `held_by`/`released_by` 를 항상 채우도록 물리·코어를 바꾸는 슬라이스가 생기면(예: NOT NULL 제약 추가) 이 통보는 자연히 해소된다 — 지금은 옛 행(코어가 아직 안 채우던 시절의 입하 보류)이 실제로 비어 있다 |

## 사실

- 계약 `LotHoldEvent.required` 6개(`lotHoldId`·`eventTypeCode`·`occurredAt`·`lotId`·`lotNo`·`actorId`) 중 `actorId` 가 「등록이면 `held_by`, 해제면 `released_by`」로 설명된다.
- 물리 `trace.lot_hold.held_by`·`released_by` 는 둘 다 `BigInt?`(nullable) — `app_user` 삭제·미기재 등을 대비한 기록 전용 칸이다(`prisma/schema.prisma:3625,3627`).
- 우리가 새로 만드는 쓰기 셋(`core/lot/lot-registry.service.ts` 의 입하 보류 등록 · I-19 `:confirm` 의 해제 · I-20 PR ④⑤ 의 등록·해제)은 로그인 사용자를 언제나 채운다 — 하지만 이미 쌓인 옛 행(코어가 그 칸을 채우기 시작하기 전에 태어난 것)은 비어 있을 수 있다.

## 우리가 한 것

`LotHoldEventView.actorId`/`actorName` 을 옵셔널로 두고, 물리 값이 NULL 이면 `omitEmpty` 로 두 키를 함께 생략한다(`lot-hold-event-query.ts:lotHoldEventView`). e2e(`test/quality-lot-hold.e2e-spec.ts` — `held_by 가 NULL 인 보류는 actorId·actorName 키가 «없다»`)가 EVLEGACY 픽스처(`held_by` 를 안 준 HELD 사건)로 그 특성을 잠갔다.

## 통보 — 답을 기다리지 않는다

계약 required 를 「항상 채운다」로 억지로 맞추려면 물리에 없는 값을 지어내야 한다(0 이나 가짜 사용자 id) — 이는 §2 2단계 기준 4(값을 조용히 도출하지 않는 쪽)에 정면으로 걸린다. 키 생략이 더 정직한 표현이라 판단해 **문의가 아니라 통보**로 남긴다.
