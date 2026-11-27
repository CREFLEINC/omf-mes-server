import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ERROR_CODE, field, one } from '../../common/errors';
import { InventoryPostingService } from '../../core/inventory-posting';
// ⛔ `index.ts` 가 재수출하지 않는다 — 코어 파일은 import 만 한다(옛 `:pick` 과 같다).
import { LockedBalanceRow, lockBalancesByItemLot } from '../../core/inventory-posting/balance-lock';
import { NumberingService } from '../../core/numbering';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogisticsWriteActor } from '../logistics-write-actor';
import { assertNoUnconfirmedSplit } from '../product-lot-split/product-lot-split-guard';
import { assertLotsReleased } from '../shipment/shipment-rules';
import {
  CandidateLineRow,
  WAREHOUSE_PICK_CONFLICT,
  chooseLine,
  findBusinessUnitLot,
  inTerminalScope,
  lockItemLines,
  lockLotBalances,
  notInLineWarehouse,
} from './shipment-lot-pick-warehouse';
import { SHIPMENT_REQUEST_LINE, pickedQtyOf } from './shipment-progress';
import { TerminalShipmentScope } from './shipment-request-scope';
import { ShipmentRequestQueryService } from './shipment-request-query.service';
import { ShipmentRequestLineView, ShipmentRequestLotView } from './shipment-request-view';

/** 계약 `ShipmentLotPick` — 둘 중 하나. 스캔은 LOT 번호, 목록 선택은 id 다. */
export interface ShipmentLotPick {
  lotId?: number;
  lotNo?: string;
}

export interface ShipmentLotPickResult {
  pickedLot: ShipmentRequestLotView;
  /** 실제로 피킹한 줄 — 경로의 줄과 다를 수 있다(LOT 창고로 고른다 · 피처 012 R-3). */
  line: ShipmentRequestLineView;
  /** 줄 출고 창고 밖에 남은 그 LOT 수량(피처 012 Edge) — 0 이면 싣지 않는다. */
  otherWarehouseQty?: number;
}

/** `ShipmentConflictResponse.code` — 피처 010 이 더한 피킹 사유. */
export const PICK_CONFLICT = {
  USE_PICK_LOT: 'USE_PICK_LOT',
  LOT_TARGET_REACHED: 'LOT_TARGET_REACHED',
  LOT_ALREADY_RESERVED: 'LOT_ALREADY_RESERVED',
  LOT_ALREADY_PICKED: 'LOT_ALREADY_PICKED',
  NO_LINE_FOR_ITEM: 'NO_LINE_FOR_ITEM',
  ...WAREHOUSE_PICK_CONFLICT,
  /** 피처 013 — 확인 전 분리의 원래·자식 LOT. */
  LOT_SPLIT_UNCONFIRMED: 'LOT_SPLIT_UNCONFIRMED',
} as const;

const INVALID_STATE = 'INVALID_STATE';
const RESERVATION_TYPE_SHIPMENT = 'SHIPMENT';
const RESERVATION_REGISTERED = 'REGISTERED';
const INVENTORY_RESERVATION = 'INVENTORY_RESERVATION';
const PICKED = 'PICKED';
const REPLACED = 'REPLACED';
const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86_400_000;

interface LineRow {
  shipment_request_line_id: bigint;
  shipment_request_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  allocated_qty: Prisma.Decimal;
  minimum_remaining_shelf_life_days: number | null;
  fulfillment_plant_id: bigint | null;
  warehouse_id: bigint | null;
  business_unit_id: bigint | null;
}

interface LotRow {
  lot_id: bigint;
  item_id: bigint;
  status_code: string;
  expiry_date: Date | null;
}

/**
 * LOT 통째 피킹(`M-04-01` PDA · 피처 010 R-1·R-2·R-3).
 *
 * ⭐ LOT 의 **공장 안** 가용 잔액 행을 전부 잡는다(불량창고 제외 — 여러 창고·위치·적치 대기 자리 포함). 행마다
 *    예약을 하나씩 걸고 곧바로 푼다(옛 `:pick` 의 ⓒ안 — 순변화는 `picked += 행 가용`). 수량 입력은 없다.
 * ⭐ 라인 피킹 합이 목표(배정)보다 작을 때만 받는다 — 초과는 마지막 LOT 에서만 생긴다(FR-005).
 * ⛔ 다른 예약·피킹·차단이 걸린 행이 하나라도 있으면 통째로 잡을 수 없어 409 다(LOT 이 갈라지면 LOT 단위 OQC·교체와 어긋난다).
 */
