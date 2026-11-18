import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { incomingLines } from './leaf-location';
import { PostingLine } from './posting.types';

/**
 * 위치 품목 제한 — 「지정 품목만 받기」(`item_restricted`)를 켠 위치만 지정 밖 품목을 받지 않는다(2026-11-18 결정 · 피처 009).
 * 꺼진 위치의 품목 지정은 안내다(PDA 미지정 위치 적치가 지정을 늘린다). 같은 위치 안 상태 변경과 역처리는 «맨 아래 위치» 검사
 * (`leaf-location.ts`)와 같은 까닭으로 보지 않는다.
 */
export async function assertAllowedItems(
  tx: Pick<Prisma.TransactionClient, 'location'>,
  lines: readonly PostingLine[],
): Promise<void> {
  const incoming = incomingLines(lines);
  if (incoming.length === 0) return;
  const restricted = await tx.location.findMany({
    where: { location_id: { in: [...new Set(incoming.map((line) => BigInt(line.to.locationId)))] }, item_restricted: true },
    select: { location_id: true, location_item: { select: { item_id: true } } },
  });
  if (restricted.length === 0) return;
  const allowed = new Map(restricted.map((row) => [row.location_id, new Set(row.location_item.map((item) => item.item_id))]));
  const blocked = incoming.some((line) => {
    const items = allowed.get(BigInt(line.to.locationId));
    return items !== undefined && !items.has(BigInt(line.itemId));
  });
  if (!blocked) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.LOCATION_ITEM_RESTRICTED, message: '이 위치는 지정 품목만 받습니다.' },
  ]);
}
