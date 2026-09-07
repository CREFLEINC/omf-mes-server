# 085. 검사 결과 DRAFT 판정 칸 — required 인데 물리는 nullable

| 칸 | 내용 |
|---|---|
| 걸리는 오퍼레이션 | GET `/quality/inspection-results` · GET `/quality/inspection-results/{inspectionResultId}` (I-19 PR ②b) · POST `/quality/inspection-results`(I-19 PR ③ 에서 같은 갈래 재등장) |
| 구현 상태 | 구현함 — `overallJudgmentCode` 값이 없으면 **키를 생략**한다(선례 054 와 같은 모양) |
| 판정 | README §2 1단계 가장자리(`status_code='DRAFT' AND overall_judgment_code IS NULL` 행에서만 갈린다) → 2단계 기준 4(값을 조용히 도출하지 않는 쪽) · 0단계 선례 인용(`material-consumption-view.ts` `terminalId` · 문의 054) |
| 되돌릴 때 | 계약이 `InspectionResult.overallJudgmentCode` 형을 `["string","null"]` 로 열면 뷰를 「값 없으면 null」로 바꾼다 — 054 와 같은 결정이라 **함께** 회신 받고 싶다 |

## 사실

- `inspection_result.overall_judgment_code`는 원래 `NOT NULL`이었으나, 마이그레이션 `20260907174412_inspection_request_plan_and_result_draft_relax` ⓒ가 **nullable로 풀었다** — 계약 `InspectionResultCreate.overallJudgmentCode` 설명 「statusCode=확정 이면 필수다」(작성중은 비어도 된다는 뜻)을 물리로 표현하기 위해서다(P-02-13 §5-9 「임시 저장은 항상」).
- 그런데 읽기 계약 `InspectionResult.overallJudgmentCode`는 **`required` + `type:"string"`**(널을 형에 안 적음)로 닫혀 있다. `["string","null"]`이 아니다(python 실측 — `contracts/quality-03품질.json`).
- 결과: `status_code='DRAFT'`이고 아직 판정을 안 고른 행을 조회로 내릴 때, 이 칸을 채울 방법이 계약 문면 안에 없다.
  - 키를 생략하면 `required` 위반이다.
  - 값을 지어내면(예: 빈 문자열, 임의 enum) 공유계약 F-6(판정 불가를 지어내지 않는다) 위반이다.
  - `null`을 실으면 `type:"string"`(널 없음) 위반이다.

## 이미 있던 같은 모양의 자리 — 문의 054

`src/production/material-consumption/material-consumption-view.ts:5-12`의 `terminalId`가 정확히 같은 구조다 — 계약은 `required` + `type:"integer"`(널 없음)인데 물리 칸이 오늘 언제나 NULL이다(단말 토큰 검증 축이 아직 0건). 그 자리는 **키 생략**을 선택하고 문의 054로 이미 올라가 있다.

이번 자리도 같은 절차(README §2 2단계 기준 4)로 **키 생략**을 골랐다 — 셋 중 유일하게 "계약 문면이 명시로 금지하지 않은" 선택은 아니지만(엄밀히는 이것도 `required` 위반이다), 값을 지어내는 것보다는 덜 위험하고, 같은 저장소 안에 이미 선 선례와 일치한다.

## 요청

두 자리(054의 `terminalId`, 085의 `overallJudgmentCode`) 모두 "계약이 값을 채울 수 없는 상태를 설계하지 않은" 같은 종류의 결손이다. 다음 중 하나로 답해 달라.

1. 이런 칸은 전부 `["type","null"]`로 열고, 값이 없으면 `null`을 싣는 쪽으로 통일한다.
2. 이런 칸은 전부 `required`를 유지하되, "값이 없는 상태"(DRAFT · 단말 토큰 미검증) 자체를 별도 응답 스키마(예: `InspectionResultDraft`)로 가른다.
3. 그 밖의 규칙.

## 현재 구현이 하는 일 (되돌릴 때 참고)

- `inspection-result-view.ts`: `overallJudgmentCode: row.overall_judgment_code ?? undefined` — 값이 없으면 키를 생략한다.
- e2e(`test/quality-inspection-result.e2e-spec.ts`)에 `status_code='DRAFT' AND overall_judgment_code=NULL` 픽스처를 prisma로 직접 심고, 그 행이 `overallJudgmentCode` 키를 안 갖는다는 것을 단언한다. 전체 스키마 ajv 검증은 이 한 행에서는 **부르지 않는다** — 계약이 `required`로 적은 자리라 키 생략도 ajv 상 위반이고(선택지 3가지 모두 ajv 를 통과 못 시킨다), 그 간극 자체가 이 문의의 근거다.
- 회신이 1번(nullable)로 오면 `?? undefined`를 `?? null`로 한 줄만 바꾸면 된다. 2번(스키마 분리)으로 오면 PR ③(쓰기)이 함께 응답 스키마 분기를 설계해야 한다.

계약 사본 `a6a87e1`은 변경하지 않았다.
