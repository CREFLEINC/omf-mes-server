import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { code_value, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCodeValueDto, UpdateCodeValueDto } from './dto/code-value.dto';

@Injectable()
export class CodeValueService {
  constructor(private readonly prisma: PrismaService) {}

  async create(groupCode: string, dto: CreateCodeValueDto, actor?: bigint): Promise<code_value> {
    const group = await this.getGroupOrFail(groupCode);
    this.assertEffectiveRange(dto.effectiveFrom, dto.effectiveTo);

    const existing = await this.prisma.code_value.findUnique({
      where: { code_group_id_code: { code_group_id: group.code_group_id, code: dto.code } },
    });
    if (existing) {
      throw new ConflictException(`이미 존재하는 코드값입니다: ${groupCode}.${dto.code}`);
    }

    return this.prisma.code_value.create({
      data: {
        code_group_id: group.code_group_id,
        code: dto.code,
        code_name: dto.codeName,
        display_order: dto.displayOrder ?? 0,
        effective_from: dto.effectiveFrom ?? null,
        effective_to: dto.effectiveTo ?? null,
        is_active: dto.isActive ?? true,
        created_by: actor,
        updated_by: actor,
      },
    });
  }

  async findAll(groupCode: string, query: PageQueryDto): Promise<PageDto<code_value>> {
    const group = await this.getGroupOrFail(groupCode);
    const where = this.buildWhere(group.code_group_id, query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.code_value.findMany({
        where,
        orderBy: [{ display_order: 'asc' }, { code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.code_value.count({ where }),
    ]);

    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(groupCode: string, code: string): Promise<code_value> {
    const group = await this.getGroupOrFail(groupCode);

    const value = await this.prisma.code_value.findUnique({
      where: { code_group_id_code: { code_group_id: group.code_group_id, code } },
    });
    if (!value) throw new NotFoundException(`코드값을 찾을 수 없습니다: ${groupCode}.${code}`);
    return value;
  }

  async update(
    groupCode: string,
    code: string,
    dto: UpdateCodeValueDto,
    actor?: bigint,
  ): Promise<code_value> {
    const value = await this.findOne(groupCode, code);
    // 한쪽만 보내는 경우가 있어 저장될 최종값 기준으로 검사한다.
    this.assertEffectiveRange(
      dto.effectiveFrom ?? value.effective_from ?? undefined,
      dto.effectiveTo ?? value.effective_to ?? undefined,
    );

    return this.prisma.code_value.update({
      where: { code_value_id: value.code_value_id },
      data: {
        code_name: dto.codeName,
        display_order: dto.displayOrder,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo,
        is_active: dto.isActive,
        updated_by: actor,
        version_no: { increment: 1 },
      },
    });
  }

  /** 비활성화 — 정본 모델에 소프트 삭제 컬럼이 없고 is_active가 수명주기 플래그다. */
  async deactivate(groupCode: string, code: string, actor?: bigint): Promise<void> {
    const value = await this.findOne(groupCode, code);

    await this.prisma.code_value.update({
      where: { code_value_id: value.code_value_id },
      data: { is_active: false, updated_by: actor, version_no: { increment: 1 } },
    });
  }

  /** DB의 ck_code_value_dates 제약과 같은 규칙 — 400으로 먼저 걸러 준다. */
  private assertEffectiveRange(from?: Date | null, to?: Date | null): void {
    if (from && to && to < from) {
      throw new ConflictException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }
  }

  private async getGroupOrFail(groupCode: string) {
    const group = await this.prisma.code_group.findUnique({
      where: { group_code: groupCode },
      select: { code_group_id: true },
    });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${groupCode}`);
    return group;
  }

  private buildWhere(codeGroupId: bigint, query: PageQueryDto): Prisma.code_valueWhereInput {
    const where: Prisma.code_valueWhereInput = { code_group_id: codeGroupId };
    if (query.isActive !== undefined) where.is_active = query.isActive;
    if (query.keyword) {
      where.OR = [
        { code: { contains: query.keyword, mode: 'insensitive' } },
        { code_name: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    return where;
  }
}
