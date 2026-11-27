import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

export interface LocationItemView {
  itemId: number;
  itemCode: string;
  itemName: string;
}

/**
 * 위치 보관 품목(사용자 결정 2026-10-29) — 위치마다 둘 품목. ⭐ 지정은 안내다(2026-11-18 결정 · 피처 009): 「지정 품목만 받기」
 * (`item_restricted`)를 켠 위치만 재고 코어가 지정 밖 품목을 막고, 지정 밖 재고 검사도 그 위치에서만 한다.
 */
@Injectable()
export class LocationItemService {
  constructor(private readonly prisma: PrismaService) {}

  async list(locationId: number): Promise<{ items: LocationItemView[] }> {
    await this.findLocation(locationId);
    return this.read(locationId);
  }

  async replace(locationId: number, itemIds: number[], appUserId: number | undefined): Promise<{ items: LocationItemView[] }> {
    const location = await this.findLocation(locationId);
    if (location.system_role_code !== null) {
      throw locked(null, '서버가 만든 자리에는 품목 제한을 걸 수 없습니다 — 적치 대기에는 어떤 품목이든 들어옵니다.');
    }
    const ids = [...new Set(itemIds)].map(BigInt);
    const found = await this.prisma.item.count({ where: { item_id: { in: ids }, is_active: true } });
    if (found !== ids.length) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [field('itemIds', ERROR_CODE.INVALID, '없거나 쓰지 않는 품목이 있습니다.')]);
    }
    if (location.item_restricted) await assertRestrictable(this.prisma, BigInt(locationId), ids, 'itemIds');
    await this.prisma.$transaction([
      this.prisma.location_item.deleteMany({ where: { location_id: locationId } }),
      this.prisma.location_item.createMany({
        data: ids.map((itemId) => ({ location_id: locationId, item_id: itemId, created_by: appUserId ?? null })),
      }),
    ]);
    return this.read(locationId);
  }

  private async findLocation(locationId: number): Promise<{ system_role_code: string | null; item_restricted: boolean }> {
    const location = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { system_role_code: true, item_restricted: true },
    });
    if (location === null) throw new NotFoundException('없는 위치입니다.');
    return location;
  }

  private async read(locationId: number): Promise<{ items: LocationItemView[] }> {
    const rows = await this.prisma.location_item.findMany({
      where: { location_id: locationId },
      select: { item: { select: { item_id: true, item_code: true, item_name: true } } },
      orderBy: { item: { item_code: 'asc' } },
    });
    return {
      items: rows.map(({ item }) => ({ itemId: Number(item.item_id), itemCode: item.item_code, itemName: item.item_name })),
    };
  }
}

/**
 * 「지정 품목만 받기」를 켤 수 있는가(FR-017c) — 지정 품목이 1개 이상이고 지정 밖 품목의 재고가 없어야 한다. 켠 위치의 지정을
 * 바꿀 때도 같은 조건이다. 시스템 자리는 부르는 쪽이 먼저 막는다.
 */
export async function assertRestrictable(
  db: Pick<PrismaService, 'inventory_balance'>, locationId: bigint, itemIds: readonly bigint[], path: string,
): Promise<void> {
  if (itemIds.length === 0) throw locked(path, '지정 품목이 없어 「지정 품목만 받기」를 켤 수 없습니다 — 품목을 먼저 지정합니다.');
  const outside = await db.inventory_balance.findFirst({
    where: { location_id: locationId, NOT: { on_hand_qty: 0 }, item_id: { notIn: [...itemIds] } },
    select: { inventory_balance_id: true },
  });
  if (outside !== null) throw locked(path, '지정 밖 품목의 재고가 있어 「지정 품목만 받기」를 켤 수 없습니다 — 재고를 먼저 옮깁니다.');
}

const locked = (path: string | null, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [
    path === null
      ? { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }
      : { scope: 'field', field: path, code: ERROR_CODE.STATE_LOCKED, message },
  ]);
