import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, terminal, terminal_process } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import { WarehouseService } from '../warehouse/warehouse.service';
import {
  CreateTerminalDto,
  TerminalQueryDto,
  UpdateTerminalDto,
  UpsertTerminalProcessDto,
} from './terminal.dto';

@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
    private readonly warehouses: WarehouseService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateTerminalDto, actor?: bigint): Promise<terminal> {
    const plant = await this.org.findPlant(dto.legalEntityCode, dto.plantCode);
    await this.codes.assertAllValid([
      ['TERMINAL_TYPE', dto.terminalTypeCode],
      ['TERMINAL_STATUS', dto.statusCode],
    ]);
    const locationId = await this.resolveLocation(dto.warehouseCode, dto.locationCode);

    orConflict(
      await this.prisma.terminal.findUnique({ where: { terminal_code: dto.terminalCode } }),
      `이미 존재하는 단말입니다: ${dto.terminalCode}`,
    );

    return this.prisma.terminal.create({
      data: {
        terminal_code: dto.terminalCode,
        plant_id: plant.plant_id,
        location_id: locationId,
        terminal_type_code: dto.terminalTypeCode,
        status_code: dto.statusCode,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: TerminalQueryDto): Promise<PageDto<terminal>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };
    if (query.terminalTypeCode) extra.terminal_type_code = query.terminalTypeCode;
    if (query.statusCode) extra.status_code = query.statusCode;

    const where = baseWhere(query, ['terminal_code'], extra) as Prisma.terminalWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.terminal.findMany({
        where,
        orderBy: { terminal_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.terminal.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(terminalCode: string) {
    const found = await this.prisma.terminal.findUnique({
      where: { terminal_code: terminalCode },
      include: { location: true, terminal_process: true },
    });
    return orFail(found, `단말(${terminalCode})`);
  }

  async update(
    terminalCode: string,
    dto: UpdateTerminalDto,
    actor?: bigint,
  ): Promise<terminal> {
    const found = await this.getTerminal(terminalCode);
    await this.codes.assertAllValid([
      ['TERMINAL_TYPE', dto.terminalTypeCode],
      ['TERMINAL_STATUS', dto.statusCode],
    ]);

    const locationId =
      dto.warehouseCode === undefined && dto.locationCode === undefined
        ? undefined
        : await this.resolveLocation(dto.warehouseCode, dto.locationCode);

    return this.prisma.terminal.update({
      where: { terminal_id: found.terminal_id },
      data: {
        terminal_type_code: dto.terminalTypeCode,
        status_code: dto.statusCode,
        location_id: locationId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  async deactivate(terminalCode: string, actor?: bigint): Promise<void> {
    const found = await this.getTerminal(terminalCode);

    await this.prisma.terminal.update({
      where: { terminal_id: found.terminal_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /** 화면의 체크박스 묶음을 그대로 저장하는 형태라 등록/수정을 나누지 않고 덮어쓴다. */
  async upsertProcess(
    terminalCode: string,
    dto: UpsertTerminalProcessDto,
    actor?: bigint,
  ): Promise<terminal_process> {
    const found = await this.getTerminal(terminalCode);
    const process = orFail(
      await this.prisma.process.findUnique({ where: { process_code: dto.processCode } }),
      `공정(${dto.processCode})`,
    );

    const flags = {
      can_input_material: dto.canInputMaterial ?? false,
      can_input_result: dto.canInputResult ?? false,
      can_input_inspection: dto.canInputInspection ?? false,
      can_print_label: dto.canPrintLabel ?? false,
      can_start_work: dto.canStartWork ?? false,
      can_complete_work: dto.canCompleteWork ?? false,
      can_cancel_input: dto.canCancelInput ?? false,
      can_return_material: dto.canReturnMaterial ?? false,
    };

    return this.prisma.terminal_process.upsert({
      where: {
        terminal_id_process_id: {
          terminal_id: found.terminal_id,
          process_id: process.process_id,
        },
      },
      update: flags,
      create: {
        terminal_id: found.terminal_id,
        process_id: process.process_id,
        ...flags,
        created_by: actor,
      },
    });
  }

  async findProcesses(terminalCode: string): Promise<terminal_process[]> {
    const found = await this.getTerminal(terminalCode);
    return this.prisma.terminal_process.findMany({
      where: { terminal_id: found.terminal_id },
      orderBy: { process_id: 'asc' },
    });
  }

  /** 단순 매핑이라 비활성 플래그가 없다. */
  async removeProcess(terminalCode: string, processCode: string): Promise<void> {
    const found = await this.getTerminal(terminalCode);
    const process = orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );

    const row = orFail(
      await this.prisma.terminal_process.findUnique({
        where: {
          terminal_id_process_id: {
            terminal_id: found.terminal_id,
            process_id: process.process_id,
          },
        },
      }),
      `단말-공정 매핑(${terminalCode}.${processCode})`,
    );

    await this.prisma.terminal_process.delete({
      where: { terminal_process_id: row.terminal_process_id },
    });
  }

  /** 로케이션 코드가 창고 범위 유니크라 창고 없이는 특정되지 않는다. */
  private async resolveLocation(
    warehouseCode?: string,
    locationCode?: string,
  ): Promise<bigint | null> {
    if (!warehouseCode && !locationCode) return null;
    if (!warehouseCode || !locationCode) {
      throw new BadRequestException(
        '설치 위치는 창고(warehouseCode)와 로케이션(locationCode)을 함께 지정해야 합니다.',
      );
    }

    const location = await this.warehouses.findLocation(warehouseCode, locationCode);
    return location.location_id;
  }

  private async getTerminal(terminalCode: string): Promise<terminal> {
    return orFail(
      await this.prisma.terminal.findUnique({ where: { terminal_code: terminalCode } }),
      `단말(${terminalCode})`,
    );
  }
}
