import { HttpStatus } from '@nestjs/common';

import type { SessionScope } from '../../auth/session.types';
import { ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { accountCoversBusinessUnit, accountCoversWarehouse } from './shipment-request-scope';

/** 사업부·줄 창고 검사에 쓰는 본문 칸(피처 012 R-8). */
export interface BusinessUnitLinesInput {
  businessUnitId?: number | null;
  lines: { warehouseId?: number | null }[];
}

/**
 * 지시서 사업부·줄 출고 창고(피처 012 R-8 · FR-001·FR-003). 둘 다 필수이고 «업무 규칙»이라 422 다 — 옛 W-04-01 이
 * 사업부 없이 보내면 여기서 막힌다(배포 순서: 서버 → 클라이언트 같은 날).
 * - 사업부: 활성, 계정 데이터 범위 안(밖이면 403).
 * - 줄 창고: 활성 · 그 사업부 · 불량창고 아님(422 `lines[n].warehouseId`), 계정 공장 범위 안(밖이면 403).
 */
export async function assertBusinessUnitAndWarehouses(
  prisma: PrismaService,
  input: BusinessUnitLinesInput,
  scopes: readonly SessionScope[],
): Promise<void> {
  const errors: ErrorItem[] = [];
  if (input.businessUnitId == null) errors.push(field('businessUnitId', ERROR_CODE.REQUIRED, '사업부를 고르세요.'));
  for (const [index, line] of input.lines.entries()) {
    if (line.warehouseId == null) errors.push(field(`lines[${index}].warehouseId`, ERROR_CODE.REQUIRED, '출고 창고를 고르세요.'));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, errors);
  const businessUnitId = input.businessUnitId as number;

  const warehouseIds = [...new Set(input.lines.map((line) => line.warehouseId as number))];
  const [unit, warehouses] = await Promise.all([
    prisma.business_unit.findUnique({ where: { business_unit_id: BigInt(businessUnitId) }, select: { is_active: true } }),
    prisma.warehouse.findMany({
      where: { warehouse_id: { in: warehouseIds.map(BigInt) } },
      select: { warehouse_id: true, plant_id: true, business_unit_id: true, is_active: true, is_defect: true },
    }),
  ]);
  if (unit === null || !unit.is_active) {
    throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
      field('businessUnitId', ERROR_CODE.INVALID, '사용할 수 있는 사업부가 아닙니다.'),
    ]);
  }
  if (!accountCoversBusinessUnit(scopes, businessUnitId)) {
    throw new ContractException(HttpStatus.FORBIDDEN, [
      field('businessUnitId', ERROR_CODE.PERMISSION_DENIED, '이 사업부에 대한 데이터 권한이 없습니다.'),
    ]);
  }

  const byId = new Map(warehouses.map((row) => [Number(row.warehouse_id), row]));
  const denied: ErrorItem[] = [];
  for (const [index, line] of input.lines.entries()) {
    const at = `lines[${index}].warehouseId`;
    const warehouse = byId.get(line.warehouseId as number);
    if (warehouse === undefined || !warehouse.is_active || warehouse.is_defect || Number(warehouse.business_unit_id) !== businessUnitId) {
      errors.push(field(at, ERROR_CODE.INVALID, '이 사업부에서 출고할 수 있는 창고가 아닙니다.'));
    } else if (!accountCoversWarehouse(scopes, { businessUnitId, plantId: Number(warehouse.plant_id) })) {
      denied.push(field(at, ERROR_CODE.PERMISSION_DENIED, '이 창고의 공장에 대한 데이터 권한이 없습니다.'));
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, errors);
  if (denied.length > 0) throw new ContractException(HttpStatus.FORBIDDEN, denied);
}

/**
 * S/O 줄 나누기(피처 012 D-3 · FR-005) — 같은 S/O 줄을 가리키는 지시서 줄 여럿을 받고, 그 배정 합이 S/O 잔여
 * (주문 − 누적 출하, W-04-01 이 승계하는 값과 같은 식)를 넘으면 그 줄들을 모두 422 로 표시한다.
 */
export function assertSalesOrderRemaining(
  lines: { salesOrderLineId?: number | null; allocatedQty: number }[],
  orderLines: { sales_order_line_id: bigint; ordered_qty: unknown; shipped_qty: unknown }[],
): void {
  const remaining = new Map(orderLines.map((row) => [Number(row.sales_order_line_id), Number(row.ordered_qty) - Number(row.shipped_qty)]));
  const groups = new Map<number, number[]>();
  for (const [index, line] of lines.entries()) {
    if (line.salesOrderLineId == null || !remaining.has(line.salesOrderLineId)) continue;
    groups.set(line.salesOrderLineId, [...(groups.get(line.salesOrderLineId) ?? []), index]);
  }
  const errors: ErrorItem[] = [];
  for (const [orderLineId, indexes] of groups) {
    const total = indexes.reduce((sum, index) => sum + lines[index].allocatedQty, 0);
    // 소수 수량의 합 오차를 피한다 — 계약 수량은 소수 6자리(`Decimal(20,6)`).
    if (Math.round(total * 1e6) > Math.round((remaining.get(orderLineId) as number) * 1e6)) {
      for (const index of indexes) {
        errors.push(field(`lines[${index}].allocatedQty`, ERROR_CODE.RANGE, 'S/O 잔여 수량을 넘습니다.'));
      }
    }
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, errors);
}
