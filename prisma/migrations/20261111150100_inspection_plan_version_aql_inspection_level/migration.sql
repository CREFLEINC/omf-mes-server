-- AQL 샘플링(omf-all-around#264) — 검사 방식에 AQL 을 더하고, 버전에 AQL 검사 수준(KS Q ISO 2859-1 일반 G-I~G-III · 특별 S-1~S-4)을 둔다.
-- ⛔ 품목별 IQC 검사 수준(item_inspection_level — 무검사 · 수월 · 보통 · 엄격)과 다른 축이라 이름에 aql 을 붙인다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1 · P-39 선례). seed.ts 에도 같은 줄을 둔다.
--    값과 빈 칸만 더하므로 옛 코드와 함께 살 수 있다.
ALTER TABLE quality.inspection_plan_version
  ADD COLUMN aql_inspection_level_code app.code_t
    CONSTRAINT ck_inspection_plan_version_aql_level
      CHECK (aql_inspection_level_code IS NULL OR aql_inspection_level_code IN ('G-I', 'G-II', 'G-III', 'S-1', 'S-2', 'S-3', 'S-4'));

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'AQL', 'AQL 샘플링', 40
FROM mdm.code_group cg
WHERE cg.group_code = 'INSPECTION_SAMPLING_METHOD'
ON CONFLICT (code_group_id, code) DO NOTHING;
