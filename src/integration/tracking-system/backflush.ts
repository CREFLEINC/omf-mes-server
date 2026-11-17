import { Prisma } from '@prisma/client';

import { plantPolicyText } from '../../app/policy/plant-policy-text';
import { ERROR_CODE } from '../../common/errors';
import { BOM_COMPONENT_SELECT, materialRequirements } from '../../core/bom';
import { InventoryPostingService } from '../../core/inventory-posting';
import { recordLateInputGenealogyWithin } from '../../core/lot';
import { PICKABLE_BALANCE, PickingDemand, StockCandidate, allocatePicking } from '../../core/picking';
import { CONSUMPTION_STATUS } from '../../production/material-consumption/material-consumption.constants';
import { postTrackingIssue } from './goods-issue-write';
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
const LOT_NORMAL = 'NORMAL';
/** PL13 ERP BOM 은 9단까지 내려간다(2026-11-17) — 이보다 깊으면 BOM 이 돌고 있다. */
const MAX_BOM_LEVELS = 20;
/** 재고·소요 칸이 소수 6자리다 — 더 잘게 남기면 미차감이 0 으로 저장된다. */
const QTY_SCALE = 6;
const ZERO = new Prisma.Decimal(0);

/**
 * 자재 차감(백플러시 · flowtrack 연동 제안 §4) — BOM 을 끝까지 풀어 차감 창고의 맨 아래 위치에서 오래된 LOT 부터 뺀다.
 * 모자란 몫은 미차감으로 남기고 제품 입고는 막지 않는다(결정 16). 뺀 것이 있으면 출고 전표 하나와 출고 라인마다 투입 기록을 남긴다.
 * 출고 전표 id 를 돌려준다 — 뺀 것이 없으면 `null`.
 */
export async function backflush(tx: Tx, posting: InventoryPostingService, input: BackflushInput): Promise<bigint | null> {
  const warehouseId = await backflushWarehouse(tx, input);
  const demands = await leafDemands(tx, input);
  const { orders, shortages } = allocatePicking(demands, await candidates(tx, warehouseId, demands), new Set());
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

/** PL13 기본 BOM 이 있는 구성품은 그 BOM 으로 다시 풀고, 맨 끝 자재의 소요를 품목·단위마다 더한다. */
async function leafDemands(tx: Tx, input: BackflushInput): Promise<PickingDemand[]> {
  const leaves = new Map<string, PickingDemand>();
  let level = [{ bomId: input.bomId, qty: input.qty }];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth === MAX_BOM_LEVELS) throw new Error(`BOM 이 ${MAX_BOM_LEVELS}단을 넘는다 — 돌고 있는지 확인: bom ${input.bomId}`);
    const boms = await tx.bom.findMany({
      where: { bom_id: { in: level.map((entry) => entry.bomId) } },
      select: { bom_id: true, base_qty: true, bom_component: { select: BOM_COMPONENT_SELECT } },
    });
    const bomOf = new Map(boms.map((bom) => [bom.bom_id, bom]));
    const needs = level.flatMap(({ bomId, qty }) => {
      const bom = bomOf.get(bomId) as (typeof boms)[number];
      return materialRequirements(bom.bom_component, qty, bom.base_qty);
    });
    const subs = await tx.bom.findMany({
      where: { parent_item_id: { in: [...new Set(needs.map((need) => need.item_id))] }, plant_id: input.plantId, is_default: true },
      select: { bom_id: true, parent_item_id: true, base_uom_id: true },
    });
    const subOf = new Map(subs.map((bom) => [bom.parent_item_id, bom]));
    level = [];
    for (const need of needs) {
      const sub = subOf.get(need.item_id);
      // 단위가 다르면 환산 규칙이 없어 풀지 않는다 — 그 품목 그대로 빼러 간다.
      if (sub !== undefined && sub.base_uom_id === need.uom_id) {
        level.push({ bomId: sub.bom_id, qty: need.requested_qty });
        continue;
      }
      const key = `${need.item_id}:${need.uom_id}`;
      const seen = leaves.get(key);
      leaves.set(key, {
        lineNo: seen?.lineNo ?? leaves.size + 1, itemId: need.item_id, uomId: need.uom_id, qty: (seen?.qty ?? ZERO).plus(need.requested_qty),
      });
    }
  }
  return [...leaves.values()].map((demand) => ({ ...demand, qty: demand.qty.toDecimalPlaces(QTY_SCALE) }));
}

/**
 * 차감 창고의 맨 아래 위치에서 뺄 수 있는 LOT 재고 — 정상 품질·가용·보류 없음·LOT 정상. 잠근 뒤에 읽는다.
 * LOT 이 없는 재고는 출고 라인에 실을 수 없어 미차감이 된다. 같은 위치·LOT 에 보유가 있는 상태가 둘 이상이면 출고 전기가
 * 어느 것을 낼지 몰라 전송 전체를 거절하므로 그 재고도 빼지 않는다.
 */
async function candidates(tx: Tx, warehouseId: bigint, demands: PickingDemand[]): Promise<StockCandidate[]> {
  const itemIds = [...new Set(demands.map((demand) => demand.itemId))];
  if (itemIds.length === 0) return [];
  const locked = await tx.$queryRaw<{ location_id: bigint; item_id: bigint; lot_id: bigint | null; on_hand_qty: Prisma.Decimal }[]>`
    SELECT location_id, item_id, lot_id, on_hand_qty
      FROM inventory.inventory_balance
     WHERE warehouse_id = ${warehouseId} AND item_id IN (${Prisma.join(itemIds)})
     ORDER BY inventory_balance_id
       FOR UPDATE`;
  const held = new Map<string, number>();
  for (const row of locked) {
    if (row.on_hand_qty.isZero()) continue;
    const key = `${row.location_id}:${row.item_id}:${row.lot_id}`;
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  const rows = await tx.inventory_balance.findMany({
    where: {
      AND: [PICKABLE_BALANCE, {
        warehouse_id: warehouseId, item_id: { in: itemIds }, lot: { is: { status_code: LOT_NORMAL } },
        location: { is_active: true, child_locations: { none: { is_active: true } } },
      }],
    },
    select: { location_id: true, lot_id: true, item_id: true, uom_id: true, available_qty: true, lot: { select: { created_at: true } } },
  });
  return rows.flatMap((row) =>
    row.lot_id === null || row.lot === null || row.available_qty === null || (held.get(`${row.location_id}:${row.item_id}:${row.lot_id}`) ?? 0) > 1
      ? []
      : [{
          warehouseId, locationId: row.location_id, lotId: row.lot_id, itemId: row.item_id, uomId: row.uom_id,
          availableQty: row.available_qty, expiryDate: null, lotCreatedAt: row.lot.created_at,
        }],
  );
}
