import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { receivableQtyOf } from '../goods-receipt/lot-receivable';
import { BlockedReason, InboundNextActionCode, InboundStageCode, labelStage, lotStage } from './inbound-stage';

type InspectionView = {
  inspectionRequestId: number;
  inspectionRequestNo: string;
  statusCode: string;
  requestedAt: string;
  judgmentCode: string | null;
  judgedAt: string | null;
};
type GoodsReceiptView = { goodsReceiptId: number; goodsReceiptNo: string; receiptDatetime: string; statusCode: string };
type PutawayView = {
  putawayTaskId: number;
  putawayTaskNo: string;
  statusCode: string;
  locationCode: string | null;
  locationName: string | null;
  completedAt: string | null;
};

/** 계약 `InboundLotProgress` 와 동형(장부 P-110). */
export interface InboundLotProgress {
  purchaseOrderLineId: number;
  inboundReceiptId: number;
  inboundReceiptNo: string;
  inboundReceiptLineId: number;
  receiptDatetime: string;
  /** LOT·상태·입고 가능 수량은 라벨 대기 줄(`LABEL_PENDING`)에서 비어 있다. */
  lotId: number | null;
  lotNo: string | null;
  receivedQty: number;
  receivableQty: number | null;
  uomCode: string;
  lotStatusCode: string | null;
  stageCode: InboundStageCode;
  nextActionCode: InboundNextActionCode;
  blockedReasons: BlockedReason[];
  inspection: InspectionView | null;
  goodsReceipt: GoodsReceiptView | null;
  putaway: PutawayView | null;
}

/** 발주 id 를 함께 든 한 줄 — 목록의 묶음 수가 발주별로 센다. */
export interface InboundLotRow {
  purchaseOrderId: bigint;
  progress: InboundLotProgress;
}

/** 취소했거나 취소 요청 중인 입하 — 취소가 받은 수량을 되돌린다(`inbound-excess.service.ts` 와 같은 기준). */
const RECEIPT_CANCEL_STATUSES = ['CANCELLED', 'CANCEL_REQUESTED'];
const POSTED = 'POSTED';
/** 선별의 선별 정도면 충분하다 — `lot-receivable.ts` 의 상한과 같다. 순환이 생겨도 멈춘다. */
const MAX_DEPTH = 10;
/** 적치 줄이 보여 줄 작업 — 가장 뒤처진 것부터. */
const PUTAWAY_ORDER = ['PENDING', 'COMPLETED_TEMPORARY', 'COMPLETED'];

const LINE_SELECT = {
  inbound_receipt_line_id: true,
  purchase_order_line_id: true,
  inspection_required: true,
  purchase_order_line: { select: { purchase_order_id: true } },
  inbound_receipt: {
    select: { inbound_receipt_id: true, inbound_receipt_no: true, receipt_datetime: true, status_code: true },
  },
} satisfies Prisma.inbound_receipt_lineSelect;

type InboundLine = Prisma.inbound_receipt_lineGetPayload<{ select: typeof LINE_SELECT }>;
type LabelLine = InboundLine & { received_qty: Prisma.Decimal; uom: { uom_code: string } };
/** LOT 이 따르는 입하 라인 — 선별 자식은 조상의 것. */
type LotOrigin = { line: InboundLine; rootLotId: bigint };
type ReceiptsOfLot = { goodsReceipt: GoodsReceiptView | null; putawayTasks: PutawayView[] };

/**
 * 입고 관리 허브(W-01-09)의 LOT 줄. 발주 라인 → 입하 라인 → LOT(선별 자식 포함) → IQC 의뢰 → 입고 → 적치를
 * 한 번에 모아 LOT 마다 단계를 정한다. LOT 을 아직 발행하지 않은 입하 라인은 라인마다 라벨 대기 줄 하나다.
 */
