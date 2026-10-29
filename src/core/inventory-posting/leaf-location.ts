import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { PostingLine } from './posting.types';

/**
 * 재고는 켜진 하위가 없는 맨 아래 위치에만 둔다(사용자 결정 2026-10-29) — 들어오는 쪽(`to`) 위치에 켜진 하위가 있으면 막는다.
 * ⭐ 같은 위치 안에서 상태만 바꾸는 줄(`from` 위치 = `to` 위치)은 둔다 — 하위가 생기기 전부터 있던 재고를 정리하는 길이다.
 * ⭐ 역처리(`reverse`)는 부르지 않는다 — 원래 있던 자리로 되돌릴 뿐이고, 막으면 전표를 취소할 수 없게 된다.
 */
/** 다른 위치에서 들어오는 줄 — 같은 위치 안에서 상태만 바꾸는 줄은 뺀다(위 머리말). */
export function incomingLines(lines: readonly PostingLine[]): (PostingLine & { to: NonNullable<PostingLine['to']> })[] {
  return lines.filter((line): line is PostingLine & { to: NonNullable<PostingLine['to']> } =>
    line.to !== undefined && line.to.locationId !== line.from?.locationId);
}

export async function assertLeafDestinations(
  tx: Pick<Prisma.TransactionClient, 'location'>,
  lines: readonly PostingLine[],
): Promise<void> {
  const incoming = incomingLines(lines).map((line) => BigInt(line.to.locationId));
  if (incoming.length === 0) return;
  const child = await tx.location.findFirst({
    where: { parent_location_id: { in: [...new Set(incoming)] }, is_active: true },
    select: { location_id: true },
  });
  if (child === null) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '하위 위치가 있는 위치에는 재고를 둘 수 없습니다 — 맨 아래 위치를 고릅니다.' },
  ]);
}
