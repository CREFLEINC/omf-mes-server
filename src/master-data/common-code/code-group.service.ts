import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CodeGroup, DataSource, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCodeGroupDto, UpdateCodeGroupDto } from './dto/code-group.dto';

@Injectable()
export class CodeGroupService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCodeGroupDto, actor?: string): Promise<CodeGroup> {
    const existing = await this.prisma.codeGroup.findUnique({ where: { code: dto.code } });
    if (existing && !existing.deletedAt) {
      throw new ConflictException(`이미 존재하는 코드그룹입니다: ${dto.code}`);
    }

    // 신규 등록 필드 — 미지정 값은 기본값으로 채운다.
    const data = {
      nameKo: dto.nameKo,
      nameVi: dto.nameVi ?? null,
      description: dto.description ?? null,
      sortOrder: dto.sortOrder ?? 0,
      useYn: dto.useYn ?? true,
      source: dto.source ?? DataSource.MES,
    };

    // 소프트 삭제된 코드는 되살려 재사용한다 — 자연키라 신규 행 생성이 불가능하다.
    // 이때도 '신규 등록'이므로 미지정 필드는 삭제 전 값을 물려받지 않고 기본값으로 되돌린다.
    if (existing) {
      return this.prisma.codeGroup.update({
        where: { code: dto.code },
        data: { ...data, deletedAt: null, createdBy: actor, updatedBy: actor },
      });
    }

    return this.prisma.codeGroup.create({
      data: { code: dto.code, ...data, createdBy: actor, updatedBy: actor },
    });
  }

  async findAll(query: PageQueryDto): Promise<PageDto<CodeGroup>> {
    const where = this.buildWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeGroup.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.codeGroup.count({ where }),
    ]);

    return new PageDto(items, total, query.page, query.size);
  }

  /** 단건 조회 — 하위 코드값(사용중)을 함께 반환한다 */
  async findOne(code: string): Promise<CodeGroup & { values: unknown[] }> {
    const group = await this.prisma.codeGroup.findFirst({
      where: { code, deletedAt: null },
      include: {
        values: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        },
      },
    });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${code}`);
    return group;
  }

  async update(code: string, dto: UpdateCodeGroupDto, actor?: string): Promise<CodeGroup> {
    const group = await this.getEditable(code);

    return this.prisma.codeGroup.update({
      where: { code: group.code },
      data: { ...this.toWriteData(dto), updatedBy: actor },
    });
  }

  /** 소프트 삭제 — 사용중인 하위 코드값이 남아 있으면 거부한다 */
  async remove(code: string, actor?: string): Promise<void> {
    const group = await this.getEditable(code);

    const activeValues = await this.prisma.codeValue.count({
      where: { groupCode: group.code, deletedAt: null },
    });
    if (activeValues > 0) {
      throw new ConflictException(
        `하위 코드값 ${activeValues}건이 남아 있어 삭제할 수 없습니다: ${code}`,
      );
    }

    await this.prisma.codeGroup.update({
      where: { code: group.code },
      data: { deletedAt: new Date(), updatedBy: actor },
    });
  }

  /**
   * 수정·삭제 대상을 조회하고 편집 가능 여부를 검증한다.
   * ERP 연계 수신본은 MES에서 수정·삭제할 수 없다
   * (개념모델 v2 §1 — 연계분 기준정보 MES 수정/삭제 불가, QA #34).
   */
  private async getEditable(code: string): Promise<CodeGroup> {
    const group = await this.prisma.codeGroup.findFirst({ where: { code, deletedAt: null } });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${code}`);
    if (group.source === DataSource.ERP) {
      throw new ConflictException(
        `ERP 연계 수신본은 MES에서 수정·삭제할 수 없습니다: ${code}`,
      );
    }
    return group;
  }

  private buildWhere(query: PageQueryDto): Prisma.CodeGroupWhereInput {
    const where: Prisma.CodeGroupWhereInput = {};
    if (!query.includeDeleted) where.deletedAt = null;
    if (query.useYn !== undefined) where.useYn = query.useYn;
    if (query.keyword) {
      where.OR = [
        { code: { contains: query.keyword, mode: 'insensitive' } },
        { nameKo: { contains: query.keyword, mode: 'insensitive' } },
        { nameVi: { contains: query.keyword, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** 수정 가능 필드만 추린다 — undefined인 필드는 Prisma가 무변경으로 처리한다 */
  private toWriteData(dto: UpdateCodeGroupDto) {
    return {
      nameKo: dto.nameKo,
      nameVi: dto.nameVi,
      description: dto.description,
      sortOrder: dto.sortOrder,
      useYn: dto.useYn,
    };
  }
}
