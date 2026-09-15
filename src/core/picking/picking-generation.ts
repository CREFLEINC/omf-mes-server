import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NumberingService } from '../numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { PickingAllocation, PickingDemand, allocatePicking } from './allocation';

/**
 * 자재 출고요청이 발행되는 두 자리(`:release` 자동 발행 · `POST /logistics/material-issue-requests`)
 * 가 같은 규칙으로 피킹 지시를 만든다(P-12). 사용처가 둘이라 코어에 둔다(`core/bom` 선례).
 * 읽기·채번은 `planPicking` 이 트랜잭션 «밖»에서, 쓰기는 `writePicking` 이 요청과 «같은»
 * 트랜잭션에서 한다 — 채번을 안에서 부르면 한 요청이 커넥션을 둘 쥔다(I-2 R-2).
 */

const MATERIAL_WAREHOUSE = 'MATERIAL';
const QUALITY_NORMAL = 'NORMAL';
const INVENTORY_AVAILABLE = 'AVAILABLE';
const FEFO = 'FEFO';
/** 코드 그룹 `PICKING_TYPE` 의 자재출고피킹. */
const PICKING_TYPE_MATERIAL = 'MATERIAL';
/** 계약 `PickingOrder.sourceDocumentTypeCode` 의 값 — `shortage.service.ts` 의 조인도 이 값을 본다. */
const SOURCE_MATERIAL_ISSUE_REQUEST = 'MATERIAL_ISSUE_REQUEST';
/** 판정에 쓰는 자리가 없다 — 목록이 여는 값(`M-01-08` 의 `OPEN_ORDER_STATUS`)과 같게 넣는다. */
const PICKING_REGISTERED = 'REGISTERED';

const logger = new Logger('PickingGeneration');

export interface PickingPlan extends PickingAllocation {
  orderNos: string[];
  assignedWorkerId: bigint | null;
}

export interface PickingPlanInput {
  /** W/O 의 공장 — 출고요청과 같이 계획의 생산오더로 푼다(R-7 단일 축). */
  plantId: bigint;
  demands: PickingDemand[];
  /** 채번 기간 키 — 출고요청 번호와 같은 값을 넘긴다. */
  periodDate: string;
  /** ⓔ W/O 의 책임 작업자 그대로 — 비었으면 비운다. */
  assignedWorkerId: bigint | null;
}

export async function planPicking(
  prisma: PrismaService,
  numbering: NumberingService,
  input: PickingPlanInput,
): Promise<PickingPlan> {
  const itemIds = [...new Set(input.demands.map((demand) => demand.itemId))];
  const [balances, fefoItems] = await Promise.all([
    prisma.inventory_balance.findMany({
      where: {
        item_id: { in: itemIds },
        quality_status_code: QUALITY_NORMAL,
        inventory_status_code: INVENTORY_AVAILABLE,
        available_qty: { gt: 0 },
        warehouse: { plant_id: input.plantId, warehouse_type_code: MATERIAL_WAREHOUSE, is_active: true },
        // 라인의 `lot_id` 가 NOT NULL 이고, 보류 중인 LOT 은 `:pick` 이 400 으로 막는다 — 집을 수
        // 없는 LOT 을 지시에 넣지 않는다.
        lot: { is: { lot_hold: { none: { released_at: null } } } },
      },
      select: {
        warehouse_id: true,
        location_id: true,
        lot_id: true,
        item_id: true,
        uom_id: true,
        available_qty: true,
        lot: { select: { expiry_date: true, created_at: true } },
      },
    }),
    prisma.item.findMany({
      where: { item_id: { in: itemIds }, fifo_policy_code: FEFO },
      select: { item_id: true },
    }),
  ]);

  const allocation = allocatePicking(
    input.demands,
    balances.flatMap((row) =>
      row.lot_id === null || row.lot === null || row.available_qty === null
        ? []
        : [
            {
              warehouseId: row.warehouse_id,
              locationId: row.location_id,
              lotId: row.lot_id,
              itemId: row.item_id,
              uomId: row.uom_id,
              availableQty: row.available_qty,
              expiryDate: row.lot.expiry_date,
              lotCreatedAt: row.lot.created_at,
            },
          ],
    ),
    new Set(fefoItems.map((row) => row.item_id)),
  );
  const orderNos =
    allocation.orders.length === 0
      ? []
      : await numbering.nextMany('PICKING_ORDER', input.plantId, input.periodDate, allocation.orders.length);
  return { ...allocation, orderNos, assignedWorkerId: input.assignedWorkerId };
}

/** 창고마다 헤더 하나 — 모든 라인이 결품이면 헤더도 없다(ⓓ). */
export async function writePicking(
  tx: Prisma.TransactionClient,
  plan: PickingPlan,
  source: { materialIssueRequestId: bigint; issueRequestNo: string },
  appUserId: number,
): Promise<void> {
  for (const shortage of plan.shortages) {
    logger.warn(
      `피킹 결품 — ${source.issueRequestNo} 라인 ${shortage.requestLineNo} ` +
        `품목 ${shortage.itemId} 부족 ${shortage.shortQty.toString()}`,
    );
  }
  for (const [index, order] of plan.orders.entries()) {
    const header = await tx.picking_order.create({
      data: {
        picking_order_no: plan.orderNos[index],
        picking_type_code: PICKING_TYPE_MATERIAL,
        source_document_type_code: SOURCE_MATERIAL_ISSUE_REQUEST,
        source_document_id: source.materialIssueRequestId,
        warehouse_id: order.warehouseId,
        status_code: PICKING_REGISTERED,
        assigned_worker_id: plan.assignedWorkerId,
        created_by: appUserId,
      },
      select: { picking_order_id: true },
    });
    await tx.picking_line.createMany({
      data: order.lines.map((line) => ({
        picking_order_id: header.picking_order_id,
        line_no: line.lineNo,
        item_id: line.itemId,
        lot_id: line.lotId,
        location_id: line.locationId,
        planned_qty: line.plannedQty,
        uom_id: line.uomId,
        status_code: PICKING_REGISTERED,
        created_by: appUserId,
      })),
    });
  }
}
