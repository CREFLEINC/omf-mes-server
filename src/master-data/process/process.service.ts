import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, process as processModel } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { CreateProcessDto, ProcessQueryDto, UpdateProcessDto } from './process.dto';

/** 표준 공정 마스터 — mdm.process */
@Injectable()
export class ProcessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateProcessDto, actor?: bigint): Promise<processModel> {
    await this.codes.assertValid('PROCESS_TYPE', dto.processTypeCode);

    orConflict(
      await this.prisma.process.findUnique({ where: { process_code: dto.processCode } }),
      `이미 존재하는 공정입니다: ${dto.processCode}`,
    );

    return this.prisma.process.create({
      data: {
        process_code: dto.processCode,
        process_name: dto.processName,
        process_type_code: dto.processTypeCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: ProcessQueryDto): Promise<PageDto<processModel>> {
    const extra = query.processTypeCode ? { process_type_code: query.processTypeCode } : {};
    const where = baseWhere(query, [
      'process_code',
      'process_name',
    ], extra) as Prisma.processWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.process.findMany({
        where,
        orderBy: { process_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.process.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(processCode: string): Promise<processModel> {
    return this.getProcess(processCode);
  }

  async update(
    processCode: string,
    dto: UpdateProcessDto,
    actor?: bigint,
  ): Promise<processModel> {
    const found = await this.getProcess(processCode);
    await this.codes.assertValid('PROCESS_TYPE', dto.processTypeCode);

    return this.prisma.process.update({
      where: { process_id: found.process_id },
      data: {
        process_name: dto.processName,
        process_type_code: dto.processTypeCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 비활성화.
   *
   * 공정은 라우팅 라인·설비·작업자 자격·단말 매핑이 참조한다.
   * routing_operation·worker_qualification·terminal_process에는 is_active가 없어
   * 존재 자체를 참조로 본다.
   */
  async deactivate(processCode: string, actor?: bigint): Promise<void> {
    const found = await this.getProcess(processCode);

    const [routingOps, equipments, qualifications, terminals] = await this.prisma.$transaction([
      this.prisma.routing_operation.count({ where: { process_id: found.process_id } }),
      this.prisma.equipment.count({ where: { process_id: found.process_id, is_active: true } }),
      this.prisma.worker_qualification.count({ where: { process_id: found.process_id } }),
      this.prisma.terminal_process.count({ where: { process_id: found.process_id } }),
    ]);

    const total = routingOps + equipments + qualifications + terminals;
    if (total > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${processCode} ` +
          `(라우팅 ${routingOps}·설비 ${equipments}·작업자자격 ${qualifications}·단말 ${terminals})`,
      );
    }

    await this.prisma.process.update({
      where: { process_id: found.process_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  private async getProcess(processCode: string): Promise<processModel> {
    return orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
  }
}
