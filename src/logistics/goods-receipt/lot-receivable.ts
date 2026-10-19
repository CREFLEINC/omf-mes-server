import { Prisma } from '@prisma/client';

import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 입하 LOT 의 «입고 가능 수량»(장부 P-56 · 3단계 검증 2026-10-16 승인).
 *
 * ⭐ 입고 전(IQC 단계) LOT 은 재고가 없어 선별(SORT)이 LOT 기록만 나눈다 — 원 LOT 의 `initial_qty` 는 그대로(50)이고
 *    떼어 낸 불량분은 자식 LOT(-S1 · 15)이 갖는다. 그래서 입하 수량(50)으로 입고하면 양품(35)보다 많이 잡혔다.
 *    입고 가능 = `initial_qty` − 선별로 떼어 낸 자식 LOT 수량 − 이미 전기된 그 LOT 의 입고 수량.
 * ⛔ 입하에서 온 LOT(자기 또는 조상이 입하 라인)에만 쓴다 — 이미 재고가 있는 LOT(제품 LOT)의 선별은 원장 이동이라 그대로다.
 */
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
const POSTED = 'POSTED';
/** 계보를 거슬러 오르는 상한 — 선별의 선별 정도면 충분하다. 순환이 생겨도 멈춘다. */
const MAX_DEPTH = 10;

type Db = Pick<PrismaService, 'lot' | 'goods_receipt_line'>;

export interface SplitLotView {
  lotId: number;
  lotNo: string;
  statusCode: string;
  receivableQty: number;
}

/**
 * LOT 이 입하에서 왔으면 그 입하 라인 id. 선별 자식(`LOT_SPLIT`)은 부모를 따라 올라간다 — 그래야 IQC 입고 규칙
 * (불량은 불량창고만)과 입고 상한이 자식에도 걸린다. 입하와 무관하면 `null`.
 */
export async function inboundLineOfLot(db: Db, lotId: bigint): Promise<bigint | null> {
  let current: bigint | null = lotId;
  for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
    const lot: { source_type_code: string; source_id: bigint; parent_lot_id: bigint | null } | null =
      await db.lot.findUnique({
        where: { lot_id: current },
        select: { source_type_code: true, source_id: true, parent_lot_id: true },
      });
    if (lot === null) return null;
    if (lot.source_type_code === INBOUND_LOT_SOURCE) return lot.source_id;
    if (lot.source_type_code !== LOT_SPLIT_SOURCE) return null;
    current = lot.parent_lot_id;
  }
  return null;
}

/** LOT 마다 입고 가능 수량. 없는 LOT 은 빠진다. */
export async function receivableQtyOf(db: Db, lotIds: readonly bigint[]): Promise<Map<bigint, Prisma.Decimal>> {
  if (lotIds.length === 0) return new Map();
  const ids = [...lotIds];
  const [lots, splits, received] = await Promise.all([
    db.lot.findMany({ where: { lot_id: { in: ids } }, select: { lot_id: true, initial_qty: true } }),
    db.lot.groupBy({
      by: ['parent_lot_id'],
      where: { parent_lot_id: { in: ids }, source_type_code: LOT_SPLIT_SOURCE },
      _sum: { initial_qty: true },
    }),
    db.goods_receipt_line.groupBy({
      by: ['lot_id'],
      where: { lot_id: { in: ids }, goods_receipt: { status_code: POSTED } },
      _sum: { receipt_qty: true },
    }),
  ]);
  const splitOf = new Map(splits.map((row) => [row.parent_lot_id, row._sum.initial_qty]));
  const receivedOf = new Map(received.map((row) => [row.lot_id, row._sum.receipt_qty]));
  return new Map(
    lots.map((lot) => {
      const left = lot.initial_qty
        .minus(splitOf.get(lot.lot_id) ?? 0)
        .minus(receivedOf.get(lot.lot_id) ?? 0);
      return [lot.lot_id, Prisma.Decimal.max(left, 0)];
    }),
  );
}

/** 선별로 떼어 낸 자식 LOT(부모별). 입고 화면이 「선별 불량분」 줄로 세운다. */
export async function splitLotsOf(db: Db, parentLotIds: readonly bigint[]): Promise<Map<bigint, SplitLotView[]>> {
  if (parentLotIds.length === 0) return new Map();
  const children = await db.lot.findMany({
    where: { parent_lot_id: { in: [...parentLotIds] }, source_type_code: LOT_SPLIT_SOURCE },
    select: { lot_id: true, lot_no: true, status_code: true, parent_lot_id: true },
    orderBy: { lot_id: 'asc' },
  });
  const receivable = await receivableQtyOf(db, children.map((child) => child.lot_id));
  const byParent = new Map<bigint, SplitLotView[]>();
  for (const child of children) {
    const parent = child.parent_lot_id as bigint;
    const list = byParent.get(parent) ?? [];
    list.push({
      lotId: Number(child.lot_id),
      lotNo: child.lot_no,
      statusCode: child.status_code,
      receivableQty: (receivable.get(child.lot_id) ?? new Prisma.Decimal(0)).toNumber(),
    });
    byParent.set(parent, list);
  }
  return byParent;
}