@Injectable()
export class ShipmentLotPickService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: InventoryPostingService,
    private readonly numbering: NumberingService,
    private readonly queries: ShipmentRequestQueryService,
  ) {}

  async pickLot(
    shipmentRequestId: number,
    shipmentRequestLineId: number,
    body: ShipmentLotPick,
    actor: LogisticsWriteActor,
    scope?: TerminalShipmentScope,
  ): Promise<ShipmentLotPickResult> {
    if (body.lotId === undefined && (body.lotNo === undefined || body.lotNo.trim() === '')) {
      throw one(field('lotId', ERROR_CODE.REQUIRED, 'LOT 을 스캔하거나 고르세요.'));
    }
    // ⛔ 채번은 트랜잭션 «밖»이다(옛 `:pick` 과 같은 이유 — P2024). 잔액 행이 여럿이면 뒤에 순번을 붙인다.
    const now = new Date();
    const reservationNo = await this.numbering.next(INVENTORY_RESERVATION, null, now.toISOString().slice(0, 10));

    const picked = await this.prisma.$transaction(async (tx) => {
      const line = await lockLine(tx, shipmentRequestId, shipmentRequestLineId);
      if (line === undefined) throw new NotFoundException('없는 출하작업지시 라인입니다.');
      // 줄 출고 창고가 있는 사업부 지시서(피처 012) — 경로의 줄은 품목 힌트다.
      if (line.warehouse_id !== null) return this.pickInLineWarehouse(tx, line, body, actor, scope, reservationNo, now);
      if (line.fulfillment_plant_id === null) {
        throw conflict(INVALID_STATE, '이행 공장이 지정되지 않은 출하작업지시는 피킹할 수 없습니다.');
      }
      const plantId = line.fulfillment_plant_id;
      const lot = await findLot(tx, body, plantId);
      await assertLineItem(tx, line, lot);
      await assertNotPicked(tx, line, lot);
      const picked = await linePicked(tx, line.shipment_request_line_id);
      if (!picked.lessThan(line.allocated_qty)) {
        throw conflict(
          PICK_CONFLICT.LOT_TARGET_REACHED,
          `목표 수량을 채웠습니다. (목표 ${line.allocated_qty.toString()} · 피킹 ${picked.toString()})`,
        );
      }
      await assertPickable(tx, lot);
      await assertNoUnconfirmedSplit(tx, lot.lot_id);
      assertLotsReleased([{ lotId: lot.lot_id, statusCode: lot.status_code }], () => 'lotId');
      assertShelfLife(lot, line, now);

      const rows = await lockPlantBalances(tx, lot, plantId);
      const total = rows.reduce((sum, row) => sum.plus(row.on_hand_qty), ZERO);
      for (const [index, row] of rows.entries()) {
        await this.reserveAndPick(tx, line, row, index === 0 ? reservationNo : `${reservationNo}-${index + 1}`, actor);
      }
      return { lotRowId: await recordPicked(tx, line, lot.lot_id, total, actor, now), lineId: line.shipment_request_line_id, other: ZERO };
    });

    const detail = await this.queries.get(shipmentRequestId);
    const lineView = (detail.lines ?? []).find((row) => row.shipmentRequestLineId === Number(picked.lineId));
    if (lineView === undefined) throw new Error('피킹한 라인을 다시 읽지 못했다');
    const pickedLot = lineView.lots.find((row) => row.shipmentRequestLotId === Number(picked.lotRowId));
    if (pickedLot === undefined) throw new Error('피킹 LOT 행을 다시 읽지 못했다');
    return { pickedLot, line: lineView, ...(picked.other.greaterThan(0) ? { otherWarehouseQty: Number(picked.other) } : {}) };
  }

  /**
   * 사업부 지시서 피킹(피처 012 R-3) — LOT 의 가용 잔액이 있는 창고로 같은 품목·단말 범위 줄을 고르고(`chooseLine`) 그 창고의
   * 잔액만 통째로 잡는다. 다른 창고에 남은 몫은 `otherWarehouseQty` 로 알린다(두 창고에 걸친 LOT).
   */
  private async pickInLineWarehouse(
    tx: Prisma.TransactionClient,
    hint: LineRow,
    body: ShipmentLotPick,
    actor: LogisticsWriteActor,
    scope: TerminalShipmentScope | undefined,
    reservationNo: string,
    now: Date,
  ): Promise<{ lotRowId: bigint; lineId: bigint; other: Prisma.Decimal }> {
    const lot = await findBusinessUnitLot(tx, body, hint.business_unit_id, scope?.plantId);
    const itemLines = await lockItemLines(tx, hint.shipment_request_id, lot.item_id);
    if (itemLines.length === 0) throw conflict(PICK_CONFLICT.NO_LINE_FOR_ITEM, '이 지시서에 그 LOT 품목의 라인이 없습니다.');
    await assertNotPicked(tx, hint, lot);
    await assertPickable(tx, lot);
    await assertNoUnconfirmedSplit(tx, lot.lot_id);
    assertLotsReleased([{ lotId: lot.lot_id, statusCode: lot.status_code }], () => 'lotId');

    const rows = await lockLotBalances(tx, lot);
    if (rows.length === 0) throw conflict(INVALID_STATE, '그 LOT 의 재고가 없습니다.');
    const lines = inTerminalScope(itemLines, scope);
    const candidates = await Promise.all(lines.map(async (row) => ({
      lineId: row.shipment_request_line_id, lineNo: row.line_no, warehouseId: row.warehouse_id,
      allocated: row.allocated_qty, picked: await linePicked(tx, row.shipment_request_line_id),
    })));
    const choice = chooseLine(candidates, new Set(rows.map((row) => String(row.warehouseId))));
    if (choice.kind === 'NOT_IN_LINE_WAREHOUSE') throw await notInLineWarehouse(tx, rows);
    if (choice.kind === 'TARGET_REACHED') {
      throw conflict(PICK_CONFLICT.LOT_TARGET_REACHED,
        `목표 수량을 채웠습니다. (라인 ${choice.line.lineNo} · 목표 ${choice.line.allocated.toString()} · 피킹 ${choice.line.picked.toString()})`);
    }
    const chosen = lines.find((row) => row.shipment_request_line_id === choice.line.lineId) as CandidateLineRow;
    if (!chosen.warehouse_active || chosen.warehouse_business_unit_id !== hint.business_unit_id) {
      throw conflict(PICK_CONFLICT.LINE_WAREHOUSE_UNAVAILABLE, '출고 창고를 쓸 수 없습니다. (비활성이거나 지시서 사업부의 창고가 아닙니다)');
    }
    const line: LineRow = { ...hint, shipment_request_line_id: chosen.shipment_request_line_id, uom_id: chosen.uom_id,
      allocated_qty: chosen.allocated_qty, minimum_remaining_shelf_life_days: chosen.minimum_remaining_shelf_life_days, warehouse_id: chosen.warehouse_id };
    assertShelfLife(lot, line, now);

    const mine = rows.filter((row) => row.warehouseId === chosen.warehouse_id);
    await assertNotBusy(tx, lot, mine);
    for (const [index, row] of mine.entries()) {
      await this.reserveAndPick(tx, line, row, index === 0 ? reservationNo : `${reservationNo}-${index + 1}`, actor);
    }
    const total = mine.reduce((sum, row) => sum.plus(row.on_hand_qty), ZERO);
    const other = rows.filter((row) => row.warehouseId !== chosen.warehouse_id).reduce((sum, row) => sum.plus(row.on_hand_qty), ZERO);
    return { lotRowId: await recordPicked(tx, line, lot.lot_id, total, actor, now), lineId: line.shipment_request_line_id, other };
  }

  /** 잔액 행 하나 — 그 행의 가용 전부를 예약하고 곧바로 피킹으로 옮긴다(ⓒ안). 차원 11칸은 잠근 행에서 그대로 옮긴다. */
  private async reserveAndPick(
    tx: Prisma.TransactionClient,
    line: LineRow,
    balance: LockedBalanceRow,
    reservationNo: string,
    actor: LogisticsWriteActor,
  ): Promise<void> {
    const qty = new Prisma.Decimal(balance.on_hand_qty);
    const dimension = {
      legalEntityId: balance.legalEntityId,
      businessUnitId: balance.businessUnitId,
      plantId: balance.plantId,
      warehouseId: balance.warehouseId,
      locationId: balance.locationId,
      itemId: balance.itemId,
      lotId: balance.lotId,
      qualityStatusCode: balance.quality_status_code,
      inventoryStatusCode: balance.inventory_status_code,
      ownershipTypeCode: balance.ownership_type_code,
      ownerPartnerId: balance.owner_partner_id,
    };
    const [reservationId] = await this.posting.reserve(tx, [
      {
        dimension,
        qty,
        reservationNo,
        reservationTypeCode: RESERVATION_TYPE_SHIPMENT,
        sourceDocumentTypeCode: SHIPMENT_REQUEST_LINE,
        sourceDocumentId: line.shipment_request_line_id,
        uomId: line.uom_id,
        statusCode: RESERVATION_REGISTERED,
        ...(actor.appUserId === undefined ? {} : { createdBy: BigInt(actor.appUserId) }),
        field: 'lotId',
      },
    ]);
    await this.posting.pick(tx, [{ dimension, delta: qty, inventoryReservationId: reservationId, field: 'lotId' }]);
  }
}

