-- 처분 «선별»의 LOT 전이 코드와 분할 LOT 원천(omf-all-around#108 · 2026-10-16 담당자 지시).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1 · P-35 선례).
--    seed.ts 에도 같은 줄을 둔다. 값만 더하므로 옛 코드와 함께 살 수 있다.
-- ⚠ C21·C22 는 #105(검사 생략)가 쓴다 — 선별은 C23·C24 다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
FROM mdm.code_group cg
JOIN (VALUES ('C23', '처분 선별 → 정상(양품)', 160), ('C24', '처분 선별 → 불량(불량분 분할)', 170))
  AS v(code, code_name, display_order) ON TRUE
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'LOT_SPLIT', 'LOT 분할(선별 불량분)', 40
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_SOURCE_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;
