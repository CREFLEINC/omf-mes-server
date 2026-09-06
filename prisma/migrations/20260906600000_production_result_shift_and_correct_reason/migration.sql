-- I-7 선행 커밋 · D1 · D2 (I-7.md §2-2)
--
-- 완화 1 · 추가 1 · 삭제 0 — forward-only 이고 두 릴리스 규칙 미해당. 백필 0.
--
-- 사전 대조(마이그 «전» 개발 DB 실측 · 읽기만):
--   SELECT count(*) FILTER (WHERE shift_id IS NULL) AS null_shift, count(*) AS total
--     FROM production.production_result;                       -- → null_shift=0 · total=0
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_schema='production' AND table_name='production_result'
--      AND column_name IN ('shift_id','correct_reason_code');  -- → shift_id=NO · 뒤 칸은 «없음»
--
-- ── D1. production.production_result.shift_id 의 NOT NULL 해제 ──────────────
-- 계약 `ProductionResult.shiftId` 가 «선택»이고 `ProductionResultCreate` 에는 칸조차 없다.
-- x-internal-note: ⌜교대는 «설계가 정의하는 값이 아니다»(2026-08-18 사용자 확정) — 작업
--   실적 등록 화면은 교대를 받지 않는다. … 속성은 남기되 «필수를 풀었다». ⛔ 화면이 이
--   값에 의존해서는 안 된다. 📨 모델의 NOT NULL 은 작업 통지 대상이며 우리를 막지 않는다⌝.
-- ⛔ 기존 FK `production_result_shift_id_fkey` 를 건드리지 않는다 — DROP NOT NULL 은 FK 와
--    무관하고, 제약 이름을 손으로 다시 지으면 `migrate diff` 가 드리프트를 낸다.
ALTER TABLE production.production_result ALTER COLUMN shift_id DROP NOT NULL;

-- ── D2. production.production_result.correct_reason_code 추가 ───────────────
-- 계약 `ProductionResultCorrect.reasonCode` 가 **required** 인데 담을 칸이 물리에 없다
-- (실측: production 스키마의 `%reason%` 칸 10개 중 이 표의 것은 late_entry_reason_code
--  하나뿐이고, 형제 material_consumption 에는 change_reason_code 가 «있다»).
-- README §5 ⌜물리 모델과 계약이 다르면 «물리»를 고친다⌝. nullable 이라 원본 행은 빈다.
-- `app.code_t` 는 varchar(50) CHECK (VALUE <> '') 다 — nullable 로 붙는다(I-3 A3 선례).
ALTER TABLE production.production_result ADD COLUMN correct_reason_code app.code_t;
