import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../common/errors';
import { PUTAWAY_STAGING } from '../common/master';

export interface DestinationLocationInput {
  warehouseId: number;
  /** 본문이 준 위치. ⛔ 긴급 직행은 본문에 위치 칸이 «0개»라 늘 없다. */
  requestedLocationId?: number | null;
  /** 창고 쪽 오류를 짚을 칸. */
  warehouseField: string;
  /** 위치 쪽 오류를 짚을 칸 — 본문에 위치 칸이 없으면 비운다(그때는 창고 칸을 짚는다). */
  locationField?: string;
}

/**
 * ⭐⭐ **「도착 위치」를 푼다.** 창고 관리수준을 없애고(사용자 결정 2026-10-29 · 장부 P-153) 고를 수 있는
 * 자리의 수로 가른다 — 구역을 만들지 않은 창고는 「창고 전체」 하나뿐이라 위치를 묻지 않는다.
 *
 * ⭐ 사용처가 «둘»이다 — 긴급 직행 출하(본문에 위치 칸 0개)와 재고 재등록(`toLocationId` nullable).
 *
 * | 본문 위치 | 결과 |
 * |---|---|
 * | 없음 | 그 창고의 «고를 수 있는» 자리(활성 · 적치 대기 뺌 · 켜진 하위 없음)가 하나면 그것 · 0 → 400 `RANGE` · 2+ → 400 `REQUIRED` |
 * | 있음 | 그 창고의 «활성» 위치여야 한다 — 아니면 400 `INVALID` |
 */
export async function resolveDestinationLocation(
  prisma: Pick<Prisma.TransactionClient, 'location'>,
  input: DestinationLocationInput,
): Promise<bigint> {
  const requested = input.requestedLocationId ?? undefined;
  const path = input.locationField ?? input.warehouseField;
  if (requested === undefined) {
    // `take: 2` — 0 · 1 · «둘 이상»만 가르면 된다.
    const locations = await prisma.location.findMany({
      // 적치 대기 자리는 «놓기 전» 자리라 도착이 아니다(장부 P-145).
      // `not` 만 걸면 SQL `<>` 라 역할이 없는(NULL) 사람의 위치까지 빠진다.
      where: {
        warehouse_id: BigInt(input.warehouseId),
        is_active: true,
        OR: [{ system_role_code: null }, { system_role_code: { not: PUTAWAY_STAGING } }],
        child_locations: { none: { is_active: true } },
      },
      select: { location_id: true },
      orderBy: { location_id: 'asc' },
      take: 2,
    });
    if (locations.length === 0) {
      throw badRequest(input.warehouseField, ERROR_CODE.RANGE, '창고에 도착 위치가 없습니다.');
    }
    if (locations.length > 1) {
      throw badRequest(path, ERROR_CODE.REQUIRED, '위치를 나눈 창고라 도착 위치가 필요합니다.');
    }
    return locations[0].location_id;
  }
  const found = await prisma.location.findFirst({
    where: { location_id: BigInt(requested), warehouse_id: BigInt(input.warehouseId), is_active: true },
    select: { location_id: true },
  });
  if (found === null) {
    throw badRequest(path, ERROR_CODE.INVALID, '이 창고의 쓸 수 있는 위치가 아닙니다.');
  }
  return found.location_id;
}

const badRequest = (path: string, code: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [field(path, code, message)]);
