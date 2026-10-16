-- 검사 비대상·IQC 생략의 LOT 전이 코드와 보류 해제 사유(omf-all-around#105 · 2026-10-16 결정).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1).
--    seed.ts 에도 같은 줄을 둔다(새로 만드는 DB 의 동등성). 값만 더하므로 옛 코드와 함께 살 수 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
FROM mdm.code_group cg
JOIN (VALUES ('C21', '검사 비대상 → 정상', 140), ('C22', 'IQC 생략 → 정상', 150))
  AS v(code, code_name, display_order) ON TRUE
WHERE cg.group_code = 'LOT_STATUS_TRANSITION'
ON CONFLICT (code_group_id, code) DO NOTHING;

INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'INCOMING_INSPECTION_SKIPPED', '수입검사 생략', 50
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_HOLD_RELEASE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
