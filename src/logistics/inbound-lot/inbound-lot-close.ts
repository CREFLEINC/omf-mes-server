import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';

import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';
import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { idempotencyContextOf } from '../../common/master';
import { assertUpdated } from '../../common/optimistic-lock';
import { INBOUND_LOT_RECEIVING, type InboundLotActor, IqcHandoverNotifier } from '../../core/lot';
import { NumberingService } from '../../core/numbering';
import { findInspectionPlanVersion, itemIqcDefaultSkipped } from '../../core/quality/inspection-plan-version';
import { localDate } from '../../planning/production-plan/plan-window';
import { PrismaService } from '../../prisma/prisma.service';
import { assertInstant } from '../../trace/lot/lot-rules';
import { CLOSED_ORDER_STATUSES } from '../purchase-order/purchase-order-receipt';
import { LogisticsWriteActor } from '../logistics-write-actor';
import { recordInboundLotEvent } from './inbound-lot-event';
import { InboundLotView, loadInboundLotViews } from './inbound-lot-view';
import { AutoAllocationResult, allocateByOrderAge } from './po-auto-allocate';

/** 계약 `InboundLotCloseReceipt`. */
export interface InboundLotCloseReceipt {
  versionNo: number;
  occurredAt: string;
}

/** 계약 `InboundLotClosed`. */
export interface InboundLotClosedView extends InboundLotView {
  iqcRequestId: number | null;
}

export interface CloseInboundLotInput {
  inboundLotId: bigint;
  /** null = 시스템(날짜 자동 마감) — 이벤트 행위자·`received_closed_by` 가 비고 `closed_automatically` 가 선다. */
  actor: InboundLotActor | null;
  auto: boolean;
  at: Date;
  /** IQC 기준 버전·생략 판단의 날짜(공장 현지). */
  effectiveDate: string;
  /** 트랜잭션 밖에서 미리 뽑은 IQC 요청 번호. 요청이 필요한데 없으면 `IqcRequestNoNeeded`. */
  iqcRequestNo: string | null;
  terminalAudit?: LogisticsWriteActor['terminalAudit'];
}

export interface ClosedInboundLot {
  inboundLotNo: string;
  iqcRequestId: bigint | null;
  allocation: AutoAllocationResult;
}

/** 요청이 필요한데 번호가 없다 — 트랜잭션을 버리고 번호를 뽑아 다시 한다(채번은 트랜잭션 밖). */
export class IqcRequestNoNeeded extends Error {}

interface LockedForClose {
  inbound_lot_id: bigint;
  inbound_lot_no: string;
  plant_id: bigint;
  supplier_id: bigint;
  item_id: bigint;
  uom_id: bigint;
  status_code: string;
  version_no: number;
  inbound_receipt_line_id: bigint;
}

const RECEIVED = 'RECEIVED';
const RETRY = 3;
const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

/**
 * 입하 마감 코어(R-5a) — 수동(`:close-receipt`)·날짜 자동 마감(받기 때 확인 · S6 러너)이 같은 코어를 쓴다.
 * P/O 부모를 오름차순으로 잠그고 자동 배정(R-22) → 받은 양 증가 → `RECEIVED` → IQC 요청(또는 생략 기록)·인계 알림 → 이벤트.
 */
