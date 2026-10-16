-- 불량 기록 원천에 수입검사(IQC)를 더한다(omf-all-around#106 · 2026-10-16 결정).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1).
--    seed.ts 에도 같은 줄을 둔다. 값만 더하므로 옛 코드와 함께 살 수 있다.
-- ⚠ 수입검사 «공정» 행은 고객 기준정보라 여기 넣지 않는다 — deploy/seed/mes-iqc-process.sql(제시만).
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'IQC', '수입검사', 60
FROM mdm.code_group cg
WHERE cg.group_code = 'DEFECT_RECORD_SOURCE'
ON CONFLICT (code_group_id, code) DO NOTHING;
