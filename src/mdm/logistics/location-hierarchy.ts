import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

/** 위치 계층 — 위에서 아래로. 건너뛰기가 없어 단계는 상위가 정한다(사용자 결정 2026-10-29 · 장부 P-154). */
export const LOCATION_LEVELS = ['ZONE', 'RACK', 'LEVEL', 'CELL'] as const;

type Db = Pick<Prisma.TransactionClient, 'location' | 'inventory_balance' | '$queryRaw'>;

/** 그 위치와 밑의 위치 전부(가지). */
export async function branchIds(prisma: Pick<Prisma.TransactionClient, '$queryRaw'>, locationId: number): Promise<bigint[]> {
  const rows = await prisma.$queryRaw<{ location_id: bigint }[]>`
    WITH RECURSIVE branch AS (
      SELECT location_id FROM mdm.location WHERE location_id = ${BigInt(locationId)}
      UNION ALL
      SELECT child.location_id FROM mdm.location child JOIN branch ON child.parent_location_id = branch.location_id
    )
    SELECT location_id FROM branch`;
  return rows.map((row) => row.location_id);
}

/** 상위 밑에 올 단계. 셀·서버가 만든 자리·단계 없는 위치(넷보다 깊던 옛 위치) 밑에는 달 수 없다. */
export async function levelUnder(prisma: Db, parentId: number | null): Promise<string> {
  if (parentId === null) return LOCATION_LEVELS[0];
  const parent = await prisma.location.findUnique({
    where: { location_id: parentId },
    select: { location_level_code: true, system_role_code: true },
  });
  if (parent?.system_role_code != null) throw parentError('서버가 만든 자리 밑에는 위치를 둘 수 없습니다.');
  const index = LOCATION_LEVELS.findIndex((level) => level === parent?.location_level_code);
  if (index === LOCATION_LEVELS.length - 1) throw parentError('셀 밑에는 위치를 둘 수 없습니다.');
  if (index < 0) throw parentError('단계가 없는 위치 밑에는 둘 수 없습니다.');
  return LOCATION_LEVELS[index + 1];
}

/** 본문의 단계는 선택이다 — 보냈으면 서버가 정한 값과 같아야 한다. */
export function assertSentLevel(sent: unknown, level: string | null): void {
  if (sent === undefined || sent === null || sent === level) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'locationLevelCode', code: ERROR_CODE.INVALID, message: `상위로 정해지는 단계는 ${level} 입니다.` },
  ]);
}

/** 재고는 맨 아래 위치에만 둔다 — 재고가 있는 위치는 하위를 받지 않는다. `path` 가 없으면 화면 오류다. */
export async function assertNoStock(prisma: Db, locationId: number, path?: string): Promise<void> {
  const stocked = await prisma.inventory_balance.findFirst({
    where: { location_id: locationId, NOT: { on_hand_qty: 0 } },
    select: { inventory_balance_id: true },
  });
  if (stocked === null) return;
  const message = '재고가 있는 위치 밑에는 위치를 둘 수 없습니다 — 재고를 먼저 옮깁니다.';
  const error: ErrorItem = path === undefined
    ? { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }
    : { scope: 'field', field: path, code: ERROR_CODE.STATE_LOCKED, message };
  throw new ContractException(HttpStatus.BAD_REQUEST, [error]);
}

/**
 * 상위는 바꾸지 않는다 — 코드가 상위 경로를 담는데 코드는 바꿀 수 없다(사용자 결정 2026-10-29). 잘못 단 위치는
 * 지우고 다시 만든다. 화면이 저장된 값을 그대로 실어 보내는 것은 받는다.
 */
export function assertKeptPlace(
  current: { parent_location_id: bigint | null; location_level_code: string | null },
  input: { parentLocationId?: number | null; locationLevelCode?: unknown },
): void {
  assertSentLevel(input.locationLevelCode, current.location_level_code);
  if (input.parentLocationId === undefined) return;
  if (input.parentLocationId !== (current.parent_location_id === null ? null : Number(current.parent_location_id))) {
    throw parentError('상위는 바꿀 수 없습니다 — 지우고 다시 만듭니다.');
  }
}

/** 가지 안에 재고가 있으면 끄지 않는다 — 먼저 옮긴다(사용자 결정 2026-10-29). */
export async function assertBranchEmpty(prisma: Db, branch: bigint[]): Promise<void> {
  const stocked = await prisma.inventory_balance.findFirst({
    where: { location_id: { in: branch }, NOT: { on_hand_qty: 0 } },
    select: { inventory_balance_id: true },
  });
  if (stocked === null) return;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message: '재고가 있는 위치가 있어 끌 수 없습니다 — 재고를 먼저 옮깁니다.' },
  ]);
}

/** 꺼진 하위를 다시 켜면 상위가 맨 아래가 아니게 된다 — 상위에 재고가 있으면 막는다. */
export async function assertParentEmpty(prisma: Db, locationId: number): Promise<void> {
  const row = await prisma.location.findUnique({
    where: { location_id: locationId },
    select: { parent_location_id: true },
  });
  if (row?.parent_location_id != null) await assertNoStock(prisma, Number(row.parent_location_id));
}

export function parentError(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'parentLocationId', code: ERROR_CODE.INVALID, message },
  ]);
}
