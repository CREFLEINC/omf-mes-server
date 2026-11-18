import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { inboundLineOfLot, receivableQtyOf } from '../goods-receipt/lot-receivable';

/**
 * 「적치 대기」 자재 관리 LOT(피처 009 research R-3) — 목록·LOT 확인·적치 쓰기·배지가 이 판정 하나를 쓴다.
 * 조건: 입하에서 온 LOT · 단말 공장 · (a) 입하 LOT 마감(또는 입하 LOT 없음 — 이전 흐름) · (b) 정상/불량 ·
 * (c) 입고 가능 수량 > 0 · (d) 취소되지 않은 입고 없음 · (e) PENDING 적치 지시 없음. 저장하지 않고 계산한다.
 */
export type PendingReason = 'RECEIVING' | 'INSPECTION' | 'ALREADY_PUT_AWAY' | 'HAS_TASK' | 'DISPOSED' | 'OTHER_PLANT' | 'NOT_INBOUND';

export const PENDING_REASON_MESSAGES: Readonly<Record<PendingReason, string>> = {
  RECEIVING: '입하 마감 전인 LOT 입니다.',
  INSPECTION: 'IQC 판정 전(검사 대기·보류)인 LOT 입니다.',
  ALREADY_PUT_AWAY: '이미 적치된 LOT 입니다.',
  HAS_TASK: '적치 지시가 있는 LOT 입니다 — 적치 지시로 완료합니다.',
  DISPOSED: '처분된 LOT 입니다.',
  OTHER_PLANT: '다른 공장 LOT 입니다.',
  NOT_INBOUND: '구매 입하 LOT 이 아닙니다.',
};

const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
const PUTTABLE_STATUSES = ['NORMAL', 'DEFECTIVE'];
const INSPECTION_STATUS = 'INSPECTION_PENDING';
/** 취소되지 않은 입고 — 취소 요청 중이어도 입고가 살아 있다(지금 입고 처리 화면과 같다). */
const LIVE_RECEIPT_STATUSES = ['POSTED', 'CANCEL_REQUESTED'];

export interface PendingLotFacts {
  lotId: bigint; lotNo: string; plantId: bigint; itemId: bigint; itemCode: string; itemName: string; uomId: bigint; uomCode: string;
  statusCode: string;
  inboundLineId: bigint | null;
  inboundLot: { inboundLotId: bigint; inboundLotNo: string; statusCode: string; closedAt: Date | null } | null;
  supplierName: string | null;
  receivableQty: Prisma.Decimal;
  liveReceipt: { goodsReceiptLineId: bigint } | null;
  pendingTaskIds: bigint[];
}

/** 숨김 이유 — 없으면 적치 대기다. `plantId` 가 `null` 이면(공장을 주지 않은 세션) LOT 의 공장을 그대로 본다. */
export function pendingReasonOf(facts: PendingLotFacts, plantId: bigint | null): PendingReason | null {
  if (facts.inboundLineId === null) return 'NOT_INBOUND';
  if (plantId !== null && facts.plantId !== plantId) return 'OTHER_PLANT';
  if (facts.pendingTaskIds.length > 0) return 'HAS_TASK';
  if (facts.liveReceipt !== null) return 'ALREADY_PUT_AWAY';
  if (facts.inboundLot?.statusCode === 'RECEIVING') return 'RECEIVING';
  if (facts.statusCode === INSPECTION_STATUS) return 'INSPECTION';
  if (facts.inboundLot !== null && facts.inboundLot.statusCode !== 'RECEIVED') return 'DISPOSED';
  if (!PUTTABLE_STATUSES.includes(facts.statusCode) || facts.receivableQty.lessThanOrEqualTo(0)) return 'DISPOSED';
  return null;
}

type Db = Pick<PrismaService, 'lot' | 'goods_receipt_line' | 'inventory_transaction_line' | 'putaway_task' | 'inbound_receipt_line'>;

