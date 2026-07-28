import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, uom } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { CreateUomDto, UpdateUomDto } from './uom.dto';

@Injectable()
export class UomService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUomDto, actor?: bigint): Promise<uom> {
    orConflict(
      await this.prisma.uom.findUnique({ where: { uom_code: dto.uomCode } }),
      `이미 존재하는 단위입니다: ${dto.uomCode}`,
    );

    return this.prisma.uom.create({
      data: {
        uom_code: dto.uomCode,
        uom_name: dto.uomName,
        decimal_scale: dto.decimalScale ?? 0,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: PageQueryDto): Promise<PageDto<uom>> {
    const where = baseWhere(query, ['uom_code', 'uom_name']) as Prisma.uomWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.uom.findMany({ where, orderBy: { uom_code: 'asc' }, skip: query.skip, take: query.size }),
      this.prisma.uom.count({ where }),
    ]);

    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(uomCode: string): Promise<uom> {
    return orFail(
      await this.prisma.uom.findUnique({ where: { uom_code: uomCode } }),
      `단위(${uomCode})`,
    );
  }

  async update(uomCode: string, dto: UpdateUomDto, actor?: bigint): Promise<uom> {
    const found = await this.findOne(uomCode);

    return this.prisma.uom.update({
      where: { uom_id: found.uom_id },
      data: {
        uom_name: dto.uomName,
        decimal_scale: dto.decimalScale,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /** 재고·품목이 FK로 참조하므로 물리 삭제하지 않는다. */
  async deactivate(uomCode: string, actor?: bigint): Promise<void> {
    const found = await this.findOne(uomCode);

    const [itemCount, locationCount] = await this.prisma.$transaction([
      this.prisma.item.count({ where: { base_uom_id: found.uom_id, is_active: true } }),
      this.prisma.location.count({ where: { capacity_uom_id: found.uom_id, is_active: true } }),
    ]);
    const refs = itemCount + locationCount;
    if (refs > 0) {
      throw new ConflictException(
        `사용중인 참조 ${refs}건(품목 ${itemCount}·로케이션 ${locationCount})이 있어 비활성화할 수 없습니다: ${uomCode}`,
      );
    }

    await this.prisma.uom.update({
      where: { uom_id: found.uom_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }
}
