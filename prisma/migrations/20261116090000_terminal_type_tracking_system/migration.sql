-- 외부 추적 시스템(flowtrack)이 MES 를 부르는 단말 유형(사용자 결정 2026-11-12 · flowtrack 연동 제안 §1-1 의 2).
-- 배포는 migrate deploy 만 돌고 시드를 안 돌린다 — seed.ts 에도 같은 줄을 둔다. 값만 더하므로 옛 코드와 함께 산다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'TRACKING_SYSTEM', '추적 시스템 연동', 30
FROM mdm.code_group cg
WHERE cg.group_code = 'TERMINAL_TYPE'
ON CONFLICT (code_group_id, code) DO NOTHING;
