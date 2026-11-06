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
