import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { LOT_SPLIT_SOURCE } from '../../core/lot';
import { PrismaService } from '../../prisma/prisma.service';
import { MATERIAL_RECEIPT, erpInboundLines } from './erp-receipt';
import { inboundLineOfLot, receivableQtyOf, receivingInboundLotOf } from './lot-receivable';
import { GoodsReceiptCreate } from './receipt-posting';

/**
 * 입고 게이트 — 입하 LOT 의 입고 문(입하 마감 · 입고 상한 · 불량은 불량창고만 · IQC 합격 전 금지)과 ERP 구매입고 적재 판정.
 * 웹 입고 처리(`GoodsReceiptService`)와 PDA 지시 없는 적치(피처 009)가 같은 판정을 쓴다(research R-1).
 */
const INBOUND_LOT_SOURCE = 'INBOUND_RECEIPT_LINE';
/** IQC 합격 확정이 LOT 을 옮기는 상태(시드 `LOT_STATUS` · 전이 C4). */
const IQC_PASSED_LOT_STATUS = 'NORMAL';
/** IQC 불합격 확정(C6)이 LOT 을 옮기는 상태 — 불량창고 입고만 허용한다(P-45). */
const DEFECTIVE_LOT_STATUS = 'DEFECTIVE';

export interface InboundGateLot {
  status_code: string;
  source_type_code: string;
  source_id: bigint;
}

/**
 * 구매 입하 LOT 의 입고 상태 — 합격·무검사는 정상, IQC 불합격은 불량. 불량은 불량창고에 두고 처분·특채를 기다린다 — 쓰지 못하게
 * 막는 것은 LOT 상태가 한다(사용자 결정 2026-10-29). PDA 지시 없는 적치(피처 009)가 이 규칙으로 입고 상태를 정한다.
 */
export const RECEIPT_STATUS_OF_LOT: Readonly<Record<string, { quality: string; inventory: string }>> = {
  NORMAL: { quality: 'NORMAL', inventory: 'AVAILABLE' },
  DEFECTIVE: { quality: 'DEFECTIVE', inventory: 'ON_HOLD' },
};

/** 같은 LOT 이 여러 줄이면 상한은 줄마다가 아니라 «LOT 합계»로 본다(#108 리뷰 m2). */
export function lotTotals(lines: GoodsReceiptCreate['lines']): Map<number, Prisma.Decimal> {
  const totals = new Map<number, Prisma.Decimal>();
  for (const line of lines) {
    totals.set(line.lotId, (totals.get(line.lotId) ?? new Prisma.Decimal(0)).plus(line.receiptQty));
  }
  return totals;
}

/**
 * 입하 LOT 의 문을 전기 트랜잭션 안에서 다시 본다(#755) — `assertWritable` 은 번호를 뽑기 전의 빠른 거절이고 최종 판정은 여기다.
 * LOT 을 잠근 뒤 읽으므로 같은 LOT 을 동시에 입고하면 뒤의 것이 앞의 커밋을 기다렸다가 줄어든 상한을 본다.
 * ⛔ `FOR NO KEY UPDATE` — `FOR UPDATE` 면 같은 LOT 을 전기하는 다른 트랜잭션이 원장·잔액 줄의 FK(KEY SHARE)로 이 잠금을
 *    기다리고, 이쪽은 그 트랜잭션이 쥔 잔액 행을 기다려 교착한다. 보류·품질 전이(`FOR UPDATE`·LOT 수정)와는 한 줄로 선다.
 */
