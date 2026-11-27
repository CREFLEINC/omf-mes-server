import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { LOCATION_FACT_SELECT, locationFinding, resolveFgLocation } from '../../core/erp-warehouse/fg-location';

type LocationBody = {
  defaultFgLocationId?: number | null;
  defaultScrapLocationId?: number | null;
};

/** 변경된 생산품 입고 위치를 ERP W/O의 창고 규칙으로 검사한다. */
export async function assertLocationsAllowed(tx: Prisma.TransactionClient, workOrderId: number, body: LocationBody): Promise<void> {
  if (body.defaultFgLocationId == null) return;
  const locationId = BigInt(body.defaultFgLocationId);
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) },
    select: {
      default_fg_location_id: true,
      production_plan: { select: { production_order: { select: { plant_id: true, erp_storage_location_code: true } } } },
    },
  });
  const order = row.production_plan?.production_order;
  if (order === undefined || row.default_fg_location_id === locationId) return;

  const facts = await tx.location.findMany({ where: { location_id: { in: [locationId] } }, select: LOCATION_FACT_SELECT });
  const fg = await resolveFgLocation(tx, { plantId: order.plant_id, erpCode: order.erp_storage_location_code });
  const found = locationFinding(order.plant_id, facts[0], fg);
  if (found !== null) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('defaultFgLocationId', found.code, found.message)]);
  }
}

export async function assertLineAssignmentAllowed(
  tx: Prisma.TransactionClient, workOrderId: number, productionLineId: number | null | undefined,
): Promise<void> {
  if (productionLineId == null) return;
  const lineId = BigInt(productionLineId);
  const row = await tx.work_order.findUniqueOrThrow({
    where: { work_order_id: BigInt(workOrderId) },
    select: { production_line_id: true, production_plan: { select: { production_order: { select: { plant_id: true } } } } },
  });
  if (lineId === row.production_line_id) return;
  const line = await tx.production_line.findUnique({
    where: { production_line_id: lineId },
    select: { plant_id: true, is_active: true },
  });
  if (!line || !line.is_active || (row.production_plan && line.plant_id !== row.production_plan.production_order.plant_id)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('productionLineId', ERROR_CODE.INVALID, '이 공장의 사용 중인 생산 라인을 선택하세요.')]);
  }
}
