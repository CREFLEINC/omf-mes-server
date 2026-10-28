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

/** 정정이 기준으로 삼는 원본 배분과 그 배분을 가진 행의 양품. */
export interface OriginalShare {
  allocations: OriginalAllocation[];
  goodQty: Prisma.Decimal;
}

/** W/O 가 이 상태면 정정을 막는다 — 마감 때 ERP 로 생산입고가 나간다. */
export const CORRECTION_CLOSED_STATUSES = ['CLOSED', 'CANCELLED'];

/**
 * 원본 배분 — 원본에 배분이 없으면 정정 체인을 거슬러 배분이 있는 행을 찾는다(배분 없이 만든 옛 정정본을 다시
 * 정정하는 자리). 끝까지 없으면 배분 없음이다.
 */
export async function originalShare(tx: Tx, productionResultId: bigint): Promise<OriginalShare> {
  let id: bigint | null = productionResultId;
  let first: Prisma.Decimal | undefined;
  while (id !== null) {
    const row: { good_qty: Prisma.Decimal; corrects_production_result_id: bigint | null } = await tx.production_result.findUniqueOrThrow({
      where: { production_result_id: id }, select: { good_qty: true, corrects_production_result_id: true },
    });
    first ??= row.good_qty;
    const allocations = await ownAllocations(tx, id);
    if (allocations.length > 0) return { allocations, goodQty: row.good_qty };
    id = row.corrects_production_result_id;
  }
  return { allocations: [], goodQty: first ?? new Prisma.Decimal(0) };
}

/**
 * 그 행 자신의 배분(없으면 빈 배열). 바뀌는 LOT·정정 전 수량·이력은 이것과 비교한다 — 조상 배분과 비교하면
 * 0 정정을 다시 정정할 때 되살아나는 LOT 을 «안 바뀜»으로, 불량만 고친 0 정정을 «바뀜»으로 잘못 본다.
 */
export async function ownAllocations(tx: Tx, productionResultId: bigint): Promise<OriginalAllocation[]> {
  const rows = await tx.production_result_lot_allocation.findMany({
    where: { production_result_id: productionResultId },
    select: { lot_id: true, allocated_qty: true, lot: { select: { lot_no: true } } },
    orderBy: { lot_id: 'asc' },
  });
  return rows.map((row) => ({ lotId: Number(row.lot_id), lotNo: row.lot.lot_no, allocatedQty: row.allocated_qty.toNumber() }));
}

/**
 * 정정본의 배분. 본문이 주면 그대로(원본이 배분한 LOT 안에서만). 안 주면 양품이 같을 때 원본을 옮기고, 원본 LOT 이
 * 하나면 양품 차이만큼 그 LOT 을 늘이거나 줄인다. 0 정정은 배분이 없다. 원본 LOT 이 여럿인데 양품이 바뀌면 고를 수 없다.
 * 원본이 양품을 LOT 에 다 나눠 담았으면 정정도 합이 양품과 같아야 한다.
 * `fieldName` 은 본문에 배분이 없을 때 오류가 짚을 칸이다.
 */
