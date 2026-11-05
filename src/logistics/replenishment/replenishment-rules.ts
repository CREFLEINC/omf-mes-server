import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { isProductionWarehouse } from '../../core/material-issue/production-warehouse';

/**
 * 창고 보충의 기준정보 규칙(피처 004 · research R-3·R-9). 관리 품목과 보충 요청이 같이 쓴다.
 */

/** 관리 품목은 자재만 받는다(plan 확인할 것 3 — 반제품을 보충해야 하면 넓힌다). */
export const MATERIAL_ITEM_TYPES = ['RAW_MATERIAL', 'SUBSIDIARY_MATERIAL'];

const invalid = (errors: ErrorItem[]): ContractException => new ContractException(HttpStatus.BAD_REQUEST, errors);

/** 생산 창고(부서에 연결된 활성 창고)인지 보고 공장을 돌려준다. */
export async function productionWarehousePlant(
  db: Prisma.TransactionClient,
  warehouseId: bigint,
  name = 'productionWarehouseId',
): Promise<bigint> {
  const warehouse = await db.warehouse.findUnique({ where: { warehouse_id: warehouseId }, select: { plant_id: true } });
  if (warehouse === null || !(await isProductionWarehouse(db, warehouseId))) {
    throw invalid([field(name, ERROR_CODE.INVALID, '생산 창고가 아닙니다 — 부서에 연결된 사용 중인 창고만 고를 수 있습니다.')]);
  }
  return warehouse.plant_id;
}

/**
 * 출고 자재 창고(FR-002) — 생산 창고와 같은 공장의 활성 창고, 생산 창고 자신·불량창고가 아님. 맞지 않으면 오류 항목을 낸다.
 * 여러 줄을 한 번에 보고 모아 내려고 던지지 않고 돌려준다.
 */
export async function sourceWarehouseErrors(
  db: Prisma.TransactionClient,
  input: { sourceWarehouseIds: readonly bigint[]; productionWarehouseId: bigint; plantId: bigint },
  fieldOf: (index: number) => string,
): Promise<ErrorItem[]> {
  const rows = await db.warehouse.findMany({
    where: { warehouse_id: { in: [...new Set(input.sourceWarehouseIds)] } },
    select: { warehouse_id: true, plant_id: true, is_active: true, is_defect: true },
  });
  const byId = new Map(rows.map((row) => [row.warehouse_id, row]));
  const errors: ErrorItem[] = [];
  input.sourceWarehouseIds.forEach((id, index) => {
    const row = byId.get(id);
    const message =
      row === undefined || row.plant_id !== input.plantId
        ? '생산 창고와 같은 공장의 창고여야 합니다.'
        : !row.is_active
          ? '사용 중지된 창고입니다.'
          : row.is_defect
            ? '불량창고에서는 보충할 수 없습니다.'
            : id === input.productionWarehouseId
              ? '생산 창고 자신은 출고 자재 창고가 될 수 없습니다.'
              : null;
    if (message !== null) errors.push(field(fieldOf(index), ERROR_CODE.INVALID, message));
  });
  return errors;
}

export function throwIfAny(errors: ErrorItem[]): void {
  if (errors.length > 0) throw invalid(errors);
}
