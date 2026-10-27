-- 재발행 사유 「자재 LOT 수량 정정」(장부 P-121). 배포는 migrate deploy 만 돌고 시드를 안 돌려 마이그에 둔다 — seed.ts 에도 같은 줄이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'MATERIAL_QTY_CORRECTED', '자재 LOT 수량 정정', 70
FROM mdm.code_group cg
WHERE cg.group_code = 'REISSUE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
