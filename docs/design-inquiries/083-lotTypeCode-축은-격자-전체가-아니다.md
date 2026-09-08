# 83. `LotStatusSummary.counts` — `lotTypeCode` 축은 격자 전체(4×3)가 아니다

**구분: 통보**(회신을 기다리지 않는다 — README §2 3단계 흔적 · §2 2단계 기준 4)

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/lot-status-summary` (I-20 PR ①a2) |
| 구현 상태 | 구현함 — `statusCode` 축은 `LOT_STATUS` 4값 전건(행이 없어도 `lotCount:0`), `lotTypeCode` 축은 **실재하는 조합만** 낸다(격자 전체를 지어내지 않는다) |
| 판정 | 2단계 기준 4(값을 조용히 도출하지 않는 쪽) — `docs/coverage-100/README.md` §2 |
| 되돌릴 때 | `W-03-01` 이 유형 축도 격자 전체(그리드)로 그린다고 확정하면, 상태가 0건일 때도 `lotTypeCode` 3값(`MATERIAL`·`PRODUCTION`·`PRODUCT`) 각각에 `lotCount:0` 행을 낸다 — `countsOf()` 한 곳만 고치면 된다 |

## 사실 — 계약은 침묵한다

- `LotStatusCount.lotTypeCode` 는 **optional**(`required = [statusCode, lotCount]`)이다. 이것은 「생략해도 스키마를 통과한다」일 뿐 「격자를 채우지 마라」가 아니다 — **희소 격자와 4×3 완전 격자가 둘 다 ajv 를 통과한다.**
- 4×3 을 만들 재료도 계약에 있다 — `lotTypeCode` 설명이 값 3종(`MATERIAL`·`PRODUCTION`·`PRODUCT`)을 직접 적었고 시드에도 3값이 있다. 즉 **실행 가능한 대안이 실재하는 진짜 갈림길**이다.
- `W-03-01` §5-4(`:205~234`)는 상태 축(정상·불량·검사대기·폐기)만 다루고 유형(자재·생산·제품)은 그 절에 **한 번도 등장하지 않는다**(grep 실측). L-7(`:249`)은 「합치지 마라」만 말할 뿐 「격자 전체를 내라」는 말하지 않는다.

## 우리가 한 것

`LOT_STATUS` 4값은 R-16(`W-03-01:209`)이 문자로 못 박아 **전건**이 본길이다. 그러나 `lotTypeCode` 축은
같은 근거가 없다 — 상태 자체가 0건이면 그 상태의 LOT 이 어느 유형인지 **알 길이 없다**(「모른다」).
격자 전체(4×3=12)를 내려면 없는 조합에 `lotTypeCode` 값을 **지어내야** 하므로 §2 2단계 기준 4(값을
조용히 도출하지 않는 쪽) 위반이다. `countsOf()` 는 상태별로 **실재하는 `(statusCode, lotTypeCode)`
조합만** 내고, 상태 자체가 0건이면 `lotTypeCode` 키를 생략한 `{statusCode, lotCount:0}` 한 행만 낸다.

## 통보 — 답을 기다리지 않는다

이 판정은 §2 2단계 기준 4로 결정 비용이 낮아 **문의가 아니라 통보**로 남긴다. 유형 축도 격자
전체로 그린다는 설계 확정이 오면, `countsOf()` 의 4값 루프를 `LOT_STATUS × LOT_TYPE` 12값 루프로
바꾸는 한 줄 변경으로 되돌린다.

## 관련

- `docs/design-inquiries/073-outOfScopeCount-적용-조회-0건.md` — 같은 조회의 자매 판정(칸 생략 원칙 L-8)
- `src/quality/lot-status/lot-status.service.ts` `countsOf()` 코드 주석 — `// 결정 — 통보 083`
