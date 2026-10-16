-- 처분 정상·선별 양품으로 정상이 된 LOT 의 수입검사 대기 보류 해제 사유(품질 통합 · 장부 P-42).
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(089 §1). seed.ts 에도 같은 줄이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'DISPOSITION_NORMAL', '처분 정상(입고 가능)', 60
FROM mdm.code_group cg
WHERE cg.group_code = 'LOT_HOLD_RELEASE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
