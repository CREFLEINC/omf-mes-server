import type { Prisma } from '@prisma/client';

/**
 * 출하 지시서 범위 규칙 한 곳(피처 012 R-2 · omf-all-around#338). 「지시서 공장 = 단말 공장」이 단말 목록·소유 검사·배지·
 * OQC·완료 찾기·대시보드에 흩어져 있었는데, 지시서가 사업부 단위·줄별 출고 창고가 되며 규칙이 셋으로 갈렸다.
 *
 * - **줄 범위**(PDA 피킹): 줄 창고가 있으면 그 창고의 공장 = 단말 공장(창고가 지정된 단말은 줄 창고 = 단말 창고).
 *   창고 없는 옛 줄은 지시서 이행 공장 = 단말 공장(창고 지정 단말도 공장만 본다 — 배포 전 동작 그대로, FR-027).
 * - **사업부 범위**(POP 찾기·완료·OQC·배지): 지시서 사업부 = 단말 공장의 사업부. 사업부가 없는 옛 지시서는
 *   이행 공장 = 단말 공장(FR-026).
 *
 * ⛔ 같은 규칙을 다른 파일에 다시 적지 않는다 — 갈래가 어긋나면 #331 같은 빠짐이 다시 생긴다.
 */

export type OutOfScopeReason = 'OTHER_PLANT' | 'OTHER_WAREHOUSE';

/** 단말의 공장과(있으면) 창고. */
export interface TerminalShipmentScope {
  plantId: bigint;
  warehouseId: bigint | null;
}

/** 범위 판정에 필요한 줄의 사실 — 줄 창고와 그 창고의 공장, 지시서 이행 공장. */
export interface ScopedLine {
  warehouseId: bigint | null;
  warehousePlantId: bigint | null;
  requestPlantId: bigint | null;
}

/** 줄이 단말 범위 밖인 이유 — 안이면 null. */
export function lineOutOfScopeReason(line: ScopedLine, scope: TerminalShipmentScope): OutOfScopeReason | null {
  if (line.warehouseId === null) return line.requestPlantId === scope.plantId ? null : 'OTHER_PLANT';
  if (line.warehousePlantId !== scope.plantId) return 'OTHER_PLANT';
  if (scope.warehouseId !== null && line.warehouseId !== scope.warehouseId) return 'OTHER_WAREHOUSE';
  return null;
}

/** 사업부 범위 판정 — 지시서 사업부 = 단말 공장 사업부, 사업부 없는 옛 지시서는 이행 공장 = 단말 공장. */
export function requestInBusinessUnit(
  request: { businessUnitId: bigint | null; fulfillmentPlantId: bigint | null },
  terminal: { plantId: bigint; businessUnitId: bigint | null },
): boolean {
  if (request.businessUnitId === null) return request.fulfillmentPlantId === terminal.plantId;
  return terminal.businessUnitId !== null && request.businessUnitId === terminal.businessUnitId;
}

/** Prisma 조건 — 단말 범위 안의 줄. */
export function lineInTerminalScopeWhere(scope: TerminalShipmentScope): Prisma.shipment_request_lineWhereInput {
  return {
    OR: [
      {
        warehouse: { plant_id: scope.plantId },
        ...(scope.warehouseId === null ? {} : { warehouse_id: scope.warehouseId }),
      },
      { warehouse_id: null, shipment_request: { fulfillment_plant_id: scope.plantId } },
    ],
  };
}

/** Prisma 조건 — 단말 범위 안 줄이 하나라도 있는 지시서(PDA 목록·배지·소유 검사). */
export function requestPickableByTerminalWhere(scope: TerminalShipmentScope): Prisma.shipment_requestWhereInput {
  return { shipment_request_line: { some: lineInTerminalScopeWhere(scope) } };
}

/** Prisma 조건 — 단말 공장 사업부의 지시서. `businessUnitId` 는 단말 공장의 사업부(없으면 null). */
export function requestInBusinessUnitWhere(plantId: bigint, businessUnitId: bigint | null): Prisma.shipment_requestWhereInput {
  const legacy: Prisma.shipment_requestWhereInput = { business_unit_id: null, fulfillment_plant_id: plantId };
  return businessUnitId === null ? legacy : { OR: [{ business_unit_id: businessUnitId }, legacy] };
}

