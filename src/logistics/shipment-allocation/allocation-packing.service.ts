import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertWorkerNoPresent } from '../../common/master';
// ⭐ 01 자재창고가 «소유한» 상수를 그대로 쓴다 — 값을 베끼면 저쪽이 늘 때 여기만 조용히 뒤처진다
//    (README §6-4). 도메인 간 상수 import 선례: `inspection-plan.service.ts:20` 의 `REVISION_STATUS`.
import { HU_STATUS_PACKED } from '../../inventory/handling-unit/handling-unit-status';
import { PrismaService } from '../../prisma/prisma.service';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { ShipmentAllocationQueryService } from './shipment-allocation-query.service';
import { ShipmentLotAllocationView } from './shipment-allocation-view';

/** 계약 `ShipmentLotAllocationPacking` — required 1 · 프로퍼티 1. */
export interface ShipmentLotAllocationPacking {
  handlingUnitId: number;
}

export interface AllocationPackingContext {
  /** ⚠ 저장하지 않는다 — `shipment_lot_allocation` 에 담을 칸이 0개다(§7-4 「읽고 버림」형). */
  workerNo?: string;
  actor?: LogisticsWriteActor;
}

/** 409 enum 다섯 중 이 자리가 쓰는 하나. `code` 는 계약 required 라 명시로 넘긴다(R-18). */
const INVALID_STATE = 'INVALID_STATE';
const HU_FIELD = 'handlingUnitId';

/**
 * The packing-result client completes :pack before linking. Requiring PACKED
 * prevents an OPEN unit from changing its contents after a reported full pack.
 */
const PACKABLE_STATUS: ReadonlySet<string> = new Set([HU_STATUS_PACKED]);

interface AllocationRow {
  shipment_lot_allocation_id: bigint;
  handling_unit_id: bigint | null;
  current_handling_unit_no: string | null;
  warehouse_id: bigint;
  item_id: bigint;
  lot_id: bigint;
  uom_id: bigint;
  allocated_qty: Prisma.Decimal;
}

/**
 * `PUT /logistics/shipment-lot-allocations/{id}` — 배분에 포장 단위를 잇는다(`P-04-01` §4-C).
 * ⛔ `handling_unit_content` 를 **만들지 않는다** — 내용물은 01 계약(`:pack`)이 소유한다(§3-3).
 */
@Injectable()
export class AllocationPackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queries: ShipmentAllocationQueryService,
  ) {}

  async pack(
    shipmentLotAllocationId: number,
    body: ShipmentLotAllocationPacking,
    context: AllocationPackingContext,
  ): Promise<ShipmentLotAllocationView> {
    // ① 계약 가드가 헤더를 «안 본다»(`contract-validation.guard.ts:39`) — 서버가 유일한 그물이다.
    assertWorkerNoPresent(context.workerNo);
    const handlingUnitId = BigInt(body.handlingUnitId);

    await this.prisma.$transaction(async (tx) => {
      const allocation = await lockAllocation(tx, shipmentLotAllocationId);
      // ③ ⛔ 404 는 «배분»에만이다 — 없는 HU 는 ④ 의 400 `INVALID` 다(A-25).
      if (allocation === undefined) throw new NotFoundException('없는 출하 LOT 배분입니다.');

      await assertPackable(tx, handlingUnitId, allocation.warehouse_id);
      await assertContentCoversAllocation(tx, handlingUnitId, allocation);

      // ⑦ ⭐ 멱등의 방향이 «둘»이다 — 같은 HU 면 행을 건드리지 않고 200, 다른 HU 면 409.
      //    ⛔ 둘 중 하나만 걸면 나머지 변이가 조용히 산다(A-20·A-21 이 서로를 죽인다).
      if (allocation.handling_unit_id === handlingUnitId) return;
      if (allocation.handling_unit_id !== null) {
        // ⭐ 409 넷이 전부 `INVALID_STATE` 라 **문구가 사유를 싣는다**(R-18 · §3-4). 화면은 «현재
        //   HU»를 모르면 다음 행동(그 포장을 풀 것인가)을 정하지 못한다.
        throw conflict(`이미 다른 포장 단위에 담겼습니다. (현재 ${allocation.current_handling_unit_no})`);
      }

      await tx.shipment_lot_allocation.update({
        where: { shipment_lot_allocation_id: allocation.shipment_lot_allocation_id },
        data: { handling_unit_id: handlingUnitId },
      });
      if (context.actor?.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
        actor: context.actor.terminalAudit, targetTypeCode: 'SHIPMENT_LOT_ALLOCATION',
        targetId: allocation.shipment_lot_allocation_id, eventTypeCode: 'LINK_HANDLING_UNIT',
      });
    });

    // ⑨ ⛔ 되읽기는 ⑦a 의 뷰 «그대로»다 — `oqcPassed`·`packedQty` 를 여기서 다시 세면 목록이 쓰는
    //    LOT 모집단(예약 축 · `SHIPMENT_REQUEST_LINE`)과 갈린다(⑦a 리뷰 Major-1).
    return this.queries.get(shipmentLotAllocationId);
  }
}

