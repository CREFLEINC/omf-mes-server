-- 검사 수준 관리(W-03-12)를 검사 기준 관리(W-06-02)로 합친다(omf-all-around#357 · 사용자 지시 「검사 수준 권한이랑 검사 기준 권한 통합」).
-- 검사 수준을 바꾸던 역할이 계속 바꿀 수 있게 W-06-02 를 먼저 주고, 앱이 더는 쓰지 않는 W-03-12 부여를 지운다.
INSERT INTO app.role_permission (role_id, permission_code)
SELECT role_id, 'W-06-02'
  FROM app.role_permission
 WHERE permission_code = 'W-03-12'
ON CONFLICT (role_id, permission_code) DO NOTHING;

DELETE FROM app.role_permission WHERE permission_code = 'W-03-12';
