import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { incomingLines } from './leaf-location';
import { PostingLine } from './posting.types';

/**
 * 위치 품목 제한(사용자 결정 2026-10-29) — 들어오는 쪽 위치에 지정 품목이 있으면 그 품목만 받는다. 걸어 둔 그 위치에만
 * 적용한다. 같은 위치 안 상태 변경과 역처리는 «맨 아래 위치» 검사(`leaf-location.ts`)와 같은 까닭으로 보지 않는다.
 */
export async function assertAllowedItems(
  tx: Pick<Prisma.TransactionClient, 'location_item'>,
  lines: readonly PostingLine[],
): Promise<void> {
  const incoming = incomingLines(lines);
  if (incoming.length === 0) return;
  const rules = await tx.location_item.findMany({
    where: { location_id: { in: [...new Set(incoming.map((line) => BigInt(line.to.locationId)))] } },
    select: { location_id: true, item_id: true },
  });
  if (rules.length === 0) return;
  const allowed = new Map<bigint, Set<bigint>>();
  for (const rule of rules) allowed.set(rule.location_id, (allowed.get(rule.location_id) ?? new Set()).add(rule.item_id));
  const blocked = incoming.some((line) => {
    const items = allowed.get(BigInt(line.to.locationId));
    return items !== undefined && !items.has(BigInt(line.itemId));
  });
  if (!blocked) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '이 위치에는 지정된 품목만 둘 수 있습니다.' },
  ]);
}