@Injectable()
export class InboundLotCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly iqcNotices: IqcHandoverNotifier,
  ) {}

  /** `POST /logistics/inbound-lots/{id}:close-receipt`. */
  async close(request: Request, inboundLotId: number, body: InboundLotCloseReceipt, actor: LogisticsWriteActor): Promise<InboundLotClosedView> {
    const errors: ErrorItem[] = [];
    assertInstant('occurredAt', body.occurredAt, errors);
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
    const context = idempotencyContextOf(request, HttpStatus.OK);
    const replay = await this.idempotency.replayExisting<InboundLotClosedView>(context);
    if (replay !== undefined) return replay.body;

    const id = BigInt(inboundLotId);
    const head = await this.prisma.inbound_lot.findUnique({
      where: { inbound_lot_id: id },
      select: { plant_id: true, item_id: true, plant: { select: { timezone_code: true } }, inbound_receipt_line: { select: { inspection_required: true } } },
    });
    if (head === null) throw new NotFoundException('없는 입하 LOT 입니다.');
    const effectiveDate = localDate(new Date(body.occurredAt), head.plant.timezone_code);
    const needsNo = (await iqcRecordOf(this.prisma as unknown as Prisma.TransactionClient, head.item_id, head.inbound_receipt_line.inspection_required, effectiveDate)) !== null;
    let iqcRequestNo = needsNo ? await this.numbering.next('INSPECTION_REQUEST', head.plant_id, effectiveDate) : null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = await this.idempotency.run(context, async (tx) => {
          const locked = await lockForClose(tx, id);
          assertUpdated(locked.version_no === body.versionNo ? 1 : 0);
          const closed = await this.closeInboundLot(tx, {
            inboundLotId: id, actor, auto: false, at: new Date(body.occurredAt), effectiveDate, iqcRequestNo, terminalAudit: actor.terminalAudit,
          });
          const [view] = await loadInboundLotViews(tx, { inbound_lot_id: id });
          return { ...view, iqcRequestId: closed.iqcRequestId === null ? null : Number(closed.iqcRequestId) };
        }, TRANSACTION_OPTIONS);
        return outcome.body;
      } catch (error) {
        if (attempt >= RETRY || !(error instanceof IqcRequestNoNeeded)) throw error;
        iqcRequestNo = await this.numbering.next('INSPECTION_REQUEST', head.plant_id, effectiveDate);
      }
    }
  }

  async closeInboundLot(tx: Prisma.TransactionClient, input: CloseInboundLotInput): Promise<ClosedInboundLot> {
    const locked = await lockForClose(tx, input.inboundLotId);
    if (locked.status_code !== INBOUND_LOT_RECEIVING) throw stateLocked('입하 중인 입하 LOT 만 마감할 수 있습니다.');
    const lotCount = await tx.lot.count({ where: { inbound_lot_id: locked.inbound_lot_id } });
    if (lotCount === 0) throw stateLocked('자재 관리 LOT 이 없는 입하 LOT 은 마감할 수 없습니다.');
    const line = await tx.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: locked.inbound_receipt_line_id },
      select: { received_qty: true, inspection_required: true, inbound_receipt: { select: { inbound_receipt_id: true, inbound_receipt_no: true } } },
    });
    const iqc = await iqcRecordOf(tx, locked.item_id, line.inspection_required, input.effectiveDate);
    if (iqc !== null && input.iqcRequestNo === null) throw new IqcRequestNoNeeded();

    const by = input.actor?.appUserId === undefined ? null : BigInt(input.actor.appUserId);
    const allocation = allocateByOrderAge(line.received_qty, await lockCandidates(tx, locked));
    for (const row of allocation.allocations) {
      await tx.purchase_order_line.update({
        where: { purchase_order_line_id: row.purchaseOrderLineId }, data: { received_qty: { increment: row.qty }, updated_by: by },
      });
      await tx.inbound_receipt_po_allocation.create({
        data: { inbound_receipt_line_id: locked.inbound_receipt_line_id, purchase_order_line_id: row.purchaseOrderLineId,
          allocated_qty: row.qty, created_by: by, updated_by: by },
      });
    }
    await tx.inbound_lot.update({
      where: { inbound_lot_id: locked.inbound_lot_id },
      data: {
        status_code: RECEIVED, open_since_date: null, received_closed_at: input.at,
        // 마감한 사람은 작업자(PDA)다 — 계정 세션·시스템이면 비고, 행위자는 이벤트가 남긴다.
        received_closed_by: input.actor?.workerId ?? null, closed_automatically: input.auto,
        version_no: { increment: 1 }, updated_by: by,
      },
    });
    const iqcRequestId = iqc === null ? null : await this.createIqcRequest(tx, locked, input, {
      ...iqc, requestNo: input.iqcRequestNo as string, qty: line.received_qty, lotCount,
      inboundReceiptId: line.inbound_receipt.inbound_receipt_id, inboundReceiptNo: line.inbound_receipt.inbound_receipt_no,
    });
    await recordInboundLotEvent(tx, locked.inbound_lot_id, 'RECEIPT_CLOSED', input.actor, {
      auto: input.auto,
      allocations: allocation.allocations.map((row) => ({ purchaseOrderLineId: String(row.purchaseOrderLineId), qty: row.qty.toString() })),
      unallocatedQty: allocation.unallocatedQty.toString(),
      iqcRequestId: iqcRequestId === null ? null : String(iqcRequestId),
    }, input.at);
    if (input.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, {
        actor: input.terminalAudit, targetTypeCode: 'INBOUND_LOT', targetId: locked.inbound_lot_id, eventTypeCode: 'RECEIPT_CLOSED',
      });
    }
    return { inboundLotNo: locked.inbound_lot_no, iqcRequestId, allocation };
  }

  /** 입하 LOT 요청 — 대상은 자재 관리 LOT 전부(`lot_id` 없음 · 「요청의 LOT 들」), 수량은 그 합(= 줄 수량). */
  private async createIqcRequest(
    tx: Prisma.TransactionClient, locked: LockedForClose, input: CloseInboundLotInput,
    iqc: IqcRecord & { requestNo: string; qty: Prisma.Decimal; lotCount: number; inboundReceiptId: bigint; inboundReceiptNo: string },
  ): Promise<bigint> {
    const skipped = iqc.statusCode === 'SKIPPED';
    const request = await tx.inspection_request.create({
      data: {
        inspection_request_no: iqc.requestNo, inspection_type_code: 'IQC', inspection_plan_version_id: iqc.planVersionId,
        target_type_code: 'INBOUND_LOT', target_id: locked.inbound_lot_id, inbound_lot_id: locked.inbound_lot_id, lot_id: null,
        item_id: locked.item_id, target_qty: iqc.qty, uom_id: locked.uom_id, status_code: iqc.statusCode,
        skip_basis_code: skipped ? 'DEFAULT' : null, requested_at: input.at,
        created_by: input.actor?.appUserId === undefined ? null : BigInt(input.actor.appUserId),
      },
      select: { inspection_request_id: true },
    });
    if (input.terminalAudit !== undefined) {
      await recordTerminalWorkerAudit(tx, {
        actor: input.terminalAudit, targetTypeCode: 'INSPECTION_REQUEST', targetId: request.inspection_request_id, eventTypeCode: 'CREATED',
      });
    }
    if (!skipped) {
      await this.iqcNotices.notify(tx, {
        // ⚠ 알림은 aggregate 당 한 번이라 마감 취소 뒤 다시 마감하면 다시 알리지 않는다 — 대상 유형은 계약 enum·클라 이동과 묶여 있다.
        aggregateTypeCode: 'INBOUND_RECEIPT', aggregateId: iqc.inboundReceiptId, plantId: locked.plant_id,
        receiptNo: input.auto ? `${iqc.inboundReceiptNo} (자동 마감)` : iqc.inboundReceiptNo,
        lotCount: iqc.lotCount, inboundReceiptId: iqc.inboundReceiptId,
      });
    }
    return request.inspection_request_id;
  }
}

