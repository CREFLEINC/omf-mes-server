import { Prisma } from '@prisma/client';

import { FgResolution, LOCATION_FACT_SELECT, LocationFact, fgKey, resolveFgLocations } from '../../core/erp-warehouse/fg-location';
import { resolveWorkingDays } from '../../app/policy/working-day-resolver';
import { toDateString } from '../../common/master';
import { PLAN_DATE_SEARCH_LIMIT_DAYS, PlanningCalendarDay, addDays } from '../../core/calendar/working-day';
import { RELEASED_WORK_ORDER_STATUSES } from '../../core/work-order';
import type { EquipmentFacts, MoldFacts, RivalWindow } from '../../production/work-order/validation';
import { DefaultBomRow, UsableRoutingRow, chooseRouting, readMastersOf } from '../production-plan/master-choice';
import { localDate } from '../production-plan/plan-window';
import { DefaultMap, pairKey, toDefaultMap } from '../production-plan/resource-assign';
import { calendarKey, draftPlanDate, proposedPlanDate } from './proposal-policy';

/**
 * 계획 제안이 읽는 것 전부 — 묶음(ERP W/O 여럿) 단위로 몇 번의 질의. 조회는 Prisma, 확정은 잠근 트랜잭션으로 같은 함수를 부른다.
 * ⛔ 쓰지 않는다 — 제안 조회는 부작용이 없어야 한다.
 */

export interface OrderRow {
  production_order_id: bigint;
  production_order_no: string;
  erp_order_no: string | null;
  plant_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  order_qty: Prisma.Decimal;
  status_code: string;
  version_no: number;
  erp_storage_location_code: string | null;
  planned_start_date: Date | null;
  plant: { timezone_code: string };
}

export interface PlanRow {
  production_plan_id: bigint;
  production_order_id: bigint;
  plan_no: string;
  status_code: string;
  version_no: number;
  plan_date: Date;
  planned_qty: Prisma.Decimal;
  uom_id: bigint;
  bom_id: bigint;
  routing_id: bigint;
  planned_line_id: bigint | null;
  plan_date_source_code: string;
  remarks: string | null;
  work_order: { status_code: string }[];
}

export interface RoutingRow {
  routing_id: bigint;
  item_id: bigint;
  routing_code: string;
  routing_version: number;
}

export interface OperationRow {
  routing_operation_id: bigint;
  routing_id: bigint;
  operation_seq: number;
  operation_name: string;
  process_id: bigint;
  equipment_required: boolean;
  mold_required: boolean;
  version_no: number;
  process: { process_code: string; process_name: string };
}

export interface DependencyRow {
  predecessor_operation_id: bigint;
  successor_operation_id: bigint;
  dependency_type_code: string;
}

export interface MapRow {
  item_resource_map_id: bigint;
  plant_id: bigint;
  item_id: bigint;
  version_no: number;
  map: DefaultMap;
}

export interface LineRow {
  production_line_id: bigint;
  plant_id: bigint;
  is_active: boolean;
  default_wip_location_id: bigint | null;
  default_fg_location_id: bigint | null;
  default_scrap_location_id: bigint | null;
  version_no: number;
}

export interface ShiftRow {
  shift_id: bigint;
  plant_id: bigint;
  start_time: Date;
  end_time: Date;
  crosses_midnight: boolean;
  is_active: boolean;
  version_no: number;
}

