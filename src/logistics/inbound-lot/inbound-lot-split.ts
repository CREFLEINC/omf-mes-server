import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { INBOUND_RECEIPT_LINE_SOURCE, type InboundLotActor } from '../../core/lot';
import { recordInboundLotEvent } from './inbound-lot-event';
import { assertInboundLotMutable, inboundLotFinalized } from './inbound-lot-finalizable';

type Db = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);
const RECEIVED = 'RECEIVED';
export const SPLIT_REMAIN_MESSAGE = '원래 입하 LOT에 자재 관리 LOT가 하나 이상 남아야 합니다';

/** 원래 줄의 P/O 배정 한 줄(라인당 합) — 채움 순서(`po-auto-allocate.ts` 의 발주일·P/O 번호·라인 번호)를 함께 든다. */
export interface SplitAllocationRow {
  purchaseOrderLineId: bigint;
  orderDate: string;
  purchaseOrderNo: string;
  lineNo: number;
  qty: Prisma.Decimal;
}

/** 새 입하 LOT 로 옮겨질 배정 — `purchaseOrderLineId` null 은 「P/O 없음」. */
export interface MovedAllocation {
  purchaseOrderLineId: bigint | null;
  purchaseOrderNo: string | null;
  lineNo: number | null;
  qty: Prisma.Decimal;
}

/**
 * 배정 이전(R-14b) — 옮기는 수량만큼 「P/O 없음」부터, 그다음 채움 역순(마지막에 채운 라인부터) 뗀다. 떼어 낸 P/O 몫은 같은 라인으로
 * 새 줄에 배정하므로 P/O 라인 받은 양 합은 그대로다. 「P/O 없음 먼저」는 초과·불량분이 ERP 몫을 덜 깎게 하는 보수적 기본값이다.
 */
export function planAllocationTransfer(
  movedQty: Prisma.Decimal, unallocatedQty: Prisma.Decimal, allocations: readonly SplitAllocationRow[],
): MovedAllocation[] {
  const moved: MovedAllocation[] = [];
  let rest = movedQty;
  const free = Prisma.Decimal.min(rest, Prisma.Decimal.max(ZERO, unallocatedQty));
  if (free.greaterThan(0)) {
    moved.push({ purchaseOrderLineId: null, purchaseOrderNo: null, lineNo: null, qty: free });
    rest = rest.minus(free);
  }
  for (const row of [...allocations].sort(byOrderAge).reverse()) {
    if (rest.lessThanOrEqualTo(0)) break;
    const share = Prisma.Decimal.min(rest, row.qty);
    if (share.lessThanOrEqualTo(0)) continue;
    moved.push({ purchaseOrderLineId: row.purchaseOrderLineId, purchaseOrderNo: row.purchaseOrderNo, lineNo: row.lineNo, qty: share });
    rest = rest.minus(share);
  }
  return moved;
}

export interface SplitResultInput {
  inspectionResultId: bigint;
  seqNo: number;
  overallJudgmentCode: string | null;
  lotIds: bigint[];
}

export interface SplitResultClasses {
  /** 옮긴 LOT 에만 매칭 — IQC 단계는 새 검사로 옮기고, 처분 단계는 복사한다. */
  moved: SplitResultInput[];
  /** 다른 LOT 와 함께 매칭 — 남기고 옮긴 LOT 매칭만 지운다. */
  unmatched: (SplitResultInput & { removedLotIds: bigint[] })[];
  /** 옮긴 LOT 와 매칭이 없다 — 그대로 남는다. */
  kept: SplitResultInput[];
}

/** 결과 이동 분류(R-14b · FR-040). 매칭이 없는 결과는 남긴다. 순번 순. */
export function classifySplitResults(results: readonly SplitResultInput[], movedLotIds: readonly bigint[]): SplitResultClasses {
  const movedSet = new Set(movedLotIds);
  const classes: SplitResultClasses = { moved: [], unmatched: [], kept: [] };
  for (const result of [...results].sort((left, right) => left.seqNo - right.seqNo)) {
    const removedLotIds = result.lotIds.filter((lotId) => movedSet.has(lotId));
    if (removedLotIds.length === 0) classes.kept.push(result);
    else if (removedLotIds.length === result.lotIds.length) classes.moved.push(result);
    else classes.unmatched.push({ ...result, removedLotIds });
  }
  return classes;
}

