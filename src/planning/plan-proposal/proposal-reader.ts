import { Prisma } from '@prisma/client';

import { RELEASED_WORK_ORDER_STATUSES } from '../../core/work-order';
import type { EquipmentFacts, MoldFacts, RivalWindow } from '../../production/work-order/validation';
import { DefaultBomRow, UsableRoutingRow, chooseRouting, readMastersOf } from '../production-plan/master-choice';
import { DefaultMap, pairKey, toDefaultMap } from '../production-plan/resource-assign';

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
  /** 라인 기본 위치 — 확정과 같은 위치 판정(`resource-rules.ts`)에 쓴다. */
  locations: Map<bigint, LocationRow>;
  rivals: RivalWindow[];
}

export interface LocationRow {
  location_id: bigint;
  is_active: boolean;
  warehouse: { plant_id: bigint; warehouse_type_code: string; is_active: boolean };
}

const CONFIRMED = 'CONFIRMED';

export async function readProposalFacts(client: Prisma.TransactionClient, orderIds: readonly bigint[], now: Date = new Date()): Promise<ProposalFacts> {
  const orders = await client.production_order.findMany({
    where: { production_order_id: { in: [...orderIds] } },
    select: {
      production_order_id: true, production_order_no: true, erp_order_no: true, plant_id: true, item_id: true, uom_id: true,
      order_qty: true, status_code: true, version_no: true, planned_start_date: true, plant: { select: { timezone_code: true } },
    },
  });
  const planRows = await client.production_plan.findMany({
    where: { production_order_id: { in: orders.map((order) => order.production_order_id) } },
    orderBy: { production_plan_id: 'asc' },
    select: {
      production_plan_id: true, production_order_id: true, plan_no: true, status_code: true, version_no: true, plan_date: true,
      planned_qty: true, uom_id: true, bom_id: true, routing_id: true, planned_line_id: true, remarks: true,
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

  const locationIds = unique(lineRows.flatMap((line) => [line.default_wip_location_id, line.default_fg_location_id, line.default_scrap_location_id]));
  const locationRows = locationIds.length === 0 ? [] : await client.location.findMany({
    where: { location_id: { in: locationIds } },
    orderBy: { location_id: 'asc' },
    select: { location_id: true, is_active: true, warehouse: { select: { plant_id: true, warehouse_type_code: true, is_active: true } } },
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
    rivals,
  };
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
