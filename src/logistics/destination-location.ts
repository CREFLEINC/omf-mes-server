import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../common/errors';
import { PUTAWAY_STAGING } from '../common/master';

/** 시드 `MANAGEMENT_LEVEL` 4값(WAREHOUSE·ZONE·RACK·CELL) 중 «위치를 받지 않는» 하나. */
const WAREHOUSE_LEVEL = 'WAREHOUSE';

export interface DestinationLocationInput {
  warehouseId: number;
  managementLevelCode: string;
  /** 본문이 준 위치. ⛔ 긴급 직행은 본문에 위치 칸이 «0개»라 늘 없다. */
  requestedLocationId?: number | null;
  /** 창고 쪽 오류를 짚을 칸. */
  warehouseField: string;
  /** 위치 쪽 오류를 짚을 칸 — 본문에 위치 칸이 없으면 비운다(그때는 창고 칸을 짚는다). */
  locationField?: string;
}

/**
 * ⭐⭐ **창고 관리수준으로 «도착 위치»를 푼다.** 계약 `managementLevelCode` 원문 「✅ 값 목록 확정
 * 2026-08-31 … **이 값이 위치 입력을 가른다 — 창고면 위치를 받지 않고, 셀이면 셀까지 받는다**」
 * (I-23 R-7 이 질의 225 를 취소한 근거).
 *
 * ⭐ 사용처가 «둘»이 되어 모았다 — 긴급 직행 출하(본문에 위치 칸 0개 · PR ⑤ 에서는 그 서비스의
 *   private 메서드였다)와 재고 재등록(`toLocationId` nullable · PR ⑧). CLAUDE.md 「사용처 하나뿐인
 *   추상화 금지」가 둘째가 온 지금 푸는 자리다.
 *
 * | 관리수준 | 본문 위치 | 결과 |
 * |---|---|---|
 * | `WAREHOUSE` | 없음 | 그 창고의 활성 위치(적치 대기 자리 뺌)가 «정확히 하나»면 그것 · 0·2+ → 400 `RANGE` |
 * | `WAREHOUSE` | 있음 | 위의 그 하나와 같아야 한다 — 다르면 400 `INVALID`(「창고면 위치를 받지 않는다」) |
 * | 그 밖 | 없음 | 400 `REQUIRED` — 위치 칸이 있으면 그 칸, 없으면 창고 칸을 짚는다 |
 * | 그 밖 | 있음 | 그 창고의 «활성» 위치여야 한다 — 아니면 400 `INVALID` |
 */
export async function resolveDestinationLocation(
  prisma: Pick<Prisma.TransactionClient, 'location'>,
  input: DestinationLocationInput,
): Promise<bigint> {
  const requested = input.requestedLocationId ?? undefined;
  if (input.managementLevelCode === WAREHOUSE_LEVEL) {
    // `take: 2` — 0 · 1 · «둘 이상»만 가르면 된다.
    const locations = await prisma.location.findMany({
      // 적치 대기 자리는 «놓기 전» 자리라 도착이 아니다 — 이것을 세면 창고 전체와 함께 늘 둘이다(장부 P-145).
      // `not` 만 걸면 SQL `<>` 라 역할이 없는(NULL) 사람의 위치까지 빠진다.
      where: {
        warehouse_id: BigInt(input.warehouseId),
        is_active: true,
        OR: [{ system_role_code: null }, { system_role_code: { not: PUTAWAY_STAGING } }],
      },
      select: { location_id: true },
      orderBy: { location_id: 'asc' },
      take: 2,
    });
    if (locations.length !== 1) {
      throw badRequest(input.warehouseField, ERROR_CODE.RANGE, '창고의 도착 위치를 하나로 정할 수 없습니다.');
    }
    const only = locations[0].location_id;
    if (requested !== undefined && BigInt(requested) !== only) {
      throw badRequest(
        input.locationField ?? input.warehouseField,
        ERROR_CODE.INVALID,
        '창고 단위로 관리하는 창고는 위치를 따로 받지 않습니다.',
      );
    }
    return only;
  }
  if (requested === undefined) {
    throw badRequest(
      input.locationField ?? input.warehouseField,
      ERROR_CODE.REQUIRED,
      `위치를 ${input.managementLevelCode} 단위로 관리하는 창고라 도착 위치가 필요합니다.`,
    );
  }
  const found = await prisma.location.findFirst({
    where: { location_id: BigInt(requested), warehouse_id: BigInt(input.warehouseId), is_active: true },
    select: { location_id: true },
  });
  if (found === null) {
    throw badRequest(input.locationField ?? input.warehouseField, ERROR_CODE.INVALID, '이 창고의 쓸 수 있는 위치가 아닙니다.');
  }
  return found.location_id;
}

const badRequest = (path: string, code: string, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [field(path, code, message)]);