/** 분리 계획 — 미리 보기와 실행이 같은 계산을 쓴다. */
export interface InboundLotSplitPlan {
  inboundLot: {
    inbound_lot_id: bigint; inbound_lot_no: string; plant_id: bigint; item_id: bigint; supplier_id: bigint; uom_id: bigint;
    status_code: string; receiving_date: Date; received_closed_at: Date | null; received_closed_by: bigint | null;
    closed_automatically: boolean; erp_send_mode_code: string; inbound_receipt_line_id: bigint; version_no: number;
  };
  movedLots: { lot_id: bigint; lot_no: string; initial_qty: Prisma.Decimal }[];
  remainingLots: { lot_id: bigint; lot_no: string; initial_qty: Prisma.Decimal }[];
  movedQty: Prisma.Decimal;
  remainingQty: Prisma.Decimal;
  allocations: MovedAllocation[];
}

/**
 * 고른 자재 관리 LOT 을 검증하고 옮길 것을 계산한다. 같은 LOT 두 번·다른 입하 LOT 의 LOT·LOT 전부는 400, 마감(`RECEIVED`)이 아니면 409.
 * 입하 중에는 해제(`:unregister-lots`)가 같은 일을 하고, 최종 마감 막음(`INBOUND_LOT_FINALIZED`)은 부르는 쪽 맨 앞이다.
 */
export async function planInboundLotSplit(db: Db, inboundLotId: bigint, lotIds: readonly number[]): Promise<InboundLotSplitPlan> {
  const ids = lotIds.map((id) => BigInt(id));
  if (ids.length === 0) throw one(field('lotIds', ERROR_CODE.REQUIRED, '옮길 자재 관리 LOT 을 고르세요.'));
  if (new Set(ids).size !== ids.length) throw one(field('lotIds', ERROR_CODE.INVALID, '같은 LOT 을 두 번 실었습니다.'));
  const inboundLot = await db.inbound_lot.findUnique({
    where: { inbound_lot_id: inboundLotId },
    select: {
      inbound_lot_id: true, inbound_lot_no: true, plant_id: true, item_id: true, supplier_id: true, uom_id: true, status_code: true,
      receiving_date: true, received_closed_at: true, received_closed_by: true, closed_automatically: true, erp_send_mode_code: true,
      inbound_receipt_line_id: true, version_no: true,
    },
  });
  if (inboundLot === null) throw new NotFoundException('없는 입하 LOT 입니다.');
  if (inboundLot.status_code === 'FINALIZED') throw inboundLotFinalized();
  if (inboundLot.status_code !== RECEIVED) {
    throw new ContractException(HttpStatus.CONFLICT, [{
      scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '마감된 입하 LOT 만 자재 관리 LOT 을 분리할 수 있습니다.',
    }]);
  }
  const lots = await db.lot.findMany({
    where: { inbound_lot_id: inboundLotId }, select: { lot_id: true, lot_no: true, initial_qty: true }, orderBy: { lot_id: 'asc' },
  });
  const chosen = new Set(ids);
  const movedLots = lots.filter((lot) => chosen.has(lot.lot_id));
  if (movedLots.length !== ids.length) throw one(field('lotIds', ERROR_CODE.INVALID, '이 입하 LOT 의 자재 관리 LOT 이 아닌 것이 섞여 있습니다.'));
  const remainingLots = lots.filter((lot) => !chosen.has(lot.lot_id));
  if (remainingLots.length === 0) throw one(field('lotIds', ERROR_CODE.INVALID, SPLIT_REMAIN_MESSAGE));

  const sum = (rows: { initial_qty: Prisma.Decimal }[]) => rows.reduce((total, row) => total.plus(row.initial_qty), ZERO);
  const movedQty = sum(movedLots);
  const line = await db.inbound_receipt_line.findUniqueOrThrow({
    where: { inbound_receipt_line_id: inboundLot.inbound_receipt_line_id },
    select: {
      received_qty: true,
      inbound_receipt_po_allocation: {
        select: {
          purchase_order_line_id: true, allocated_qty: true,
          purchase_order_line: { select: { line_no: true, purchase_order: { select: { purchase_order_no: true, order_date: true } } } },
        },
      },
    },
  });
  const byLine = new Map<bigint, SplitAllocationRow>();
  for (const row of line.inbound_receipt_po_allocation) {
    const order = row.purchase_order_line.purchase_order;
    const current = byLine.get(row.purchase_order_line_id);
    byLine.set(row.purchase_order_line_id, {
      purchaseOrderLineId: row.purchase_order_line_id, orderDate: order.order_date.toISOString().slice(0, 10),
      purchaseOrderNo: order.purchase_order_no, lineNo: row.purchase_order_line.line_no,
      qty: (current?.qty ?? ZERO).plus(row.allocated_qty),
    });
  }
  const allocated = [...byLine.values()].reduce((total, row) => total.plus(row.qty), ZERO);
  return {
    inboundLot, movedLots, remainingLots, movedQty, remainingQty: sum(remainingLots),
    allocations: planAllocationTransfer(movedQty, line.received_qty.minus(allocated), [...byLine.values()]),
  };
}

