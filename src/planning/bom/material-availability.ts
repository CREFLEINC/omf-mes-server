import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { loadStockUomTable, materialRequirements, stockUomLines } from '../../core/bom';
import { availableQty } from '../../core/material-issue/planned-stock';
import { plantProductionWarehouses } from '../../core/material-issue/production-warehouse';
import { localDate } from '../production-plan/plan-window';

const MATERIAL_WAREHOUSE = 'MATERIAL';

export interface MaterialAvailabilityBody {
  plantId: number;
  lines: { bomComponentId: number; quantity: number }[];
}

export type MaterialAvailabilityStatus = 'ENOUGH' | 'SHORT' | 'NOT_COMPARABLE';

export interface MaterialAvailabilityLine {
  bomComponentId: number;
  quantity: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  requiredQty: number;
  bomUomCode: string;
  stockUomCode: string;
  requiredStockQty: number | null;
  availableQty: number;
  statusCode: MaterialAvailabilityStatus;
}

/**
 * 생산계획 화면의 BOM 구성 자재 가용 수량·부족 판정(omf-all-around#320). 저장하지 않는다.
 *
 * 필요 수량은 배포와 «같은 함수»(`materialRequirements` → `stockUomLines`)로 재고 단위까지 낸다 — 배포 확인의
 * 출고 기준 소요량과 어긋나지 않게. 가용은 피킹이 집을 수 있는 잔액 합(`availableQty`)이고, 다른 계획의
 * 출고 예정은 빼지 않는다(이슈 결정 3). 창고는 공장의 자재창고와 생산창고(`plantProductionWarehouses`)다.
 */
export async function materialAvailability(
  client: Prisma.TransactionClient,
  body: MaterialAvailabilityBody,
  scope: bigint[] | null,
): Promise<{ items: MaterialAvailabilityLine[] }> {
  const plantId = BigInt(body.plantId);
  const componentIds = [...new Set(body.lines.map((line) => BigInt(line.bomComponentId)))];
  const [plant, components] = await Promise.all([
    client.plant.findUnique({ where: { plant_id: plantId }, select: { timezone_code: true } }),
    client.bom_component.findMany({
      where: { bom_component_id: { in: componentIds } },
      select: {
        bom_component_id: true,
        component_item_id: true,
        uom_id: true,
        required_qty: true,
        bom: { select: { base_qty: true } },
        item: { select: { item_code: true, item_name: true } },
      },
    }),
  ]);
  const componentOf = new Map(components.map((row) => [row.bom_component_id, row]));

  const errors: ErrorItem[] = [];
  if (plant === null) errors.push({ scope: 'field', field: 'plantId', code: ERROR_CODE.INVALID, message: '없는 공장입니다.' });
  body.lines.forEach((line, index) => {
    const component = componentOf.get(BigInt(line.bomComponentId));
    if (component === undefined) {
      errors.push({ scope: 'field', field: `lines[${index}].bomComponentId`, code: ERROR_CODE.INVALID, message: '없는 BOM 구성 행입니다.' });
    }
  });
  if (plant === null || errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  if (scope !== null && !scope.includes(plantId)) {
    throw new ContractException(HttpStatus.FORBIDDEN, [
      { scope: 'field', field: 'plantId', code: ERROR_CODE.PERMISSION_DENIED, message: '이 공장에 대한 데이터 권한이 없습니다.' },
    ]);
  }

  const itemIds = [...new Set(components.map((row) => row.component_item_id))];
  const [table, available] = await Promise.all([
    loadStockUomTable(client, itemIds, localDate(new Date(), plant.timezone_code)),
    plantAvailable(client, plantId, itemIds),
  ]);

  const uomCode = (uomId: bigint) => table.uoms.get(uomId)?.code ?? '';
  return {
    items: body.lines.flatMap((request) => {
      const component = componentOf.get(BigInt(request.bomComponentId));
      if (component === undefined) return []; // 위 검증에서 400 — 여기 오지 않는다.
      const [line] = materialRequirements([component], new Prisma.Decimal(request.quantity), component.bom.base_qty);
      const required = line ?? {
        line_no: 1,
        bom_component_id: component.bom_component_id,
        item_id: component.component_item_id,
        requested_qty: new Prisma.Decimal(0),
        uom_id: component.uom_id,
      };
      const [{ bomQty, conversion }] = stockUomLines(table, [required]);
      const stockQty = conversion.stockQty;
      const free = available.get(component.component_item_id) ?? new Prisma.Decimal(0);
      return {
        bomComponentId: request.bomComponentId,
        quantity: request.quantity,
        itemId: Number(component.component_item_id),
        itemCode: component.item.item_code,
        itemName: component.item.item_name,
        requiredQty: bomQty.toNumber(),
        bomUomCode: uomCode(conversion.bomUomId),
        stockUomCode: uomCode(conversion.stockUomId),
        requiredStockQty: stockQty?.toNumber() ?? null,
        availableQty: free.toNumber(),
        statusCode: stockQty === null ? 'NOT_COMPARABLE' : free.gte(stockQty) ? 'ENOUGH' : 'SHORT',
      };
    }),
  };
}

/** 공장 자재창고 + 생산창고의 품목별 피킹 가능 잔액 합. 창고가 없으면 묻지 않는다. */
async function plantAvailable(client: Prisma.TransactionClient, plantId: bigint, itemIds: bigint[]): Promise<Map<bigint, Prisma.Decimal>> {
  const [materialWarehouses, productionWarehouses] = await Promise.all([
    client.warehouse.findMany({
      where: { plant_id: plantId, is_active: true, warehouse_type_code: MATERIAL_WAREHOUSE },
      select: { warehouse_id: true },
    }),
    plantProductionWarehouses(client, plantId),
  ]);
  const warehouseIds = [...new Set([...materialWarehouses.map((row) => row.warehouse_id), ...productionWarehouses])];
  const available = new Map<bigint, Prisma.Decimal>();
  if (warehouseIds.length === 0) return available;
  for (const [key, qty] of await availableQty(client, warehouseIds, itemIds)) {
    const itemId = BigInt(key.split(':')[1]);
    available.set(itemId, (available.get(itemId) ?? new Prisma.Decimal(0)).plus(qty));
  }
  return available;
}
