-- 교대 관리(omf-all-around#318) — 새 기준정보 화면 W-06-26 권한을 공장 근무일 설정(W-CO-15) 보유 역할에 준다.
-- 둘 다 공장별 근무 시간 기준을 정하는 일이라 같은 사람이 맡는다. 표·칸은 바꾸지 않는다(mdm.shift 그대로).
-- 시드는 기본 역할에 권한을 주지 않는 관례라 기존 DB 는 여기서 준다(20261125090000 선례).
INSERT INTO app.role_permission (role_id, permission_code)
SELECT rp.role_id, 'W-06-26'
  FROM app.role_permission rp
 WHERE rp.permission_code = 'W-CO-15'
ON CONFLICT (role_id, permission_code) DO NOTHING;
