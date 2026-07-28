import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  equipment,
  inspection_item_spec,
  inspection_plan,
  inspection_plan_version,
  item,
  Prisma,
  process as processModel,
  routing,
  uom,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  mergeDefined,
  orConflict,
  orFail,
  updateStamp,
} from '../common/master-crud';
import {
  CreateInspectionItemSpecDto,
  CreateInspectionPlanDto,
  CreateInspectionPlanVersionDto,
  InspectionPlanQueryDto,
  InspectionPlanVersionQueryDto,
  UpdateInspectionItemSpecDto,
  UpdateInspectionPlanDto,
  UpdateInspectionPlanVersionDto,
} from './inspection-plan.dto';

/** 검사기준 헤더가 선택적으로 가리키는 참조들 — 코드·ID를 내부 PK로 바꿔 담는다. */
interface InspectionPlanRefs {
  itemId?: bigint;
  processId?: bigint;
  routingId?: bigint;
}

/** 검사항목이 선택적으로 가리키는 참조들. */
interface InspectionItemSpecRefs {
  uomId?: bigint;
  equipmentId?: bigint;
}

/** 교차 필드 검증 입력. 부분 수정에서도 같은 규칙을 돌리려고 기존 행과 DTO를 이 모양으로 합친다. */
interface VersionRuleInput {
  samplingMethodCode?: string;
  samplingQty?: number;
  aqlValue?: number;
  acceptanceNumber?: number;
  rejectionNumber?: number;
  inspectionFrequencyCode?: string;
  frequencyIntervalValue?: number;
  frequencyIntervalUomCode?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
}

interface ItemSpecRuleInput {
  dataTypeCode?: string;
  targetValue?: number;
  lowerLimit?: number;
  upperLimit?: number;
  automaticJudgment?: boolean;
}

@Injectable()
export class InspectionPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateInspectionPlanDto, actor?: bigint): Promise<inspection_plan> {
    await this.codes.assertValid('INSPECTION_TYPE', dto.inspectionTypeCode);
    const refs = await this.resolvePlanRefs(dto);

    orConflict(
      await this.prisma.inspection_plan.findUnique({
        where: { inspection_plan_code: dto.inspectionPlanCode },
      }),
      `이미 존재하는 검사기준입니다: ${dto.inspectionPlanCode}`,
    );

