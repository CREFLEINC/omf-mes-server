import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { cause_code, Prisma, process as processModel } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { CreateCauseCodeDto, QualityCodeQueryDto, UpdateCauseCodeDto } from './quality-code.dto';

/**
 * 원인코드도 불량코드와 같은 2계층 마스터다.
 * 불량실적은 추정원인·확정원인 두 자리에서 이 코드를 가리킨다 — 참조 검사도 두 자리를 함께 본다.
 */
@Injectable()
export class CauseCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCauseCodeDto, actor?: bigint): Promise<cause_code> {
    orConflict(
      await this.prisma.cause_code.findUnique({ where: { cause_code: dto.causeCode } }),
      `이미 존재하는 원인코드입니다: ${dto.causeCode}`,
    );

    const [parent, process] = await Promise.all([
      dto.parentCauseCode ? this.getParent(dto.parentCauseCode) : null,
      dto.processCode ? this.getProcess(dto.processCode) : null,
    ]);

    return this.prisma.cause_code.create({
      data: {
        cause_code: dto.causeCode,
        cause_name: dto.causeName,
        parent_cause_code_id: parent?.cause_code_id ?? null,
        process_id: process?.process_id ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: QualityCodeQueryDto): Promise<PageDto<cause_code>> {
    const extra: Prisma.cause_codeWhereInput = {};
    if (query.processCode) extra.process = { process_code: query.processCode };
    if (query.isRootOnly) extra.parent_cause_code_id = null;

    const where = baseWhere(query, [
      'cause_code',
      'cause_name',
    ], extra) as Prisma.cause_codeWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.cause_code.findMany({
        where,
        orderBy: { cause_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.cause_code.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(causeCode: string) {
    const found = await this.prisma.cause_code.findUnique({
      where: { cause_code: causeCode },
      include: {
        parent_cause_code: { select: { cause_code: true, cause_name: true } },
        child_cause_codes: { orderBy: { cause_code: 'asc' } },
        process: { select: { process_code: true, process_name: true } },
      },
    });
    return orFail(found, `원인코드(${causeCode})`);
  }

  async update(causeCode: string, dto: UpdateCauseCodeDto, actor?: bigint): Promise<cause_code> {
    const found = await this.getCauseCode(causeCode);

    let parentId: bigint | null | undefined;
    if (dto.parentCauseCode !== undefined) {
      const parent = await this.getParent(dto.parentCauseCode);
      if (parent.cause_code_id === found.cause_code_id) {
        throw new BadRequestException('자기 자신을 상위 코드로 지정할 수 없습니다.');
      }
      await this.assertNoChildren(found, '하위 코드가 있어 다른 코드 밑으로 옮길 수 없습니다');
      parentId = parent.cause_code_id;
    }

    const processId = dto.processCode ? (await this.getProcess(dto.processCode)).process_id : undefined;

    return this.prisma.cause_code.update({
      where: { cause_code_id: found.cause_code_id },
      data: {
        cause_name: dto.causeName,
        parent_cause_code_id: parentId,
        process_id: processId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(causeCode: string, actor?: bigint): Promise<void> {
    const found = await this.getCauseCode(causeCode);

    const [children, suspected, confirmed] = await this.prisma.$transaction([
      this.prisma.cause_code.count({
        where: { parent_cause_code_id: found.cause_code_id, is_active: true },
      }),
      this.prisma.defect_record.count({ where: { suspected_cause_code_id: found.cause_code_id } }),
      this.prisma.defect_record.count({ where: { confirmed_cause_code_id: found.cause_code_id } }),
    ]);

    if (children + suspected + confirmed > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${causeCode} ` +
          `(사용중 하위코드 ${children}·추정원인 ${suspected}·확정원인 ${confirmed})`,
      );
    }

    await this.prisma.cause_code.update({
      where: { cause_code_id: found.cause_code_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /** 상위는 반드시 최상위여야 한다 — 손자 코드를 만들면 2계층 약속이 깨진다. */
  private async getParent(parentCode: string): Promise<cause_code> {
    const parent = await this.getCauseCode(parentCode);
    if (parent.parent_cause_code_id !== null) {
      throw new BadRequestException(
        `원인코드는 2계층까지만 허용합니다: ${parentCode}는 이미 하위 코드입니다.`,
      );
    }
    return parent;
  }

  private async assertNoChildren(found: cause_code, message: string): Promise<void> {
    const children = await this.prisma.cause_code.count({
      where: { parent_cause_code_id: found.cause_code_id },
    });
    if (children > 0) {
      throw new BadRequestException(`${message}: ${found.cause_code} (하위 ${children}건)`);
    }
  }

  private async getCauseCode(causeCode: string): Promise<cause_code> {
    return orFail(
      await this.prisma.cause_code.findUnique({ where: { cause_code: causeCode } }),
      `원인코드(${causeCode})`,
    );
  }

  private async getProcess(processCode: string): Promise<processModel> {
    return orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
  }
}