/** LOT 마다 판정 재료. 없는 LOT 은 빠진다. */
export async function pendingLotFacts(db: Db, lotIds: readonly bigint[]): Promise<Map<bigint, PendingLotFacts>> {
  if (lotIds.length === 0) return new Map();
  const ids = [...new Set(lotIds)];
  const [lots, receivable, receipts, tasks] = await Promise.all([
    db.lot.findMany({
      where: { lot_id: { in: ids } },
      select: {
        lot_id: true, lot_no: true, plant_id: true, item_id: true, uom_id: true, status_code: true, source_type_code: true, source_id: true,
        item: { select: { item_code: true, item_name: true } }, uom: { select: { uom_code: true } },
        inbound_lot: { select: { inbound_lot_id: true, inbound_lot_no: true, status_code: true, received_closed_at: true, supplier: { select: { partner_name: true } } } },
      },
    }),
    receivableQtyOf(db, ids),
    db.goods_receipt_line.findMany({
      where: { lot_id: { in: ids }, goods_receipt: { status_code: { in: LIVE_RECEIPT_STATUSES } } },
      select: { lot_id: true, goods_receipt_line_id: true },
      orderBy: { goods_receipt_line_id: 'desc' },
    }),
    db.putaway_task.findMany({ where: { lot_id: { in: ids }, status_code: 'PENDING' }, select: { lot_id: true, putaway_task_id: true } }),
  ]);
  const result = new Map<bigint, PendingLotFacts>();
  for (const lot of lots) {
    const inboundLineId = lot.source_type_code === INBOUND_LOT_SOURCE
      ? lot.source_id
      : lot.source_type_code === LOT_SPLIT_SOURCE ? await inboundLineOfLot(db, lot.lot_id) : null;
    const receipt = receipts.find((row) => row.lot_id === lot.lot_id);
    result.set(lot.lot_id, {
      lotId: lot.lot_id, lotNo: lot.lot_no, plantId: lot.plant_id, itemId: lot.item_id, itemCode: lot.item.item_code, itemName: lot.item.item_name,
      uomId: lot.uom_id, uomCode: lot.uom.uom_code, statusCode: lot.status_code, inboundLineId,
      inboundLot: lot.inbound_lot === null ? null : {
        inboundLotId: lot.inbound_lot.inbound_lot_id, inboundLotNo: lot.inbound_lot.inbound_lot_no,
        statusCode: lot.inbound_lot.status_code, closedAt: lot.inbound_lot.received_closed_at,
      },
      supplierName: lot.inbound_lot?.supplier.partner_name ?? (inboundLineId === null ? null : await supplierOfLine(db, inboundLineId)),
      receivableQty: receivable.get(lot.lot_id) ?? new Prisma.Decimal(0),
      liveReceipt: receipt === undefined ? null : { goodsReceiptLineId: receipt.goods_receipt_line_id },
      pendingTaskIds: tasks.filter((task) => task.lot_id === lot.lot_id).map((task) => task.putaway_task_id),
    });
  }
  return result;
}

async function supplierOfLine(db: Pick<PrismaService, 'inbound_receipt_line'>, inboundLineId: bigint): Promise<string | null> {
  const line = await db.inbound_receipt_line.findUnique({
    where: { inbound_receipt_line_id: inboundLineId }, select: { inbound_receipt: { select: { partner: { select: { partner_name: true } } } } },
  });
  return line?.inbound_receipt.partner.partner_name ?? null;
}

/**
 * 공장의 적치 대기 LOT — 후보를 SQL 로 좁힌 뒤(입하에서 옴·정상/불량·입하 LOT 마감·입고·지시 없음) 같은 판정으로 거른다.
 * 정렬: 입하 마감 오래된 순(이전 흐름 LOT 먼저) → 입하 LOT 번호 → LOT 번호.
 */
export async function pendingLotsOfPlant(db: Db, plantId: bigint, lotId?: bigint): Promise<PendingLotFacts[]> {
  const candidates = await db.lot.findMany({
    where: {
      plant_id: plantId, status_code: { in: PUTTABLE_STATUSES }, source_type_code: { in: [INBOUND_LOT_SOURCE, LOT_SPLIT_SOURCE] },
      ...(lotId === undefined ? {} : { lot_id: lotId }),
      OR: [{ inbound_lot_id: null }, { inbound_lot: { status_code: 'RECEIVED' } }],
      goods_receipt_line: { none: { goods_receipt: { status_code: { in: LIVE_RECEIPT_STATUSES } } } },
      putaway_task: { none: { status_code: 'PENDING' } },
    },
    select: { lot_id: true },
  });
  const facts = await pendingLotFacts(db, candidates.map((row) => row.lot_id));
  return [...facts.values()]
    .filter((row) => pendingReasonOf(row, plantId) === null)
    .sort((a, b) => compare(a.inboundLot?.closedAt?.getTime() ?? 0, b.inboundLot?.closedAt?.getTime() ?? 0)
      || compare(a.inboundLot?.inboundLotNo ?? '', b.inboundLot?.inboundLotNo ?? '')
      || compare(a.lotNo, b.lotNo));
}

function compare<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PendingLotView {
  lotId: number; lotNo: string; itemId: number; itemCode: string; itemName: string; qty: number; uomCode: string;
  lotStatusCode: string; inboundLotId?: number; inboundLotNo?: string; supplierName?: string; inboundClosedAt?: string;
}

export function pendingLotView(facts: PendingLotFacts): PendingLotView {
  return {
    lotId: Number(facts.lotId), lotNo: facts.lotNo, itemId: Number(facts.itemId), itemCode: facts.itemCode, itemName: facts.itemName,
    qty: facts.receivableQty.toNumber(), uomCode: facts.uomCode, lotStatusCode: facts.statusCode,
    ...(facts.inboundLot === null ? {} : { inboundLotId: Number(facts.inboundLot.inboundLotId), inboundLotNo: facts.inboundLot.inboundLotNo }),
    ...(facts.supplierName === null ? {} : { supplierName: facts.supplierName }),
    ...(facts.inboundLot?.closedAt == null ? {} : { inboundClosedAt: facts.inboundLot.closedAt.toISOString() }),
  };
}