/**
 * ③ ⭐ **`FOR UPDATE OF a`** — 배분 «한 행»만 잠근다. 헤더까지 잠그면 같은 출하의 다른 배분을 잇는
 * 스캔이 서로를 막는데, 여러 배분을 연달아 포장하는 것이 `P-04-01` 의 정상 흐름이다(⑥ 이
 * `FOR UPDATE OF l` 에 같은 이유를 적었다). ⚠ 범위를 넓혀도 HTTP 로는 안 갈린다(§12-1).
 */
async function lockAllocation(
  tx: Prisma.TransactionClient,
  shipmentLotAllocationId: number,
): Promise<AllocationRow | undefined> {
  const [row] = await tx.$queryRaw<AllocationRow[]>`
    SELECT a.shipment_lot_allocation_id, a.handling_unit_id, s.warehouse_id,
           sl.item_id, a.lot_id, a.uom_id, a.allocated_qty,
           hu.handling_unit_no AS current_handling_unit_no
      FROM logistics.shipment_lot_allocation a
      JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
      JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
      LEFT JOIN inventory.handling_unit hu ON hu.handling_unit_id = a.handling_unit_id
     WHERE a.shipment_lot_allocation_id = ${shipmentLotAllocationId}
       FOR UPDATE OF a`;
  return row;
}

/**
 * ④⑤⑥ — **순서가 판정이다**(§3-4). ⛔⛔ ⑤ 는 **널을 통과시키지 않는다** —
 * `handling_unit.warehouse_id` 는 nullable 이고 창고를 확인할 수 없으면 붙이지 않는다(기준 2 ·
 * R-13 Minor 5). ⭐ 널과 불일치를 «따로» 던진다 — 합치면 널 갈래를 지워도 대조가 대신 막아
 * 서로의 변이를 못 죽인다(§6-3 ⑴).
 */
async function assertPackable(
  tx: Prisma.TransactionClient,
  handlingUnitId: bigint,
  shipmentWarehouseId: bigint,
): Promise<void> {
  const [hu] = await tx.$queryRaw<{ warehouse_id: bigint | null; status_code: string }[]>`
    SELECT warehouse_id, status_code FROM inventory.handling_unit
     WHERE handling_unit_id = ${handlingUnitId} FOR UPDATE`;
  if (hu === undefined) throw invalid('없는 취급 단위입니다.');
  if (hu.warehouse_id === null) throw invalid('취급 단위의 창고를 알 수 없어 연결할 수 없습니다.');
  if (hu.warehouse_id !== shipmentWarehouseId) throw invalid('출하 창고와 다른 창고의 취급 단위입니다.');
  if (!PACKABLE_STATUS.has(hu.status_code)) {
    throw invalid(`포장할 수 없는 취급 단위 상태입니다. (${hu.status_code})`);
  }
}

/** An allocation is reported fully packed once linked, so the HU must hold at
 * least the sum of every linked allocation for this exact item/LOT/UOM. The HU
 * lock serializes competing links and content replacement around this check. */
async function assertContentCoversAllocation(
  tx: Prisma.TransactionClient,
  handlingUnitId: bigint,
  allocation: AllocationRow,
): Promise<void> {
  const dimension = {
    handling_unit_id: handlingUnitId,
    item_id: allocation.item_id,
    lot_id: allocation.lot_id,
    uom_id: allocation.uom_id,
  };
  const [content, linked] = await Promise.all([
    tx.handling_unit_content.findFirst({ where: dimension, select: { qty: true } }),
    tx.shipment_lot_allocation.aggregate({
      where: {
        handling_unit_id: handlingUnitId,
        lot_id: allocation.lot_id,
        uom_id: allocation.uom_id,
        shipment_line: { item_id: allocation.item_id },
      },
      _sum: { allocated_qty: true },
    }),
  ]);
  const alreadyLinked = linked._sum.allocated_qty ?? new Prisma.Decimal(0);
  const needed = alreadyLinked.plus(allocation.handling_unit_id === handlingUnitId ? 0 : allocation.allocated_qty);
  if (content === null || content.qty.lt(needed)) {
    throw invalid('취급 단위의 해당 품목·LOT·단위 수량이 배분 수량보다 적습니다.');
  }
}

function invalid(message: string): ContractException {
  return one(field(HU_FIELD, ERROR_CODE.INVALID, message));
}

/** ⭐ `code` 는 계약 required 인데 공용 예외는 «선택»으로 둔다 — 이 자리가 명시로 넘긴다. */
function conflict(message: string): ConflictException {
  return new ConflictException('user', message, { code: INVALID_STATE });
}
