-- 계획 기반 출고 요청(피처 003 · omf-all-around#66) — 요청 0 줄의 뜻을 칸에 적고, 부족 칸이 음수가 되지 않게 막는다.
-- 더하기만 한다(기존 행의 shortage_qty 는 기본값 0).
ALTER TABLE logistics.material_issue_request_line
    ADD CONSTRAINT ck_material_issue_line_shortage CHECK (shortage_qty >= 0);

COMMENT ON COLUMN logistics.material_issue_request_line.requested_qty IS
    '요청 수량. 0 은 새 규칙 요청(출발 창고 있음)에서만 생긴다 — 생산 창고의 쓸 수 있는 양이 없어 소요 전부를 shortage_qty 로 남긴 줄. 피킹은 요청 0 줄을 건너뛴다.';
