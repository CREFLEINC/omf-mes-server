# 073. `LotStatusSummary.outOfScopeCount` — `user_data_scope` 를 적용하는 조회가 저장소에 0건이다

**구분: 통보**(회신을 기다리지 않는다 — README §2 3단계 흔적 · 「본질 아님·비용 낮음」)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/lot-status-summary` (I-20 PR ①a2) |
| 구현 상태 | 구현함 — `outOfScopeCount` 키를 언제나 생략한다(0 으로 채우지 않는다) |
| 판정 | 0단계 선례 — `app.user_data_scope` 를 **적용하는**(WHERE 절에 거는) 조회가 저장소에 grep 실측 **0건**이다. 유일한 참조는 `src/auth/session.service.ts:26·40` 인데 로그인 세션에 값을 **싣기만** 하고, 그 값을 목록·요약 질의의 필터로 **쓰는** 코드가 없다. 2단계 기준 4(값을 조용히 도출하지 않는 쪽) — 0 을 지어내면 「없다」와 「모른다」가 같은 모양이 된다(공유계약 L-8 · `plan-uiux.md:1073`) |
| 되돌릴 때 | `user_data_scope` 가 실제 조회 WHERE 절에 걸리는 슬라이스가 생기면 이 칸을 채운다. 응답 타입(`LotStatusSummaryView`)에 이미 선택 칸으로 자리를 남겨 뒀다(`src/quality/lot-status/lot-status.service.ts`) — 코드 변경은 그 슬라이스가 값을 채우는 한 줄뿐이다 |

## 사실

- 계약 `LotStatusSummary.outOfScopeCount` 설명 — 「권한 범위(`user_data_scope`) 밖이라 목록에 안 나온 건수. ⚠ 「없다」와 구분되지 않는 문제를 화면이 문구로 푼다. 근거: `W-03-01` §6 · §8-6」.
- `app.user_data_scope` 테이블 자체는 실재한다(`business_unit_id` · `plant_id` · `ck_user_data_scope_target`(둘 중 하나는 NOT NULL)).
- 그러나 이 값을 **필터로 적용하는** 코드는 저장소 전체에 0건이다(grep 실측). `session.service.ts:26·40` 이 로그인 시 세션에 값을 담는 것이 유일한 사용처이고, 그 세션 값을 이후 어떤 조회의 WHERE 절에 다시 쓰는 자리가 없다.

## 우리가 한 것

권한 범위 필터가 애초에 걸리지 않으므로 **이 조회는 언제나 전건을 본다** — "범위 밖으로 빠진 LOT"이라는 것 자체가 지금 존재하지 않는다. 그래서 `outOfScopeCount` 를 0 으로 채우지 않고 **키를 생략**했다(`src/quality/lot-status/lot-status.service.ts` — `LotStatusSummaryView` 에 그 칸을 아예 만들지 않는다). 0 을 내리면 "범위 필터가 걸렸는데 범위 밖이 0건"과 "범위 필터가 아예 없다"가 같은 응답 모양이 되어(L-8 위반), 나중에 범위 필터가 실제로 걸리기 시작해도 과거 응답과 구분할 수 없다.

## 통보 — 답을 기다리지 않는다

이 판정은 README §2 2단계 기준 4(도출 안 함)로 결정 비용이 낮고 본질적인 설계 문제가 아니라고 판단해 **문의가 아니라 통보**로 남긴다. `user_data_scope` 를 실제로 적용하는 조회가 이후 슬라이스에서 생기면, 그 구현을 참고해 이 칸을 채우는 후속 작업을 별도로 연다.
