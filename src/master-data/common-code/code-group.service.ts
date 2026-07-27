import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { code_group, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCodeGroupDto, UpdateCodeGroupDto } from './dto/code-group.dto';

@Injectable()
export class CodeGroupService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCodeGroupDto, actor?: bigint): Promise<code_group> {
    const existing = await this.prisma.code_group.findUnique({
      where: { group_code: dto.groupCode },
    });
    if (existing) {
      throw new ConflictException(`이미 존재하는 코드그룹입니다: ${dto.groupCode}`);
    }

    return this.prisma.code_group.create({
      data: {
        group_code: dto.groupCode,
        group_name: dto.groupName,
        description: dto.description ?? null,
        is_active: dto.isActive ?? true,
        created_by: actor,
        updated_by: actor,
      },
    });
  }

  async findAll(query: PageQueryDto): Promise<PageDto<code_group>> {
    const where = this.buildWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.code_group.findMany({
        where,
        orderBy: [{ group_code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.code_group.count({ where }),
    ]);

    return new PageDto(items, total, query.page, query.size);
  }

  /** 단건 조회 — 하위 코드값을 정렬순서대로 함께 반환한다 */
  async findOne(groupCode: string) {
    const group = await this.prisma.code_group.findUnique({
      where: { group_code: groupCode },
      include: {
        code_value: { orderBy: [{ display_order: 'asc' }, { code: 'asc' }] },
      },
    });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${groupCode}`);
    return group;
  }

  async update(
    groupCode: string,
    dto: UpdateCodeGroupDto,
    actor?: bigint,
  ): Promise<code_group> {
    const group = await this.getOrFail(groupCode);

    return this.prisma.code_group.update({
      where: { code_group_id: group.code_group_id },
      data: {
        group_name: dto.groupName,
        description: dto.description,
        is_active: dto.isActive,
        updated_by: actor,
        // 낙관적 락 컬럼 — 지금은 증가만 시킨다. 클라이언트가 기대 버전을 보내는
        // 완전한 낙관적 락은 후속 과제(README '남은 과제').
        version_no: { increment: 1 },
      },
    });
  }

  /**
   * 비활성화(is_active=false).
   * 정본 물리 모델에는 소프트 삭제 컬럼이 없고 `is_active`가 수명주기 플래그다.
   * 마스터는 타 테이블이 FK로 참조하므로 물리 삭제하지 않는다.
   */
  async deactivate(groupCode: string, actor?: bigint): Promise<void> {
    const group = await this.getOrFail(groupCode);

    const activeValues = await this.prisma.code_value.count({
      where: { code_group_id: group.code_group_id, is_active: true },
    });
    if (activeValues > 0) {
      throw new ConflictException(
        `사용중인 하위 코드값 ${activeValues}건이 남아 있어 비활성화할 수 없습니다: ${groupCode}`,
      );
    }

    await this.prisma.code_group.update({
      where: { code_group_id: group.code_group_id },
      data: { is_active: false, updated_by: actor, version_no: { increment: 1 } },
    });
  }

  private async getOrFail(groupCode: string): Promise<code_group> {
    const group = await this.prisma.code_group.findUnique({ where: { group_code: groupCode } });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${groupCode}`);
    return group;
  }

  private buildWhere(query: PageQueryDto): Prisma.code_groupWhereInput {
    const where: Prisma.code_groupWhereInput = {};
    if (query.isActive !== undefined) where.is_active = query.isActive;
    if (query.keyword) {
      where.OR = [
        { group_code: { contains: query.keyword, mode: 'insensitive' } },
        { group_name: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    return where;
  }
}
