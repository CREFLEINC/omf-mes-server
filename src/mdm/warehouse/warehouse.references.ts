import { ReferenceColumn } from '../reference-count';

/**
 * `mdm.warehouse.warehouse_id` 를 FK 로 가리키는 모든 곳.
 *
 * 이 목록에서 하나가 빠지면 **쓰이고 있는 창고가 「수정 가능」으로 잘못 판정된다** —
 * 코드를 고칠 수 있게 되고 과거 전표가 무엇을 가리키는지 어긋난다. 그래서 e2e 가
 * 이 목록을 정본 DB 의 `pg_constraint` 와 대조한다. 정본에 FK 가 늘면 테스트가 깨진다.
 */
export const WAREHOUSE_REFERENCES: readonly ReferenceColumn[] = [
  { schema: 'logistics', table: 'goods_issue', column: 'source_warehouse_id' },
  { schema: 'logistics', table: 'goods_receipt', column: 'warehouse_id' },
  { schema: 'logistics', table: 'picking_order', column: 'warehouse_id' },
  { schema: 'logistics', table: 'putaway_rule', column: 'warehouse_id' },
  { schema: 'logistics', table: 'shipment', column: 'warehouse_id' },
  { schema: 'logistics', table: 'stock_transfer', column: 'from_warehouse_id' },
  { schema: 'logistics', table: 'stock_transfer', column: 'to_warehouse_id' },
  { schema: 'inventory', table: 'handling_unit', column: 'warehouse_id' },
  { schema: 'inventory', table: 'inventory_balance', column: 'warehouse_id' },
  { schema: 'inventory', table: 'inventory_count', column: 'warehouse_id' },
  { schema: 'inventory', table: 'inventory_reservation', column: 'warehouse_id' },
  { schema: 'inventory', table: 'inventory_transaction_line', column: 'from_warehouse_id' },
  { schema: 'inventory', table: 'inventory_transaction_line', column: 'to_warehouse_id' },
  { schema: 'mdm', table: 'location', column: 'warehouse_id' },
  { schema: 'production', table: 'material_return', column: 'destination_warehouse_id' },
];
