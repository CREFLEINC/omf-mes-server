import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field, one } from '../../common/errors';
import { LIVE_ALLOCATION, Tx } from '../../core/lot';
import { ResultLotAllocation } from './production-result-rules';

/**
 * 실적 정정의 LOT 배분(장부 P-120). 정정본이 배분을 갖고 LOT 수량은 잎(정정 안 된 실적)만 세므로,
 * 정정본의 배분이 곧 그 실적 몫의 «새» LOT 수량이다.
 */
export interface OriginalAllocation {
  lotId: number;
  lotNo: string;
  allocatedQty: number;
}

/** W/O 가 이 상태면 정정을 막는다 — 마감 때 ERP 로 생산입고가 나간다. */
export const CORRECTION_CLOSED_STATUSES = ['CLOSED', 'CANCELLED'];

/**
 * 정정본의 배분. 본문이 주면 그대로(원본이 배분한 LOT 안에서만), 안 주면 양품이 같을 때 원본을 옮기고,
 * 원본 LOT 이 하나면 양품 차이만큼 그 LOT 을 늘이거나 줄인다. 원본 LOT 이 여럿인데 양품이 바뀌면 고를 수 없다.
 */
export function correctionAllocations(
  original: readonly OriginalAllocation[],
  requested: readonly ResultLotAllocation[] | undefined,
  goodBefore: number,
  goodAfter: number,
): ResultLotAllocation[] {
  if (requested !== undefined) {
    const known = new Set(original.map((row) => row.lotId));
    const outside = requested.find((row) => !known.has(row.lotId));
    if (outside !== undefined) {
      throw one(field('lotAllocations', ERROR_CODE.INVALID,
        `LOT ${outside.lotId} 은 이 실적이 배분한 LOT 이 아닙니다. 정정은 원래 LOT 안에서만 수량을 고칩니다 — 다른 LOT 으로 옮기려면 이 실적을 0 으로 정정하고 새 실적을 등록하세요.`));
    }
    return [...requested];
  }
  if (goodAfter === goodBefore) return original.map((row) => ({ lotId: row.lotId, allocatedQty: row.allocatedQty }));
  if (original.length === 0) return [];
  if (original.length > 1) {
    throw one(field('lotAllocations', ERROR_CODE.REQUIRED,
      `이 실적은 LOT ${original.map((row) => row.lotNo).join('·')} 에 나눠 배분됐습니다. 양품 수량이 바뀌므로 LOT 마다 몇 개인지 lotAllocations 로 보내세요.`));
  }
  const qty = original[0].allocatedQty + (goodAfter - goodBefore);
  if (qty < 0) {
    throw one(field('lotAllocations', ERROR_CODE.INVALID,
      `LOT ${original[0].lotNo} 에 배분된 ${original[0].allocatedQty} 보다 많이 줄일 수 없습니다. lotAllocations 로 LOT 수량을 직접 보내세요.`));
  }
  return qty === 0 ? [] : [{ lotId: original[0].lotId, allocatedQty: qty }];
}

