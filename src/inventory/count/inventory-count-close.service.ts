import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { InventoryCountQueryService, inventoryCountSummary } from './inventory-count-query.service';
import { InventoryCountDetail } from './inventory-count-view';

export interface InventoryCountClose {
  businessDate: string;
}

interface LockedCount {
  inventory_count_id: bigint;
  status_code: string;
  version_no: number;
}

@Injectable()
export class InventoryCountCloseService {
  constructor(private readonly queries: InventoryCountQueryService) {}

  async closeWithin(
    tx: Prisma.TransactionClient,
    inventoryCountId: number,
    version: number,
    body: InventoryCountClose,
    appUserId: number,
  ): Promise<InventoryCountDetail> {
    assertBusinessDate(body.businessDate);
    const locked = await lockCount(tx, inventoryCountId);
    if (locked.version_no !== version) assertUpdated(0);

    const summary = await inventoryCountSummary(tx, locked.inventory_count_id, locked.status_code);
    if (summary.closeBlockedReasonCode !== null) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        field(
          'inventoryCountId',
          summary.closeBlockedReasonCode,
          blockedMessage(summary.closeBlockedReasonCode),
        ),
      ]);
    }

    const updated = await tx.inventory_count.updateMany({
      where: {
        inventory_count_id: locked.inventory_count_id,
        status_code: 'IN_PROGRESS',
        version_no: locked.version_no,
      },
      data: {
        status_code: 'COMPLETED',
        version_no: { increment: 1 },
        updated_by: appUserId,
      },
    });
    assertUpdated(updated.count);
    return (await this.queries.getWithin(tx, inventoryCountId)).detail;
  }
}

async function lockCount(
  tx: Prisma.TransactionClient,
  inventoryCountId: number,
): Promise<LockedCount> {
  const rows = await tx.$queryRaw<LockedCount[]>`
    SELECT inventory_count_id, status_code, version_no
      FROM inventory.inventory_count
     WHERE inventory_count_id = ${BigInt(inventoryCountId)}
       FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('없는 재고 실사입니다.');
  return rows[0];
}

function assertBusinessDate(value: string): void {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return;
  }
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field('businessDate', ERROR_CODE.INVALID, 'YYYY-MM-DD 형식의 실재하는 날짜여야 합니다.'),
  ]);
}

function blockedMessage(code: string): string {
  switch (code) {
    case ERROR_CODE.ALREADY_CLOSED:
      return '이미 마감된 실사입니다.';
    case ERROR_CODE.STATE_LOCKED:
      return '진행 중인 실사만 마감할 수 있습니다.';
    case ERROR_CODE.COUNT_REMAINING:
      return '미실사 라인이 남아 있습니다.';
    case ERROR_CODE.VARIANCE_UNADJUSTED:
      return '조정 완료되지 않은 차이 라인이 남아 있습니다.';
    default:
      throw new Error(`알 수 없는 실사 마감 차단 사유입니다: ${code}`);
  }
}
