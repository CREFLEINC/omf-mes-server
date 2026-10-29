import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

export interface LocationItemView {
  itemId: number;
  itemCode: string;
  itemName: string;
}

/**
 * 위치 품목 제한(사용자 결정 2026-10-29) — 위치마다 지정 품목, 걸어 둔 그 위치에만 적용한다. 지정 밖 품목이 들어오는
 * 재고 전기는 재고 코어가 막는다.
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
    if (ids.length > 0) {
      const outside = await this.prisma.inventory_balance.findFirst({
        where: { location_id: locationId, NOT: { on_hand_qty: 0 }, item_id: { notIn: ids } },
        select: { inventory_balance_id: true },
      });
      if (outside !== null) throw locked('itemIds', '지정 밖 품목의 재고가 있어 걸 수 없습니다 — 재고를 먼저 옮깁니다.');
    }
    await this.prisma.$transaction([
      this.prisma.location_item.deleteMany({ where: { location_id: locationId } }),
      this.prisma.location_item.createMany({
        data: ids.map((itemId) => ({ location_id: locationId, item_id: itemId, created_by: appUserId ?? null })),
      }),
    ]);
    return this.read(locationId);
  }

  private async findLocation(locationId: number): Promise<{ system_role_code: string | null }> {
    const location = await this.prisma.location.findUnique({
      where: { location_id: locationId },
      select: { system_role_code: true },
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

const locked = (path: string | null, message: string): ContractException =>
  new ContractException(HttpStatus.BAD_REQUEST, [
    path === null
      ? { scope: 'screen', code: ERROR_CODE.STATE_LOCKED, message }
      : { scope: 'field', field: path, code: ERROR_CODE.STATE_LOCKED, message },
  ]);
