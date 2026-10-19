-- ERP 제조오더에서 받아 온 그대로 담는 칸. 생산입고 실적을 ERP 로 돌려보낼 때 공정번호를 원래
-- 값으로 실어야 한다 — `010` 과 `1` 이 섞여 와 숫자로 바꾸지 않는다.
-- 계획 시작일은 ERP 가 보내는 유일한 날짜다. 납기(due_date)와 뜻이 달라 따로 둔다.
ALTER TABLE planning.production_order
    ADD COLUMN erp_operation_no          varchar(3),
    ADD COLUMN erp_storage_location_code varchar(7),
    ADD COLUMN erp_rework_flag           varchar(2),
    ADD COLUMN planned_start_date        date;

-- 계획 시작일 변경의 «이전» 값. 한 행에 한 항목만 담는 제약을 넷째 칸까지 다시 건다.
ALTER TABLE planning.production_order_change_field
    ADD COLUMN before_planned_start_date date,
    DROP CONSTRAINT ck_po_change_field_single_value,
    ADD CONSTRAINT ck_po_change_field_single_value
        CHECK (num_nonnulls(before_order_qty, before_due_date, before_status_code,
                            before_planned_start_date) <= 1);
