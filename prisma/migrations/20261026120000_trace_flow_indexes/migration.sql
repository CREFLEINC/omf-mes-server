-- 입하~출고 추적(정·역방향 사슬)과 입고·출고 현황이 LOT·품목·기간으로 찾는 자리에 인덱스를 단다. 추가만이라 옛 코드와 함께 산다.
-- 사슬은 LOT 하나에서 입고 줄·포장·W/O 의 생산 LOT 으로 건너가는데, 그 외래키 쪽에 인덱스가 없어 표를 통째로 훑었다.
-- ⚠ 정본 물리 모델에 없는 구현 측 추가분이다(20260805000000_add_warehouse_fk_indexes 와 같은 처지) — 모델링 SQL 에 역반영이 필요하다.

-- LOT → 그 LOT 의 입고 줄(자재입고·생산입고).
CREATE INDEX ix_goods_receipt_line_lot ON logistics.goods_receipt_line (lot_id);
-- 입고 현황의 품목 필터.
CREATE INDEX ix_goods_receipt_line_item ON logistics.goods_receipt_line (item_id);
-- 입고 현황·정방향 목록의 기간(+ 입고 유형). 기간이 앞이라 유형을 고르지 않은 조회와 유형별 건수도 탄다.
CREATE INDEX ix_goods_receipt_datetime_type ON logistics.goods_receipt (receipt_datetime, receipt_type_code);
-- 생산 LOT → 그 LOT 을 담은 포장(취급 단위). 유일 키는 handling_unit_id 가 앞이라 LOT 으로는 못 탄다.
CREATE INDEX ix_handling_unit_content_lot ON inventory.handling_unit_content (lot_id);
-- W/O → 그 W/O 를 원천으로 발행한 생산 LOT.
CREATE INDEX ix_lot_source ON trace.lot (source_type_code, source_id);
-- 출고 현황의 품목 필터.
CREATE INDEX ix_shipment_line_item ON logistics.shipment_line (item_id);
-- 출고 현황·출하 목록의 기간(출하 일시).
CREATE INDEX ix_shipment_shipped_at ON logistics.shipment (shipped_at);