/** 라인만 잠근다(헤더는 공유) — 같은 지시서의 여러 라인을 동시에 스캔하는 것이 정상 흐름이다(옛 `:pick` 과 같다). */
async function lockLine(tx: Prisma.TransactionClient, requestId: number, lineId: number): Promise<LineRow | undefined> {
  const [line] = await tx.$queryRaw<LineRow[]>`
    SELECT l.shipment_request_line_id, l.shipment_request_id, l.item_id, l.uom_id, l.allocated_qty,
           l.minimum_remaining_shelf_life_days, h.fulfillment_plant_id, l.warehouse_id, h.business_unit_id
      FROM logistics.shipment_request_line l
      JOIN logistics.shipment_request h ON h.shipment_request_id = l.shipment_request_id
     WHERE l.shipment_request_line_id = ${lineId}
       AND l.shipment_request_id = ${requestId}
       FOR UPDATE OF l FOR SHARE OF h`;
  return line;
}

/** LOT 번호는 공장 안에서만 유일하다 — 지시서 이행 공장으로 좁힌다. 남의 공장 LOT 은 「없는 LOT」이다. */
async function findLot(tx: Prisma.TransactionClient, body: ShipmentLotPick, plantId: bigint): Promise<LotRow> {
  const select = { lot_id: true, item_id: true, status_code: true, expiry_date: true };
  const lot = body.lotId !== undefined
    ? await tx.lot.findFirst({ where: { lot_id: BigInt(body.lotId), plant_id: plantId }, select })
    : await tx.lot.findFirst({ where: { lot_no: (body.lotNo as string).trim(), plant_id: plantId }, select });
  if (lot === null) {
    throw one(field(body.lotId !== undefined ? 'lotId' : 'lotNo', ERROR_CODE.INVALID, '이 공장의 LOT 이 아닙니다.'));
  }
  return lot;
}