export interface ProposalFacts {
  orders: OrderRow[];
  plans: Map<bigint, PlanRow[]>;
  boms: Map<bigint, DefaultBomRow[]>;
  /** 키는 `pairKey(공장, 품목)` — 공장 현지 날짜로 판정했다. */
  usableRoutings: Map<string, UsableRoutingRow[]>;
  routings: Map<bigint, RoutingRow>;
  operations: Map<bigint, OperationRow[]>;
  dependencies: Map<bigint, DependencyRow[]>;
  maps: Map<string, MapRow[]>;
  lines: Map<bigint, LineRow>;
  shifts: Map<bigint, ShiftRow[]>;
  equipments: Map<bigint, EquipmentFacts & { plant_id: bigint; production_line_id: bigint | null; version_no: number }>;
  molds: Map<bigint, MoldFacts & { plant_id: bigint; version_no: number }>;
  /** 라인 기본 위치와 ERP 입고 창고의 입고 위치 — 확정과 같은 위치 판정(`resource-rules.ts`)에 쓴다. */
  locations: Map<bigint, LocationFact>;
  /** ERP W/O 마다 완제품 위치 판정 — 키는 `fgKey`. */
  fg: Map<string, FgResolution>;
  rivals: RivalWindow[];
  /** 계획일 후보마다 그날부터 보정 한도까지의 근무일 판정 — 키는 `calendarKey`. */
  calendar: Map<string, PlanningCalendarDay[]>;
}

const CONFIRMED = 'CONFIRMED';

