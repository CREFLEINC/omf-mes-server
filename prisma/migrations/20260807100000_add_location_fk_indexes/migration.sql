-- mdm.location 을 가리키는 외래키 컬럼에 인덱스를 단다. 창고에 남은 하나도 함께 고친다.
--
-- ⚠ 이 인덱스들은 OMF-MES 구현 측 추가분이다. 모델링 정본 SQL에 역반영이 필요하다.
--
-- 왜 필요한가:
--   PostgreSQL은 외래키 컬럼에 인덱스를 자동으로 만들지 않는다. mdm.location 을
--   가리키는 26개 컬럼 중 선행 컬럼 인덱스를 가진 것은 ix_location_parent 하나뿐이다.
--
--   로케이션 상세 조회가 참조 건수를 세면서 나머지 25개를 전부 훑는다. 참조 건수는
--   코드 필드를 잠글지 판정하는 값이라(공유계약 B-4) 화면을 열 때마다 돈다.
--
-- 「인덱스가 이미 있다」를 어떻게 판정했나:
--   20260805000000 이 두 번 틀렸다. ix_inventory_available 과 ix_picking_open 을
--   「warehouse_id 가 선행 컬럼인 인덱스」로 셌는데, 둘 다 부분 인덱스다:
--
--     ix_inventory_available … WHERE available_qty > 0 AND inventory_status_code = 'AVAILABLE'
--     ix_picking_open       … WHERE status_code IN ('CREATED','ASSIGNED','PICKING')
--
--   마스터 하나로 조회하는 쪽은 그 조건을 걸지 않으므로 어느 쪽도 쓸 수 없다.
--   앞은 20260807000000 이 고쳤고 뒤가 이 파일 마지막 줄이다.
--
--   이번에는 손으로 세지 않고 pg_constraint 와 pg_index 를 대조했다 —
--   indkey[0] = 컬럼(선행 컬럼) AND indpred IS NULL(부분 아님). 같은 판정을
--   test/mdm-location-references.e2e-spec.ts 가 매번 돌린다.
--
-- 비용:
--   인덱스가 붙은 테이블은 쓰기마다 인덱스를 갱신한다. 여기 대상은 재고 이동이
--   쌓이는 테이블들이라 MES 에서 가장 쓰기가 잦은 곳이다. 그럼에도 다는 이유는
--   창고에 이미 같은 판단을 했고(20260805000000), 안 달면 상세 조회가 25번
--   순차 스캔을 하기 때문이다. 한 테이블당 1~3개씩이라 한 곳에 몰리지도 않는다.
--
-- 되돌리기:
--   나중에 복합 인덱스가 더 맞는 것으로 드러나면 DROP INDEX 로 걷어낸다.
--   인덱스는 스키마 변경 중 가장 되돌리기 쉬운 축이다.

CREATE INDEX ix_handling_unit_location
  ON inventory.handling_unit (location_id);

CREATE INDEX ix_inventory_balance_location
  ON inventory.inventory_balance (location_id);

CREATE INDEX ix_inventory_count_line_location
  ON inventory.inventory_count_line (location_id);

CREATE INDEX ix_inventory_reservation_location
  ON inventory.inventory_reservation (location_id);

CREATE INDEX ix_inventory_line_from_location
  ON inventory.inventory_transaction_line (from_location_id);

CREATE INDEX ix_inventory_line_to_location
  ON inventory.inventory_transaction_line (to_location_id);

CREATE INDEX ix_goods_issue_line_source_location
  ON logistics.goods_issue_line (source_location_id);

CREATE INDEX ix_goods_receipt_line_destination_location
  ON logistics.goods_receipt_line (destination_location_id);

CREATE INDEX ix_inbound_receipt_dock_location
  ON logistics.inbound_receipt (dock_location_id);

CREATE INDEX ix_material_issue_request_destination_location
  ON logistics.material_issue_request (destination_location_id);

CREATE INDEX ix_picking_line_location
  ON logistics.picking_line (location_id);

CREATE INDEX ix_putaway_rule_location
  ON logistics.putaway_rule (location_id);

CREATE INDEX ix_putaway_task_actual_location
  ON logistics.putaway_task (actual_location_id);

CREATE INDEX ix_putaway_task_from_location
  ON logistics.putaway_task (from_location_id);

CREATE INDEX ix_putaway_task_recommended_location
  ON logistics.putaway_task (recommended_location_id);

CREATE INDEX ix_shopfloor_receipt_destination_location
  ON logistics.shopfloor_receipt (destination_location_id);

CREATE INDEX ix_stock_transfer_line_from_location
  ON logistics.stock_transfer_line (from_location_id);

CREATE INDEX ix_stock_transfer_line_to_location
  ON logistics.stock_transfer_line (to_location_id);

CREATE INDEX ix_terminal_location
  ON mdm.terminal (location_id);

CREATE INDEX ix_material_return_source_location
  ON production.material_return (source_location_id);

CREATE INDEX ix_operation_handover_line_destination_location
  ON production.operation_handover_line (destination_location_id);

CREATE INDEX ix_operation_handover_line_source_location
  ON production.operation_handover_line (source_location_id);

CREATE INDEX ix_work_order_default_fg_location
  ON production.work_order (default_fg_location_id);

CREATE INDEX ix_work_order_default_scrap_location
  ON production.work_order (default_scrap_location_id);

CREATE INDEX ix_work_order_default_wip_location
  ON production.work_order (default_wip_location_id);

-- 창고 쪽에 남은 하나. ix_picking_open 이 부분 인덱스라 쓸 수 없다(위 설명).
CREATE INDEX ix_picking_order_warehouse
  ON logistics.picking_order (warehouse_id);