export interface SplitInboundLotInput {
  inboundLotId: bigint;
  lotIds: readonly number[];
  /** 트랜잭션 밖에서 뽑은 새 입하 LOT 번호(`INBOUND_LOT` 채번). */
  newInboundLotNo: string;
  /** IQC 단계 분리는 입하 LOT 판 번호를 받는다 — 처분 단계 선별은 부적합 판 번호로 잠근다. */
  versionNo?: number;
  actor: InboundLotActor;
  at: Date;
  reason?: string | null;
}

export interface SplitInboundLotOutcome {
  plan: InboundLotSplitPlan;
  newInboundLotId: bigint;
}

/**
 * 자재 관리 LOT 분리 코어(R-14b · FR-039) — IQC 단계 `:split-lots` 와 처분 단계 선별이 같이 쓴다. 한 트랜잭션에서:
 * 원래 입하 LOT 의 LOT(오름차순)·입하 LOT 잠금 → 같은 공장·품목·공급사의 새 입하 LOT(`RECEIVED`·원래 것 이어받기) → 같은 입하 헤더에
 * 새 줄(옮긴 LOT 합)·원래 줄 감소 → 옮긴 LOT 의 입하 LOT·원천(새 줄) → 배정 이전(받은 양 합 불변) → 이벤트 `SPLIT`(양쪽).
 * LOT 번호·라벨은 그대로다. 검사·부적합은 부르는 쪽이 다룬다.
 */
export async function splitInboundLot(tx: Db, input: SplitInboundLotInput): Promise<SplitInboundLotOutcome> {
  // 받기·해제·마감 취소와 같은 순서 — LOT 을 먼저(오름차순), 그다음 입하 LOT.
  await tx.$queryRaw`SELECT lot_id FROM trace.lot WHERE inbound_lot_id = ${input.inboundLotId} ORDER BY lot_id FOR UPDATE`;
  const [locked] = await tx.$queryRaw<{ version_no: number }[]>`
    SELECT version_no FROM trace.inbound_lot WHERE inbound_lot_id = ${input.inboundLotId} FOR UPDATE`;
  if (locked === undefined) throw new NotFoundException('없는 입하 LOT 입니다.');
  await assertInboundLotMutable(tx, input.inboundLotId);
  if (input.versionNo !== undefined) assertUpdated(locked.version_no === input.versionNo ? 1 : 0);
  const plan = await planInboundLotSplit(tx, input.inboundLotId, input.lotIds);
  const source = plan.inboundLot;
  const by = input.actor.appUserId === undefined ? null : BigInt(input.actor.appUserId);

  const line = await tx.inbound_receipt_line.update({
    where: { inbound_receipt_line_id: source.inbound_receipt_line_id },
    data: { received_qty: { decrement: plan.movedQty }, updated_by: by },
    select: { inbound_receipt_id: true, item_id: true, uom_id: true, inspection_required: true, status_code: true },
  });
  const last = await tx.inbound_receipt_line.aggregate({ where: { inbound_receipt_id: line.inbound_receipt_id }, _max: { line_no: true } });
  const newLine = await tx.inbound_receipt_line.create({
    data: {
      inbound_receipt_id: line.inbound_receipt_id, line_no: (last._max.line_no ?? 0) + 1, item_id: line.item_id, received_qty: plan.movedQty,
      uom_id: line.uom_id, supplier_lot_missing: false, supplier_lot_label_attached: false, inspection_required: line.inspection_required,
      status_code: line.status_code, created_by: by,
    },
    select: { inbound_receipt_line_id: true },
  });
  const created = await tx.inbound_lot.create({
    data: {
      inbound_lot_no: input.newInboundLotNo, plant_id: source.plant_id, item_id: source.item_id, supplier_id: source.supplier_id,
      uom_id: source.uom_id, status_code: RECEIVED, receiving_date: source.receiving_date,
      // 옮긴 LOT 은 원래 입하 LOT 과 함께 마감됐다 — 마감 칸도 이어받는다(CHECK `ck_inbound_lot_closed`).
      received_closed_at: source.received_closed_at, received_closed_by: source.received_closed_by,
      closed_automatically: source.closed_automatically, erp_send_mode_code: source.erp_send_mode_code,
      inbound_receipt_line_id: newLine.inbound_receipt_line_id, split_from_inbound_lot_id: source.inbound_lot_id, created_by: by,
    },
    select: { inbound_lot_id: true },
  });
  const movedIds = plan.movedLots.map((lot) => lot.lot_id);
  await tx.lot.updateMany({ where: { lot_id: { in: movedIds } }, data: { inbound_lot_id: created.inbound_lot_id, updated_by: by } });
  await tx.lot.updateMany({
    where: { lot_id: { in: movedIds }, source_type_code: INBOUND_RECEIPT_LINE_SOURCE, source_id: source.inbound_receipt_line_id },
    data: { source_id: newLine.inbound_receipt_line_id },
  });
  await moveAllocations(tx, source.inbound_receipt_line_id, newLine.inbound_receipt_line_id, plan.allocations, by);
  await tx.inbound_lot.update({ where: { inbound_lot_id: source.inbound_lot_id }, data: { version_no: { increment: 1 }, updated_by: by } });

  const lots = plan.movedLots.map((lot) => ({ lotId: String(lot.lot_id), lotNo: lot.lot_no, lotQty: lot.initial_qty.toString() }));
  const allocations = plan.allocations.map((row) => ({
    purchaseOrderLineId: row.purchaseOrderLineId === null ? null : String(row.purchaseOrderLineId), qty: row.qty.toString(),
  }));
  const reason = input.reason?.trim() || null;
  await recordInboundLotEvent(tx, source.inbound_lot_id, 'SPLIT', input.actor, {
    direction: 'OUT', newInboundLotId: String(created.inbound_lot_id), newInboundLotNo: input.newInboundLotNo, lots, allocations,
  }, input.at, reason);
  await recordInboundLotEvent(tx, created.inbound_lot_id, 'SPLIT', input.actor, {
    direction: 'IN', splitFromInboundLotId: String(source.inbound_lot_id), splitFromInboundLotNo: source.inbound_lot_no, lots, allocations,
  }, input.at, reason);
  return { plan, newInboundLotId: created.inbound_lot_id };
}

