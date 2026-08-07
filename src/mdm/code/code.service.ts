import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { components } from '../../contracts/mdm';
import { PrismaService } from '../../prisma/prisma.service';
import { codeEditability } from './code.editability';
import { toCodeGroup, toCodeValue } from './code.mapper';
import { CodeGroupQueryDto, CodeValueQueryDto } from './code.query.dto';

/** `versionNo` 는 본문이 아니라 ETag 헤더로 나간다(공유계약 A-4). 분기는 컨트롤러가 한다. */
type Detail<T> = { body: T; versionNo: number };

@Injectable()
export class CodeService {
  constructor(private readonly prisma: PrismaService) {}

  async findGroups(query: CodeGroupQueryDto): Promise<{
    items: components['schemas']['CodeGroup'][];
    page: components['schemas']['PageMeta'];
  }> {
    const where: Prisma.code_groupWhereInput = {};
    if (!query.includeInactive) where.is_active = true;
    if (query.q) {
      where.OR = [
        { group_code: { contains: query.q, mode: 'insensitive' } },
        { group_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.code_group.findMany({
        where,
        // 계약에 정렬이 없다. group_code 가 유일키라 페이지가 흔들리지 않는다.
        orderBy: { group_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.code_group.count({ where }),
    ]);

    return {
      items: rows.map(toCodeGroup),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findGroup(
    codeGroupId: bigint,
  ): Promise<Detail<components['schemas']['CodeGroupDetailResponse']>> {
    const row = await this.prisma.code_group.findUnique({
      where: { code_group_id: codeGroupId },
    });
    if (!row) throw new NotFoundException(`코드그룹(${codeGroupId})을 찾을 수 없습니다.`);

    return {
      body: { codeGroup: toCodeGroup(row), editability: codeEditability() },
      versionNo: row.version_no,
    };
  }

  async findValues(query: CodeValueQueryDto): Promise<{
    items: components['schemas']['CodeValue'][];
    page: components['schemas']['PageMeta'];
  }> {
    const where: Prisma.code_valueWhereInput = { code_group_id: BigInt(query.codeGroupId) };
    if (!query.includeInactive) where.is_active = true;
    if (query.q) {
      where.OR = [
        { code: { contains: query.q, mode: 'insensitive' } },
        { code_name: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.code_value.findMany({
        where,
        // display_order 가 화면에 보이는 차례다. 유일하지 않으므로 code 로 동점을 깬다 —
        // 안 그러면 순서가 같은 값들이 페이지를 넘길 때 흔들린다.
        orderBy: [{ display_order: 'asc' }, { code: 'asc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.code_value.count({ where }),
    ]);

    return {
      items: rows.map(toCodeValue),
      page: { page: query.page, size: query.size, total },
    };
  }

  async findValue(
    codeValueId: bigint,
  ): Promise<Detail<components['schemas']['CodeValueDetailResponse']>> {
    const row = await this.prisma.code_value.findUnique({
      where: { code_value_id: codeValueId },
    });
    if (!row) throw new NotFoundException(`코드값(${codeValueId})을 찾을 수 없습니다.`);

    return {
      body: { codeValue: toCodeValue(row), editability: codeEditability() },
      versionNo: row.version_no,
    };
  }
}
