-- 창고를 가리키는 외래키 컬럼에 인덱스를 단다.
--
-- ⚠ 이 인덱스들은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   PostgreSQL은 외래키 컬럼에 인덱스를 자동으로 만들지 않는다 — 참조되는 PK 쪽에만
--   만든다. 정본 물리 모델은 인덱스를 조회 패턴별로 골라서만 정의했고
--   (ix_inventory_line_lot·ix_reservation_source·ix_goods_issue_source·
--   ix_inventory_available·ix_picking_open), 「창고 하나로 이 테이블들을 조회한다」는
--   패턴이 그 목록에 없었다.
--
--   그 결과 mdm.warehouse.warehouse_id 를 가리키는 15개 컬럼 중 12개가 순차 스캔이다.
--   창고 상세 조회(GET /api/mdm/warehouses/{id})가 참조 건수를 세면서 재고 원장 라인
--   테이블을 from/to 두 번 훑는다 — 모든 재고 변동이 쌓이는 테이블이라 MES 에서 가장
--   행이 많아지는 곳이다.
--
--   참조 건수는 코드 필드를 잠글지 판정하는 값이라(공유계약 B-4) 상세 조회마다 돈다.
--
-- 왜 지금인가:
--   지금은 재고 모듈이 없어 테이블이 비어 있고 따라서 빠르다. 문제는 M1 tracer bullet
--   이 올라오는 순간 드러나는데, 그때는 이 경로를 아무도 다시 보지 않는다.
--   테이블이 비어 있어 생성 비용도 지금이 가장 싸다.
--
-- 되돌리기:
--   나중에 (warehouse_id, item_id, business_date) 같은 복합 인덱스가 더 맞는 것으로
--   드러나면 여기 단일 컬럼 인덱스는 DROP INDEX 로 걷어낸다. 인덱스는 스키마 변경 중
--   가장 되돌리기 쉬운 축이다.
--
-- 제외한 것:
--   inventory.inventory_balance(ix_inventory_available) · logistics.picking_order
--   (ix_picking_open) · mdm.location(uq_location) 은 warehouse_id 가 선행 컬럼인
--   인덱스를 이미 갖는다.
--   logistics.putaway_rule 은 uq_putaway_rule(item_id, warehouse_id, …) 를 갖지만
--   warehouse_id 가 두 번째라 단독 필터에 쓰이지 않는다 — 그래서 여기 포함한다.

CREATE INDEX ix_goods_issue_source_warehouse
  ON logistics.goods_issue (source_warehouse_id);

CREATE INDEX ix_goods_receipt_warehouse
  ON logistics.goods_receipt (warehouse_id);

CREATE INDEX ix_putaway_rule_warehouse
  ON logistics.putaway_rule (warehouse_id);

CREATE INDEX ix_shipment_warehouse
  ON logistics.shipment (warehouse_id);

CREATE INDEX ix_stock_transfer_from_warehouse
  ON logistics.stock_transfer (from_warehouse_id);

CREATE INDEX ix_stock_transfer_to_warehouse
  ON logistics.stock_transfer (to_warehouse_id);

CREATE INDEX ix_handling_unit_warehouse
  ON inventory.handling_unit (warehouse_id);

CREATE INDEX ix_inventory_count_warehouse
  ON inventory.inventory_count (warehouse_id);

CREATE INDEX ix_inventory_reservation_warehouse
  ON inventory.inventory_reservation (warehouse_id);

CREATE INDEX ix_inventory_line_from_warehouse
  ON inventory.inventory_transaction_line (from_warehouse_id);

CREATE INDEX ix_inventory_line_to_warehouse
  ON inventory.inventory_transaction_line (to_warehouse_id);

CREATE INDEX ix_material_return_destination_warehouse
  ON production.material_return (destination_warehouse_id);