export function correctionAllocations(
  original: OriginalShare,
  requested: readonly ResultLotAllocation[] | undefined,
  goodAfter: Prisma.Decimal,
): ResultLotAllocation[] {
  const { allocations } = original;
  const fieldName = requested === undefined ? 'goodQty' : 'lotAllocations';
  const allocatedBefore = allocations.reduce((sum, row) => sum.plus(row.allocatedQty), new Prisma.Decimal(0));
  const fullyAllocated = allocations.length > 0 && allocatedBefore.equals(original.goodQty);
  const lotNos = allocations.map((row) => row.lotNo).join('·');
  if (requested !== undefined) {
    const known = new Set(allocations.map((row) => row.lotId));
    if (requested.some((row) => !known.has(row.lotId))) {
      throw one(field(fieldName, ERROR_CODE.INVALID,
        `고른 LOT 중에 이 실적이 담긴 LOT(${lotNos || '없음'})이 아닌 것이 있습니다. 정정은 원래 LOT 안에서만 수량을 고칩니다 — 다른 LOT 으로 옮기려면 이 실적을 0 으로 정정하고 새 실적을 등록하세요.`));
    }
    const total = requested.reduce((sum, row) => sum.plus(row.allocatedQty), new Prisma.Decimal(0));
    if (fullyAllocated && !total.equals(goodAfter)) {
      throw one(field(fieldName, ERROR_CODE.INVALID,
        `원래 실적은 양품을 LOT(${lotNos})에 모두 나눠 담았습니다. LOT 별 수량의 합(${total.toString()})을 양품 수량(${goodAfter.toString()})에 맞춰 다시 저장하세요.`));
    }
    return [...requested];
  }
  if (goodAfter.isZero() || allocations.length === 0) return [];
  if (goodAfter.equals(original.goodQty)) return allocations.map((row) => ({ lotId: row.lotId, allocatedQty: row.allocatedQty }));
  if (allocations.length > 1) {
    throw one(field(fieldName, ERROR_CODE.REQUIRED,
      `이 실적은 LOT ${lotNos} 에 나눠 담겼습니다. 양품 수량이 바뀌므로 LOT 별 수량을 정해 다시 저장하세요.`));
  }
  const qty = new Prisma.Decimal(allocations[0].allocatedQty).plus(goodAfter.minus(original.goodQty));
  if (qty.isNegative()) {
    throw one(field(fieldName, ERROR_CODE.INVALID,
      `LOT ${allocations[0].lotNo} 에 담긴 ${allocations[0].allocatedQty} 보다 많이 줄일 수 없습니다. LOT 별 수량을 정해 다시 저장하세요.`));
  }
  return qty.isZero() ? [] : [{ lotId: allocations[0].lotId, allocatedQty: qty.toNumber() }];
}

