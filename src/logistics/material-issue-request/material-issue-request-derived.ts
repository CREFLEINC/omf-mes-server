import { Prisma } from '@prisma/client';

import { dynamicShortages } from '../../core/material-issue/planned-stock';
import { localDate } from '../../planning/production-plan/plan-window';

/**
 * 출고 요청의 화면 값(피처 003 · W-02-11) — 저장하지 않고 요청 줄·피킹·W/O 에서 푼다. 상태 다섯(research R-1):
 * 대기 = WAITING · 배포 = REGISTERED 이고 집은 것·출고 없음 · 진행 중 = REGISTERED 이고 있음 · 완료 = POSTED 또는
 * W/O 취소·마감으로 닫힘 · 취소 = CANCELLED. 줄이 모두 0 인 배포 요청은 피킹이 없어 「배포」다.
 */

export const DISPLAY_STATUSES = ['WAITING', 'RELEASED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
const ZERO = new Prisma.Decimal(0);

/** 진행 — 줄에 기출고가 있거나 취소 안 된 피킹에서 집은 양이 있다. */
export const STARTED: Prisma.material_issue_requestWhereInput = {
  material_issue_request_line: {
    some: {
      OR: [
        { issued_qty: { gt: 0 } },
        { picking_line: { some: { picked_qty: { gt: 0 }, picking_order: { status_code: { not: 'CANCELLED' } } } } },
      ],
    },
  },
};

const STATUS_WHERE: Record<DisplayStatus, Prisma.material_issue_requestWhereInput> = {
  WAITING: { status_code: 'WAITING' },
  RELEASED: { status_code: 'REGISTERED', closed_at: null, NOT: STARTED },
  IN_PROGRESS: { AND: [{ status_code: 'REGISTERED', closed_at: null }, STARTED] },
  DONE: { OR: [{ status_code: 'POSTED' }, { closed_at: { not: null } }] },
  CANCELLED: { status_code: 'CANCELLED' },
};

export function displayStatusWhere(codes: readonly DisplayStatus[]): Prisma.material_issue_requestWhereInput {
  return { OR: codes.map((code) => STATUS_WHERE[code]) };
}

/** 이름 칸까지 한 질의로 — 목록이 줄마다·행마다 다시 읽지 않는다. */
export const DERIVED_INCLUDE = {
  source_warehouse: { select: { warehouse_name: true } },
  location: { select: { location_name: true, warehouse_id: true, warehouse: { select: { warehouse_name: true } } } },
  work_order: {
    select: {
      work_order_no: true,
      planned_start_at: true,
      production_plan_id: true,
      production_plan: { select: { plan_no: true, production_order: { select: { plant: { select: { timezone_code: true } } } } } },
    },
  },
  material_issue_request_line: {
    select: {
      material_issue_request_line_id: true,
      requested_qty: true,
      issued_qty: true,
      shortage_qty: true,
      item: { select: { item_code: true, item_name: true } },
      uom: { select: { uom_code: true } },
      picking_line: { where: { picking_order: { status_code: { not: 'CANCELLED' } } }, select: { picked_qty: true } },
    },
  },
} satisfies Prisma.material_issue_requestInclude;

export type DerivedRow = Prisma.material_issue_requestGetPayload<{ include: typeof DERIVED_INCLUDE }>;

export interface LineDerived {
  itemCode: string;
  itemName: string;
  uomCode: string;
  pickedQty: number;
  outstandingQty: number;
  dynamicShortageQty: number;
}

export interface RequestDerived {
  displayStatus: DisplayStatus;
  sourceWarehouseName: string | null;
  /** 창고 보충 요청(피처 004)은 W/O 가 없어 W/O·계획·생산일 칸이 null 이다. */
  workOrderNo: string | null;
  productionDate: string | null;
  productionPlanId: number | null;
  productionPlanNo: string | null;
  destinationLocationName: string;
  destinationWarehouseId: number;
  destinationWarehouseName: string;
  lineCount: number;
  /** 줄 저장 부족(만들 때 줄인 양)의 합. */
  shortageQtyTotal: number;
  /** 줄에 배분된 동적 부족(예정 > 가용)의 합 — 「부족 N」 = 둘의 합. */
  dynamicShortageQtyTotal: number;
  lines: Map<bigint, LineDerived>;
}

/** 동적 부족을 줄마다. 출발 창고가 있는 활성 요청만 해당한다 — 쓸 일이 없으면 읽지 않는다. */
export async function lineDynamicShortages(db: Prisma.TransactionClient, rows: readonly DerivedRow[]): Promise<Map<bigint, Prisma.Decimal>> {
  const map = new Map<bigint, Prisma.Decimal>();
  if (!rows.some((row) => row.source_warehouse_id !== null && ['WAITING', 'REGISTERED'].includes(row.status_code) && row.closed_at === null)) {
    return map;
  }
  for (const shortage of await dynamicShortages(db, {})) {
    for (const line of shortage.lines) map.set(line.requestLineId, (map.get(line.requestLineId) ?? ZERO).plus(line.shortageQty));
  }
  return map;
}

export function derive(row: DerivedRow, dynamic: ReadonlyMap<bigint, Prisma.Decimal>): RequestDerived {
  const lines = new Map<bigint, LineDerived>();
  let started = false;
  let stored = ZERO;
  let dynamicTotal = ZERO;
  for (const line of row.material_issue_request_line) {
    const picked = line.picking_line.reduce((sum, p) => sum.plus(p.picked_qty), ZERO);
    const dyn = dynamic.get(line.material_issue_request_line_id) ?? ZERO;
    if (picked.gt(0) || line.issued_qty.gt(0)) started = true;
    stored = stored.plus(line.shortage_qty);
    dynamicTotal = dynamicTotal.plus(dyn);
    lines.set(line.material_issue_request_line_id, {
      itemCode: line.item.item_code,
      itemName: line.item.item_name,
      uomCode: line.uom.uom_code,
      pickedQty: picked.toNumber(),
      outstandingQty: Prisma.Decimal.max(line.requested_qty.minus(line.issued_qty), ZERO).toNumber(),
      dynamicShortageQty: dyn.toNumber(),
    });
  }
  const workOrder = row.work_order;
  const timezone = workOrder?.production_plan?.production_order.plant.timezone_code ?? null;
  const plannedStart = workOrder?.planned_start_at ?? null;
  return {
    displayStatus: statusOf(row, started),
    sourceWarehouseName: row.source_warehouse?.warehouse_name ?? null,
    workOrderNo: workOrder?.work_order_no ?? null,
    productionDate: plannedStart === null || timezone === null ? null : localDate(plannedStart, timezone),
    productionPlanId: workOrder?.production_plan_id == null ? null : Number(workOrder.production_plan_id),
    productionPlanNo: workOrder?.production_plan?.plan_no ?? null,
    destinationLocationName: row.location.location_name,
    destinationWarehouseId: Number(row.location.warehouse_id),
    destinationWarehouseName: row.location.warehouse.warehouse_name,
    lineCount: row.material_issue_request_line.length,
    shortageQtyTotal: stored.toNumber(),
    dynamicShortageQtyTotal: dynamicTotal.toNumber(),
    lines,
  };
}

function statusOf(row: DerivedRow, started: boolean): DisplayStatus {
  if (row.status_code === 'CANCELLED') return 'CANCELLED';
  if (row.status_code === 'POSTED' || row.closed_at !== null) return 'DONE';
  if (row.status_code === 'WAITING') return 'WAITING';
  return started ? 'IN_PROGRESS' : 'RELEASED';
}
