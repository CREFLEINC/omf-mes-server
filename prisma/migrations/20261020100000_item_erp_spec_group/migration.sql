-- ERP 품목의 규격(SPEC)·품목그룹(ITEM_GROUP_CD)을 온 그대로 담는다. 9,813행 중 5,060·9,635행이
-- 채워져 오는데 담을 칸이 없었다. ERP 수신본이라 화면에서 고치지 않는다.
ALTER TABLE mdm.item
    ADD COLUMN erp_spec            text,
    ADD COLUMN erp_item_group_code varchar(10);
