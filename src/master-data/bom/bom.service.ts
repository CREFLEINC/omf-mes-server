import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  bom,
  bom_component,
  item,
  material_substitution_rule,
  partner,
  Prisma,
  process as processModel,
  uom,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  BomQueryDto,
  CreateBomComponentDto,
  CreateBomDto,
  CreateSubstitutionRuleDto,
  UpdateBomComponentDto,
  UpdateBomDto,
} from './bom.dto';

const OBSOLETE = 'OBSOLETE';

/** BOM 라인이 선택적으로 가리키는 참조들 — 코드·ID를 내부 PK로 바꿔 담는다. */
interface BomComponentRefs {
  actualUseProcessId?: bigint;
  routingOperationId?: bigint;
}

@Injectable()
export class BomService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateBomDto, actor?: bigint): Promise<bom> {
    await this.codes.assertValid('REVISION_STATUS', dto.statusCode);
    this.assertDateOrder(dto.effectiveFrom, dto.effectiveTo);

    const [parentItem, baseUom] = await Promise.all([
      this.getItem(dto.parentItemCode),
      this.getUom(dto.baseUomCode),
    ]);

    orConflict(
      await this.prisma.bom.findUnique({
        where: {
          parent_item_id_bom_code_bom_version: {
            parent_item_id: parentItem.item_id,
            bom_code: dto.bomCode,
            bom_version: dto.bomVersion,
          },
        },
      }),
      `이미 존재하는 BOM입니다: ${dto.parentItemCode}/${dto.bomCode} Rev${dto.bomVersion}`,
    );

    const isDefault = dto.isDefault ?? false;