/** 원본과 정정본 배분이 다른 LOT — 이 LOT 들의 수량이 바뀐다. */
export function changedLotIds(original: readonly OriginalAllocation[], next: readonly ResultLotAllocation[]): number[] {
  const before = new Map(original.map((row) => [row.lotId, new Prisma.Decimal(row.allocatedQty)]));
  const after = new Map(next.map((row) => [row.lotId, new Prisma.Decimal(row.allocatedQty)]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((lotId) => !(before.get(lotId) ?? new Prisma.Decimal(0)).equals(after.get(lotId) ?? new Prisma.Decimal(0)));
}

type DownstreamKind = 'RECEIPT' | 'PACKAGE' | 'SHIPMENT' | 'SPLIT' | 'CONSUMED' | 'OQC';

interface DownstreamRow {
  lot_no: string;
  kind: DownstreamKind;
  ref_no: string;
}

/** 넘어간 곳마다 무엇이 일어났고 대신 무엇을 하는가. */
const DOWNSTREAM: Record<DownstreamKind, (ref: string) => string> = {
  RECEIPT: (ref) => `생산입고 ${ref} 로 창고에 들어갔습니다(LOT 추적에서 확인). 생산입고를 취소한 뒤 정정하세요`,
  PACKAGE: (ref) => `포장 ${ref} 에 담겼습니다(LOT 추적에서 확인). 포장을 해체한 뒤(PDA 포장 재구성) 정정하세요`,
  SHIPMENT: (ref) => `출하 ${ref} 에 배분됐습니다(LOT 추적에서 확인). 출하를 취소한 뒤 정정하세요`,
  SPLIT: (ref) => `선별로 LOT ${ref} 이 나뉘었습니다(LOT 추적에서 확인). 수량 차이는 재고 조정으로 맞추세요`,
  CONSUMED: (ref) => `다음 공정 W/O ${ref} 에 투입됐습니다(W/O 진행 상세에서 확인). 그 투입을 정정한 뒤 고치세요`,
  OQC: (ref) => `OQC 의뢰 ${ref} 가 있습니다(출하 검사에서 확인). 의뢰를 취소한 뒤 정정하세요`,
};

/**
 * 생산입고·포장·출하·선별 분할·다음 공정 투입·OQC 로 이미 넘어간 LOT 의 수량은 고치지 않는다 — 실적은 원장을 지나지
 * 않아 정정해도 그쪽 수량이 따라오지 않는다. 취소 완료 입고·취소된 출하·취소된 의뢰는 넘어간 것으로 보지 않는다.
 * ⭐ 대상 LOT 을 먼저 잠근다(`FOR UPDATE`) — 확인과 저장 사이에 같은 LOT 을 정정하는 다른 요청과 갈린다.
 */
export async function assertLotsNotMovedOn(tx: Tx, lotIds: readonly number[], fieldName: string): Promise<void> {
  if (lotIds.length === 0) return;
  const ids = Prisma.join([...lotIds].sort((a, b) => a - b).map(BigInt));
  await tx.$queryRaw`SELECT lot_id FROM trace.lot WHERE lot_id IN (${ids}) ORDER BY lot_id FOR UPDATE`;
  const rows = await tx.$queryRaw<DownstreamRow[]>`
    SELECT * FROM (
      SELECT lt.lot_no, 'RECEIPT' AS kind, gr.goods_receipt_no AS ref_no
        FROM logistics.goods_receipt_line l
        JOIN logistics.goods_receipt gr ON gr.goods_receipt_id = l.goods_receipt_id
        JOIN trace.lot lt ON lt.lot_id = l.lot_id
       WHERE l.lot_id IN (${ids}) AND gr.receipt_type_code = 'PRODUCT' AND gr.status_code <> 'CANCELLED'
      UNION ALL
      SELECT lt.lot_no, 'PACKAGE', hu.handling_unit_no
        FROM inventory.handling_unit_content hc
        JOIN inventory.handling_unit hu ON hu.handling_unit_id = hc.handling_unit_id
        JOIN trace.lot lt ON lt.lot_id = hc.lot_id
       WHERE hc.lot_id IN (${ids})
      UNION ALL
      SELECT lt.lot_no, 'SHIPMENT', s.shipment_no
        FROM logistics.shipment_lot_allocation a
        JOIN logistics.shipment_line sl ON sl.shipment_line_id = a.shipment_line_id
        JOIN logistics.shipment s ON s.shipment_id = sl.shipment_id
        JOIN trace.lot lt ON lt.lot_id = a.lot_id
       WHERE a.lot_id IN (${ids}) AND s.status_code <> 'CANCELLED'
      UNION ALL
      SELECT parent.lot_no, 'SPLIT', child.lot_no
        FROM trace.lot child
        JOIN trace.lot parent ON parent.lot_id = child.parent_lot_id
       WHERE child.parent_lot_id IN (${ids})
      UNION ALL
      SELECT lt.lot_no, 'CONSUMED', wo.work_order_no
        FROM production.material_consumption mc
        JOIN production.work_order wo ON wo.work_order_id = mc.work_order_id
        JOIN trace.lot lt ON lt.lot_id = mc.lot_id
       WHERE mc.lot_id IN (${ids})
      UNION ALL
      SELECT lt.lot_no, 'OQC', ir.inspection_request_no
        FROM quality.inspection_request ir
        JOIN trace.lot lt ON lt.lot_id = ir.lot_id
       WHERE ir.lot_id IN (${ids}) AND ir.inspection_type_code = 'OQC' AND ir.status_code <> 'CANCELLED'
    ) moved ORDER BY lot_no LIMIT 1`;
  if (rows.length === 0) return;
  const [row] = rows;
  throw new ContractException(HttpStatus.BAD_REQUEST, [{
    scope: 'field', field: fieldName, code: ERROR_CODE.STATE_LOCKED,
    message: `LOT ${row.lot_no} 은 이미 ${DOWNSTREAM[row.kind](row.ref_no)}.`,
  }]);
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

/**
 * 완료된 LOT 의 수량이 바뀌면 완료 판정을 다시 본다. 미달이 됐는데 W/O 에 미달 사유가 없으면 완료를 풀어 다시 완료하게 한다
 * (완료 화면이 사유를 묻는다). 수량이 0 이 된 LOT 은 미달 사유가 있어도 완료를 푼다 — 빈 LOT 을 완료로 두지 않는다.
 * 이 W/O 의 완료 LOT 중 미달이 하나도 안 남으면 W/O 의 미달 사유를 비운다. 돌려주는 것은 완료를 푼 LOT.
 */
export async function recheckCompletion(
  tx: Tx, workOrderId: bigint, lotIds: readonly number[], appUserId?: number,
): Promise<Set<number>> {
  const completed = await tx.lot.findMany({
    where: { source_type_code: 'WORK_ORDER', source_id: workOrderId, completed_at: { not: null } },
    select: { lot_id: true, initial_qty: true },
  });
  if (completed.length === 0) return new Set();
  const live = await liveLotQuantities(tx, completed.map((lot) => Number(lot.lot_id)));
  const judged = completed.map((lot) => {
    const qty = new Prisma.Decimal(live.get(Number(lot.lot_id)) ?? 0);
    // 완료 판정의 미달(`trace/lot/lot-progress.ts` 의 UNDER)과 같은 비교 — 도메인 간 import 를 하지 않는다.
    return { lotId: Number(lot.lot_id), under: qty.lessThan(lot.initial_qty), empty: qty.isZero() };
  });
  const workOrder = await tx.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId }, select: { completion_variance_reason_code: true } });
  const changed = new Set(lotIds);
  const noReason = workOrder.completion_variance_reason_code === null;
  const reset = new Set(judged.filter((lot) => changed.has(lot.lotId) && (lot.empty || (lot.under && noReason))).map((lot) => lot.lotId));
  if (reset.size > 0) {
    await tx.lot.updateMany({ where: { lot_id: { in: [...reset].map(BigInt) } }, data: { completed_at: null, version_no: { increment: 1 } } });
  }
  if (workOrder.completion_variance_reason_code !== null && !judged.some((lot) => lot.under && !reset.has(lot.lotId))) {
    await tx.work_order.update({
      where: { work_order_id: workOrderId },
      data: { completion_variance_reason_code: null, version_no: { increment: 1 }, ...(appUserId === undefined ? {} : { updated_by: BigInt(appUserId) }) },
    });
  }
  return reset;
}

