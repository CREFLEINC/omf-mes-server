import { Prisma } from '@prisma/client';

import { plantPolicyText } from '../../app/policy/plant-policy-text';
import { ERROR_CODE } from '../../common/errors';
import { leafRequirements } from '../../core/bom';
import { InventoryPostingService } from '../../core/inventory-posting';
import { recordLateInputGenealogyWithin } from '../../core/lot';
import { allocatePicking } from '../../core/picking';
import { CONSUMPTION_STATUS } from '../../production/material-consumption/material-consumption.constants';
import { postTrackingIssue } from './goods-issue-write';
import { issuableStock } from './issuable-stock';
import { screen } from './tracking-transmission';

type Tx = Prisma.TransactionClient;

/** 제품 `qty` 개를 만든 W/O 한 번의 자재 차감. */
export interface BackflushInput {
  trackingTransmissionId: bigint;
  transmissionId: string;
  plantId: bigint;
  workOrderId: bigint;
  bomId: bigint;
  qty: Prisma.Decimal;
  productionResultId: bigint;
  workerId: bigint;
  goodsIssueNo: string;
  businessDate: string;
  occurredAt: Date;
}

const ISSUE_TYPE = 'PRODUCTION';
const SOURCE_DOCUMENT_TYPE = 'PRODUCTION_RESULT';
const CONSUMPTION_TYPE = 'BACKFLUSH';

/**
 * 자재 차감(백플러시 · flowtrack 연동 제안 §4) — BOM 을 끝까지 풀어 차감 창고의 맨 아래 위치에서 오래된 LOT 부터 뺀다.
 * 모자란 몫은 미차감으로 남기고 제품 입고는 막지 않는다(결정 16). 뺀 것이 있으면 출고 전표 하나와 출고 라인마다 투입 기록을 남긴다.
 * 출고 전표 id 를 돌려준다 — 뺀 것이 없으면 `null`.
 */
export async function backflush(tx: Tx, posting: InventoryPostingService, input: BackflushInput): Promise<bigint | null> {
  const warehouseId = await backflushWarehouse(tx, input);
  const demands = (await leafRequirements(tx, input)).map((line) => ({
    lineNo: line.line_no, itemId: line.item_id, uomId: line.uom_id, qty: line.requested_qty,
  }));
  const stock = await issuableStock(tx, {
    warehouseId, itemIds: [...new Set(demands.map((demand) => demand.itemId))], lock: true, withoutSerials: false,
  });
  const { orders, shortages } = allocatePicking(demands, stock, new Set());
  if (shortages.length > 0) {
    await tx.tracking_transmission_shortage.createMany({
      data: shortages.map((shortage) => ({
        tracking_transmission_id: input.trackingTransmissionId, item_id: shortage.itemId,
        uom_id: demands[shortage.requestLineNo - 1].uomId, warehouse_id: warehouseId, shortage_qty: shortage.shortQty,
      })),
    });
  }
  const drafts = orders[0]?.lines ?? [];
  if (drafts.length === 0) return null;

  const { goodsIssueId, lines } = await postTrackingIssue(tx, posting, {
    goodsIssueNo: input.goodsIssueNo, issueTypeCode: ISSUE_TYPE, sourceDocumentTypeCode: SOURCE_DOCUMENT_TYPE,
    sourceDocumentId: input.productionResultId, warehouseId, occurredAt: input.occurredAt, businessDate: input.businessDate,
  }, drafts.map((draft) => ({ itemId: draft.itemId, lotId: draft.lotId, uomId: draft.uomId, locationId: draft.locationId, qty: draft.plannedQty })));
  // 번호를 출고 라인에서 딴다 — 라인 수는 잔액을 잠근 뒤에야 알고, 채번은 트랜잭션 밖에서만 한다(I-2 R-2).
  await tx.material_consumption.createMany({
    data: lines.map((line, index) => ({
      consumption_no: `${input.goodsIssueNo}-${index + 1}`, work_order_id: input.workOrderId, item_id: line.itemId, lot_id: line.lotId,
      consumption_type_code: CONSUMPTION_TYPE, input_qty: line.issueQty, uom_id: line.uomId, occurred_at: input.occurredAt,
      worker_id: input.workerId, status_code: CONSUMPTION_STATUS, idempotency_key: `${CONSUMPTION_TYPE}:${input.transmissionId}:${index + 1}`,
    })),
  });
  // 실적이 먼저 섰으니 방금 남긴 투입을 그 실적의 계보에 더한다.
  await recordLateInputGenealogyWithin(tx, input.workOrderId, input.occurredAt, undefined);
  return goodsIssueId;
}

async function backflushWarehouse(tx: Tx, input: BackflushInput): Promise<bigint> {
  const code = await plantPolicyText(tx, 'BACKFLUSH_WAREHOUSE', input.plantId, input.businessDate);
  const warehouse = code === null ? null : await tx.warehouse.findUnique({
    where: { plant_id_warehouse_code: { plant_id: input.plantId, warehouse_code: code } },
    select: { warehouse_id: true, is_active: true },
  });
  if (warehouse === null || !warehouse.is_active) {
    throw screen(ERROR_CODE.INVALID, `자재 차감 창고가 없습니다(운영 정책 BACKFLUSH_WAREHOUSE: ${code ?? '없음'}) — 이 공장의 정책 행과 그 창고를 확인하세요.`);
  }
  return warehouse.warehouse_id;
}
