import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface LockedMoldForWrite {
  mold_id: bigint;
  plant_id: bigint;
  mold_code: string;
  status_code: string;
}

/** TOOL_LABEL 발행과 같은 부모 행을 먼저 잡아 코드 검사와 변경 사이를 닫는다. */
export async function lockMoldForWrite(tx: Prisma.TransactionClient, moldId: number): Promise<LockedMoldForWrite> {
  const rows = await tx.$queryRaw<LockedMoldForWrite[]>(Prisma.sql`
    SELECT mold_id,plant_id,mold_code,status_code
    FROM mdm.mold
    WHERE mold_id=${BigInt(moldId)}
    FOR NO KEY UPDATE`);
  if (rows.length === 0) throw new NotFoundException('없는 툴입니다.');
  return rows[0];
}