export async function assertInboundLotsWithin(tx: Prisma.TransactionClient, input: GoodsReceiptCreate): Promise<void> {
  const lotIds = [...new Set(input.lines.map((line) => BigInt(line.lotId)))];
  const lots = await tx.$queryRaw<(InboundGateLot & { lot_id: bigint })[]>`
    SELECT lot_id, status_code, source_type_code, source_id
      FROM trace.lot
     WHERE lot_id IN (${Prisma.join(lotIds.map((id) => Prisma.sql`${id}::bigint`))})
     ORDER BY lot_id
       FOR NO KEY UPDATE`;
  await assertInboundLotsClosed(tx, input);
  const byId = new Map(lots.map((lot) => [lot.lot_id, lot]));
  const totals = lotTotals(input.lines);
  const errors: ErrorItem[] = [];
  for (const [index, line] of input.lines.entries()) {
    const lot = byId.get(BigInt(line.lotId));
    if (lot === undefined) continue;
    await inboundGate(tx, input.warehouseId, `lines[${index}]`, line, lot, totals.get(line.lotId) as Prisma.Decimal, errors);
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/**
 * 입하 중인 입하 LOT 의 자재 관리 LOT 은 입고하지 않는다(409 `INBOUND_LOT_RECEIVING` · FR-014a). LOT 을 잠근 뒤 읽는다 —
 * 마감 취소도 LOT 을 먼저 잠그므로 둘이 한 줄로 선다.
 */
export async function assertInboundLotsClosed(db: Pick<PrismaService, 'lot'>, input: GoodsReceiptCreate): Promise<void> {
  const receiving = await receivingInboundLotOf(db, [...new Set(input.lines.map((line) => BigInt(line.lotId)))]);
  if (receiving.size === 0) return;
  throw new ContractException(HttpStatus.CONFLICT, input.lines.flatMap((line, index) => {
    const inboundLotNo = receiving.get(BigInt(line.lotId));
    return inboundLotNo === undefined ? [] : [field(`lines[${index}].lotId`, 'INBOUND_LOT_RECEIVING',
      `입하 마감 전인 입하 LOT(${inboundLotNo})의 자재 관리 LOT 은 입고할 수 없습니다 — 먼저 입하 마감하세요.`)];
  }));
}

/**
 * 구매 입하 자재는 PDA 적치로 입고한다(피처 009 · research R-2) — 웹 입고 처리(`POST /logistics/goods-receipts`)가 입하에서 온
 * LOT(선별 자식은 조상 기준)을 받으면 409 `USE_PDA_PUTAWAY`. 배포 사이·옛 탭의 관리웹이 적치 지시를 새로 만들지 않게 막는다.
 * 제품 입고(M-04-04)·반품 입고(W-04-06)는 입하 LOT 이 아니라 그대로다.
 */
export async function assertNotPurchaseInbound(db: Pick<PrismaService, 'lot'>, input: GoodsReceiptCreate): Promise<void> {
  const errors: ErrorItem[] = [];
  for (const [index, line] of input.lines.entries()) {
    if ((await inboundLineOfLot(db as Prisma.TransactionClient, BigInt(line.lotId))) === null) continue;
    errors.push(field(`lines[${index}].lotId`, 'USE_PDA_PUTAWAY', '구매 입하 자재는 PDA 적치로 입고합니다.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.CONFLICT, errors);
}

/** 입하 LOT 의 문 셋 — 입고 상한 · 불량은 불량창고만 · IQC 합격 전 금지. 입하와 무관한 LOT 은 지나간다. */
export async function inboundGate(
  db: Prisma.TransactionClient,
  warehouseId: number,
  at: string,
  line: GoodsReceiptCreate['lines'][number],
  lot: InboundGateLot,
  lotTotal: Prisma.Decimal,
  errors: ErrorItem[],
): Promise<void> {
  // 입하에서 온 LOT — 선별로 떼어 낸 자식(`LOT_SPLIT`)은 조상의 입하 라인을 따른다(장부 P-56).
  const inboundLineId =
    lot.source_type_code === INBOUND_LOT_SOURCE
      ? lot.source_id
      : lot.source_type_code === LOT_SPLIT_SOURCE
        ? await inboundLineOfLot(db, BigInt(line.lotId))
        : null;
  if (inboundLineId === null) return;
  await assertReceivable(db, line, at, errors, lotTotal);
  // ⭐ 불량 LOT 은 «불량창고»로만 입고할 수 있다(omf-all-around#84 · 2026-10-16 결정 · 장부 P-45) — 불량 자재를
  //    불량창고로 옮겨 처분·반품을 기다린다. 검사 대상 여부와 상관없다 — 무검사 품목에 건 클레임 재Hold(C9)도
  //    불량이다(사용자 결정 2026-10-23).
  if (lot.status_code === DEFECTIVE_LOT_STATUS) {
    const toDefectWarehouse =
      (await db.warehouse.findUnique({ where: { warehouse_id: warehouseId }, select: { is_defect: true } }))
        ?.is_defect === true;
    if (!toDefectWarehouse) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.STATE_LOCKED, '불량 LOT 은 불량창고로만 입고할 수 있습니다.'));
    }
    return;
  }
  // IQC 대상 입하 LOT 은 합격(LOT 정상) 전에 입고하지 않는다(omf-all-around#100 · C17). 검사 대기는 어디로도 안 된다.
  // 대상 여부는 입하 라인의 표식으로 본다 — 무검사 품목 LOT 은 이 검사를 타지 않는다.
  if (lot.status_code !== IQC_PASSED_LOT_STATUS) {
    const inbound = await db.inbound_receipt_line.findUnique({
      where: { inbound_receipt_line_id: inboundLineId },
      select: { inspection_required: true },
    });
    if (inbound?.inspection_required === true) {
      errors.push(field(`${at}.lotId`, ERROR_CODE.STATE_LOCKED, 'IQC 수입검사 합격 전인 LOT 은 입고할 수 없습니다.'));
    }
  }
}

/**
 * 입고 상한(장부 P-56) — 입하 LOT 은 «입고 가능 수량»까지만 입고한다. 선별로 떼어 낸 불량분(자식 LOT)과 이미 입고한 수량을 뺀 값이다.
 * 비교 대상은 이 요청 안 같은 LOT 줄의 합계다(`lotTotal`).
 */
export async function assertReceivable(
  db: Prisma.TransactionClient,
  line: GoodsReceiptCreate['lines'][number],
  at: string,
  errors: ErrorItem[],
  lotTotal: Prisma.Decimal,
): Promise<void> {
  const receivable = (await receivableQtyOf(db, [BigInt(line.lotId)])).get(BigInt(line.lotId));
  if (receivable === undefined || receivable.greaterThanOrEqualTo(lotTotal)) return;
  errors.push(
    field(
      `${at}.receiptQty`,
      ERROR_CODE.INVALID,
      `이 LOT 은 ${receivable.toString()} 까지 입고할 수 있습니다(선별로 떼어 낸 불량분·이미 입고한 수량 제외).`,
    ),
  );
}

/**
 * ERP 구매입고로 갈 입고 줄의 입하 줄(겹침 없이) — 자재 입고이고, 불량창고가 아니고(IQC 불합격분 · 고객 질문 8
 * 전까지 합격 입고만), ERP 발주에 이어진 줄(장부 P-104). 없으면 적재하지 않는다. 줄을 고르는 일은 보낼 때 바꾸개가 다시 한다.
 */
export async function erpLinesOf(tx: Prisma.TransactionClient, input: GoodsReceiptCreate): Promise<bigint[]> {
  if (input.receiptTypeCode !== MATERIAL_RECEIPT) return [];
  const warehouse = await tx.warehouse.findUnique({
    where: { warehouse_id: BigInt(input.warehouseId) },
    select: { is_defect: true },
  });
  if (warehouse === null || warehouse.is_defect) return [];
  const lines = input.lines.map((line) => ({
    lotId: BigInt(line.lotId),
    inboundReceiptLineId: line.inboundReceiptLineId == null ? null : BigInt(line.inboundReceiptLineId),
  }));
  const found = (await erpInboundLines(tx, lines)).filter((inboundLineId) => inboundLineId !== null);
  return [...new Set(found)];
}

function field(name: string, code: string, message: string): ErrorItem {
  return { scope: 'field', field: name, code, message };
}
