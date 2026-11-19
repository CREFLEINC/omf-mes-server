import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { plantPolicyText } from '../../app/policy/plant-policy-text';
import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { findArrivalLocationId } from '../../core/material-issue/production-warehouse';
import { SourceScope } from '../../core/material-issue/source-warehouse';

/**
 * 라인 없이 배포하는 자동 W/O(OA)의 출고요청 출발·도착(사용자 결정 2026-11-19). 라인이 없어 부서 생산 창고를 못 푼다 — 공장 정책으로 정한다.
 * 출발은 `AUTO_ISSUE_SOURCE_WAREHOUSE` 창고 하나, 도착은 자재 차감 창고(`BACKFLUSH_WAREHOUSE`)의 받는 자리다(나뉜 창고는 적치 대기,
 * 아니면 창고 전체 — 창고 보충과 같은 규칙). 차감은 그 창고의 맨 아래 위치를 다 보므로 받는 자리에 있어도 빠진다.
 * 출발 정책이 없는 공장은 `null` — 출고요청 없이 배포한다.
 */
export async function autoIssueScope(db: Prisma.TransactionClient, plantId: bigint, onDate: string): Promise<SourceScope | null> {
  const sourceCode = await plantPolicyText(db, 'AUTO_ISSUE_SOURCE_WAREHOUSE', plantId, onDate);
  if (sourceCode === null) return null;
  const destinationCode = await plantPolicyText(db, 'BACKFLUSH_WAREHOUSE', plantId, onDate);
  const source = await activeWarehouseId(db, plantId, sourceCode);
  const destination = destinationCode === null ? null : await activeWarehouseId(db, plantId, destinationCode);
  const arrival = destination === null ? null : await findArrivalLocationId(db, destination);

  const errors: ErrorItem[] = [];
  if (source === null) {
    errors.push(screen(`자재 출발 창고(운영 정책 AUTO_ISSUE_SOURCE_WAREHOUSE: ${sourceCode})가 이 공장의 사용 중인 창고가 아닙니다.`));
  }
  if (arrival === null) {
    errors.push(screen(`자재 차감 창고(운영 정책 BACKFLUSH_WAREHOUSE: ${destinationCode ?? '없음'})에 받을 자리가 없습니다 — 정책 행과 그 창고를 확인하세요.`));
  }
  if (source === null || arrival === null) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  return { warehouseIds: [source], destinationLocationId: arrival };
}

async function activeWarehouseId(db: Prisma.TransactionClient, plantId: bigint, code: string): Promise<bigint | null> {
  const row = await db.warehouse.findUnique({
    where: { plant_id_warehouse_code: { plant_id: plantId, warehouse_code: code } },
    select: { warehouse_id: true, is_active: true },
  });
  return row?.is_active === true ? row.warehouse_id : null;
}

function screen(message: string): ErrorItem {
  return { scope: 'screen', code: ERROR_CODE.INVALID, message };
}
