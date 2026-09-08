-- 검사 의뢰·결과 물리 완화 3 — 기준 없는 의뢰 · 임시 저장(DRAFT) 두 칸.
--
-- 요청: 계약 되돌림 #280(검사 의뢰 기준 완화) · `docs/server-architecture.md` §6
--       「그 도메인 첫 PR 앞에 마이그레이션을 둔다」
-- 계약: quality-03품질.json 의 InspectionRequest.inspectionPlanVersionId([integer,null]) ·
--       InspectionResultCreate.statusCode / .overallJudgmentCode
-- 계획: docs/coverage-100/slices/I-19.md §0 #3 · §2-4 · 재수립 R-2
--
-- ⭐ 셋 다 «완화»다 — 추가 0 · 삭제 0 · 백필 0. 지금 통과하는 행은 전부 그대로 통과한다.
--    그래서 세 레인의 마이그가 뒤섞인 순서로 들어와도 순서에 의존하지 않는다(lanes.md §1-2).

-- ── ⓐ 검사 기준 없이도 의뢰가 선다 (#280) ───────────────────────────────────
--
-- 계약이 이 칸을 `[integer, null]` 로 적고 근거까지 붙였다 — 「검사 기준이 등록되지 않은
-- 상태에서도 검사를 진행한다는 고객 확정(2026-07-15)」. 물리만 NOT NULL 이라 그 갈래를
-- «표현할 수가 없다»: 기준 미등록 품목의 의뢰를 심으면 23502 로 튕긴다.
--
-- 비는 쪽이 예외가 아니라 설계된 갈래다. 비면 화면(P-02-13 §5-2)은 항목별 규격 표를
-- 접고 종합 판정 선택과 자유 입력만 그린다.

ALTER TABLE quality.inspection_request
    ALTER COLUMN inspection_plan_version_id DROP NOT NULL;

COMMENT ON COLUMN quality.inspection_request.inspection_plan_version_id IS
    '이 의뢰가 따르는 검사 기준 버전. 비어 있을 수 있다 — 기준 미등록 품목도 검사를 진행한다(✓확정 2026-07-15). 비면 항목별 규격이 없어 결과는 수량 세 칸·종합 판정·자유 입력만으로 성립한다(P-02-13 §5-2). ⚠ IQC·OQC 의뢰는 서버가 언제나 채워 내린다(W-01-01 §4 · W-04-03 §4). 근거: 계약 #280 · omf-mes#251.';

-- ── ⓑ 수량 합계 강제를 «확정일 때»로 좁힌다 ─────────────────────────────────
--
-- 계약이 조건을 직접 적었다: 「⛔ statusCode=확정 이면 acceptedQty + rejectedQty +
-- heldQty = inspectedQty 를 강제한다(ck_inspection_result_qty · 공유계약 A-3).
-- **작성중은 통과시킨다**」(quality-03품질.json:3789).
--
-- 지금 CHECK 는 조건이 없다(baseline `:1870-1871`). 검사원이 세 칸을 다 채우기 전에
-- 임시 저장하면 DB 가 튕기고 API 는 P2010/500 을 낸다 — 임시 저장의 «본길»이 막힌다.
--
-- ⛔ DROP → ADD 지만 «삭제»가 아니라 같은 이름 제약의 완화다. 이름을 바꾸지 않는다.
-- 선례: 20260901010000 이 ck_lot_initial_qty 를 같은 모양으로 갈았다.

ALTER TABLE quality.inspection_result DROP CONSTRAINT ck_inspection_result_qty;
ALTER TABLE quality.inspection_result
    ADD CONSTRAINT ck_inspection_result_qty
        CHECK (status_code <> 'CONFIRMED'
               OR accepted_qty + rejected_qty + held_qty = inspected_qty);

-- ── ⓒ 임시 저장에는 종합 판정이 아직 없다 ───────────────────────────────────
--
-- ⓑ 만으로는 임시 저장이 여전히 막힌다. 계약 InspectionResultCreate 의 required 10칸에
-- overallJudgmentCode 가 «없고» 그 설명이 「statusCode=확정 이면 필수다」라 조건을
-- 명시한다 — 즉 작성중에는 판정이 비어 있어도 된다. 물리는 NOT NULL 이라 같은 지점에서
-- 23502 로 튕긴다. 두 칸을 함께 풀어야 「임시 저장은 항상」(P-02-13 §5-9)이 성립한다.
--
-- ⚠ 확정 시 필수는 여기서 CHECK 로 박지 않는다 — status_code 는 공통코드 소유라 값
--    문자열을 제약에 박으면 죽는다(20260901010000 의 'PREISSUED' 가 그 선례다). ⓑ 는
--    이미 baseline 이 박아 둔 이름을 «완화»하는 것이라 성격이 다르다. 확정 경로의 판정
--    필수는 서비스가 400 REQUIRED 로 막는다(I-19 PR ③·④).
-- ⚠ 읽기 계약(InspectionResult)은 overallJudgmentCode 를 required 로 둔다 — 작성중 행을
--    내리는 조회(PR ②b)가 그 갈래를 어떻게 그릴지는 그 PR 이 판정한다.

ALTER TABLE quality.inspection_result
    ALTER COLUMN overall_judgment_code DROP NOT NULL;

COMMENT ON COLUMN quality.inspection_result.overall_judgment_code IS
    '종합 판정 — ACCEPTED(합격)·REJECTED(불합격)·HELD(보류). 값 목록은 공통코드 INSPECTION_RESULT_OVERALL_JUDGMENT 가 갖는다(제약에 박지 않는다). 작성중(DRAFT)에는 비어 있을 수 있고 확정(CONFIRMED)에는 반드시 있다 — 그 필수는 서비스가 400 REQUIRED 로 막는다. 근거: 계약 InspectionResultCreate.overallJudgmentCode 「statusCode=확정 이면 필수다」 · 회신 E-3 종결 2026-08-07 · P-02-13 §5-9.';
