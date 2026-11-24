-- 피처 015 자재 기준 생산 추적·제품 기준 역추적(omf-all-around#355) — 공급사 LOT 번호 찾기 인덱스와 화면 권한 승계.
-- 기존 행은 바꾸지 않는다(forward-only). W-02-09 부여는 옛 화면이 내려갈 때까지 남긴다.

-- ① 공급사 LOT 번호로 관리 LOT 을 찾는다(번호 풀기 trace-starts · R-5). 지금까지 이 칸에는 인덱스가 없었다.
CREATE INDEX ix_lot_external_identifier_value ON trace.lot_external_identifier (identifier_type_code, external_identifier);
COMMENT ON INDEX trace.ix_lot_external_identifier_value IS '공급사 LOT 등 외부 식별 번호로 LOT 찾기(피처 015 번호 풀기)';

-- ② W-02-09(LOT 생산 이력 조회)를 가진 역할에 새 두 화면 권한을 준다 — W-02-13 자재 기준 생산 추적, W-02-14 제품 기준 역추적.
--    배포 사이에도 지금 사용자가 그대로 추적할 수 있게 한다(시드는 기본 역할에 권한을 주지 않는 관례 · 20261112090000 선례).
INSERT INTO app.role_permission (role_id, permission_code)
SELECT rp.role_id, v.new_code
  FROM app.role_permission rp
  JOIN (VALUES ('W-02-09', 'W-02-13'), ('W-02-09', 'W-02-14')) AS v(old_code, new_code)
    ON rp.permission_code = v.old_code
ON CONFLICT (role_id, permission_code) DO NOTHING;
