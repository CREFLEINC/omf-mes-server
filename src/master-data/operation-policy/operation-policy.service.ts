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
  EffectivePolicyQueryDto,
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

/** 정책값을 물을 때 넘기는 상황. 모르는 축은 생략한다. */
export interface PolicyContext {
  businessUnitId?: bigint;
  plantId?: bigint;
  itemId?: bigint;
  processId?: bigint;
  /** 기준 시각 — 생략 시 지금. 유효기간이 지난 정책은 후보에서 빠진다. */
  on?: Date;
}

/**
 * 스코프 구체성 가중치. 좁은 축일수록 크다.
 *
 * 2의 거듭제곱이라 축 조합마다 합이 유일하다 — 「지정한 축이 많을수록, 좁은 축일수록
 * 이긴다」가 한 번의 비교로 결정된다. 같은 점수는 같은 축 조합뿐이고, 그건
 * uq_operation_policy상 시작일만 다르므로 늦은 시작일이 이긴다.
 */
const SCOPE_WEIGHT = { process: 8, item: 4, plant: 2, businessUnit: 1 } as const;

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

  /**
   * 주어진 상황에 적용할 정책 1건을 고른다. 없으면 null.
   *
   * 같은 정책코드에 스코프가 겹치는 행이 여럿 있을 수 있다(전역 OFF · 1공장 WARN ·
   * 1공장+사출 BLOCK). **구체적일수록 이긴다** — 공정 > 품목 > 공장 > 사업부 > 전역.
   *
   * 축이 null인 행은 그 축에 대해 '전역'이라 어떤 값에도 맞는다. 반대로 요청이 축을
   * 주지 않으면(예: 품목을 모르는 상황) 그 축이 지정된 행은 후보에서 뺀다 —
   * 적용 대상인지 확인할 수 없는 정책을 적용하면 안 된다.
   */
  async resolve(policyCode: string, context: PolicyContext = {}): Promise<operation_policy | null> {
    const on = context.on ?? new Date();

    const candidates = await this.prisma.operation_policy.findMany({
      where: {
        policy_code: policyCode,
        effective_from: { lte: on },
        AND: [
          { OR: [{ effective_to: null }, { effective_to: { gte: on } }] },
          this.axisFilter('business_unit_id', context.businessUnitId),
          this.axisFilter('plant_id', context.plantId),
          this.axisFilter('item_id', context.itemId),
          this.axisFilter('process_id', context.processId),
        ],
      },
    });

    return candidates.reduce<operation_policy | null>((best, row) => {
      if (!best) return row;
      const diff = this.specificity(row) - this.specificity(best);
      if (diff !== 0) return diff > 0 ? row : best;
      return row.effective_from > best.effective_from ? row : best;
    }, null);
  }

  /** 코드로 받은 스코프를 내부 ID로 바꿔 resolve한다 — 관리 화면의 「실제 적용값」 확인용. */
  async resolveByCodes(query: EffectivePolicyQueryDto): Promise<operation_policy | null> {
    const [businessUnit, plant, item, process] = await Promise.all([
      query.businessUnitCode ? this.getBusinessUnit(query.businessUnitCode) : null,
      query.plantCode ? this.getPlant(query.plantCode) : null,
      query.itemCode ? this.getItem(query.itemCode) : null,
      query.processCode ? this.getProcess(query.processCode) : null,
    ]);

    return this.resolve(query.policyCode, {
      businessUnitId: businessUnit?.business_unit_id,
      plantId: plant?.plant_id,
      itemId: item?.item_id,
      processId: process?.process_id,
      on: query.on,
    });
  }

  /** 문자값으로 읽는다. 정책이 없으면 fallback. */
  async resolveText(
    policyCode: string,
    fallback: string,
    context: PolicyContext = {},
  ): Promise<string> {
    const found = await this.resolve(policyCode, context);
    return found?.value_text ?? fallback;
  }

  async resolveNumber(
    policyCode: string,
    fallback: number,
    context: PolicyContext = {},
  ): Promise<number> {
    const found = await this.resolve(policyCode, context);
    return found?.value_numeric?.toNumber() ?? fallback;
  }

  async resolveBoolean(
    policyCode: string,
    fallback: boolean,
    context: PolicyContext = {},
  ): Promise<boolean> {
    const found = await this.resolve(policyCode, context);
    return found?.value_boolean ?? fallback;
  }

  /** 요청이 축을 주면 「그 값 또는 전역」, 주지 않으면 「전역만」. */
  private axisFilter(
    column: 'business_unit_id' | 'plant_id' | 'item_id' | 'process_id',
    value?: bigint,
  ): Prisma.operation_policyWhereInput {
    if (value === undefined) return { [column]: null };
    return { OR: [{ [column]: value }, { [column]: null }] };
  }

  private specificity(row: operation_policy): number {
    return (
      (row.process_id === null ? 0 : SCOPE_WEIGHT.process) +
      (row.item_id === null ? 0 : SCOPE_WEIGHT.item) +
      (row.plant_id === null ? 0 : SCOPE_WEIGHT.plant) +
      (row.business_unit_id === null ? 0 : SCOPE_WEIGHT.businessUnit)
    );
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