export async function readProposalFacts(client: Prisma.TransactionClient, orderIds: readonly bigint[], now: Date = new Date()): Promise<ProposalFacts> {
  const orders = await client.production_order.findMany({
    where: { production_order_id: { in: [...orderIds] } },
    select: {
      production_order_id: true, production_order_no: true, erp_order_no: true, plant_id: true, item_id: true, uom_id: true,
      order_qty: true, status_code: true, version_no: true, erp_storage_location_code: true, planned_start_date: true, plant: { select: { timezone_code: true } },
    },
  });
  const planRows = await client.production_plan.findMany({
    where: { production_order_id: { in: orders.map((order) => order.production_order_id) } },
    orderBy: { production_plan_id: 'asc' },
    select: {
      production_plan_id: true, production_order_id: true, plan_no: true, status_code: true, version_no: true, plan_date: true,
      planned_qty: true, uom_id: true, bom_id: true, routing_id: true, planned_line_id: true, plan_date_source_code: true, remarks: true,
      work_order: { select: { status_code: true }, orderBy: { work_order_id: 'asc' } },
    },
  });
  const plans = group(planRows, (plan) => plan.production_order_id);
  const { boms, routings: usableRoutings } = await readMastersOf(client, orders.map((order) => ({ plantId: order.plant_id, itemId: order.item_id })), now);

  // 제안이 쓸 수 있는 Routing — 품목의 쓸 수 있는 Rev 전부와 작성중 계획에 저장된 Rev. 확정 계획의 Routing 은 보지 않는다.
  const routingIds = new Set<bigint>();
  for (const rows of usableRoutings.values()) rows.forEach((row) => routingIds.add(row.routing_id));
  for (const plan of planRows) if (plan.status_code !== CONFIRMED) routingIds.add(plan.routing_id);
  const ids = [...routingIds];
  const [routingRows, operationRows] = ids.length === 0
    ? [[], []]
    : await Promise.all([
        client.routing.findMany({ where: { routing_id: { in: ids } }, select: { routing_id: true, item_id: true, routing_code: true, routing_version: true } }),
        client.routing_operation.findMany({
          where: { routing_id: { in: ids } },
          orderBy: [{ routing_id: 'asc' }, { operation_seq: 'asc' }],
          select: {
            routing_operation_id: true, routing_id: true, operation_seq: true, operation_name: true, process_id: true,
            equipment_required: true, mold_required: true, version_no: true, process: { select: { process_code: true, process_name: true } },
          },
        }),
      ]);
  const operationIds = operationRows.map((row) => row.routing_operation_id);
  const routingOf = new Map(operationRows.map((row) => [row.routing_operation_id, row.routing_id]));
  const dependencyRows = operationIds.length === 0 ? [] : await client.routing_operation_dependency.findMany({
    where: { predecessor_operation_id: { in: operationIds }, successor_operation_id: { in: operationIds } },
    orderBy: [{ predecessor_operation_id: 'asc' }, { successor_operation_id: 'asc' }],
    select: { predecessor_operation_id: true, successor_operation_id: true, dependency_type_code: true },
  });

  const mapRows = orders.length === 0 ? [] : await client.item_resource_map.findMany({
    where: { is_default: true, is_active: true, OR: orders.map((order) => ({ plant_id: order.plant_id, item_id: order.item_id })) },
    orderBy: { item_resource_map_id: 'asc' },
    select: {
      item_resource_map_id: true, plant_id: true, item_id: true, version_no: true, process_id: true,
      equipment: { select: { equipment_id: true, status_code: true, is_active: true, production_line_id: true } },
      mold: { select: { mold_id: true, status_code: true, is_active: true } },
    },
  });
  const maps = new Map<string, MapRow[]>();
  for (const row of mapRows) {
    const key = pairKey(row.plant_id, row.item_id);
    maps.set(key, [...(maps.get(key) ?? []), { item_resource_map_id: row.item_resource_map_id, plant_id: row.plant_id, item_id: row.item_id, version_no: row.version_no, map: toDefaultMap(row) }]);
  }

  const equipmentIds = unique(mapRows.map((row) => row.equipment?.equipment_id ?? null));
  const moldIds = unique(mapRows.map((row) => row.mold?.mold_id ?? null));
  const [equipments, molds, rivals] = await Promise.all([
    equipmentIds.length === 0 ? [] : client.equipment.findMany({
      where: { equipment_id: { in: equipmentIds } },
      orderBy: { equipment_id: 'asc' },
      select: { equipment_id: true, plant_id: true, status_code: true, is_active: true, production_line_id: true, calibration_required: true, calibration_due_date: true, version_no: true },
    }),
    moldIds.length === 0 ? [] : client.mold.findMany({
      where: { mold_id: { in: moldIds } },
      orderBy: { mold_id: 'asc' },
      select: { mold_id: true, plant_id: true, status_code: true, is_active: true, guaranteed_shot_count: true, current_shot_count: true, version_no: true },
    }),
    equipmentIds.length === 0 ? [] : client.work_order.findMany({
      where: { planned_equipment_id: { in: equipmentIds }, planned_start_at: { not: null }, planned_end_at: { not: null }, status_code: { notIn: RELEASED_WORK_ORDER_STATUSES } },
      select: { planned_equipment_id: true, planned_start_at: true, planned_end_at: true },
    }),
  ]);

  const lineIds = unique([
    ...planRows.filter((plan) => plan.status_code !== CONFIRMED).map((plan) => plan.planned_line_id),
    ...equipments.map((equipment) => equipment.production_line_id),
  ]);
  const plantIds = unique(orders.map((order) => order.plant_id));
  const [lineRows, shiftRows] = await Promise.all([
    lineIds.length === 0 ? [] : client.production_line.findMany({
      where: { production_line_id: { in: lineIds } },
      orderBy: { production_line_id: 'asc' },
      select: {
        production_line_id: true, plant_id: true, is_active: true, version_no: true,
        default_wip_location_id: true, default_fg_location_id: true, default_scrap_location_id: true,
      },
    }),
    plantIds.length === 0 ? [] : client.shift.findMany({
      where: { plant_id: { in: plantIds } },
      orderBy: { shift_id: 'asc' },
      select: { shift_id: true, plant_id: true, start_time: true, end_time: true, crosses_midnight: true, is_active: true, version_no: true },
    }),
  ]);

  const fg = await resolveFgLocations(client, orders.map((order) => ({ plantId: order.plant_id, erpCode: order.erp_storage_location_code })));
  const erpLocationIds = [...fg.values()].map((resolution) => (resolution.kind === 'ERP_STORAGE_LOCATION' ? resolution.location.id : null));
  const locationIds = unique([...lineRows.flatMap((line) => [line.default_wip_location_id, line.default_fg_location_id, line.default_scrap_location_id]), ...erpLocationIds]);
  const locationRows = locationIds.length === 0 ? [] : await client.location.findMany({
    where: { location_id: { in: locationIds } },
    orderBy: { location_id: 'asc' },
    select: LOCATION_FACT_SELECT,
  });

  return {
    orders,
    plans,
    boms,
    usableRoutings,
    routings: new Map(routingRows.map((row) => [row.routing_id, row])),
    operations: group(operationRows, (row) => row.routing_id),
    dependencies: group(dependencyRows, (row) => routingOf.get(row.predecessor_operation_id) as bigint),
    maps,
    lines: new Map(lineRows.map((row) => [row.production_line_id, row])),
    shifts: group(shiftRows, (row) => row.plant_id),
    equipments: new Map(equipments.map((row) => [row.equipment_id, row])),
    molds: new Map(molds.map((row) => [row.mold_id, row])),
    locations: new Map(locationRows.map((row) => [row.location_id, row])),
    fg,
    rivals,
    calendar: await readCalendar(client, orders, planRows, now),
  };
}