/** 단말 공장의 사업부 — 사업부 범위 조건의 입력. */
export async function plantBusinessUnit(db: Pick<Prisma.TransactionClient, 'plant'>, plantId: bigint): Promise<bigint | null> {
  return (await db.plant.findUnique({ where: { plant_id: plantId }, select: { business_unit_id: true } }))?.business_unit_id ?? null;
}

/** SQL 조각의 자리표 — 값을 넣고 `$n` 을 돌려준다. */
type Bind = (value: unknown) => string;

/** SQL — 줄 별칭 `line`·지시서 별칭 `request` 의 줄이 단말 범위 안. */
export function lineInTerminalScopeSql(line: string, request: string, scope: TerminalShipmentScope, bind: Bind): string {
  const plant = `${bind(scope.plantId)}::bigint`;
  const warehouse = scope.warehouseId === null ? '' : ` AND ${line}.warehouse_id = ${bind(scope.warehouseId)}::bigint`;
  return `((${line}.warehouse_id IS NOT NULL AND EXISTS (SELECT 1 FROM mdm.warehouse sw
                 WHERE sw.warehouse_id = ${line}.warehouse_id AND sw.plant_id = ${plant})${warehouse})
        OR (${line}.warehouse_id IS NULL AND ${request}.fulfillment_plant_id = ${plant}))`;
}

/** SQL — 지시서 별칭 `request` 에 단말 범위 안 줄이 하나라도 있다. */
export function requestPickableByTerminalSql(request: string, scope: TerminalShipmentScope, bind: Bind): string {
  return `EXISTS (SELECT 1 FROM logistics.shipment_request_line scl
                 WHERE scl.shipment_request_id = ${request}.shipment_request_id
                   AND ${lineInTerminalScopeSql('scl', request, scope, bind)})`;
}

/** SQL — 지시서 별칭 `request` 가 단말 공장의 사업부(사업부 없는 옛 지시서는 이행 공장)다. */
export function requestInBusinessUnitSql(request: string, plantId: bigint, bind: Bind): string {
  const plant = `${bind(plantId)}::bigint`;
  return `(${request}.business_unit_id = (SELECT sp.business_unit_id FROM mdm.plant sp WHERE sp.plant_id = ${plant})
        OR (${request}.business_unit_id IS NULL AND ${request}.fulfillment_plant_id = ${plant}))`;
}

/** 계정 데이터 범위 한 줄 — 세션 `scopes` 와 같은 모양(공장이 없으면 사업부 전체). */
export interface AccountScope {
  businessUnitId: number;
  plantId?: number;
}

/** 계정이 그 사업부를 다룰 수 있나 — 범위 줄이 없으면 제한 없음(omf-all-around#336). */
export function accountCoversBusinessUnit(scopes: readonly AccountScope[], businessUnitId: number): boolean {
  return scopes.length === 0 || scopes.some((scope) => scope.businessUnitId === businessUnitId);
}

/** 계정이 그 창고(공장)를 다룰 수 있나 — 사업부 줄은 사업부 전체, 공장 줄은 그 공장만. */
export function accountCoversWarehouse(scopes: readonly AccountScope[], warehouse: { businessUnitId: number; plantId: number }): boolean {
  return scopes.length === 0 || scopes.some((scope) =>
    scope.businessUnitId === warehouse.businessUnitId && (scope.plantId === undefined || scope.plantId === warehouse.plantId));
}

/**
 * SQL — 지시서 별칭 `request` 가 계정 데이터 범위 안(W-04-02 · 피처 012 D-12). 범위 줄이 없으면 조건을 걸지 않는다(null).
 * 사업부 줄·공장 줄 모두 그 사업부의 지시서를 본다(공장만 범위인 계정 = 그 공장 사업부). 사업부 없는 옛 지시서는
 * 공장 줄이 있을 때만 그 이행 공장으로 본다.
 */
export function requestInAccountScopeSql(request: string, scopes: readonly AccountScope[], bind: Bind): string | null {
  if (scopes.length === 0) return null;
  const units = [...new Set(scopes.map((scope) => scope.businessUnitId))];
  const plants = [...new Set(scopes.flatMap((scope) => (scope.plantId === undefined ? [] : [scope.plantId])))];
  const legacy = plants.length === 0 ? '' : `
        OR (${request}.business_unit_id IS NULL AND ${request}.fulfillment_plant_id = ANY(${bind(plants)}::bigint[]))`;
  return `(${request}.business_unit_id = ANY(${bind(units)}::bigint[])${legacy})`;
}