/** 그 품목 라인이 지시서에 없으면 409, 있지만 다른 라인이면 400(화면이 라인을 잘못 골랐다). */
async function assertLineItem(tx: Prisma.TransactionClient, line: LineRow, lot: LotRow): Promise<void> {
  if (lot.item_id === line.item_id) return;
  const other = await tx.shipment_request_line.findFirst({
    where: { shipment_request_id: line.shipment_request_id, item_id: lot.item_id },
    select: { line_no: true },
  });
  if (other === null) throw conflict(PICK_CONFLICT.NO_LINE_FOR_ITEM, '이 지시서에 그 LOT 품목의 라인이 없습니다.');
  throw one(field('lotId', ERROR_CODE.INVALID, `이 라인의 품목이 아닌 LOT 입니다. (라인 ${other.line_no} 의 품목)`));
}

/** 같은 지시서에 살아 있는(교체 아님) 피킹 LOT 이면 409 — 라인이 달라도 같다. */
async function assertNotPicked(tx: Prisma.TransactionClient, line: LineRow, lot: LotRow): Promise<void> {
  const found = await tx.shipment_request_lot.findFirst({
    where: {
      lot_id: lot.lot_id,
      status_code: { not: REPLACED },
      shipment_request_line: { shipment_request_id: line.shipment_request_id },
    },
    select: { shipment_request_lot_id: true },
  });
  if (found !== null) throw conflict(PICK_CONFLICT.LOT_ALREADY_PICKED, '이미 이 지시서에 피킹한 LOT 입니다.');
}

async function linePicked(tx: Prisma.TransactionClient, lineId: bigint): Promise<Prisma.Decimal> {
  const rows = await tx.inventory_reservation.findMany({
    where: { source_document_type_code: SHIPMENT_REQUEST_LINE, source_document_id: lineId },
    select: { reserved_qty: true, released_qty: true },
  });
  return pickedQtyOf(rows.map((row) => ({ reservedQty: row.reserved_qty, releasedQty: row.released_qty })));
}

/** 미해제 보류·`blocks_picking` 상태 — 옛 `:pick` 과 같은 문구다. */
async function assertPickable(tx: Prisma.TransactionClient, lot: LotRow): Promise<void> {
  const hold = await tx.lot_hold.findFirst({
    where: { lot_id: lot.lot_id, released_at: null },
    select: { reason_code: true },
  });
  if (hold !== null) throw conflict(INVALID_STATE, `보류 중인 LOT 입니다. (사유: ${hold.reason_code})`);
  const blocked = await tx.judgment_type_control.findFirst({
    where: { blocks_picking: true, lot_status_code: lot.status_code },
    select: { code_value_id: true },
  });
  if (blocked !== null) throw conflict(INVALID_STATE, '피킹이 막힌 LOT 상태입니다.');
}