export interface AffectedLot {
  lotId: number;
  lotNo: string;
  qtyBefore: number;
  qtyAfter: number;
  /** 마지막 생산 LOT 라벨(인쇄 실패 제외)에 찍힌 수량 — 발행한 적이 없거나 수량을 남기기 전 발행이면 null. */
  lastLabelQty: number | null;
  /** 라벨을 발행한 적이 있고 지금 수량과 다르다 — 「실적 정정」 사유로 다시 발행한다. */
  labelReissueNeeded: boolean;
  /** 미달이 됐는데 W/O 에 미달 사유가 없어 완료를 풀었다 — 생산 LOT 완료를 다시 한다. */
  completionReset: boolean;
}

export async function affectedLots(
  tx: Tx,
  lotIds: readonly number[],
  before: Map<number, number>,
  completionReset: Set<number>,
): Promise<AffectedLot[]> {
  if (lotIds.length === 0) return [];
  const [after, lots, labels] = await Promise.all([
    liveLotQuantities(tx, lotIds),
    tx.lot.findMany({ where: { lot_id: { in: lotIds.map(BigInt) } }, select: { lot_id: true, lot_no: true }, orderBy: { lot_no: 'asc' } }),
    // 출력 결과 칸이 생기기 전의 발행은 결과가 비어 있다 — 실패만 빼고 빈 것은 발행으로 센다.
    tx.document_issue_log.findMany({
      where: { document_type_code: 'PRODUCTION_LOT_LABEL', lot_id: { in: lotIds.map(BigInt) }, OR: [{ print_outcome_code: null }, { print_outcome_code: { not: 'FAILED' } }] },
      orderBy: [{ lot_id: 'asc' }, { issue_seq: 'desc' }],
      distinct: ['lot_id'],
      select: { lot_id: true, label_qty: true },
    }),
  ]);
  const lastLabel = new Map(labels.map((row) => [Number(row.lot_id), row.label_qty === null ? null : Number(row.label_qty)]));
  return lots.map((lot) => {
    const lotId = Number(lot.lot_id);
    const qtyBefore = before.get(lotId) ?? 0;
    const qtyAfter = after.get(lotId) ?? 0;
    const lastLabelQty = lastLabel.get(lotId) ?? null;
    return {
      lotId,
      lotNo: lot.lot_no,
      qtyBefore,
      qtyAfter,
      lastLabelQty,
      // 수량을 남기기 전 발행이면 찍힌 수량을 모른다 — 정정으로 수량이 바뀌었으면 다시 발행하게 한다.
      labelReissueNeeded: lastLabel.has(lotId) && (lastLabelQty === null ? qtyAfter !== qtyBefore : lastLabelQty !== qtyAfter),
      completionReset: completionReset.has(lotId),
    };
  });
}
