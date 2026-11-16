-- 추적 시스템(flowtrack) 연동의 운영 정책 코드 둘(사용자 결정 2026-11-12 · flowtrack 연동 제안 §1-1 의 9).
-- 자동 라우팅 공정 · 자재 차감 창고. 범위는 공장만 받고 값은 그 공정·창고의 코드다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(003 · 004 선례).
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, v.code, v.code_name, v.display_order
  FROM mdm.code_group cg
 CROSS JOIN (VALUES ('AUTO_ROUTING_PROCESS', '자동 라우팅 공정 코드', 170),
                    ('BACKFLUSH_WAREHOUSE', '자재 차감 창고 코드', 180))
       AS v(code, code_name, display_order)
 WHERE cg.group_code = 'OPERATION_POLICY'
ON CONFLICT (code_group_id, code) DO NOTHING;
