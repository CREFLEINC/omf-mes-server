import { Prisma } from '@prisma/client';
import { field, one } from '../../common/errors';
import { RELEASED_WORK_ORDER_STATUSES } from '../../core/work-order';

/** 단일/N 배정·여러 계획이 같은 설비를 서로 다른 순서로 잡아도 잠금 순환이 생기지 않게 한다.
 * 점유를 만드는 모든 경로가 행 잠금보다 먼저 호출하고, 같은 READ COMMITTED tx에서 재판정한다. */
export async function lockEquipmentOccupancy(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext('production.equipment-occupancy'))`;
}
const resourceSelect = { resource_type_code: true, equipment_id: true } as const;

export async function assertEquipmentOccupancy(tx: Prisma.TransactionClient, workOrderId: number | bigint, requireWindow = false): Promise<void> {
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) },
    select: { work_order_id: true, status_code: true, planned_equipment_id: true, planned_start_at: true, planned_end_at: true,
      work_order_resource_assignment: { select: resourceSelect } },
  });
  if (RELEASED_WORK_ORDER_STATUSES.includes(row.status_code)) return;
  const ids = [...new Set([row.planned_equipment_id, ...row.work_order_resource_assignment
    .filter(resource => resource.resource_type_code === 'EQUIPMENT').map(resource => resource.equipment_id)]
    .filter((id): id is bigint => id !== null))];
  if (ids.length === 0) return;
  if (row.planned_start_at === null || row.planned_end_at === null) {
    if (!requireWindow) return;
    throw one(field('plannedStartAt', 'EQUIPMENT_WINDOW_REQUIRED', '설비를 배정하려면 계획 시작·종료를 지정하세요.'));
  }
  if (row.planned_start_at >= row.planned_end_at) throw one(field('plannedEndAt', 'EQUIPMENT_WINDOW_REQUIRED', '계획 종료를 시작 이후로 지정하세요.'));
  const rival = await tx.work_order.findFirst({
    where: { work_order_id: { not: row.work_order_id }, status_code: { notIn: RELEASED_WORK_ORDER_STATUSES },
      planned_start_at: { lt: row.planned_end_at }, planned_end_at: { gt: row.planned_start_at },
      OR: [{ planned_equipment_id: { in: ids } }, { work_order_resource_assignment: { some: { resource_type_code: 'EQUIPMENT', equipment_id: { in: ids } } } }] },
    select: { work_order_no: true, planned_start_at: true, planned_end_at: true },
    orderBy: { work_order_id: 'asc' },
  });
  if (rival) throw one(field('plannedEquipmentId', 'EQUIPMENT_DOUBLE_BOOKED', `같은 시간에 배정된 작업지시(${rival.work_order_no})가 있습니다. 설비 배정 내역을 확인하세요.`));
}
