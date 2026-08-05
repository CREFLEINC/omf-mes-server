import { PrismaService } from '../../prisma/prisma.service';

/**
 * `mdm.warehouse.warehouse_id` 를 FK 로 가리키는 모든 곳.
 *
 * 이 목록에서 하나가 빠지면 **쓰이고 있는 창고가 「수정 가능」으로 잘못 판정된다** —
 * 코드를 고칠 수 있게 되고 과거 전표가 무엇을 가리키는지 어긋난다. 그래서 e2e 가
 * 이 목록을 정본 DB 의 `pg_constraint` 와 대조한다. 정본에 FK 가 늘면 테스트가 깨진다.
 */
export const WAREHOUSE_REFERENCES: readonly { schema: string; table: string; column: string }[] = [
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

/**
 * 참조 건수 합계. 스칼라 서브쿼리를 하나로 묶어 DB 왕복을 1회로 둔다 —
 * 상세 조회마다 15번 왕복할 수는 없다.
 *
 * 식별자는 `WAREHOUSE_REFERENCES` 의 상수에서만 오고 값은 파라미터로 나간다.
 */
export async function countWarehouseReferences(
  prisma: PrismaService,
  warehouseId: bigint,
): Promise<number> {
  const terms = WAREHOUSE_REFERENCES.map(
    ({ schema, table, column }) =>
      `(SELECT count(*) FROM ${schema}.${table} WHERE ${column} = $1)`,
  ).join(' + ');

  const [{ total }] = await prisma.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT ${terms} AS total`,
    warehouseId,
  );

  return Number(total);
}

/** e2e 가 정본의 `pg_constraint` 와 대조할 때 쓴다. */
export function referenceKey({
  schema,
  table,
  column,
}: {
  schema: string;
  table: string;
  column: string;
}): string {
  return `${schema}.${table}.${column}`;
}