/** 원래 줄 배정 행을 줄이고(0 이면 지운다) 같은 P/O 라인으로 새 줄에 배정 행을 만든다. P/O 라인 받은 양은 건드리지 않는다. */
async function moveAllocations(tx: Db, fromLineId: bigint, toLineId: bigint, moved: readonly MovedAllocation[], by: bigint | null): Promise<void> {
  for (const row of moved) {
    if (row.purchaseOrderLineId === null) continue;
    let rest = row.qty;
    const rows = await tx.inbound_receipt_po_allocation.findMany({
      where: { inbound_receipt_line_id: fromLineId, purchase_order_line_id: row.purchaseOrderLineId },
      select: { inbound_receipt_po_allocation_id: true, allocated_qty: true }, orderBy: { inbound_receipt_po_allocation_id: 'desc' },
    });
    for (const existing of rows) {
      if (rest.lessThanOrEqualTo(0)) break;
      const share = Prisma.Decimal.min(rest, existing.allocated_qty);
      const where = { inbound_receipt_po_allocation_id: existing.inbound_receipt_po_allocation_id };
      if (share.equals(existing.allocated_qty)) await tx.inbound_receipt_po_allocation.delete({ where });
      else await tx.inbound_receipt_po_allocation.update({ where, data: { allocated_qty: { decrement: share }, updated_by: by } });
      rest = rest.minus(share);
    }
    await tx.inbound_receipt_po_allocation.create({
      data: { inbound_receipt_line_id: toLineId, purchase_order_line_id: row.purchaseOrderLineId, allocated_qty: row.qty, created_by: by, updated_by: by },
    });
  }
}

function byOrderAge(left: SplitAllocationRow, right: SplitAllocationRow): number {
  if (left.orderDate !== right.orderDate) return left.orderDate < right.orderDate ? -1 : 1;
  if (left.purchaseOrderNo !== right.purchaseOrderNo) return left.purchaseOrderNo < right.purchaseOrderNo ? -1 : 1;
  return left.lineNo - right.lineNo;
}