/** 잔여 유효기간 — 옛 `:pick` 과 같은 400 `RANGE`. 유효기간이 없는 LOT 은 하한이 있는 라인에서 통과하지 못한다. */
function assertShelfLife(lot: LotRow, line: LineRow, now: Date): void {
  const min = line.minimum_remaining_shelf_life_days;
  if (min === null) return;
  if (lot.expiry_date === null) throw one(field('lotId', ERROR_CODE.RANGE, `유효기간이 없는 LOT 입니다. (요구 ${min}일)`));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const actual = Math.floor((lot.expiry_date.getTime() - today) / DAY_MS);
  if (actual < min) {
    throw one(field('lotId', ERROR_CODE.RANGE, `잔여 유효기간이 모자랍니다. (요구 ${min}일 · 실제 ${actual}일)`));
  }
}

/**
 * LOT 의 공장 안 잔액 행 — 보유 > 0 이고 불량창고가 아닌 것. 잠금은 코어와 같은 순서(`inventory_balance_id`)다.
 * ⛔ 하나라도 예약·피킹·차단이 걸려 있으면 409 — 잠근 «뒤»에 읽어 잠금 밖의 값으로 판정하지 않는다.
 */
async function lockPlantBalances(tx: Prisma.TransactionClient, lot: LotRow, plantId: bigint): Promise<LockedBalanceRow[]> {
  const locked = await lockBalancesByItemLot(tx, lot.item_id, lot.lot_id);
  const defect = new Set(
    (await tx.warehouse.findMany({ where: { plant_id: plantId, is_defect: true }, select: { warehouse_id: true } }))
      .map((row) => String(row.warehouse_id)),
  );
  const rows = locked.filter(
    (row) => row.plantId === plantId && !defect.has(String(row.warehouseId)) && new Prisma.Decimal(row.on_hand_qty).greaterThan(0),
  );
  if (rows.length === 0) throw conflict(INVALID_STATE, '그 LOT 의 재고가 없습니다.');
  await assertNotBusy(tx, lot, rows);
  return rows;
}

/** 잡을 행 가운데 하나라도 예약·피킹·차단이 걸려 있으면 409 — 통째로 잡을 수 없다. 잠근 «뒤»에 읽는다. */
async function assertNotBusy(tx: Prisma.TransactionClient, lot: LotRow, rows: LockedBalanceRow[]): Promise<void> {
  const busy = await tx.inventory_balance.count({
    where: {
      item_id: lot.item_id,
      lot_id: lot.lot_id,
      plant_id: { in: [...new Set(rows.map((row) => row.plantId))] },
      warehouse_id: { in: [...new Set(rows.map((row) => row.warehouseId))] },
      on_hand_qty: { gt: 0 },
      OR: [{ reserved_qty: { gt: 0 } }, { picked_qty: { gt: 0 } }, { blocked_qty: { gt: 0 } }],
    },
  });
  if (busy > 0) throw conflict(PICK_CONFLICT.LOT_ALREADY_RESERVED, '다른 작업에 잡힌 LOT 입니다. 통째로 피킹할 수 없습니다.');
}

/** 피킹 LOT 행 + 단말 감사 — 옛 줄·창고 줄이 같다. */
async function recordPicked(
  tx: Prisma.TransactionClient, line: LineRow, lotId: bigint, total: Prisma.Decimal, actor: LogisticsWriteActor, now: Date,
): Promise<bigint> {
  const created = await tx.shipment_request_lot.create({
    data: {
      shipment_request_line_id: line.shipment_request_line_id,
      lot_id: lotId,
      picked_qty: total,
      uom_id: line.uom_id,
      status_code: PICKED,
      picked_at: now,
      picked_worker_id: actor.workerId ?? null,
      created_by: actor.appUserId === undefined ? null : BigInt(actor.appUserId),
    },
  });
  if (actor.terminalAudit !== undefined) {
    await recordTerminalWorkerAudit(tx, {
      actor: actor.terminalAudit,
      targetTypeCode: 'SHIPMENT_REQUEST_LINE',
      targetId: line.shipment_request_line_id,
      eventTypeCode: 'PICK',
    });
  }
  return created.shipment_request_lot_id;
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException('user', message, { code });
}