@Injectable()
export class InboundProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async ofPurchaseOrder(purchaseOrderId: number): Promise<InboundLotProgress[]> {
    const order = await this.prisma.purchase_order.findUnique({
      where: { purchase_order_id: purchaseOrderId },
      select: { purchase_order_id: true },
    });
    if (!order) throw new NotFoundException('없는 P/O 입니다.');
    return (await this.lotsOf([order.purchase_order_id])).map((row) => row.progress);
  }

  async lotsOf(purchaseOrderIds: readonly bigint[]): Promise<InboundLotRow[]> {
    if (purchaseOrderIds.length === 0) return [];
    const lines = await this.prisma.inbound_receipt_line.findMany({
      where: { purchase_order_line: { purchase_order_id: { in: [...purchaseOrderIds] } } },
      select: { ...LINE_SELECT, lot_id: true, received_qty: true, uom: { select: { uom_code: true } } },
      orderBy: { inbound_receipt_line_id: 'asc' },
    });
    const labelRows = lines.flatMap((line) => (line.lot_id === null ? labelRow(line) : []));
    const origins = await this.withSplitChildren(lines);
    const lotIds = [...origins.keys()];
    const [lots, receivable, inspections, holds, receipts] = await Promise.all([
      this.prisma.lot.findMany({
        where: { lot_id: { in: lotIds } },
        select: { lot_id: true, lot_no: true, initial_qty: true, status_code: true, uom: { select: { uom_code: true } } },
        orderBy: { lot_id: 'asc' },
      }),
      receivableQtyOf(this.prisma, lotIds),
      this.inspections(lotIds),
      this.openHolds(lotIds),
      this.receipts(lotIds),
    ]);
    const lotRows = lots.flatMap((lot): InboundLotRow[] => {
      const origin = origins.get(lot.lot_id);
      if (origin === undefined) return [];
      const { line, rootLotId } = origin;
      const orderLine = line.purchase_order_line;
      if (orderLine === null) return [];
      const header = line.inbound_receipt;
      const inspection = inspections.get(lot.lot_id) ?? inspections.get(rootLotId) ?? null;
      const receivableQty = receivable.get(lot.lot_id) ?? new Prisma.Decimal(0);
      const { goodsReceipt, putawayTasks } = receipts.get(lot.lot_id) ?? { goodsReceipt: null, putawayTasks: [] };
      const stage = lotStage({
        receiptCancelled: RECEIPT_CANCEL_STATUSES.includes(header.status_code),
        lotStatusCode: lot.status_code,
        inspectionRequired: line.inspection_required,
        inspectionStatusCode: inspection?.statusCode ?? null,
        openHolds: holds.get(lot.lot_id) ?? [],
        receivableQty,
        putawayStatusCodes: putawayTasks.map((task) => task.statusCode),
      });
      const progress: InboundLotProgress = {
        ...lineFields(line),
        lotId: Number(lot.lot_id),
        lotNo: lot.lot_no,
        receivedQty: lot.initial_qty.toNumber(),
        receivableQty: receivableQty.toNumber(),
        uomCode: lot.uom.uom_code,
        lotStatusCode: lot.status_code,
        ...stage,
        inspection,
        goodsReceipt,
        putaway: putawayTasks[0] ?? null,
      };
      return [{ purchaseOrderId: orderLine.purchase_order_id, progress }];
    });
    return [...labelRows, ...lotRows];
  }

  /** 입하 LOT 마다 그 입하 라인. 선별 자식(`LOT_SPLIT`)은 조상의 라인을 따른다 — 검사 대상 표식도 그렇다. */
  private async withSplitChildren(lines: (InboundLine & { lot_id: bigint | null })[]): Promise<Map<bigint, LotOrigin>> {
    const origins = new Map<bigint, LotOrigin>();
    for (const { lot_id: lotId, ...line } of lines) {
      if (lotId !== null) origins.set(lotId, { line, rootLotId: lotId });
    }
    let frontier = [...origins.keys()];
    for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth += 1) {
      const children = await this.prisma.lot.findMany({
        where: { parent_lot_id: { in: frontier }, source_type_code: LOT_SPLIT_SOURCE },
        select: { lot_id: true, parent_lot_id: true },
      });
      frontier = [];
      for (const child of children) {
        const parent = child.parent_lot_id === null ? undefined : origins.get(child.parent_lot_id);
        if (parent === undefined || origins.has(child.lot_id)) continue;
        origins.set(child.lot_id, parent);
        frontier.push(child.lot_id);
      }
    }
    return origins;
  }

  /** LOT 마다 가장 최근 IQC 의뢰. 판정은 의뢰가 끝났을 때만 — 재검사 중에는 앞 판정을 싣지 않는다. */
  private async inspections(lotIds: bigint[]): Promise<Map<bigint, InspectionView>> {
    const requests = await this.prisma.inspection_request.findMany({
      where: { lot_id: { in: lotIds }, inspection_type_code: 'IQC' },
      orderBy: [{ requested_at: 'desc' }, { inspection_request_id: 'desc' }],
      select: {
        inspection_request_id: true,
        inspection_request_no: true,
        status_code: true,
        requested_at: true,
        lot_id: true,
        inspection_result: {
          where: { status_code: 'CONFIRMED' },
          orderBy: { inspection_round: 'desc' },
          take: 1,
          select: { overall_judgment_code: true, confirmed_at: true },
        },
      },
    });
    const byLot = new Map<bigint, InspectionView>();
    for (const request of requests) {
      if (request.lot_id === null || byLot.has(request.lot_id)) continue;
      const judged = request.status_code === 'COMPLETED' ? request.inspection_result[0] : undefined;
      byLot.set(request.lot_id, {
        inspectionRequestId: Number(request.inspection_request_id),
        inspectionRequestNo: request.inspection_request_no,
        statusCode: request.status_code,
        requestedAt: request.requested_at.toISOString(),
        judgmentCode: judged?.overall_judgment_code ?? null,
        judgedAt: judged?.confirmed_at?.toISOString() ?? null,
      });
    }
    return byLot;
  }

  /** 열린 보류(`released_at IS NULL`)의 사유와 이름 — 건 순서대로, 같은 사유는 한 번. */
  private async openHolds(lotIds: bigint[]): Promise<Map<bigint, BlockedReason[]>> {
    const holds = await this.prisma.lot_hold.findMany({
      where: { lot_id: { in: lotIds }, released_at: null },
      orderBy: [{ held_at: 'asc' }, { lot_hold_id: 'asc' }],
      select: { lot_id: true, reason_code: true },
    });
    const codes = [...new Set(holds.map((hold) => hold.reason_code))];
    const names =
      codes.length === 0
        ? []
        : await this.prisma.code_value.findMany({
          where: { code: { in: codes }, code_group: { group_code: 'LOT_HOLD_REASON' } },
          select: { code: true, code_name: true },
        });
    const nameOf = new Map(names.map((value) => [value.code, value.code_name]));
    const byLot = new Map<bigint, BlockedReason[]>();
    for (const hold of holds) {
      const reasons = byLot.get(hold.lot_id) ?? [];
      if (!reasons.some((reason) => reason.code === hold.reason_code)) {
        reasons.push({ code: hold.reason_code, name: nameOf.get(hold.reason_code) ?? hold.reason_code });
      }
      byLot.set(hold.lot_id, reasons);
    }
    return byLot;
  }

  /**
   * LOT 마다 가장 최근 입고(취소 완료는 뺀다)와 적치 작업. 적치는 «살아 있는»(POSTED) 입고의 것만 —
   * 입고를 취소해도 그 작업은 PENDING 으로 남지만 끝낼 수 없다(`putaway-complete.service.ts`).
   */
  private async receipts(lotIds: bigint[]): Promise<Map<bigint, ReceiptsOfLot>> {
    const lines = await this.prisma.goods_receipt_line.findMany({
      where: { lot_id: { in: lotIds }, goods_receipt: { status_code: { not: 'CANCELLED' } } },
      orderBy: [{ goods_receipt: { receipt_datetime: 'desc' } }, { goods_receipt_line_id: 'desc' }],
      select: {
        lot_id: true,
        goods_receipt: {
          select: { goods_receipt_id: true, goods_receipt_no: true, receipt_datetime: true, status_code: true },
        },
        putaway_task: {
          where: { status_code: { not: 'CANCELLED' } },
          select: {
            putaway_task_id: true,
            putaway_task_no: true,
            status_code: true,
            completed_at: true,
            location_putaway_task_actual_location_idTolocation: { select: { location_code: true, location_name: true } },
          },
        },
      },
    });
    const byLot = new Map<bigint, ReceiptsOfLot>();
    for (const { lot_id: lotId, goods_receipt: header, putaway_task: tasks } of lines) {
      const entry = byLot.get(lotId) ?? {
        goodsReceipt: {
          goodsReceiptId: Number(header.goods_receipt_id),
          goodsReceiptNo: header.goods_receipt_no,
          receiptDatetime: header.receipt_datetime.toISOString(),
          statusCode: header.status_code,
        },
        putawayTasks: [],
      };
      if (header.status_code === POSTED) {
        for (const task of tasks) {
          const location = task.location_putaway_task_actual_location_idTolocation;
          entry.putawayTasks.push({
            putawayTaskId: Number(task.putaway_task_id),
            putawayTaskNo: task.putaway_task_no,
            statusCode: task.status_code,
            locationCode: location?.location_code ?? null,
            locationName: location?.location_name ?? null,
            completedAt: task.completed_at?.toISOString() ?? null,
          });
        }
      }
      byLot.set(lotId, entry);
    }
    for (const entry of byLot.values()) entry.putawayTasks.sort(byPutawayOrder);
    return byLot;
  }
}