    return this.prisma.inspection_plan.create({
      data: {
        inspection_plan_code: dto.inspectionPlanCode,
        inspection_plan_name: dto.inspectionPlanName,
        inspection_type_code: dto.inspectionTypeCode,
        item_id: refs.itemId ?? null,
        process_id: refs.processId ?? null,
        routing_id: refs.routingId ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: InspectionPlanQueryDto): Promise<PageDto<inspection_plan>> {
    const extra: Prisma.inspection_planWhereInput = {};
    if (query.inspectionTypeCode) extra.inspection_type_code = query.inspectionTypeCode;
    if (query.itemCode) extra.item = { item_code: query.itemCode };
    if (query.processCode) extra.process = { process_code: query.processCode };

    const where = baseWhere(query, [
      'inspection_plan_code',
      'inspection_plan_name',
    ], extra) as Prisma.inspection_planWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inspection_plan.findMany({
        where,
        orderBy: { inspection_plan_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.inspection_plan.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(planCode: string) {
    const found = await this.prisma.inspection_plan.findUnique({
      where: { inspection_plan_code: planCode },
      include: {
        item: { select: { item_code: true, item_name: true } },
        process: { select: { process_code: true, process_name: true } },
        inspection_plan_version: { orderBy: { plan_version: 'desc' } },
      },
    });
    return orFail(found, `검사기준(${planCode})`);
  }

  async update(
    planCode: string,
    dto: UpdateInspectionPlanDto,
    actor?: bigint,
  ): Promise<inspection_plan> {
    const found = await this.getPlan(planCode);
    await this.codes.assertValid('INSPECTION_TYPE', dto.inspectionTypeCode);
    const refs = await this.resolvePlanRefs(dto);

    return this.prisma.inspection_plan.update({
      where: { inspection_plan_id: found.inspection_plan_id },
      data: {
        inspection_plan_name: dto.inspectionPlanName,
        inspection_type_code: dto.inspectionTypeCode,
        item_id: refs.itemId,
        process_id: refs.processId,
        routing_id: refs.routingId,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 승인자는 호출한 사용자로 박는다 — 임의의 승인자를 본문으로 받으면
   * 누가 실제로 승인했는지 알 수 없게 된다.
   */
  async approve(planCode: string, actor?: bigint): Promise<inspection_plan> {
    const found = await this.getPlan(planCode);

    return this.prisma.inspection_plan.update({
      where: { inspection_plan_id: found.inspection_plan_id },
      data: { approved_by: actor ?? null, approved_at: new Date(), ...updateStamp(actor) },
    });
  }

  async deactivate(planCode: string, actor?: bigint): Promise<void> {
    const found = await this.getPlan(planCode);

    const requests = await this.prisma.inspection_request.count({
      where: { inspection_plan_version: { inspection_plan_id: found.inspection_plan_id } },
    });
    if (requests > 0) {
      throw new ConflictException(
        `검사요청이 참조 중이라 비활성화할 수 없습니다: ${planCode} (검사요청 ${requests})`,
      );
    }

    await this.prisma.inspection_plan.update({
      where: { inspection_plan_id: found.inspection_plan_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async addVersion(
    planCode: string,
    dto: CreateInspectionPlanVersionDto,
    actor?: bigint,
  ): Promise<inspection_plan_version> {
    const plan = await this.getPlan(planCode);
    await this.validateVersionCodes(dto);
    this.assertVersionRules(dto);

    orConflict(
      await this.prisma.inspection_plan_version.findUnique({
        where: {
          inspection_plan_id_plan_version: {
            inspection_plan_id: plan.inspection_plan_id,
            plan_version: dto.planVersion,
          },
        },
      }),
      `이미 존재하는 기준 버전입니다: ${dto.planVersion}`,
    );

    return this.prisma.inspection_plan_version.create({
      data: {
        inspection_plan_id: plan.inspection_plan_id,
        plan_version: dto.planVersion,
        status_code: dto.statusCode,
        sampling_method_code: dto.samplingMethodCode,
        sampling_qty: dto.samplingQty ?? null,
        aql_value: dto.aqlValue ?? null,
        acceptance_number: dto.acceptanceNumber ?? null,
        rejection_number: dto.rejectionNumber ?? null,
        inspection_frequency_code: dto.inspectionFrequencyCode,
        frequency_interval_value: dto.frequencyIntervalValue ?? null,
        frequency_interval_uom_code: dto.frequencyIntervalUomCode ?? null,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        ...createStamp(actor),
      },
    });
  }

  async findVersions(
    planCode: string,
    query: InspectionPlanVersionQueryDto,
  ): Promise<PageDto<inspection_plan_version>> {
    const plan = await this.getPlan(planCode);
    const where: Prisma.inspection_plan_versionWhereInput = {
      inspection_plan_id: plan.inspection_plan_id,
    };
    if (query.statusCode) where.status_code = query.statusCode;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inspection_plan_version.findMany({
        where,
        orderBy: { plan_version: 'desc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.inspection_plan_version.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findVersion(planCode: string, planVersion: number) {
    const plan = await this.getPlan(planCode);
    return orFail(
      await this.prisma.inspection_plan_version.findUnique({
        where: {
          inspection_plan_id_plan_version: {
            inspection_plan_id: plan.inspection_plan_id,
            plan_version: planVersion,
          },
        },
        include: {
          inspection_item_spec: {
            orderBy: { sequence_no: 'asc' },
            include: { uom: { select: { uom_code: true } } },
          },
        },
      }),
      `기준 버전(${planVersion})`,
    );
  }

  async updateVersion(
    planCode: string,
    planVersion: number,
    dto: UpdateInspectionPlanVersionDto,
    actor?: bigint,
  ): Promise<inspection_plan_version> {
    const version = await this.getVersion(planCode, planVersion);
    await this.validateVersionCodes(dto);
    this.assertVersionRules(mergeDefined(this.toVersionRuleInput(version), { ...dto }));

    return this.prisma.inspection_plan_version.update({
      where: { inspection_plan_version_id: version.inspection_plan_version_id },
      data: {
        status_code: dto.statusCode,
        sampling_method_code: dto.samplingMethodCode,
        sampling_qty: dto.samplingQty,
        aql_value: dto.aqlValue,
        acceptance_number: dto.acceptanceNumber,
        rejection_number: dto.rejectionNumber,
        inspection_frequency_code: dto.inspectionFrequencyCode,
        frequency_interval_value: dto.frequencyIntervalValue,
        frequency_interval_uom_code: dto.frequencyIntervalUomCode,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo,
        ...updateStamp(actor),
      },
    });
  }

  async removeVersion(planCode: string, planVersion: number): Promise<void> {
    const version = await this.getVersion(planCode, planVersion);
    const id = version.inspection_plan_version_id;

    const [requests, specs] = await this.prisma.$transaction([
      this.prisma.inspection_request.count({ where: { inspection_plan_version_id: id } }),
      this.prisma.inspection_item_spec.count({ where: { inspection_plan_version_id: id } }),
    ]);

    if (requests > 0) {
      throw new ConflictException(
        `검사요청이 참조 중이라 삭제할 수 없습니다: 기준 버전 ${planVersion} (검사요청 ${requests})`,
      );
    }
    if (specs > 0) {
      throw new ConflictException(
        `검사항목이 남아 있어 삭제할 수 없습니다: 기준 버전 ${planVersion} (항목 ${specs}건)`,
      );
    }

    await this.prisma.inspection_plan_version.delete({ where: { inspection_plan_version_id: id } });
  }

  async addItemSpec(
    planCode: string,
    planVersion: number,
    dto: CreateInspectionItemSpecDto,
    actor?: bigint,
  ): Promise<inspection_item_spec> {
    const version = await this.getVersion(planCode, planVersion);
    await this.validateItemSpecCodes(dto);
    this.assertItemSpecRules(dto);
    const refs = await this.resolveItemSpecRefs(dto);

    orConflict(
      await this.prisma.inspection_item_spec.findUnique({
        where: {
          inspection_plan_version_id_sequence_no: {
            inspection_plan_version_id: version.inspection_plan_version_id,
            sequence_no: dto.sequenceNo,
          },
        },
      }),
      `이미 존재하는 검사항목 순서입니다: ${dto.sequenceNo}`,
    );

    return this.prisma.inspection_item_spec.create({
      data: {
        inspection_plan_version_id: version.inspection_plan_version_id,
        sequence_no: dto.sequenceNo,
        inspection_item_code: dto.inspectionItemCode,
        inspection_item_name: dto.inspectionItemName,
        data_type_code: dto.dataTypeCode,
        uom_id: refs.uomId ?? null,
        target_value: dto.targetValue ?? null,
        lower_limit: dto.lowerLimit ?? null,
        upper_limit: dto.upperLimit ?? null,
        measurement_count: dto.measurementCount ?? 1,
        inspection_method_code: dto.inspectionMethodCode ?? null,
        default_inspection_equipment_id: refs.equipmentId ?? null,
        required_flag: dto.requiredFlag ?? true,
        automatic_judgment: dto.automaticJudgment ?? true,
        created_by: actor,
      },
    });
  }

  async findItemSpecs(planCode: string, planVersion: number): Promise<inspection_item_spec[]> {
    const version = await this.getVersion(planCode, planVersion);
    return this.prisma.inspection_item_spec.findMany({
      where: { inspection_plan_version_id: version.inspection_plan_version_id },
      include: { uom: { select: { uom_code: true } } },
      orderBy: { sequence_no: 'asc' },
    });
  }

  async findItemSpec(planCode: string, planVersion: number, sequenceNo: number) {
    const version = await this.getVersion(planCode, planVersion);
    return orFail(
      await this.prisma.inspection_item_spec.findUnique({
        where: {
          inspection_plan_version_id_sequence_no: {
            inspection_plan_version_id: version.inspection_plan_version_id,
            sequence_no: sequenceNo,
          },
        },
        include: { uom: { select: { uom_code: true } } },
      }),
      `검사항목(순서 ${sequenceNo})`,
    );
  }

  /** 검사항목에는 수정 이력 컬럼이 없다 — 측정 실적이 붙은 뒤에는 손대지 못하게 막는다. */
  async updateItemSpec(
    planCode: string,
    planVersion: number,
    sequenceNo: number,
    dto: UpdateInspectionItemSpecDto,
  ): Promise<inspection_item_spec> {
    const version = await this.getVersion(planCode, planVersion);
    const spec = await this.getItemSpec(version.inspection_plan_version_id, sequenceNo);
    await this.assertNoMeasurement(spec, '수정');

    await this.validateItemSpecCodes(dto);
    this.assertItemSpecRules(mergeDefined(this.toItemSpecRuleInput(spec), { ...dto }));
    const refs = await this.resolveItemSpecRefs(dto);

    if (dto.sequenceNo !== undefined && dto.sequenceNo !== sequenceNo) {
      orConflict(
        await this.prisma.inspection_item_spec.findUnique({
          where: {
            inspection_plan_version_id_sequence_no: {
              inspection_plan_version_id: version.inspection_plan_version_id,
              sequence_no: dto.sequenceNo,
            },
          },
        }),
        `이미 존재하는 검사항목 순서입니다: ${dto.sequenceNo}`,
      );
    }

    return this.prisma.inspection_item_spec.update({
      where: { inspection_item_spec_id: spec.inspection_item_spec_id },
      data: {
        sequence_no: dto.sequenceNo,
        inspection_item_code: dto.inspectionItemCode,
        inspection_item_name: dto.inspectionItemName,
        data_type_code: dto.dataTypeCode,
        uom_id: refs.uomId,
        target_value: dto.targetValue,
        lower_limit: dto.lowerLimit,
        upper_limit: dto.upperLimit,
        measurement_count: dto.measurementCount,
        inspection_method_code: dto.inspectionMethodCode,
        default_inspection_equipment_id: refs.equipmentId,
        required_flag: dto.requiredFlag,
        automatic_judgment: dto.automaticJudgment,
      },
    });
  }

  async removeItemSpec(planCode: string, planVersion: number, sequenceNo: number): Promise<void> {
    const version = await this.getVersion(planCode, planVersion);
    const spec = await this.getItemSpec(version.inspection_plan_version_id, sequenceNo);
    await this.assertNoMeasurement(spec, '삭제');

    await this.prisma.inspection_item_spec.delete({
      where: { inspection_item_spec_id: spec.inspection_item_spec_id },
    });
  }

  private async assertNoMeasurement(
    spec: inspection_item_spec,
    action: string,
  ): Promise<void> {
    const measurements = await this.prisma.inspection_measurement.count({
      where: { inspection_item_spec_id: spec.inspection_item_spec_id },
    });
    if (measurements > 0) {
      throw new ConflictException(
        `측정 실적이 있어 ${action}할 수 없습니다: 검사항목 ${spec.inspection_item_code} ` +
          `(측정 ${measurements}건). 기준을 바꾸려면 새 버전을 만드십시오.`,
      );
    }
  }

  private async validateVersionCodes(
    dto: CreateInspectionPlanVersionDto | UpdateInspectionPlanVersionDto,
  ): Promise<void> {
    await this.codes.assertAllValid([
      ['REVISION_STATUS', dto.statusCode],
      ['SAMPLING_METHOD', dto.samplingMethodCode],
      ['INSPECTION_FREQUENCY', dto.inspectionFrequencyCode],
      ['FREQUENCY_INTERVAL_UOM', dto.frequencyIntervalUomCode],
    ]);
  }

  /** 부분 수정에서도 같은 규칙을 돌리려고 기존 행을 DTO 모양으로 되돌린다. */
  private toVersionRuleInput(version: inspection_plan_version): VersionRuleInput {
    return {
      samplingMethodCode: version.sampling_method_code,
      samplingQty: version.sampling_qty?.toNumber(),
      aqlValue: version.aql_value?.toNumber(),
      acceptanceNumber: version.acceptance_number ?? undefined,
      rejectionNumber: version.rejection_number ?? undefined,
      inspectionFrequencyCode: version.inspection_frequency_code,
      frequencyIntervalValue: version.frequency_interval_value?.toNumber(),
      frequencyIntervalUomCode: version.frequency_interval_uom_code ?? undefined,
      effectiveFrom: version.effective_from,
      effectiveTo: version.effective_to ?? undefined,
    };
  }

  private assertVersionRules(dto: VersionRuleInput): void {
    if (dto.effectiveFrom && dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }
    if (dto.samplingMethodCode === 'AQL' && dto.aqlValue === undefined) {
      throw new BadRequestException('AQL 샘플링은 aqlValue가 필요합니다.');
    }
    if (dto.samplingMethodCode === 'FIXED' && dto.samplingQty === undefined) {
      throw new BadRequestException('고정 수량 샘플링은 samplingQty가 필요합니다.');
    }
    if (
      dto.inspectionFrequencyCode === 'PERIODIC' &&
      (dto.frequencyIntervalValue === undefined || dto.frequencyIntervalUomCode === undefined)
    ) {
      throw new BadRequestException(
        '주기 검사는 frequencyIntervalValue와 frequencyIntervalUomCode가 모두 필요합니다.',
      );
    }
    if (
      dto.acceptanceNumber !== undefined &&
      dto.rejectionNumber !== undefined &&
      dto.rejectionNumber <= dto.acceptanceNumber
    ) {
      throw new BadRequestException('불합격 판정개수(Re)는 합격 판정개수(Ac)보다 커야 합니다.');
    }
  }

  private async validateItemSpecCodes(
    dto: CreateInspectionItemSpecDto | UpdateInspectionItemSpecDto,
  ): Promise<void> {
    await this.codes.assertAllValid([
      ['INSPECTION_DATA_TYPE', dto.dataTypeCode],
      ['INSPECTION_METHOD', dto.inspectionMethodCode],
    ]);
  }

  private toItemSpecRuleInput(spec: inspection_item_spec): ItemSpecRuleInput {
    return {
      dataTypeCode: spec.data_type_code,
      targetValue: spec.target_value?.toNumber(),
      lowerLimit: spec.lower_limit?.toNumber(),
      upperLimit: spec.upper_limit?.toNumber(),
      automaticJudgment: spec.automatic_judgment,
    };
  }

  private assertItemSpecRules(dto: ItemSpecRuleInput): void {
    const hasLimit = dto.lowerLimit !== undefined || dto.upperLimit !== undefined;

    if (
      dto.lowerLimit !== undefined &&
      dto.upperLimit !== undefined &&
      dto.upperLimit < dto.lowerLimit
    ) {
      throw new BadRequestException('상한(UCL)은 하한(LCL)보다 작을 수 없습니다.');
    }

    if (dto.dataTypeCode !== 'NUMERIC' && (hasLimit || dto.targetValue !== undefined)) {
      throw new BadRequestException(
        '계량형(NUMERIC)이 아닌 항목에는 목표값·상한·하한을 둘 수 없습니다.',
      );
    }

    if (dto.dataTypeCode === 'NUMERIC' && dto.automaticJudgment !== false && !hasLimit) {
      throw new BadRequestException(
        '계량형 자동판정은 상한(UCL)이나 하한(LCL) 중 하나가 있어야 합니다.',
      );
    }
  }

  private async resolvePlanRefs(
    dto: CreateInspectionPlanDto | UpdateInspectionPlanDto,
  ): Promise<InspectionPlanRefs> {
    const [item, process, routing] = await Promise.all([
      dto.itemCode ? this.getItem(dto.itemCode) : null,
      dto.processCode ? this.getProcess(dto.processCode) : null,
      dto.routingId !== undefined ? this.getRouting(dto.routingId) : null,
    ]);

    return {
      itemId: item?.item_id,
      processId: process?.process_id,
      routingId: routing?.routing_id,
    };
  }

  private async getRouting(routingId: number): Promise<routing> {
    return orFail(
      await this.prisma.routing.findUnique({ where: { routing_id: BigInt(routingId) } }),
      `라우팅(${routingId})`,
    );
  }

  private async resolveItemSpecRefs(
    dto: CreateInspectionItemSpecDto | UpdateInspectionItemSpecDto,
  ): Promise<InspectionItemSpecRefs> {
    const [uom, equipment] = await Promise.all([
      dto.uomCode ? this.getUom(dto.uomCode) : null,
      this.findInspectionEquipment(dto.defaultInspectionEquipmentCode),
    ]);

    return { uomId: uom?.uom_id, equipmentId: equipment?.equipment_id };
  }

  /** 설비코드는 (공장, 코드)로만 유일하다 — 여러 공장에 같은 코드가 있으면 조용히 고르지 않고 거부한다. */
  private async findInspectionEquipment(equipmentCode?: string): Promise<equipment | null> {
    if (!equipmentCode) return null;

    const rows = await this.prisma.equipment.findMany({
      where: { equipment_code: equipmentCode },
      take: 2,
    });
    return exactlyOne(rows, '설비', equipmentCode);
  }

  private async getPlan(planCode: string): Promise<inspection_plan> {
    return orFail(
      await this.prisma.inspection_plan.findUnique({
        where: { inspection_plan_code: planCode },
      }),
      `검사기준(${planCode})`,
    );
  }

  private async getVersion(
    planCode: string,
    planVersion: number,
  ): Promise<inspection_plan_version> {
    const plan = await this.getPlan(planCode);
    return orFail(
      await this.prisma.inspection_plan_version.findUnique({
        where: {
          inspection_plan_id_plan_version: {
            inspection_plan_id: plan.inspection_plan_id,
            plan_version: planVersion,
          },
        },
      }),
      `기준 버전(${planVersion})`,
    );
  }

  private async getItemSpec(
    versionId: bigint,
    sequenceNo: number,
  ): Promise<inspection_item_spec> {
    return orFail(
      await this.prisma.inspection_item_spec.findUnique({
        where: {
          inspection_plan_version_id_sequence_no: {
            inspection_plan_version_id: versionId,
            sequence_no: sequenceNo,
          },
        },
      }),
      `검사항목(순서 ${sequenceNo})`,
    );
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

  private async getUom(uomCode: string): Promise<uom> {
    return orFail(
      await this.prisma.uom.findUnique({ where: { uom_code: uomCode } }),
      `단위(${uomCode})`,
    );
  }
}
