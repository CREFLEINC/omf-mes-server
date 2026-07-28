import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  item,
  Prisma,
  process as processModel,
  routing,
  routing_operation,
  routing_operation_dependency,
} from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  CreateRoutingDependencyDto,
  CreateRoutingDto,
  CreateRoutingOperationDto,
  RoutingQueryDto,
  UpdateRoutingDto,
  UpdateRoutingOperationDto,
} from './routing.dto';

const OBSOLETE = 'OBSOLETE';

@Injectable()
export class RoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreateRoutingDto, actor?: bigint): Promise<routing> {
    await this.codes.assertValid('REVISION_STATUS', dto.statusCode);
    this.assertDateOrder(dto.effectiveFrom, dto.effectiveTo);

    const item = await this.getItem(dto.itemCode);

    orConflict(
      await this.prisma.routing.findUnique({
        where: {
          item_id_routing_code_routing_version: {
            item_id: item.item_id,
            routing_code: dto.routingCode,
            routing_version: dto.routingVersion,
          },
        },
      }),
      `이미 존재하는 라우팅입니다: ${dto.itemCode}/${dto.routingCode} Rev${dto.routingVersion}`,
    );

    return this.prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: dto.routingCode,
        routing_version: dto.routingVersion,
        status_code: dto.statusCode,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo ?? null,
        ...createStamp(actor),
      },
    });
  }

  async findAll(query: RoutingQueryDto): Promise<PageDto<routing>> {
    const where: Prisma.routingWhereInput = {};
    if (query.itemCode) where.item = { item_code: query.itemCode };
    if (query.statusCode) where.status_code = query.statusCode;
    if (query.keyword) where.routing_code = { contains: query.keyword, mode: 'insensitive' };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.routing.findMany({
        where,
        include: { item: { select: { item_code: true, item_name: true } } },
        orderBy: [{ routing_code: 'asc' }, { routing_version: 'desc' }],
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.routing.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(routingId: bigint) {
    const found = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      include: {
        item: { select: { item_code: true, item_name: true } },
        routing_operation: {
          orderBy: { operation_seq: 'asc' },
          include: { process: { select: { process_code: true, process_name: true } } },
        },
      },
    });
    return orFail(found, `라우팅(${routingId})`);
  }

  async update(routingId: bigint, dto: UpdateRoutingDto, actor?: bigint): Promise<routing> {
    const found = await this.getRouting(routingId);
    await this.codes.assertValid('REVISION_STATUS', dto.statusCode);
    this.assertDateOrder(
      dto.effectiveFrom ?? found.effective_from,
      dto.effectiveTo === undefined ? found.effective_to : dto.effectiveTo,
    );

    return this.prisma.routing.update({
      where: { routing_id: found.routing_id },
      data: {
        status_code: dto.statusCode,
        effective_from: dto.effectiveFrom,
        effective_to: dto.effectiveTo,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 라우팅에는 is_active가 없다 — 수명주기는 status_code가 갖는다.
   * 실적이 붙은 Rev를 지우면 이력이 끊기므로, 삭제 대신 폐기 상태로 내린다.
   */
  async obsolete(routingId: bigint, actor?: bigint): Promise<void> {
    const found = await this.getRouting(routingId);

    const [plans, workOrders] = await this.prisma.$transaction([
      this.prisma.production_plan.count({ where: { routing_id: found.routing_id } }),
      this.prisma.work_order.count({
        where: { routing_operation: { routing_id: found.routing_id } },
      }),
    ]);

    if (plans + workOrders > 0) {
      throw new ConflictException(
        `참조 중이라 폐기할 수 없습니다: 라우팅(${routingId}) ` +
          `(생산계획 ${plans}·작업지시 ${workOrders})`,
      );
    }

    await this.prisma.routing.update({
      where: { routing_id: found.routing_id },
      data: { status_code: OBSOLETE, ...updateStamp(actor) },
    });
  }

  async addOperation(
    routingId: bigint,
    dto: CreateRoutingOperationDto,
    actor?: bigint,
  ): Promise<routing_operation> {
    const found = await this.getRouting(routingId);
    const process = await this.getProcess(dto.processCode);

    orConflict(
      await this.prisma.routing_operation.findUnique({
        where: {
          routing_id_operation_seq: {
            routing_id: found.routing_id,
            operation_seq: dto.operationSeq,
          },
        },
      }),
      `이미 존재하는 공정 순서입니다: ${dto.operationSeq}`,
    );

    return this.prisma.routing_operation.create({
      data: {
        routing_id: found.routing_id,
        operation_seq: dto.operationSeq,
        process_id: process.process_id,
        operation_name: dto.operationName,
        mes_managed: dto.mesManaged ?? true,
        material_input_managed: dto.materialInputManaged ?? false,
        production_result_managed: dto.productionResultManaged ?? true,
        inspection_managed: dto.inspectionManaged ?? false,
        output_lot_required: dto.outputLotRequired ?? false,
        equipment_required: dto.equipmentRequired ?? false,
        mold_required: dto.moldRequired ?? false,
        standard_cycle_time_sec: dto.standardCycleTimeSec ?? null,
        standard_yield_rate: dto.standardYieldRate ?? null,
        ...createStamp(actor),
      },
    });
  }

  async findOperations(routingId: bigint): Promise<routing_operation[]> {
    const found = await this.getRouting(routingId);
    return this.prisma.routing_operation.findMany({
      where: { routing_id: found.routing_id },
      include: { process: { select: { process_code: true, process_name: true } } },
      orderBy: { operation_seq: 'asc' },
    });
  }

  async findOperation(routingId: bigint, operationSeq: number) {
    const found = await this.getRouting(routingId);
    return orFail(
      await this.prisma.routing_operation.findUnique({
        where: {
          routing_id_operation_seq: { routing_id: found.routing_id, operation_seq: operationSeq },
        },
        include: { process: { select: { process_code: true, process_name: true } } },
      }),
      `라우팅 공정(순서 ${operationSeq})`,
    );
  }

  async updateOperation(
    routingId: bigint,
    operationSeq: number,
    dto: UpdateRoutingOperationDto,
    actor?: bigint,
  ): Promise<routing_operation> {
    const [operation, process] = await Promise.all([
      this.getOperation(routingId, operationSeq),
      dto.processCode ? this.getProcess(dto.processCode) : null,
    ]);
    const processId = process?.process_id;

    if (dto.operationSeq !== undefined && dto.operationSeq !== operationSeq) {
      orConflict(
        await this.prisma.routing_operation.findUnique({
          where: {
            routing_id_operation_seq: {
              routing_id: operation.routing_id,
              operation_seq: dto.operationSeq,
            },
          },
        }),
        `이미 존재하는 공정 순서입니다: ${dto.operationSeq}`,
      );
    }

    return this.prisma.routing_operation.update({
      where: { routing_operation_id: operation.routing_operation_id },
      data: {
        operation_seq: dto.operationSeq,
        process_id: processId,
        operation_name: dto.operationName,
        mes_managed: dto.mesManaged,
        material_input_managed: dto.materialInputManaged,
        production_result_managed: dto.productionResultManaged,
        inspection_managed: dto.inspectionManaged,
        output_lot_required: dto.outputLotRequired,
        equipment_required: dto.equipmentRequired,
        mold_required: dto.moldRequired,
        standard_cycle_time_sec: dto.standardCycleTimeSec,
        standard_yield_rate: dto.standardYieldRate,
        ...updateStamp(actor),
      },
    });
  }

  /** 라인에는 비활성 플래그가 없다 — 참조가 없을 때만 물리 삭제한다. */
  async removeOperation(routingId: bigint, operationSeq: number): Promise<void> {
    const operation = await this.getOperation(routingId, operationSeq);
    const id = operation.routing_operation_id;

    const [workOrders, bomComponents, dependencies] = await this.prisma.$transaction([
      this.prisma.work_order.count({ where: { routing_operation_id: id } }),
      this.prisma.bom_component.count({ where: { routing_operation_id: id } }),
      this.prisma.routing_operation_dependency.count({
        where: { OR: [{ predecessor_operation_id: id }, { successor_operation_id: id }] },
      }),
    ]);

    if (workOrders + bomComponents + dependencies > 0) {
      throw new ConflictException(
        `참조 중이라 삭제할 수 없습니다: 공정 순서 ${operationSeq} ` +
          `(작업지시 ${workOrders}·BOM 라인 ${bomComponents}·선후행 ${dependencies})`,
      );
    }

    await this.prisma.routing_operation.delete({ where: { routing_operation_id: id } });
  }

  async addDependency(
    routingId: bigint,
    dto: CreateRoutingDependencyDto,
    actor?: bigint,
  ): Promise<routing_operation_dependency> {
    await this.codes.assertValid('DEPENDENCY_TYPE', dto.dependencyTypeCode);

    if (dto.predecessorSeq === dto.successorSeq) {
      throw new BadRequestException('선행과 후행 공정이 같을 수 없습니다.');
    }

    const [predecessor, successor] = await Promise.all([
      this.getOperation(routingId, dto.predecessorSeq),
      this.getOperation(routingId, dto.successorSeq),
    ]);

    orConflict(
      await this.prisma.routing_operation_dependency.findUnique({
        where: {
          predecessor_operation_id_successor_operation_id: {
            predecessor_operation_id: predecessor.routing_operation_id,
            successor_operation_id: successor.routing_operation_id,
          },
        },
      }),
      `이미 등록된 선후행입니다: ${dto.predecessorSeq}→${dto.successorSeq}`,
    );

    await this.assertNoCycle(
      routingId,
      predecessor.routing_operation_id,
      successor.routing_operation_id,
    );

    return this.prisma.routing_operation_dependency.create({
      data: {
        predecessor_operation_id: predecessor.routing_operation_id,
        successor_operation_id: successor.routing_operation_id,
        dependency_type_code: dto.dependencyTypeCode ?? 'FINISH_TO_START',
        created_by: actor,
      },
    });
  }

  async findDependencies(routingId: bigint): Promise<routing_operation_dependency[]> {
    const operationIds = await this.operationIds(routingId);
    return this.prisma.routing_operation_dependency.findMany({
      where: { predecessor_operation_id: { in: operationIds } },
      orderBy: { routing_operation_dependency_id: 'asc' },
    });
  }

  async removeDependency(routingId: bigint, dependencyId: bigint): Promise<void> {
    const operationIds = await this.operationIds(routingId);
    const row = orFail(
      await this.prisma.routing_operation_dependency.findFirst({
        where: {
          routing_operation_dependency_id: dependencyId,
          predecessor_operation_id: { in: operationIds },
        },
      }),
      `선후행(${dependencyId})`,
    );

    await this.prisma.routing_operation_dependency.delete({
      where: { routing_operation_dependency_id: row.routing_operation_dependency_id },
    });
  }

  /**
   * DB는 자기참조만 막는다(ck_routing_dependency_self). 3개 이상이 얽힌 순환은
   * 여기서 막지 않으면 작업지시 전개가 무한히 돈다.
   */
  private async assertNoCycle(
    routingId: bigint,
    predecessorId: bigint,
    successorId: bigint,
  ): Promise<void> {
    const operationIds = await this.operationIds(routingId);
    const edges = await this.prisma.routing_operation_dependency.findMany({
      where: { predecessor_operation_id: { in: operationIds } },
      select: { predecessor_operation_id: true, successor_operation_id: true },
    });

    const next = new Map<bigint, bigint[]>();
    for (const edge of edges) {
      const list = next.get(edge.predecessor_operation_id) ?? [];
      list.push(edge.successor_operation_id);
      next.set(edge.predecessor_operation_id, list);
    }

    // 후행에서 출발해 선행에 닿으면, 새 간선을 더하는 순간 순환이 된다.
    const visited = new Set<bigint>();
    const stack = [successorId];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (current === predecessorId) {
        throw new BadRequestException(
          '공정 선후행이 순환합니다 — 후행 공정이 이미 선행 공정보다 앞섭니다.',
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);
      stack.push(...(next.get(current) ?? []));
    }
  }

  private assertDateOrder(from: Date, to?: Date | null): void {
    if (to && to < from) {
      throw new BadRequestException('유효 종료일은 유효 시작일보다 빠를 수 없습니다.');
    }
  }

  private async operationIds(routingId: bigint): Promise<bigint[]> {
    const found = await this.getRouting(routingId);
    const rows = await this.prisma.routing_operation.findMany({
      where: { routing_id: found.routing_id },
      select: { routing_operation_id: true },
    });
    return rows.map((row) => row.routing_operation_id);
  }

  private async getRouting(routingId: bigint): Promise<routing> {
    return orFail(
      await this.prisma.routing.findUnique({ where: { routing_id: routingId } }),
      `라우팅(${routingId})`,
    );
  }

  private async getOperation(routingId: bigint, operationSeq: number): Promise<routing_operation> {
    const found = await this.getRouting(routingId);
    return orFail(
      await this.prisma.routing_operation.findUnique({
        where: {
          routing_id_operation_seq: { routing_id: found.routing_id, operation_seq: operationSeq },
        },
      }),
      `라우팅 공정(순서 ${operationSeq})`,
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
}
