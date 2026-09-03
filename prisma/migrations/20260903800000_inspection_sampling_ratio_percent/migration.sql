-- 샘플 비율의 «단위»를 계약에 맞춘다 — 비율(0~1)이 아니라 백분율(0 초과 100 이하)이다.
--
-- 계약 `InspectionPlanVersion.samplingRatio` 는 이렇게 적혀 있다.
--
--   「샘플 비율(%). 검사할 몫을 백분율로 지정한다 — 0 초과 100 이하」
--   x-internal-note: 「✓확정 2026-07-15 가 「샘플 비율(%)」로 정한 것이다. 앞서 물리
--   모델의 sampling_qty(수량)를 따라 «수량»으로 받았으나 2026-08-18 되돌렸다 —
--   물리 모델은 설계 결정을 앞설 수 없다(사용자 확정)」
--
-- 그런데 CHECK 는 `BETWEEN 0 AND 1` 이다. 즉 물리 모델이 아직 «비율»로 읽고 있다.
-- 계약대로 30(%)을 저장하면 CHECK 가 깨지고, CHECK 를 그대로 두면 화면이 0.3 을 보내야
-- 하는데 계약은 30 이라 적었다 — 둘 중 하나는 반드시 틀린다.
--
-- ⛔ 같은 숫자가 두 뜻을 갖는 자리라 조용히 틀린다. 0.3 을 백분율로 읽으면 0.3%,
--    비율로 읽으면 30% 다 — 검사 강도가 백 배 갈린다(공유계약 A-8 이 지목한 종류).
--
-- 기존 행이 없어(실측 0행) 값 변환은 필요 없다. 있었다면 ×100 이 함께 갔어야 한다.

ALTER TABLE quality.inspection_plan_version
    DROP CONSTRAINT ck_inspection_plan_sampling_ratio,
    ADD CONSTRAINT ck_inspection_plan_sampling_ratio
        CHECK (sampling_ratio IS NULL OR (sampling_ratio > 0 AND sampling_ratio <= 100));

COMMENT ON COLUMN quality.inspection_plan_version.sampling_ratio IS
  '샘플 비율(%). 0 초과 100 이하 — 비율이 아니라 백분율이다 (✓확정 2026-07-15).';
