-- 계획 기반 출고 요청(피처 003 · omf-all-around#66) — 생산 창고의 쓸 수 있는 양이 0 이면 그 자재 줄은 「요청 0 · 부족 N」
-- 이다(US2-11 · US4-2). 요청 수량 CHECK 를 `> 0` 에서 `>= 0` 으로 푼다. 넓히기만 하므로 옛 코드(0 을 쓰지 않는다)와 함께 산다.
-- `issued_qty <= requested_qty`(ck_material_issue_line_qty)는 그대로다 — 요청 0 줄은 출고되지 않는다.
ALTER TABLE logistics.material_issue_request_line
    DROP CONSTRAINT material_issue_request_line_requested_qty_check,
    ADD CONSTRAINT material_issue_request_line_requested_qty_check CHECK (requested_qty >= 0);