/** 가장 뒤처진 작업이 앞 — 같은 상태면 늦게 끝난 것이 앞. */
function byPutawayOrder(a: PutawayView, b: PutawayView): number {
  const rank = PUTAWAY_ORDER.indexOf(a.statusCode) - PUTAWAY_ORDER.indexOf(b.statusCode);
  if (rank !== 0) return rank;
  return (b.completedAt ?? '').localeCompare(a.completedAt ?? '');
}

function lineFields(line: InboundLine): Pick<InboundLotProgress,
  'purchaseOrderLineId' | 'inboundReceiptId' | 'inboundReceiptNo' | 'inboundReceiptLineId' | 'receiptDatetime'> {
  const header = line.inbound_receipt;
  return {
    purchaseOrderLineId: Number(line.purchase_order_line_id),
    inboundReceiptId: Number(header.inbound_receipt_id),
    inboundReceiptNo: header.inbound_receipt_no,
    inboundReceiptLineId: Number(line.inbound_receipt_line_id),
    receiptDatetime: header.receipt_datetime.toISOString(),
  };
}

/** LOT 이 없는 입하 라인 — 수량·단위는 라인의 것이고 LOT·검사·입고·적치 칸은 비어 있다. */
function labelRow(line: LabelLine): InboundLotRow[] {
  const orderLine = line.purchase_order_line;
  if (orderLine === null) return [];
  const progress: InboundLotProgress = {
    ...lineFields(line),
    lotId: null,
    lotNo: null,
    receivedQty: line.received_qty.toNumber(),
    receivableQty: null,
    uomCode: line.uom.uom_code,
    lotStatusCode: null,
    ...labelStage(RECEIPT_CANCEL_STATUSES.includes(line.inbound_receipt.status_code)),
    inspection: null,
    goodsReceipt: null,
    putaway: null,
  };
  return [{ purchaseOrderId: orderLine.purchase_order_id, progress }];
}