/** 원본과 정정본 배분이 다른 LOT — 이 LOT 들의 수량이 바뀐다. */
export function changedLotIds(original: readonly OriginalAllocation[], next: readonly ResultLotAllocation[]): number[] {
  const before = new Map(original.map((row) => [row.lotId, row.allocatedQty]));
  const after = new Map(next.map((row) => [row.lotId, row.allocatedQty]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((lotId) => (before.get(lotId) ?? 0) !== (after.get(lotId) ?? 0));
}

interface DownstreamRow {
  lot_no: string;
  kind: 'RECEIPT' | 'PACKAGE' | 'SHIPMENT';
  ref_no: string;
}

/**
 * 생산입고·포장·출하로 이미 넘어간 LOT 의 수량은 고치지 않는다(사용자 결정 2026-10-26) — 실적은 원장을 지나지
 * 않아 정정해도 재고·포장·출하 수량이 따라오지 않는다. 취소 완료 입고와 취소된 출하는 넘어간 것으로 보지 않는다.
 */
export async function assertLotsNotMovedOn(tx: Tx, lotIds: readonly number[]): Promise<void> {
  if (lotIds.length === 0) return;
  const ids = lotIds.map(BigInt);
  const rows = await tx.$queryRaw<DownstreamRow[]>`
    SELECT lt.lot_no, 'RECEIPT' AS kind, gr.goods_receipt_no AS ref_no
      FROM logistics.goods_receipt_line l
      JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = l.goods_receipt_id
      JOIN trace.lot lt ON lt.lot_id = l.lot_id
     WHERE l.lot_id IN (${Prisma.join(ids)}) AND gr.receipt_type_code = 'PRODUCT' AND gr.status_code <> 'CANCELLED'
    UNION ALL
    SELECT lt.lot_no, 'PACKAGE', hu.handling_unit_no
      FROM inventory.handling_unit_content hc
      JOIN inventory.handling_unit hu ON hu.handling_unit_id = hc.handling_unit_id
      JOIN trace.lot lt ON lt.lot_id = hc.lot_id
     WHERE hc.lot_id IN (${Prisma.join(ids)})
    UNION ALL
    SELECT lt.lot_no, 'SHIPMENT', s.shipment_no
      FROM logistics.shipment_lot_allocation a
      JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
      JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
      JOIN trace.lot lt ON lt.lot_id = a.lot_id
     WHERE a.lot_id IN (${Prisma.join(ids)}) AND s.status_code <> 'CANCELLED'
     LIMIT 1`;
  if (rows.length === 0) return;
  const [row] = rows;
  const what = { RECEIPT: `생산입고 ${row.ref_no} 로 창고에 들어갔습니다`, PACKAGE: `포장 ${row.ref_no} 에 담겼습니다`, SHIPMENT: `출하 ${row.ref_no} 에 배분됐습니다` }[row.kind];
  throw new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field', field: 'lotAllocations', code: ERROR_CODE.STATE_LOCKED,
    message: `LOT ${row.lot_no} 은 이미 ${what}(LOT 추적에서 확인). 실적 수량을 고칠 수 없습니다 — 생산입고를 취소한 뒤 정정하거나, 재고 조정으로 맞추세요.`,
  }]);
}

export interface AffectedLot {
  lotId: number;
  lotNo: string;
  qtyBefore: number;
  qtyAfter: number;
  /** 마지막 생산 LOT 라벨에 찍힌 수량 — 발행한 적이 없거나 수량을 남기기 전 발행이면 null. */
  lastLabelQty: number | null;
  /** 라벨을 발행한 적이 있고 지금 수량과 다르다 — 「실적 정정」 사유로 다시 발행한다. */
  labelReissueNeeded: boolean;
}

/** LOT 마다 잎 배분 합계. */
export async function liveLotQuantities(tx: Tx, lotIds: readonly number[]): Promise<Map<number, number>> {
  const rows = await tx.production_result_lot_allocation.groupBy({
    by: ['lot_id'],
    where: { lot_id: { in: lotIds.map(BigInt) }, ...LIVE_ALLOCATION },
    _sum: { allocated_qty: true },
  });
  return new Map(rows.map((row) => [Number(row.lot_id), Number(row._sum.allocated_qty ?? 0)]));
}

export async function affectedLots(
  tx: Tx,
  lotIds: readonly number[],
  before: Map<number, number>,
): Promise<AffectedLot[]> {
  if (lotIds.length === 0) return [];
  const [after, lots, labels] = await Promise.all([
    liveLotQuantities(tx, lotIds),
    tx.lot.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } }, select: { lot_id: true, lot_no: true }, orderBy: { lot_no: 'asc' } }),
    tx.document_issue_log.findMany({
      where: { document_type_code: 'PRODUCTION_LOT_LABEL', lot_id: { in: lotIds.map(BigInt) } },
      orderBy: [{ lot_id: 'asc' }, { issue_seq: 'desc' }],
      distinct: ['lot_id'],
      select: { lot_id: true, label_qty: true },
    }),
  ]);
  const lastLabel = new Map(labels.map((row) => [Number(row.lot_id), row.label_qty === null ? null : Number(row.label_qty)]));
  return lots.map((lot) => {
    const lotId = Number(lot.lot_id);
    const qtyAfter = after.get(lotId) ?? 0;
    const issued = lastLabel.has(lotId);
    const lastLabelQty = lastLabel.get(lotId) ?? null;
    return {
      lotId,
      lotNo: lot.lot_no,
      qtyBefore: before.get(lotId) ?? 0,
      qtyAfter,
      lastLabelQty,
      // 수량을 남기기 전 발행이면 찍힌 수량을 모른다 — 정정으로 수량이 바뀌었으면 다시 발행하게 한다.
      labelReissueNeeded: issued && (lastLabelQty === null ? qtyAfter !== (before.get(lotId) ?? 0) : lastLabelQty !== qtyAfter),
    };
  });
}
