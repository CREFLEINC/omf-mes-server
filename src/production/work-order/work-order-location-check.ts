import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ErrorItem, field } from '../../common/errors';
import { LOCATION_FACT_SELECT, locationFinding, resolveFgLocation } from '../../core/erp-warehouse/fg-location';

type LocationBody = {
  defaultWipLocationId?: number | null;
  defaultFgLocationId?: number | null;
  defaultScrapLocationId?: number | null;
};

const LOCATION_COLUMNS = [
  ['defaultWipLocationId', 'default_wip_location_id'],
  ['defaultFgLocationId', 'default_fg_location_id'],
  ['defaultScrapLocationId', 'default_scrap_location_id'],
] as const;

/**
 * 본문이 «바꾸는» 기본 위치만 검증한다 — 같은 값을 다시 보내는 수정(옛 W/O 포함)은 막지 않는다. null(해제)도 막지 않는다 — 배포가
 * 빈 위치를 REQUIRED 로 막는다. 완제품 위치는 ERP W/O 의 입고 창고 규칙(`fg-location.ts`), 나머지는 기존 자원 규칙(공장 일치·활성·자재창고 아님)이다.
 * 계획 없는 W/O 는 공장을 알 수 없어 검증하지 않는다.
 */
export async function assertLocationsAllowed(tx: Prisma.TransactionClient, workOrderId: number, body: LocationBody): Promise<void> {
  const sent = LOCATION_COLUMNS.filter(([name]) => body[name] !== undefined && body[name] !== null);
  if (sent.length === 0) return;
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) },
    select: {
      default_wip_location_id: true,
      default_fg_location_id: true,
      default_scrap_location_id: true,
      production_plan: { select: { production_order: { select: { plant_id: true, erp_storage_location_code: true } } } },
    },
  });
  const order = row.production_plan?.production_order;
  if (order === undefined) return;
  const changed = sent.filter(([name, column]) => row[column] !== BigInt(body[name] as number));
  if (changed.length === 0) return;

  const ids = changed.map(([name]) => BigInt(body[name] as number));
  const facts = new Map((await tx.location.findMany({ where: { location_id: { in: ids } }, select: LOCATION_FACT_SELECT })).map((fact) => [fact.location_id, fact]));
  const fg = await resolveFgLocation(tx, { plantId: order.plant_id, erpCode: order.erp_storage_location_code });
  const errors: ErrorItem[] = [];
  for (const [name] of changed) {
    const found = locationFinding(order.plant_id, facts.get(BigInt(body[name] as number)), name === 'defaultFgLocationId' ? fg : undefined);
    if (found !== null) errors.push(field(name, found.code, found.message));
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** WIP is derived before release; changing a line must not retain the previous line's destination. */
export async function withLineWip<T extends LocationBody & { productionLineId?: number | null }>(tx: Prisma.TransactionClient, workOrderId: number, body: T): Promise<T> {
  if (body.productionLineId === undefined && body.defaultWipLocationId === undefined) return body;
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) },
    select: { production_line_id: true, default_wip_location_id: true, production_plan: { select: { production_order: { select: { plant_id: true } } } } },
  });
  const lineId = body.productionLineId === undefined ? row.production_line_id : body.productionLineId === null ? null : BigInt(body.productionLineId);
  if (lineId === row.production_line_id && row.default_wip_location_id !== null) return { ...body, defaultWipLocationId: Number(row.default_wip_location_id) };
  if (lineId === null) return { ...body, defaultWipLocationId: null };
  const line = await tx.production_line.findUnique({ where: { production_line_id: lineId }, select: { plant_id: true, is_active: true, default_wip_location_id: true } });
  if (!line || !line.is_active || (row.production_plan && line.plant_id !== row.production_plan.production_order.plant_id)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('productionLineId', 'INVALID', '이 공장의 사용 중인 생산 라인을 선택하세요.')]);
  }
  return { ...body, defaultWipLocationId: line.default_wip_location_id === null ? null : Number(line.default_wip_location_id) };
}
