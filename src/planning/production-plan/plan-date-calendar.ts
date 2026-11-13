import { Prisma } from '@prisma/client';

import { resolveWorkingDays } from '../../app/policy/working-day-resolver';
import { toDateString } from '../../common/master';
import { PlanningCalendarDay } from '../../core/calendar/working-day';

export interface PlanDateRow {
  production_order_id: bigint;
  planned_line_id: bigint | null;
  plan_date: Date;
}

/**
 * 계획 여럿의 계획일 판정 — 공장은 ERP W/O 의 공장, 라인은 계획 라인(없으면 공장 층). 입력 순서대로.
 * 같은 공장·라인·날짜는 한 번만 묻는다.
 */
export async function calendarsOfPlans(client: Prisma.TransactionClient, rows: readonly PlanDateRow[]): Promise<PlanningCalendarDay[]> {
  if (rows.length === 0) return [];
  const orders = await client.production_order.findMany({
    where: { production_order_id: { in: [...new Set(rows.map((row) => row.production_order_id))] } },
    select: { production_order_id: true, plant_id: true },
  });
  const plantOf = new Map(orders.map((order) => [order.production_order_id, order.plant_id]));
  const targets = rows.map((row) => ({
    plantId: plantOf.get(row.production_order_id) as bigint,
    lineId: row.planned_line_id,
    date: toDateString(row.plan_date) as string,
  }));
  const key = (target: (typeof targets)[number]) => `${target.plantId}:${target.lineId ?? ''}:${target.date}`;
  const unique = [...new Map(targets.map((target) => [key(target), target])).values()];
  const days = await resolveWorkingDays(client, unique.map((target) => ({ plantId: target.plantId, lineId: target.lineId, from: target.date, to: target.date })));
  const byKey = new Map(unique.map((target, index) => [key(target), days[index][0]]));
  return targets.map((target) => byKey.get(key(target)) as PlanningCalendarDay);
}
