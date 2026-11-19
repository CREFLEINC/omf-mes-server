-- 라인 없이 배포하는 자동 W/O(OA · PL13)의 자재 출고요청 출발 창고(사용자 결정 2026-11-19).
-- 범위는 공장만 받고 값은 그 창고의 코드다. 도착은 자재 차감 창고(BACKFLUSH_WAREHOUSE)다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다(20261116120000 선례).
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order)
SELECT cg.code_group_id, 'AUTO_ISSUE_SOURCE_WAREHOUSE', '자동 W/O 자재 출발 창고 코드', 190
  FROM mdm.code_group cg
 WHERE cg.group_code = 'OPERATION_POLICY'
ON CONFLICT (code_group_id, code) DO NOTHING;
