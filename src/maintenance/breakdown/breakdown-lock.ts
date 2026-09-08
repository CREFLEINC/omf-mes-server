import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';

export type BreakdownTx = Prisma.TransactionClient;

export interface LockedBreakdown {
  breakdown_id: bigint;
  status_code: string;
  version_no: number;
}

export async function lockBreakdownForUpdate(
  tx: BreakdownTx,
  breakdownId: number,
): Promise<LockedBreakdown> {
  const rows = await tx.$queryRaw<LockedBreakdown[]>`
    SELECT breakdown_id,status_code,version_no
    FROM maintenance.breakdown
    WHERE breakdown_id=${BigInt(breakdownId)}
    FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException('없는 고장 기록입니다.');
  return rows[0];
}

export function assertBreakdownVersion(
  row: LockedBreakdown,
  version: number,
): void {
  if (row.version_no !== version) assertUpdated(0, 'user');
}

export function assertBreakdownEditable(row: LockedBreakdown): void {
  if (row.status_code === 'RECEIVED' || row.status_code === 'HANDLING') return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    field(
      'statusCode',
      ERROR_CODE.STATE_LOCKED,
      '현재 상태에서는 고장을 수정할 수 없습니다.',
    ),
  ]);
}
