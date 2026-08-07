import { ReferenceColumn } from '../reference-count';

/**
 * `mdm.location.location_id` 를 FK 로 가리키는 모든 곳. 창고(15)보다 많은 26곳이다 —
 * 재고와 전표가 창고가 아니라 자리 단위로 기록되기 때문이다.
 *
 * `mdm.location.parent_location_id` 가 들어 있다. 자기 자신을 가리키는 참조이고,
 * 하위 자리를 가진 로케이션은 코드를 고칠 수 없다는 뜻이다.
 *
 * 하나라도 빠지면 **쓰이고 있는 자리가 「수정 가능」으로 잘못 판정된다.**
 * e2e 가 이 목록을 정본 DB 의 `pg_constraint` 와 대조한다.
 */
export const LOCATION_REFERENCES: readonly ReferenceColumn[] = [
  { schema: 'inventory', table: 'handling_unit', column: 'location_id' },
  { schema: 'inventory', table: 'inventory_balance', column: 'location_id' },
  { schema: 'inventory', table: 'inventory_count_line', column: 'location_id' },
  { schema: 'inventory', table: 'inventory_reservation', column: 'location_id' },
  { schema: 'inventory', table: 'inventory_transaction_line', column: 'from_location_id' },
  { schema: 'inventory', table: 'inventory_transaction_line', column: 'to_location_id' },
  { schema: 'logistics', table: 'goods_issue_line', column: 'source_location_id' },
  { schema: 'logistics', table: 'goods_receipt_line', column: 'destination_location_id' },
  { schema: 'logistics', table: 'inbound_receipt', column: 'dock_location_id' },
  { schema: 'logistics', table: 'material_issue_request', column: 'destination_location_id' },
  { schema: 'logistics', table: 'picking_line', column: 'location_id' },
  { schema: 'logistics', table: 'putaway_rule', column: 'location_id' },
  { schema: 'logistics', table: 'putaway_task', column: 'actual_location_id' },
  { schema: 'logistics', table: 'putaway_task', column: 'from_location_id' },
  { schema: 'logistics', table: 'putaway_task', column: 'recommended_location_id' },
  { schema: 'logistics', table: 'shopfloor_receipt', column: 'destination_location_id' },
  { schema: 'logistics', table: 'stock_transfer_line', column: 'from_location_id' },
  { schema: 'logistics', table: 'stock_transfer_line', column: 'to_location_id' },
  { schema: 'mdm', table: 'location', column: 'parent_location_id' },
  { schema: 'mdm', table: 'terminal', column: 'location_id' },
  { schema: 'production', table: 'material_return', column: 'source_location_id' },
  { schema: 'production', table: 'operation_handover_line', column: 'destination_location_id' },
  { schema: 'production', table: 'operation_handover_line', column: 'source_location_id' },
  { schema: 'production', table: 'work_order', column: 'default_fg_location_id' },
  { schema: 'production', table: 'work_order', column: 'default_scrap_location_id' },
  { schema: 'production', table: 'work_order', column: 'default_wip_location_id' },
];