/** 새 계획(공장 층)과 작성중 계획(그 라인)의 계획일 후보마다 보정 한도까지 — 어느 쪽을 제안할지는 계산이 정하므로 둘 다 읽는다. */
async function readCalendar(
  client: Prisma.TransactionClient,
  orders: readonly OrderRow[],
  planRows: readonly PlanRow[],
  now: Date,
): Promise<Map<string, PlanningCalendarDay[]>> {
  const starts = new Map<string, { plantId: bigint; lineId: bigint | null; start: string }>();
  const add = (plantId: bigint, lineId: bigint | null, start: string) => starts.set(calendarKey(plantId, lineId, start), { plantId, lineId, start });
  const orderOf = new Map(orders.map((order) => [order.production_order_id, order]));
  for (const order of orders) {
    const today = localDate(now, order.plant.timezone_code);
    add(order.plant_id, null, proposedPlanDate(toDateString(order.planned_start_date), today));
  }
  for (const plan of planRows) {
    const order = orderOf.get(plan.production_order_id);
    if (order === undefined || plan.status_code === CONFIRMED) continue;
    add(order.plant_id, plan.planned_line_id, draftPlanDate(toDateString(plan.plan_date) as string, localDate(now, order.plant.timezone_code)));
  }
  const entries = [...starts.entries()];
  const days = await resolveWorkingDays(client, entries.map(([, target]) => ({
    plantId: target.plantId,
    lineId: target.lineId,
    from: target.start,
    to: addDays(target.start, PLAN_DATE_SEARCH_LIMIT_DAYS),
  })));
  return new Map(entries.map(([key], index) => [key, days[index]]));
}

/** 품목의 Routing 선택 — 작성중 계획은 저장된 Rev 가 아직 쓸 수 있으면 그것, 아니면 새 계획과 같은 규칙. */
export function routingFor(facts: ProposalFacts, order: OrderRow, savedRoutingId: bigint | null): ReturnType<typeof chooseRouting> {
  const usable = facts.usableRoutings.get(pairKey(order.plant_id, order.item_id)) ?? [];
  if (savedRoutingId !== null && usable.some((row) => row.routing_id === savedRoutingId)) return { routingId: savedRoutingId };
  return chooseRouting(usable.map((row) => ({ routingId: row.routing_id, isDefault: row.is_default })));
}

function group<T>(rows: readonly T[], key: (row: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return map;
}

function unique(ids: readonly (bigint | null)[]): bigint[] {
  return [...new Set(ids.filter((id): id is bigint => id !== null))];
}

export const fgOf = (facts: ProposalFacts, order: OrderRow): FgResolution =>
  facts.fg.get(fgKey({ plantId: order.plant_id, erpCode: order.erp_storage_location_code })) as FgResolution;