interface IqcRecord {
  statusCode: 'REQUESTED' | 'SKIPPED';
  planVersionId: bigint | null;
}

/**
 * 마감이 세울 IQC 요청 — 지금 입하의 규칙 그대로(#101·#212·#215). 검사 필요로 받은 입하 LOT 은 검사 요청, 아니면 품목이 검사
 * 대상(기준이 기본 생략)이거나 품목 전용 기준이 기본 생략일 때만 생략(DEFAULT) 기록, 그 밖(검사 대상 아님)은 요청 없음.
 */
export async function iqcRecordOf(
  db: Prisma.TransactionClient, itemId: bigint, inspectionNeeded: boolean, effectiveDate: string,
): Promise<IqcRecord | null> {
  if (!inspectionNeeded) {
    const item = await db.item.findUniqueOrThrow({ where: { item_id: itemId }, select: { inspection_required: true } });
    if (!item.inspection_required && !(await itemIqcDefaultSkipped(db, Number(itemId), effectiveDate))) return null;
  }
  return {
    statusCode: inspectionNeeded ? 'REQUESTED' : 'SKIPPED',
    planVersionId: await findInspectionPlanVersion(db, 'IQC', Number(itemId), effectiveDate),
  };
}

async function lockForClose(tx: Prisma.TransactionClient, inboundLotId: bigint): Promise<LockedForClose> {
  const rows = await tx.$queryRaw<LockedForClose[]>`
    SELECT inbound_lot_id, inbound_lot_no, plant_id, supplier_id, item_id, uom_id, status_code, version_no, inbound_receipt_line_id
      FROM trace.inbound_lot
     WHERE inbound_lot_id = ${inboundLotId}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 입하 LOT 입니다.');
  return rows[0];
}

/**
 * 후보 P/O 라인(R-22 의 1) — 부모 P/O 를 «먼저» 오름차순 한 문장으로 잠그고 라인을 읽는다(`received_qty` 를 쓰는 모든 경로의 불변식,
 * `inbound-receipt.service.ts` `lockParentsOf`).
 */
async function lockCandidates(tx: Prisma.TransactionClient, locked: LockedForClose) {
  const parents = await tx.$queryRaw<{ purchase_order_id: bigint }[]>`
    SELECT po.purchase_order_id
      FROM logistics.purchase_order po
     WHERE po.plant_id = ${locked.plant_id} AND po.supplier_id = ${locked.supplier_id}
       AND po.status_code NOT IN (${Prisma.join(CLOSED_ORDER_STATUSES)})
       AND EXISTS (SELECT 1 FROM logistics.purchase_order_line l
                    WHERE l.purchase_order_id = po.purchase_order_id AND l.item_id = ${locked.item_id}
                      AND l.uom_id = ${locked.uom_id} AND l.cancelled_at IS NULL)
     ORDER BY po.purchase_order_id
       FOR UPDATE`;
  if (parents.length === 0) return [];
  const lines = await tx.purchase_order_line.findMany({
    where: {
      purchase_order_id: { in: parents.map((row) => row.purchase_order_id) },
      item_id: locked.item_id, uom_id: locked.uom_id, cancelled_at: null,
    },
    select: {
      purchase_order_line_id: true, line_no: true, ordered_qty: true, tolerance_over_qty: true, received_qty: true,
      purchase_order: { select: { order_date: true, purchase_order_no: true } },
    },
  });
  return lines.map((row) => ({
    purchaseOrderLineId: row.purchase_order_line_id, lineNo: row.line_no,
    orderDate: row.purchase_order.order_date.toISOString().slice(0, 10), purchaseOrderNo: row.purchase_order.purchase_order_no,
    orderedQty: row.ordered_qty, toleranceOverQty: row.tolerance_over_qty, receivedQty: row.received_qty,
  }));
}

function stateLocked(message: string): ContractException {
  return new ContractException(HttpStatus.CONFLICT, [{ scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }]);
}
