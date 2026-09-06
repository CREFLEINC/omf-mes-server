-- I-10 §2-5 · 재수립 R-3·R-4. 컬럼·테이블 삭제 0 — NOT NULL «완화»라 두 릴리스 규칙 미해당(오늘 두 표 0행 · 백필 없음).
-- M-1: 단말 토큰 검증 축·계약 security 선언이 0 이라 토큰 없는 호출을 400 으로 죽이지 않는 한 nullable 이어야 한다(문의 054).
ALTER TABLE production.material_consumption ALTER COLUMN terminal_id DROP NOT NULL;
-- M-2: 계약 MaterialReturnLine 요청·응답 어디에도 칸이 없고 RETURN_QUALITY_STATUS 코드 그룹도 0건 — 값을 만드는 대신 제약을 푼다(문의 053).
ALTER TABLE production.material_return_line ALTER COLUMN return_quality_status_code DROP NOT NULL;
