-- ERP 발주에서 받아 온 그대로 담는 칸. 구매입고 실적을 ERP 로 돌려보낼 때 구매그룹·입출고유형·
-- 입고창고를 원래 값으로 실어야 한다(구매그룹·창고는 필수). 발주유형은 위탁가공·임가공을 가른다.
-- 이름(_NM)은 담지 않는다 — 공통코드 ORDER_TYPE·PUR_GROUP·SL_TYPE 에서 찾는다.
ALTER TABLE logistics.purchase_order
    ADD COLUMN erp_order_type_code     varchar(5),
    ADD COLUMN erp_purchase_group_code varchar(4),
    ADD COLUMN erp_io_type_code        varchar(5);

-- 창고는 라인마다 다를 수 있다(실데이터 1건). ERP 는 라인 단위로 취소(CREATE_TYPE=C)하는데
-- 라인에 상태 칸이 없다 — 지우지 않고 취소 시각만 남긴다.
ALTER TABLE logistics.purchase_order_line
    ADD COLUMN erp_storage_location_code varchar(7),
    ADD COLUMN cancelled_at              timestamptz;
