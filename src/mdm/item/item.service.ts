import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractBadRequest } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { itemEditability } from './item.editability';
import { toItem } from './item.mapper';
import { ItemQueryDto } from './item.query.dto';
import { UpdateItemDto } from './item.update.dto';
import { ItemValidator } from './item.validator';

type ItemList = {
  items: components['schemas']['Item'][];
  page: components['schemas']['PageMeta'];
};

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 분기는 컨트롤러가 한다. */
type ItemDetail = { body: components['schemas']['ItemDetailResponse']; versionNo: number };
type ItemWritten = { body: components['schemas']['Item']; versionNo: number };

@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: ItemValidator,
  ) {}

  async findAll(query: ItemQueryDto): Promise<ItemList> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where,
        // item_code 가 전역 유일키라 한 칸으로 페이지가 흔들리지 않는다.
        orderBy: { item_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.item.count({ where }),
    ]);

    return { items: rows.map(toItem), page: { page: query.page, size: query.size, total } };
  }

  async findOne(itemId: bigint): Promise<ItemDetail> {
    const row = await this.prisma.item.findUnique({ where: { item_id: itemId } });
    if (!row) throw new NotFoundException(`품목(${itemId})을 찾을 수 없습니다.`);

    // 참조를 세지 않는다 — ERP 수신본이라 원본 4열이 항상 잠긴다.
    return { body: { item: toItem(row), editability: itemEditability() }, versionNo: row.version_no };
  }

  /**
   * MES 확장 속성만 갱신한다. 원본 4열은 DTO 가 받지 않으므로 여기 올 수 없다.
   *
   * 낙관적 잠금은 **조건부 갱신**으로 건다 — WHERE 에 기대 버전을 넣어 행 단위
   * 비교-교환으로 만든다(공유계약 B-1).
   */
  async update(
    itemId: bigint,
    expectedVersion: number,
    dto: UpdateItemDto,
    actorId: bigint,
  ): Promise<ItemWritten> {
    const exists = await this.prisma.item.findUnique({
      where: { item_id: itemId },
      select: { item_id: true },
    });
    if (!exists) throw new NotFoundException(`품목(${itemId})을 찾을 수 없습니다.`);

    const errors = await this.validator.validateUpdate(dto);
    if (errors.length > 0) throw new ContractBadRequest(errors);

    const { count } = await this.prisma.item.updateMany({
      where: { item_id: itemId, version_no: expectedVersion },
      data: {
        lot_control_type_code: dto.lotControlTypeCode,
        serial_control_type_code: dto.serialControlTypeCode,
        // 「유효기한 관리」 토글은 별도 컬럼이 아니라 이 값의 null 여부다(§8-2).
        shelf_life_days: dto.shelfLifeDays ?? null,
        inspection_required: dto.inspectionRequired,
        fifo_policy_code: dto.fifoPolicyCode,
        negative_stock_allowed: dto.negativeStockAllowed,
        storage_condition_code: dto.storageConditionCode ?? null,
        opened_shelf_life_hours: dto.openedShelfLifeHours ?? null,
        is_active: dto.isActive,
        updated_by: actorId,
        updated_at: new Date(),
        version_no: { increment: 1 },
      },
    });

    if (count === 0) {
      // erpSync·workerLease 는 판정할 근거가 스키마에 없다.
      throw new ConflictException({
        conflictCause: 'user',
        message: '다른 사용자가 먼저 수정했습니다. 새로고침 후 다시 시도하십시오.',
      });
    }

    const row = await this.prisma.item.findUniqueOrThrow({ where: { item_id: itemId } });

    return { body: toItem(row), versionNo: row.version_no };
  }

  private buildWhere(query: ItemQueryDto): Prisma.itemWhereInput {
    const F = Prisma.ItemScalarFieldEnum;
    const where: Prisma.itemWhereInput = {};

    if (!query.includeInactive) where.is_active = true;
    if (query.itemTypeCode) where.item_type_code = query.itemTypeCode;
    if (query.q) {
      where.OR = [F.item_code, F.item_name].map((column) => ({
        [column]: { contains: query.q, mode: 'insensitive' as const },
      }));
    }
    // 안 보내면 안 거른다 — 「없는 것만」과 뜻이 다르므로 undefined 를 false 로 접으면 안 된다.
    if (query.hasRouting !== undefined) {
      where.routing = query.hasRouting ? { some: {} } : { none: {} };
    }

    return where;
  }
}
