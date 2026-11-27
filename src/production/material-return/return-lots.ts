import { Prisma } from '@prisma/client';

import { RECEIPT_STATUS_OF_LOT } from '../../logistics/goods-receipt/receipt-gate';
import { FinalCloseProbe } from './final-close';
import { WorkOrderIssue, issueCandidates, latestWorkOrderIssues, returnableQty, returnedQtyByIssueLine } from './return-attribution';

const MATERIAL_LOT = 'MATERIAL';

/** 반납할 수 있는 LOT 하나 — LOT 조회(§1)와 등록(§4)이 같은 판정을 쓴다. */
export interface ReturnLotFacts {
  lotId: bigint; lotNo: string; plantId: bigint; statusCode: string;
  itemId: bigint; itemCode: string; itemName: string;
  uomId: bigint; uomCode: string; decimalScale: number;
  /** 가장 최근 W/O 출고 라인 — 귀속 근거. */
  issue: WorkOrderIssue;
  returnable: Prisma.Decimal;
  /** 그 W/O 가 최종 마감(017) — 반납은 귀속 없음이 된다. */
  finalized: boolean;
}

/** 막힘 — 없음(단말이면 단말 공장 밖도) · 반납 대상 아님(FR-003·US1-4) · 남은 양 없음. */
export type ReturnLotBlock = 'NOT_FOUND' | 'NOT_RETURNABLE' | 'NOTHING_TO_RETURN';

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'lot'>;

/**
 * LOT 마다 반납 판정. 반납 대상 = 자재 LOT 이고, 입고 상태가 정해지는 LOT 상태(정상·불량 — 적치 009 와 같은 표)이고,
 * W/O 출고 이력이 있는 것. 반제품·제품 LOT 은 반납 대상이 아니다(반제품은 018 조정). `plantId` 가 있으면 그 공장 LOT 만 본다.
 */
export async function loadReturnLots(
  db: Db, probe: FinalCloseProbe, lotIds: readonly bigint[], plantId: bigint | null,
): Promise<Map<bigint, ReturnLotFacts | ReturnLotBlock>> {
  const lots = await db.lot.findMany({
    where: { lot_id: { in: [...new Set(lotIds)] }, ...(plantId === null ? {} : { plant_id: plantId }) },
    select: {
      lot_id: true, lot_no: true, plant_id: true, lot_type_code: true, status_code: true,
      item: { select: { item_id: true, item_code: true, item_name: true } },
      uom: { select: { uom_id: true, uom_code: true, decimal_scale: true } },
    },
  });
  const latest = latestWorkOrderIssues(await issueCandidates(db, lots.map((lot) => lot.lot_id)));
  const issues = [...latest.values()];
  const [returned, finalized] = await Promise.all([
    returnedQtyByIssueLine(db, issues.map((issue) => issue.goodsIssueLineId)),
    probe.finalizedWorkOrders(db, [...new Set(issues.map((issue) => issue.workOrderId))]),
  ]);

  const result = new Map<bigint, ReturnLotFacts | ReturnLotBlock>(lotIds.map((id) => [id, 'NOT_FOUND']));
  for (const lot of lots) {
    const issue = latest.get(lot.lot_id);
    if (lot.lot_type_code !== MATERIAL_LOT || RECEIPT_STATUS_OF_LOT[lot.status_code] === undefined || issue === undefined) {
      result.set(lot.lot_id, 'NOT_RETURNABLE');
      continue;
    }
    const returnable = returnableQty(issue.issueQty, returned.get(issue.goodsIssueLineId));
    if (returnable.lessThanOrEqualTo(0)) {
      result.set(lot.lot_id, 'NOTHING_TO_RETURN');
      continue;
    }
    result.set(lot.lot_id, {
      lotId: lot.lot_id, lotNo: lot.lot_no, plantId: lot.plant_id, statusCode: lot.status_code,
      itemId: lot.item.item_id, itemCode: lot.item.item_code, itemName: lot.item.item_name,
      uomId: lot.uom.uom_id, uomCode: lot.uom.uom_code, decimalScale: lot.uom.decimal_scale,
      issue, returnable, finalized: finalized.has(issue.workOrderId),
    });
  }
  return result;
}
