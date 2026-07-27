import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CodeValue, DataSource, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertDeletable,
  assertErpOriginFieldsUntouched,
  CODE_VALUE_MES_FIELDS,
} from '../erp-linked.policy';
import { CreateCodeValueDto, UpdateCodeValueDto } from './dto/code-value.dto';

@Injectable()
export class CodeValueService {
  constructor(private readonly prisma: PrismaService) {}

  async create(groupCode: string, dto: CreateCodeValueDto, actor?: string): Promise<CodeValue> {
    await this.assertGroupExists(groupCode);

    const existing = await this.prisma.codeValue.findUnique({
      where: { uq_code_value: { groupCode, code: dto.code } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException(`이미 존재하는 코드값입니다: ${groupCode}.${dto.code}`);
    }

    // 신규 등록 필드 — 미지정 값은 기본값으로 채운다.
    const data = {
      nameKo: dto.nameKo,
      nameVi: dto.nameVi ?? null,
      description: dto.description ?? null,
      attr1: dto.attr1 ?? null,
      attr2: dto.attr2 ?? null,
      sortOrder: dto.sortOrder ?? 0,
      useYn: dto.useYn ?? true,
      source: dto.source ?? DataSource.MES,
    };

    // 소프트 삭제분은 되살려 재사용한다 — (코드그룹+코드값)이 유니크라 신규 행 생성이 불가능하다.
    // 이때도 '신규 등록'이므로 미지정 필드는 삭제 전 값을 물려받지 않고 기본값으로 되돌린다.
    if (existing) {
      return this.prisma.codeValue.update({
        where: { id: existing.id },
        data: { ...data, deletedAt: null, createdBy: actor, updatedBy: actor },
      });
    }

    return this.prisma.codeValue.create({
      data: { groupCode, code: dto.code, ...data, createdBy: actor, updatedBy: actor },
    });
  }

  async findAll(groupCode: string, query: PageQueryDto): Promise<PageDto<CodeValue>> {
    await this.assertGroupExists(groupCode);
    const where = this.buildWhere(groupCode, query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.codeValue.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.codeValue.count({ where }),
    ]);

    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(groupCode: string, code: string): Promise<CodeValue> {
    const value = await this.prisma.codeValue.findFirst({
      where: { groupCode, code, deletedAt: null },
    });
    if (!value) throw new NotFoundException(`코드값을 찾을 수 없습니다: ${groupCode}.${code}`);
    return value;
  }

  async update(
    groupCode: string,
    code: string,
    dto: UpdateCodeValueDto,
    actor?: string,
  ): Promise<CodeValue> {
    const value = await this.findOne(groupCode, code);
    // ERP 연계분은 원본 필드만 잠근다 — 다국어 명칭 등 MES 확장 속성은 편집 가능하다.
    assertErpOriginFieldsUntouched(
      value.source,
      { ...dto },
      CODE_VALUE_MES_FIELDS,
      `${groupCode}.${code}`,
    );

    return this.prisma.codeValue.update({
      where: { id: value.id },
      data: { ...this.toWriteData(dto), updatedBy: actor },
    });
  }

  async remove(groupCode: string, code: string, actor?: string): Promise<void> {
    const value = await this.findOne(groupCode, code);
    assertDeletable(value.source, `${groupCode}.${code}`);

    await this.prisma.codeValue.update({
      where: { id: value.id },
      data: { deletedAt: new Date(), updatedBy: actor },
    });
  }

  private async assertGroupExists(groupCode: string): Promise<void> {
    const group = await this.prisma.codeGroup.findFirst({
      where: { code: groupCode, deletedAt: null },
      select: { code: true },
    });
    if (!group) throw new NotFoundException(`코드그룹을 찾을 수 없습니다: ${groupCode}`);
  }

  private buildWhere(groupCode: string, query: PageQueryDto): Prisma.CodeValueWhereInput {
    const where: Prisma.CodeValueWhereInput = { groupCode };
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
  private toWriteData(dto: UpdateCodeValueDto) {
    return {
      nameKo: dto.nameKo,
      nameVi: dto.nameVi,
      description: dto.description,
      attr1: dto.attr1,
      attr2: dto.attr2,
      sortOrder: dto.sortOrder,
      useYn: dto.useYn,
    };
  }
}
