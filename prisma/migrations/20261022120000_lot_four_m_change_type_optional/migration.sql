-- 4M 변경품의 변경 종류를 선택으로 — IQC 화면은 비고만 받는다(omf-all-around#133 · 장부 P-105).
-- 기존 기록의 종류는 그대로 둔다. 비고 필수는 API 가 막는다(기존 기록에 비고 없는 줄이 있을 수 있어 컬럼은 그대로).
ALTER TABLE quality.lot_four_m_change ALTER COLUMN change_type_code DROP NOT NULL;
