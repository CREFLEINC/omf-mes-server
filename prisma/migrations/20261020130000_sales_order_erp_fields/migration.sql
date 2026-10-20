-- ERP 수주에서 받아 온 그대로 담는 칸. 제품출하 실적을 ERP 로 돌려보낼 때 수불유형·출고창고를
-- 원래 값으로 실어야 한다(둘 다 필수). 수주유형은 반품(RFOC)·무상출고(FOC)를 가른다.
-- 이름(_NM)은 담지 않는다 — 공통코드 SO_TYPE·SALE_GROUP·SL_TYPE 에서 찾는다.
ALTER TABLE logistics.sales_order
    ADD COLUMN erp_order_type_code    varchar(5),
    ADD COLUMN erp_movement_type_code varchar(3),
    ADD COLUMN erp_sales_group_code   varchar(4);

-- ERP 는 라인 단위로 취소(CREATE_TYPE=C)하는데 라인에 상태 칸이 없다 — 지우지 않고 취소 시각만
-- 남긴다.
ALTER TABLE logistics.sales_order_line
    ADD COLUMN erp_storage_location_code varchar(7),
    ADD COLUMN cancelled_at              timestamptz;
