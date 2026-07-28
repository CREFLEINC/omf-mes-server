import { BadRequestException, Injectable } from '@nestjs/common';
import {
  business_unit,
  item,
  operation_policy,
  plant,
  Prisma,
  process as processModel,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { createStamp, exactlyOne, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  CreateOperationPolicyDto,
  OperationPolicyQueryDto,
  UpdateOperationPolicyDto,
} from './operation-policy.dto';

/** 정책행이 가리키는 스코프 — 지정하지 않은 축은 null(=전역)이다. */
interface PolicyScope {
  businessUnitId: bigint | null;
  plantId: bigint | null;
  itemId: bigint | null;
  processId: bigint | null;
}

@Injectable()
export class OperationPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateOperationPolicyDto, actor?: bigint): Promise<operation_policy> {
    await this.codes.assertValid('OPERATION_POLICY', dto.policyCode);
    this.assertHasValue(dto);
    this.assertDateOrder(dto.effectiveFrom, dto.effectiveTo);

    const scope = await this.resolveScope(dto);

    // DB의 유니크 인덱스는 COALESCE(...,0)을 써서 Prisma 모델로 표현되지 않는다 —
    // 앱에서 먼저 확인하고, 경합으로 빠져나간 건은 DB가 막아 P2002 → 409가 된다.
    orConflict(
      await this.prisma.operation_policy.findFirst({
        where: {
          policy_code: dto.policyCode,
          business_unit_id: scope.businessUnitId,
          plant_id: scope.plantId,
          item_id: scope.itemId,
          process_id: scope.processId,
          effective_from: dto.effectiveFrom,
        },
      }),
      `같은 스코프·시작일의 정책이 이미 있습니다: ${dto.policyCode}`,
    );

    return this.prisma.operation_policy.create({
      data: {
        policy_code: dto.policyCode,
        business_unit_id: scope.businessUnitId,
        plant_id: scope.plantId,
        item_id: scope.itemId,
        process_id: scope.processId,
        value_text: dto.valueText ?? null,
        value_numeric: dto.valueNumeric ?? null,
        value_boolean: dto.valueBoolean ?? null,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: OperationPolicyQueryDto): Promise<PageDto<operation_policy>> {
    const where: Prisma.operation_policyWhereInput = {};
    if (query.policyCode) where.policy_code = query.policyCode;
    if (query.plantCode) where.plant = { plant_code: query.plantCode };
    if (query.keyword) where.policy_code = { contains: query.keyword, mode: 'insensitive' };
    if (query.effectiveOn) {
      where.effective_from = { lte: query.effectiveOn };
      where.OR = [{ effective_to: null }, { effective_to: { gte: query.effectiveOn } }];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.operation_policy.findMany({
        where,
        include: {
          business_unit: { select: { business_unit_code: true } },
          plant: { select: { plant_code: true } },
          item: { select: { item_code: true } },
          process: { select: { process_code: true } },
        },
        orderBy: [{ policy_code: 'asc' }, { effective_from: 'desc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.operation_policy.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(policyId: bigint) {
    const found = await this.prisma.operation_policy.findUnique({
      where: { operation_policy_id: policyId },
      include: {
        business_unit: { select: { business_unit_code: true } },
        plant: { select: { plant_code: true } },
        item: { select: { item_code: true } },
        process: { select: { process_code: true } },
      },
    });
    return orFail(found, `운영정책(${policyId})`);
  }

  async update(
    policyId: bigint,
    dto: UpdateOperationPolicyDto,
    actor?: bigint,
  ): Promise<operation_policy> {
    const found = await this.getPolicy(policyId);
    this.assertDateOrder(
      found.effective_from,
      dto.effectiveTo === undefined ? found.effective_to : dto.effectiveTo,
    );

    // 값 3종을 모두 지우면 DDL의 ck_operation_policy_value에 걸린다 — 먼저 막는다.
    const merged = {
      valueText: dto.valueText ?? found.value_text,
      valueNumeric: dto.valueNumeric ?? found.value_numeric,
      valueBoolean: dto.valueBoolean ?? found.value_boolean,
    };
    this.assertHasValue(merged);

    return this.prisma.operation_policy.update({
      where: { operation_policy_id: found.operation_policy_id },
      data: {
        value_text: dto.valueText,
        value_numeric: dto.valueNumeric,
        value_boolean: dto.valueBoolean,
        effective_to: dto.effectiveTo,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 운영정책에는 is_active가 없다. 되돌아볼 이력이 필요한 값이라 물리 삭제 대신
   * 종료일을 닫는다 — 언제부터 정책이 바뀌었는지가 남는다.
   */
  async expire(policyId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getPolicy(policyId);

    await this.prisma.operation_policy.update({
      where: { operation_policy_id: found.operation_policy_id },
      data: { effective_to: new Date(), ...updateStamp(actor) },
    });
  }

  private assertHasValue(dto: {
    valueText?: string | null;
    valueNumeric?: unknown;
    valueBoolean?: boolean | null;
  }): void {
    const given = [dto.valueText, dto.valueNumeric, dto.valueBoolean].filter(
      (value) => value !== undefined && value !== null,
    );
    if (given.length === 0) {
      throw new BadRequestException(
        '정책값이 없습니다. valueText·valueNumeric·valueBoolean 중 하나 이상을 지정하십시오.',
      );
    }
  }

  private assertDateOrder(from: Date, to?: Date | null): void {
    if (to && to < from) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }
  }

  private async resolveScope(dto: CreateOperationPolicyDto): Promise<PolicyScope> {
    const [businessUnit, plant, item, process] = await Promise.all([
      dto.businessUnitCode ? this.getBusinessUnit(dto.businessUnitCode) : null,
      dto.plantCode ? this.getPlant(dto.plantCode) : null,
      dto.itemCode ? this.getItem(dto.itemCode) : null,
      dto.processCode ? this.getProcess(dto.processCode) : null,
    ]);

    return {
      businessUnitId: businessUnit?.business_unit_id ?? null,
      plantId: plant?.plant_id ?? null,
      itemId: item?.item_id ?? null,
      processId: process?.process_id ?? null,
    };
  }

  private async getPolicy(policyId: bigint): Promise<operation_policy> {
    return orFail(
      await this.prisma.operation_policy.findUnique({
        where: { operation_policy_id: policyId },
      }),
      `운영정책(${policyId})`,
    );
  }

  /** 사업부·공장 코드는 상위 조직 안에서만 유일하다 — 여러 건이면 조용히 고르지 않고 거부한다. */
  private async getBusinessUnit(businessUnitCode: string): Promise<business_unit> {
    const rows = await this.prisma.business_unit.findMany({
      where: { business_unit_code: businessUnitCode },
      take: 2,
    });
    return exactlyOne(rows, '사업부', businessUnitCode);
  }

  private async getPlant(plantCode: string): Promise<plant> {
    const rows = await this.prisma.plant.findMany({ where: { plant_code: plantCode }, take: 2 });
    return exactlyOne(rows, '공장', plantCode);
  }

  private async getItem(itemCode: string): Promise<item> {
    return orFail(
      await this.prisma.item.findUnique({ where: { item_code: itemCode } }),
      `품목(${itemCode})`,
    );
  }

  private async getProcess(processCode: string): Promise<processModel> {
    return orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
  }
}
