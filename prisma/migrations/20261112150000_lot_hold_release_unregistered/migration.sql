-- 입하 등록 해제가 닫는 검사 대기 보류의 해제 사유(피처 005 · omf-all-around#254 · 총괄 결정 2026-11-12).
-- S4 는 값이 없어 MANAGER_OVERRIDE 를 썼다 — 사람이 보류를 직권으로 푼 것과 이력에서 가르려고 값을 따로 둔다.
-- ⭐ 시드가 아니라 마이그인 이유 — 배포는 migrate deploy 만 돌고 시드를 안 돌린다. seed.ts 에도 같은 줄이 있다.
INSERT INTO mdm.code_value (code_group_id, code, code_name, display_order, name_ko, name_vi)
SELECT cg.code_group_id, 'LOT_UNREGISTERED', '입하 등록 해제', 80, '입하 등록 해제', 'Hủy đăng ký nhận hàng'
  FROM mdm.code_group cg
 WHERE cg.group_code = 'LOT_HOLD_RELEASE_REASON'
ON CONFLICT (code_group_id, code) DO NOTHING;
