import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { defect_code, Prisma, process as processModel } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  CreateDefectCodeDto,
  QualityCodeQueryDto,
  UpdateDefectCodeDto,
} from './quality-code.dto';

/**
 * 불량코드는 2계층 마스터다(03 품질섹션 재정의 — MES-11).
 * 대분류(최상위)와 세부불량(하위) 두 단계만 허용하고, 그 아래는 만들지 않는다.
 */
@Injectable()
export class DefectCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateDefectCodeDto, actor?: bigint): Promise<defect_code> {
    orConflict(
      await this.prisma.defect_code.findUnique({ where: { defect_code: dto.defectCode } }),
      `이미 존재하는 불량코드입니다: ${dto.defectCode}`,
    );

    const [parent, process] = await Promise.all([
      dto.parentDefectCode ? this.getParent(dto.parentDefectCode) : null,
      dto.processCode ? this.getProcess(dto.processCode) : null,
    ]);

    return this.prisma.defect_code.create({
      data: {
        defect_code: dto.defectCode,
        defect_name: dto.defectName,
        parent_defect_code_id: parent?.defect_code_id ?? null,
        process_id: process?.process_id ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: QualityCodeQueryDto): Promise<PageDto<defect_code>> {
    const extra: Prisma.defect_codeWhereInput = {};
    if (query.processCode) extra.process = { process_code: query.processCode };
    if (query.isRootOnly) extra.parent_defect_code_id = null;

    const where = baseWhere(query, [
      'defect_code',
      'defect_name',
    ], extra) as Prisma.defect_codeWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.defect_code.findMany({
        where,
        orderBy: { defect_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.defect_code.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(defectCode: string) {
    const found = await this.prisma.defect_code.findUnique({
      where: { defect_code: defectCode },
      include: {
        parent_defect_code: { select: { defect_code: true, defect_name: true } },
        child_defect_codes: { orderBy: { defect_code: 'asc' } },
        process: { select: { process_code: true, process_name: true } },
      },
    });
    return orFail(found, `불량코드(${defectCode})`);
  }

  async update(
    defectCode: string,
    dto: UpdateDefectCodeDto,
    actor?: bigint,
  ): Promise<defect_code> {
    const found = await this.getDefectCode(defectCode);

    let parentId: bigint | null | undefined;
    if (dto.parentDefectCode !== undefined) {
      const parent = await this.getParent(dto.parentDefectCode);
      if (parent.defect_code_id === found.defect_code_id) {
        throw new BadRequestException('자기 자신을 상위 코드로 지정할 수 없습니다.');
      }
      await this.assertNoChildren(found, '하위 코드가 있어 다른 코드 밑으로 옮길 수 없습니다');
      parentId = parent.defect_code_id;
    }

    const processId = dto.processCode ? (await this.getProcess(dto.processCode)).process_id : undefined;

    return this.prisma.defect_code.update({
      where: { defect_code_id: found.defect_code_id },
      data: {
        defect_name: dto.defectName,
        parent_defect_code_id: parentId,
        process_id: processId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(defectCode: string, actor?: bigint): Promise<void> {
    const found = await this.getDefectCode(defectCode);

    const [children, records] = await this.prisma.$transaction([
      this.prisma.defect_code.count({
        where: { parent_defect_code_id: found.defect_code_id, is_active: true },
      }),
      this.prisma.defect_record.count({ where: { defect_code_id: found.defect_code_id } }),
    ]);

    if (children + records > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${defectCode} ` +
          `(사용중 하위코드 ${children}·불량실적 ${records})`,
      );
    }

    await this.prisma.defect_code.update({
      where: { defect_code_id: found.defect_code_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /** 상위는 반드시 최상위여야 한다 — 손자 코드를 만들면 2계층 약속이 깨진다. */
  private async getParent(parentCode: string): Promise<defect_code> {
    const parent = await this.getDefectCode(parentCode);
    if (parent.parent_defect_code_id !== null) {
      throw new BadRequestException(
        `불량코드는 2계층까지만 허용합니다: ${parentCode}는 이미 하위 코드입니다.`,
      );
    }
    return parent;
  }

  private async assertNoChildren(found: defect_code, message: string): Promise<void> {
    const children = await this.prisma.defect_code.count({
      where: { parent_defect_code_id: found.defect_code_id },
    });
    if (children > 0) {
      throw new BadRequestException(`${message}: ${found.defect_code} (하위 ${children}건)`);
    }
  }

  private async getDefectCode(defectCode: string): Promise<defect_code> {
    return orFail(
      await this.prisma.defect_code.findUnique({ where: { defect_code: defectCode } }),
      `불량코드(${defectCode})`,
    );
  }

  private async getProcess(processCode: string): Promise<processModel> {
    return orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
  }
}
