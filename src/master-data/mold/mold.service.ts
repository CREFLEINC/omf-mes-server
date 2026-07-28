import { Injectable } from '@nestjs/common';
import { mold, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  updateStamp,
} from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import { CreateMoldDto, MoldQueryDto, UpdateMoldDto } from './mold.dto';

@Injectable()
export class MoldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateMoldDto, actor?: bigint): Promise<mold> {
    const plant = await this.org.findPlant(dto.legalEntityCode, dto.plantCode);
    await this.codes.assertValid('MOLD_STATUS', dto.statusCode);

    orConflict(
      await this.prisma.mold.findUnique({
        where: { plant_id_mold_code: { plant_id: plant.plant_id, mold_code: dto.moldCode } },
      }),
      `이미 존재하는 금형입니다: ${dto.plantCode}.${dto.moldCode}`,
    );

    return this.prisma.mold.create({
      data: {
        plant_id: plant.plant_id,
        mold_code: dto.moldCode,
        mold_name: dto.moldName,
        cavity_count: dto.cavityCount ?? 1,
        guaranteed_shot_count: dto.guaranteedShotCount ?? null,
        current_shot_count: dto.currentShotCount ?? 0,
        status_code: dto.statusCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: MoldQueryDto): Promise<PageDto<mold>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };
    if (query.statusCode) extra.status_code = query.statusCode;
    if (query.shotCountGte !== undefined) {
      extra.current_shot_count = { gte: query.shotCountGte };
    }

    const where = baseWhere(query, ['mold_code', 'mold_name'], extra) as Prisma.moldWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.mold.findMany({
        where,
        orderBy: { mold_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.mold.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(moldCode: string): Promise<mold> {
    return this.getMold(moldCode);
  }

  async update(moldCode: string, dto: UpdateMoldDto, actor?: bigint): Promise<mold> {
    const found = await this.getMold(moldCode);
    await this.codes.assertValid('MOLD_STATUS', dto.statusCode);

    return this.prisma.mold.update({
      where: { mold_id: found.mold_id },
      data: {
        mold_name: dto.moldName,
        cavity_count: dto.cavityCount,
        guaranteed_shot_count: dto.guaranteedShotCount,
        current_shot_count: dto.currentShotCount,
        status_code: dto.statusCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 참조처가 전부 트랜잭션(작업지시·작업세션·생산실적·불량기록)이라 검사하지 않는다.
   * '미결 작업지시가 쓰는 금형은 막는다'는 작업지시 상태 의미가 정해진 뒤라야 옳다.
   */
  async deactivate(moldCode: string, actor?: bigint): Promise<void> {
    const found = await this.getMold(moldCode);

    await this.prisma.mold.update({
      where: { mold_id: found.mold_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  private async getMold(moldCode: string): Promise<mold> {
    const rows = await this.prisma.mold.findMany({ where: { mold_code: moldCode }, take: 2 });
    return exactlyOne(rows, '금형', moldCode);
  }
}
