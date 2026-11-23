-- 없앤 화면 권한(W-03-09 품질 승인 처리 · 특채 결재 제거 · omf-all-around#352) — 앱이 이미 숨기는 부여를 지운다.
DELETE FROM app.role_permission WHERE permission_code = 'W-03-09';
