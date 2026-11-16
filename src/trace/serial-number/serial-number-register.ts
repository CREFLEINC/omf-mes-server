import { Prisma } from '@prisma/client';

import { ERROR_CODE, field, one } from '../../common/errors';

const INITIAL_STATUS = 'REGISTERED';
const SHOWN = 10;

/**
 * 밖에서 매긴 번호로 시리얼을 그 생산 LOT 에 등록한다 — 추적 시스템(flowtrack)이 번호를 매긴다(사용자 2026-11-16).
 * `ON CONFLICT` 로 거르므로 다른 트랜잭션이 같은 번호를 막 넣고 있어도 500 이 아니라 400 이다.
 */
export async function registerSerialNumbers(
  tx: Prisma.TransactionClient,
  input: { lotId: bigint; itemId: bigint; serialNos: string[] },
): Promise<void> {
  const inserted = await tx.$queryRaw<{ serial_no: string }[]>`
    INSERT INTO trace.serial_number (serial_no, item_id, lot_id, status_code)
    SELECT serial_no, ${input.itemId}, ${input.lotId}, ${INITIAL_STATUS}
      FROM unnest(${input.serialNos}::varchar[]) AS serial_no
    ON CONFLICT (serial_no) DO NOTHING
    RETURNING serial_no`;
  if (inserted.length === input.serialNos.length) return;
  const added = new Set(inserted.map((row) => row.serial_no));
  const taken = input.serialNos.filter((serialNo) => !added.has(serialNo));
  const more = taken.length > SHOWN ? ` 외 ${taken.length - SHOWN}개` : '';
  throw one(field('serialNos', ERROR_CODE.UNIQUE_VIOLATION, `MES 에 이미 있는 시리얼입니다: ${taken.slice(0, SHOWN).join(', ')}${more}`));
}
