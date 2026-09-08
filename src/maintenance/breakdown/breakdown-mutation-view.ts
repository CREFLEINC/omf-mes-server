import { Prisma } from '@prisma/client';

import {
  BREAKDOWN_INCLUDE,
  BreakdownView,
  breakdownView,
} from './breakdown-view';
import type { BreakdownTx } from './breakdown-lock';

type OrderLink = { maintenance_order_id: bigint };

export async function readBreakdownMutationView(
  tx: BreakdownTx,
  breakdownId: bigint,
): Promise<BreakdownView | null> {
  const [row, links] = await Promise.all([
    tx.breakdown.findUnique({
      where: { breakdown_id: breakdownId },
      include: BREAKDOWN_INCLUDE,
    }),
    tx.$queryRaw<OrderLink[]>(Prisma.sql`
      SELECT o.maintenance_order_id
      FROM maintenance.maintenance_order o
      WHERE o.breakdown_id = ${breakdownId}
      UNION
      SELECT t.maintenance_order_id
      FROM maintenance.maintenance_order_trigger t
      WHERE t.trigger_type_code = 'BREAKDOWN'
        AND t.source_id = ${breakdownId}`),
  ]);
  if (row === null) return null;
  const orderIds = new Set(links.map((link) => link.maintenance_order_id));
  const maintenanceOrderId =
    orderIds.size === 1 ? Number([...orderIds][0]) : null;
  return breakdownView(row, maintenanceOrderId);
}