    return this.prisma.$transaction(async (tx) => {
      if (isDefault) await this.clearDefault(tx, parentItem.item_id, actor);

      return tx.bom.create({
        data: {
          parent_item_id: parentItem.item_id,
          bom_code: dto.bomCode,
          bom_version: dto.bomVersion,
          status_code: dto.statusCode,
          is_default: isDefault,
          base_qty: dto.baseQty,
          base_uom_id: baseUom.uom_id,
          effective_from: dto.effectiveFrom,
          effective_to: dto.effectiveTo ?? null,
          ...createStamp(actor),
        },
      });
    });
  }

  async findAll(query: BomQueryDto): Promise<PageDto<bom>> {
    const where: Prisma.bomWhereInput = {};
    if (query.parentItemCode) where.item = { item_code: query.parentItemCode };
    if (query.statusCode) where.status_code = query.statusCode;
    if (query.isDefault !== undefined) where.is_default = query.isDefault;
    if (query.keyword) where.bom_code = { contains: query.keyword, mode: 'insensitive' };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.bom.findMany({
        where,
        include: { item: { select: { item_code: true, item_name: true } } },
        orderBy: [{ bom_code: 'asc' }, { bom_version: 'desc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.bom.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(bomId: bigint) {
    const found = await this.prisma.bom.findUnique({
      where: { bom_id: bomId },
      include: {
        item: { select: { item_code: true, item_name: true } },
        uom: { select: { uom_code: true } },
        bom_component: {
          orderBy: { sequence_no: 'asc' },
          include: {
            item: { select: { item_code: true, item_name: true } },
            uom: { select: { uom_code: true } },
          },
        },
      },
    });
    return orFail(found, `BOM(${bomId})`);
  }

  async update(bomId: bigint, dto: UpdateBomDto, actor?: bigint): Promise<bom> {
    const found = await this.getBom(bomId);
    await this.codes.assertValid('REVISION_STATUS', dto.statusCode);
    this.assertDateOrder(
      dto.effectiveFrom ?? found.effective_from,
      dto.effectiveTo === undefined ? found.effective_to : dto.effectiveTo,
    );

    const baseUomId = dto.baseUomCode ? (await this.getUom(dto.baseUomCode)).uom_id : undefined;

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault === true) {
        await this.clearDefault(tx, found.parent_item_id, actor, found.bom_id);
      }

      return tx.bom.update({
        where: { bom_id: found.bom_id },
        data: {
          status_code: dto.statusCode,
          is_default: dto.isDefault,
          base_qty: dto.baseQty,
          base_uom_id: baseUomId,
          effective_from: dto.effectiveFrom,
          effective_to: dto.effectiveTo,
          ...updateStamp(actor),
        },
      });
    });
  }

  /** BOM에도 is_active가 없다 — 라우팅과 같이 상태를 폐기로 내린다. */
  async obsolete(bomId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getBom(bomId);

    const plans = await this.prisma.production_plan.count({ where: { bom_id: found.bom_id } });
    if (plans > 0) {
      throw new ConflictException(
        `참조 중이라 폐기할 수 없습니다: BOM(${bomId}) (생산계획 ${plans})`,
      );
    }

    await this.prisma.bom.update({
      where: { bom_id: found.bom_id },
      data: { status_code: OBSOLETE, is_default: false, ...updateStamp(actor) },
    });
  }

  async addComponent(
    bomId: bigint,
    dto: CreateBomComponentDto,
    actor?: bigint,
  ): Promise<bom_component> {
    const found = await this.getBom(bomId);
    const [componentItem, uom] = await Promise.all([
      this.getItem(dto.componentItemCode),
      this.getUom(dto.uomCode),
    ]);
    this.assertNotSelfComponent(found, componentItem.item_id);
    const resolved = await this.resolveOptionalRefs(found, dto);

    orConflict(
      await this.prisma.bom_component.findUnique({
        where: {
          bom_id_sequence_no: { bom_id: found.bom_id, sequence_no: dto.sequenceNo },
        },
      }),
      `이미 존재하는 BOM 라인 순서입니다: ${dto.sequenceNo}`,
    );

    return this.prisma.bom_component.create({
      data: {
        bom_id: found.bom_id,
        sequence_no: dto.sequenceNo,
        component_item_id: componentItem.item_id,
        required_qty: dto.requiredQty,
        uom_id: uom.uom_id,
        routing_operation_id: resolved.routingOperationId ?? null,
        actual_use_process_id: resolved.actualUseProcessId ?? null,
        scrap_rate: dto.scrapRate ?? 0,
        is_mandatory: dto.isMandatory ?? true,
        lot_trace_required: dto.lotTraceRequired ?? false,
        backflush_allowed: dto.backflushAllowed ?? false,
        ...createStamp(actor),
      },
    });
  }

  async findComponents(bomId: bigint): Promise<bom_component[]> {
    const found = await this.getBom(bomId);
    return this.prisma.bom_component.findMany({
      where: { bom_id: found.bom_id },
      include: {
        item: { select: { item_code: true, item_name: true } },
        uom: { select: { uom_code: true } },
      },
      orderBy: { sequence_no: 'asc' },
    });
  }

  async findComponent(bomId: bigint, sequenceNo: number) {
    const found = await this.getBom(bomId);
    return orFail(
      await this.prisma.bom_component.findUnique({
        where: { bom_id_sequence_no: { bom_id: found.bom_id, sequence_no: sequenceNo } },
        include: {
          item: { select: { item_code: true, item_name: true } },
          uom: { select: { uom_code: true } },
          material_substitution_rule: { orderBy: { priority_no: 'asc' } },
        },
      }),
      `BOM 라인(순서 ${sequenceNo})`,
    );
  }

  async updateComponent(
    bomId: bigint,
    sequenceNo: number,
    dto: UpdateBomComponentDto,
    actor?: bigint,
  ): Promise<bom_component> {
    const found = await this.getBom(bomId);
    const component = await this.getComponent(found, sequenceNo);

    const [componentItem, uom, resolved] = await Promise.all([
      dto.componentItemCode ? this.getItem(dto.componentItemCode) : null,
      dto.uomCode ? this.getUom(dto.uomCode) : null,
      this.resolveOptionalRefs(found, dto),
    ]);

    const componentItemId = componentItem?.item_id;
    if (componentItemId !== undefined) this.assertNotSelfComponent(found, componentItemId);
    const uomId = uom?.uom_id;

    if (dto.sequenceNo !== undefined && dto.sequenceNo !== sequenceNo) {
      orConflict(
        await this.prisma.bom_component.findUnique({
          where: { bom_id_sequence_no: { bom_id: found.bom_id, sequence_no: dto.sequenceNo } },
        }),
        `이미 존재하는 BOM 라인 순서입니다: ${dto.sequenceNo}`,
      );
    }

    return this.prisma.bom_component.update({
      where: { bom_component_id: component.bom_component_id },
      data: {
        sequence_no: dto.sequenceNo,
        component_item_id: componentItemId,
        required_qty: dto.requiredQty,
        uom_id: uomId,
        routing_operation_id: resolved.routingOperationId,
        actual_use_process_id: resolved.actualUseProcessId,
        scrap_rate: dto.scrapRate,
        is_mandatory: dto.isMandatory,
        lot_trace_required: dto.lotTraceRequired,
        backflush_allowed: dto.backflushAllowed,
        ...updateStamp(actor),
      },
    });
  }

  async removeComponent(bomId: bigint, sequenceNo: number): Promise<void> {
    const found = await this.getBom(bomId);
    const component = await this.getComponent(found, sequenceNo);
    const id = component.bom_component_id;

    const [issueRequests, consumptions, substitutions] = await this.prisma.$transaction([
      this.prisma.material_issue_request_line.count({ where: { bom_component_id: id } }),
      this.prisma.material_consumption.count({ where: { bom_component_id: id } }),
      this.prisma.material_substitution_rule.count({ where: { bom_component_id: id } }),
    ]);

    if (issueRequests + consumptions + substitutions > 0) {
      throw new ConflictException(
        `참조 중이라 삭제할 수 없습니다: BOM 라인 ${sequenceNo} ` +
          `(불출요청 ${issueRequests}·자재소비 ${consumptions}·대체규칙 ${substitutions})`,
      );
    }

    await this.prisma.bom_component.delete({ where: { bom_component_id: id } });
  }

  async addSubstitutionRule(
    bomId: bigint,
    sequenceNo: number,
    dto: CreateSubstitutionRuleDto,
    actor?: bigint,
  ): Promise<material_substitution_rule> {
    const found = await this.getBom(bomId);
    const component = await this.getComponent(found, sequenceNo);
    this.assertDateOrder(dto.effectiveFrom, dto.effectiveTo);

    const [substitute, customer] = await Promise.all([
      this.getItem(dto.substituteItemCode),
      dto.customerRestrictionCode ? this.getPartner(dto.customerRestrictionCode) : null,
    ]);

    if (substitute.item_id === component.component_item_id) {
      throw new BadRequestException('대체 품목이 원래 구성 품목과 같을 수 없습니다.');
    }

    orConflict(
      await this.prisma.material_substitution_rule.findUnique({
        where: {
          bom_component_id_substitute_item_id_effective_from: {
            bom_component_id: component.bom_component_id,
            substitute_item_id: substitute.item_id,
            effective_from: dto.effectiveFrom,
          },
        },
      }),
      `같은 시작일의 대체규칙이 이미 있습니다: ${dto.substituteItemCode}`,
    );

    return this.prisma.material_substitution_rule.create({
      data: {
        bom_component_id: component.bom_component_id,
        substitute_item_id: substitute.item_id,
        priority_no: dto.priorityNo ?? 1,
        max_substitute_qty: dto.maxSubstituteQty ?? null,
        approval_required: dto.approvalRequired ?? true,
        customer_restriction_id: customer?.partner_id ?? null,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        created_by: actor,
      },
    });
  }

  async findSubstitutionRules(
    bomId: bigint,
    sequenceNo: number,
  ): Promise<material_substitution_rule[]> {
    const found = await this.getBom(bomId);
    const component = await this.getComponent(found, sequenceNo);
    return this.prisma.material_substitution_rule.findMany({
      where: { bom_component_id: component.bom_component_id },
      orderBy: [{ priority_no: 'asc' }, { effective_from: 'desc' }],
    });
  }

  /** 대체규칙에는 수정 이력 컬럼이 없다 — 바꾸려면 지우고 다시 넣는다. */
  async removeSubstitutionRule(
    bomId: bigint,
    sequenceNo: number,
    ruleId: bigint,
  ): Promise<void> {
    const found = await this.getBom(bomId);
    const component = await this.getComponent(found, sequenceNo);
    const row = orFail(
      await this.prisma.material_substitution_rule.findFirst({
        where: {
          substitution_rule_id: ruleId,
          bom_component_id: component.bom_component_id,
        },
      }),
      `대체규칙(${ruleId})`,
    );

    await this.prisma.material_substitution_rule.delete({
      where: { substitution_rule_id: row.substitution_rule_id },
    });
  }

  private async resolveOptionalRefs(
    parent: bom,
    dto: CreateBomComponentDto | UpdateBomComponentDto,
  ): Promise<BomComponentRefs> {
    const [actualUseProcess, routingOperationId] = await Promise.all([
      dto.actualUseProcessCode ? this.getProcess(dto.actualUseProcessCode) : null,
      this.resolveRoutingOperationId(parent, dto.routingOperationId),
    ]);

    return { actualUseProcessId: actualUseProcess?.process_id, routingOperationId };
  }

  /** 라우팅 공정은 BOM 부모품목의 라우팅에 속한 것만 허용한다 — 아니면 소요 전개가 엉뚱한 라인으로 간다. */
  private async resolveRoutingOperationId(
    parent: bom,
    routingOperationId?: number,
  ): Promise<bigint | undefined> {
    if (routingOperationId === undefined) return undefined;

    const operation = orFail(
      await this.prisma.routing_operation.findUnique({
        where: { routing_operation_id: BigInt(routingOperationId) },
        include: { routing: { select: { item_id: true } } },
      }),
      `라우팅 공정(${routingOperationId})`,
    );
    if (operation.routing.item_id !== parent.parent_item_id) {
      throw new BadRequestException('라우팅 공정이 이 BOM의 부모 품목 라우팅에 속하지 않습니다.');
    }
    return operation.routing_operation_id;
  }

  private assertNotSelfComponent(parent: bom, componentItemId: bigint): void {
    if (componentItemId === parent.parent_item_id) {
      throw new BadRequestException('구성 품목이 부모 품목과 같을 수 없습니다.');
    }
  }

  /** 품목당 기본 BOM은 1개뿐이다(uq_bom_default) — 새 기본을 세우기 전에 기존 것을 내린다. */
  private async clearDefault(
    tx: Prisma.TransactionClient,
    parentItemId: bigint,
    actor?: bigint,
    exceptBomId?: bigint,
  ): Promise<void> {
    await tx.bom.updateMany({
      where: {
        parent_item_id: parentItemId,
        is_default: true,
        ...(exceptBomId ? { bom_id: { not: exceptBomId } } : {}),
      },
      data: { is_default: false, updated_by: actor },
    });
  }

  private assertDateOrder(from: Date, to?: Date | null): void {
    if (to && to < from) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }
  }

  private async getBom(bomId: bigint): Promise<bom> {
    return orFail(await this.prisma.bom.findUnique({ where: { bom_id: bomId } }), `BOM(${bomId})`);
  }

  private async getComponent(parent: bom, sequenceNo: number): Promise<bom_component> {
    return orFail(
      await this.prisma.bom_component.findUnique({
        where: { bom_id_sequence_no: { bom_id: parent.bom_id, sequence_no: sequenceNo } },
      }),
      `BOM 라인(순서 ${sequenceNo})`,
    );
  }

  private async getItem(itemCode: string): Promise<item> {
    return orFail(
      await this.prisma.item.findUnique({ where: { item_code: itemCode } }),
      `품목(${itemCode})`,
    );
  }

  private async getUom(uomCode: string): Promise<uom> {
    return orFail(
      await this.prisma.uom.findUnique({ where: { uom_code: uomCode } }),
      `단위(${uomCode})`,
    );
  }

  private async getProcess(processCode: string): Promise<processModel> {
    return orFail(
      await this.prisma.process.findUnique({ where: { process_code: processCode } }),
      `공정(${processCode})`,
    );
  }

  private async getPartner(partnerCode: string): Promise<partner> {
    return orFail(
      await this.prisma.partner.findUnique({ where: { partner_code: partnerCode } }),
      `거래처(${partnerCode})`,
    );
  }
}
