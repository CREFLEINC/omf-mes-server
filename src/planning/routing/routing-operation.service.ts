import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { SEQ_PARKING_OFFSET, assertCodeValues, optional } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
import { REVISION_STATUS } from '../revision-status';

/** 계약 `RoutingOperation` 과 동형. 필드는 `x-source-column` 을 그대로 따른다. */
interface RoutingOperationView {
  routingOperationId: number;
  routingId: number;
  operationSeq: number;
  processId: number;
  operationName: string;
  nameKo: string | null;
  nameVi: string | null;
  mesManaged: boolean;
  materialInputManaged: boolean;
  productionResultManaged: boolean;
  inspectionManaged: boolean;
  isOutsourced: boolean;
  outputLotRequired: boolean;
  equipmentRequired: boolean;
  moldRequired: boolean;
  standardCycleTimeSec: number | null;
  standardYieldRate: number | null;
}

export interface RoutingOperationUpsert {
  routingOperationId?: number;
  routingId: number;
  operationSeq: number;
  processId: number;
  operationName: string;
  nameKo?: string | null;
  nameVi?: string | null;
  mesManaged: boolean;
  materialInputManaged: boolean;
  productionResultManaged: boolean;
  inspectionManaged: boolean;
  isOutsourced?: boolean;
  outputLotRequired: boolean;
  equipmentRequired: boolean;
  moldRequired: boolean;
  standardCycleTimeSec?: number | null;
  standardYieldRate?: number | null;
}

export interface DependencyInput {
  predecessorOperationId: number;
  successorOperationId: number;
  dependencyTypeCode?: string;
}

/** 계약 `RoutingOperationDependency` 와 동형. */
interface DependencyView {
  routingOperationDependencyId: number;
  predecessorOperationId: number;
  successorOperationId: number;
  dependencyTypeCode: string;
}

type OperationRow = Prisma.routing_operationGetPayload<object>;

@Injectable()
export class RoutingOperationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(routingId: number): Promise<RoutingOperationView[]> {
    await this.assertRouting(routingId);
    return this.read(routingId);
  }

  /**
   * 「화면이 최종 순서를 통째로 보내고 서버가 한 트랜잭션으로 반영한다」(계약 · `A-5`).
   *
   * ⛔ **행 교체가 아니다.** 계약이 그 이유를 적었다 — 「`routing_operation` 을 참조하는
   * 곳이 넷이고 특히 `work_order` 는 NOT NULL 이라 DELETE 후 INSERT 로 구현하면 진행 중
   * 작업지시가 무너진다. 서버는 기존 행을 유지하며 순서만 갱신해야 한다」.
   *
   * 그래서 셋으로 가른다 — 남길 행은 «그 자리에서» 갱신하고, 빠진 행은 지우되 참조가
   * 있으면 지우지 않고 400 을 내며, 새 행만 만든다.
   */
  async replace(
    routingId: number,
    operations: RoutingOperationUpsert[],
  ): Promise<RoutingOperationView[]> {
    await this.assertDraft(routingId, '공정 라인을 저장');
    const existing = await this.prisma.routing_operation.findMany({
      where: { routing_id: routingId },
      select: { routing_operation_id: true },
    });
    const known = new Set(existing.map((row) => Number(row.routing_operation_id)));

    assertShape(routingId, operations, known);
    await this.assertProcesses(operations);

    const keep = new Set(
      operations
        .map((operation) => operation.routingOperationId)
        .filter((id): id is number => id !== undefined),
    );
    const removed = [...known].filter((id) => !keep.has(id));
    await this.assertRemovable(removed);

    await this.prisma.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.routing_operation.deleteMany({
          where: { routing_operation_id: { in: removed } },
        });
      }
      // 남는 행을 통째로 위로 밀어 둔다 — 순서를 맞바꾸는 중간 상태가 유일 제약을 깬다.
      if (keep.size > 0) {
        await tx.$executeRaw`
          UPDATE planning.routing_operation
             SET operation_seq = operation_seq + ${SEQ_PARKING_OFFSET}
           WHERE routing_id = ${routingId}`;
      }

      for (const operation of operations) {
        if (operation.routingOperationId === undefined) {
          await tx.routing_operation.create({ data: writeData(routingId, operation) });
          continue;
        }
        await tx.routing_operation.update({
          where: { routing_operation_id: operation.routingOperationId },
          data: { ...writeData(routingId, operation), version_no: { increment: 1 } },
        });
      }
    });

    return this.read(routingId);
  }

  // ── 선후행 ──────────────────────────────────────────────────────────────

  async listDependencies(routingId: number): Promise<DependencyView[]> {
    await this.assertRouting(routingId);
    return this.readDependencies(routingId);
  }

  /**
   * 「선후행은 라인 행을 가리키는 별개 관계라 라인 전체 치환에 포함하지 않는다」(계약).
   * `routing_operation_dependency` 에는 `version_no` 가 없다(부여·회수 형) — 409 가 없다.
   */
  async replaceDependencies(
    routingId: number,
    dependencies: DependencyInput[],
    actorId?: number,
  ): Promise<DependencyView[]> {
    await this.assertDraft(routingId, '선후행을 저장');
    const rows = await this.prisma.routing_operation.findMany({
      where: { routing_id: routingId },
      select: { routing_operation_id: true },
    });
    const known = new Set(rows.map((row) => Number(row.routing_operation_id)));

    assertDependencyShape(dependencies, known);
    await assertCodeValues(
      this.prisma,
      dependencies.map((dependency, index) => ({
        field: `dependencies[${index}].dependencyTypeCode`,
        value: dependency.dependencyTypeCode,
        groupCode: 'ROUTING_OPERATION_DEPENDENCY_TYPE',
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.routing_operation_dependency.deleteMany({
        where: { predecessor_operation_id: { in: [...known] } },
      });
      if (dependencies.length === 0) return;
      await tx.routing_operation_dependency.createMany({
        data: dependencies.map((dependency) => ({
          predecessor_operation_id: dependency.predecessorOperationId,
          successor_operation_id: dependency.successorOperationId,
          ...optional('dependency_type_code', dependency.dependencyTypeCode),
          ...(actorId === undefined ? {} : { created_by: actorId }),
        })),
      });
    });

    return this.readDependencies(routingId);
  }

  // ── 읽기·검사 ───────────────────────────────────────────────────────────

  private async read(routingId: number): Promise<RoutingOperationView[]> {
    const rows = await this.prisma.routing_operation.findMany({
      where: { routing_id: routingId },
      orderBy: { operation_seq: 'asc' },
    });
    return rows.map(view);
  }

  private async readDependencies(routingId: number): Promise<DependencyView[]> {
    const rows = await this.prisma.routing_operation_dependency.findMany({
      where: { routing_operation_routing_operation_dependency_predecessor_operation_idTorouting_operation: { routing_id: routingId } },
      orderBy: [{ predecessor_operation_id: 'asc' }, { successor_operation_id: 'asc' }],
    });
    return rows.map((row) => ({
      routingOperationDependencyId: Number(row.routing_operation_dependency_id),
      predecessorOperationId: Number(row.predecessor_operation_id),
      successorOperationId: Number(row.successor_operation_id),
      dependencyTypeCode: row.dependency_type_code,
    }));
  }

  private async assertRouting(routingId: number): Promise<void> {
    const row = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      select: { routing_id: true },
    });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');
  }

  private async assertDraft(routingId: number, action: string): Promise<void> {
    const row = await this.prisma.routing.findUnique({
      where: { routing_id: routingId },
      select: { status_code: true },
    });
    if (!row) throw new NotFoundException('없는 Routing 입니다.');
    if (row.status_code === REVISION_STATUS.DRAFT) return;

    throw new ContractException(HttpStatus.BAD_REQUEST, [
      {
        scope: 'screen',
        code: ERROR_CODE.STATE_LOCKED,
        message: `확정되었거나 폐기된 Rev 는 ${action}할 수 없습니다. 신규 Rev 를 발행하세요.`,
      },
    ]);
  }

  private async assertProcesses(operations: RoutingOperationUpsert[]): Promise<void> {
    const ids = [...new Set(operations.map((operation) => operation.processId))];
    if (ids.length === 0) return;
    const found = await this.prisma.process.findMany({
      where: { process_id: { in: ids } },
      select: { process_id: true },
    });
    const known = new Set(found.map((row) => Number(row.process_id)));

    const errors: ErrorItem[] = operations.flatMap((operation, index) =>
      known.has(operation.processId)
        ? []
        : [
            {
              scope: 'field' as const,
              field: `operations[${index}].processId`,
              code: ERROR_CODE.INVALID,
              message: '없는 공정입니다.',
            },
          ],
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }

  /**
   * ⛔ 빠진 행을 지우기 전에 «가리키는 곳»을 본다. 그냥 지우면 FK 위반이 500 으로 나가고,
   * 화면은 「왜 안 되는지」를 못 받는다. 특히 `work_order.routing_operation_id` 는
   * NOT NULL 이라 진행 중 작업지시가 그 공정을 붙들고 있다.
   */
  private async assertRemovable(removed: number[]): Promise<void> {
    if (removed.length === 0) return;
    const [workOrders, components, dependencies] = await Promise.all([
      this.prisma.work_order.findMany({
        where: { routing_operation_id: { in: removed } },
        select: { routing_operation_id: true },
      }),
      this.prisma.bom_component.findMany({
        where: { routing_operation_id: { in: removed } },
        select: { routing_operation_id: true },
      }),
      this.prisma.routing_operation_dependency.findMany({
        where: {
          OR: [
            { predecessor_operation_id: { in: removed } },
            { successor_operation_id: { in: removed } },
          ],
        },
        select: { predecessor_operation_id: true, successor_operation_id: true },
      }),
    ]);

    const errors: ErrorItem[] = [];
    if (workOrders.length > 0 || components.length > 0) {
      errors.push({
        scope: 'screen',
        code: ERROR_CODE.STATE_LOCKED,
        message: '작업지시나 BOM 이 쓰고 있는 공정은 뺄 수 없습니다.',
      });
    }
    if (dependencies.length > 0) {
      // 선후행은 이 화면이 함께 관리하는 관계라 「먼저 지우라」로 안내한다.
      errors.push({
        scope: 'screen',
        code: ERROR_CODE.STATE_LOCKED,
        message: '선후행이 걸린 공정은 뺄 수 없습니다. 선후행을 먼저 정리하세요.',
      });
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

function writeData(
  routingId: number,
  operation: RoutingOperationUpsert,
): Prisma.routing_operationUncheckedCreateInput {
  return {
    routing_id: routingId,
    operation_seq: operation.operationSeq,
    process_id: operation.processId,
    operation_name: operation.operationName,
    ...optional('name_ko', operation.nameKo),
    ...optional('name_vi', operation.nameVi),
    mes_managed: operation.mesManaged,
    material_input_managed: operation.materialInputManaged,
    production_result_managed: operation.productionResultManaged,
    inspection_managed: operation.inspectionManaged,
    // ⚠ 계약 이름은 `isOutsourced`, 물리 이름은 `is_subcontract` — 계약이 「이름만 다르고
    // 컬럼은 이미 있다. 이름 정합화를 통지하되 기다리지 않는다」로 적었다.
    ...optional('is_subcontract', operation.isOutsourced),
    output_lot_required: operation.outputLotRequired,
    equipment_required: operation.equipmentRequired,
    mold_required: operation.moldRequired,
    ...optional('standard_cycle_time_sec', operation.standardCycleTimeSec),
    ...optional('standard_yield_rate', operation.standardYieldRate),
  };
}

/** 요청 안에서 먼저 본다 — DB 까지 가면 500 이고 계약은 여기에 400 을 요구한다. */
function assertShape(
  routingId: number,
  operations: RoutingOperationUpsert[],
  known: ReadonlySet<number>,
): void {
  const errors: ErrorItem[] = [];
  const seenSeq = new Map<number, number>();
  const seenId = new Map<number, number>();

  operations.forEach((operation, index) => {
    if (operation.routingId !== routingId) {
      errors.push(invalid(`operations[${index}].routingId`, '경로의 Routing 과 다릅니다.'));
    }
    if (operation.routingOperationId !== undefined) {
      if (!known.has(operation.routingOperationId)) {
        // 계약: 「routingId 아래 기존 행과 매칭되지 않는 routingOperationId 가 오면 400」.
        errors.push(
          invalid(`operations[${index}].routingOperationId`, '이 Routing 의 공정이 아닙니다.'),
        );
      }
      const firstId = seenId.get(operation.routingOperationId);
      if (firstId === undefined) seenId.set(operation.routingOperationId, index);
      else {
        errors.push(
          unique(
            `operations[${index}].routingOperationId`,
            ['routingOperationId'],
            `${firstId + 1}번째와 같은 공정입니다.`,
          ),
        );
      }
    }
    const firstSeq = seenSeq.get(operation.operationSeq);
    if (firstSeq === undefined) seenSeq.set(operation.operationSeq, index);
    else {
      errors.push(
        unique(
          `operations[${index}].operationSeq`,
          ['routingId', 'operationSeq'],
          `${firstSeq + 1}번째와 같은 순서입니다.`,
        ),
      );
    }
    if (operation.operationSeq >= SEQ_PARKING_OFFSET) {
      errors.push(
        invalid(`operations[${index}].operationSeq`, `${SEQ_PARKING_OFFSET} 보다 작아야 합니다.`),
      );
    }
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function assertDependencyShape(
  dependencies: DependencyInput[],
  known: ReadonlySet<number>,
): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();
  const edges = new Map<number, number[]>();

  dependencies.forEach((dependency, index) => {
    for (const [field, id] of [
      ['predecessorOperationId', dependency.predecessorOperationId],
      ['successorOperationId', dependency.successorOperationId],
    ] as const) {
      if (!known.has(id)) {
        errors.push(invalid(`dependencies[${index}].${field}`, '이 Routing 의 공정이 아닙니다.'));
      }
    }
    // ck_routing_dependency_self — 자기 자신 금지.
    if (dependency.predecessorOperationId === dependency.successorOperationId) {
      errors.push(
        invalid(`dependencies[${index}]`, '앞 공정과 뒤 공정이 같을 수 없습니다.'),
      );
      return;
    }
    const folded = `${dependency.predecessorOperationId} ${dependency.successorOperationId}`;
    const first = seen.get(folded);
    if (first === undefined) seen.set(folded, index);
    else {
      errors.push(
        unique(
          `dependencies[${index}]`,
          ['predecessorOperationId', 'successorOperationId'],
          `${first + 1}번째와 같은 선후행입니다.`,
        ),
      );
      return;
    }
    edges.set(dependency.predecessorOperationId, [
      ...(edges.get(dependency.predecessorOperationId) ?? []),
      dependency.successorOperationId,
    ]);
  });

  // ⛔ 순환(A→B→A)은 DB 가 막지 않는다(공유계약 A-9 ⓐ 차단). 순환이 서면 공정을 타고
  // 내려가는 모든 코드가 무한히 돈다.
  if (errors.length === 0 && hasCycle(edges)) {
    errors.push({
      scope: 'screen',
      code: ERROR_CODE.INVALID,
      message: '공정 선후행에 순환이 생깁니다.',
    });
  }
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

/** 색칠 3색 DFS — 회색 노드를 다시 만나면 그 경로가 순환이다. */
function hasCycle(edges: ReadonlyMap<number, number[]>): boolean {
  const state = new Map<number, 'visiting' | 'done'>();

  const walk = (node: number): boolean => {
    const seen = state.get(node);
    if (seen === 'visiting') return true;
    if (seen === 'done') return false;
    state.set(node, 'visiting');
    for (const next of edges.get(node) ?? []) {
      if (walk(next)) return true;
    }
    state.set(node, 'done');
    return false;
  };

  return [...edges.keys()].some((node) => walk(node));
}

function invalid(field: string, message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.INVALID, message };
}

function unique(field: string, uniqueScope: string[], message: string): ErrorItem {
  return { scope: 'field', field, code: ERROR_CODE.UNIQUE_VIOLATION, uniqueScope, message };
}

function view(row: OperationRow): RoutingOperationView {
  return {
    routingOperationId: Number(row.routing_operation_id),
    routingId: Number(row.routing_id),
    operationSeq: row.operation_seq,
    processId: Number(row.process_id),
    operationName: row.operation_name,
    nameKo: row.name_ko,
    nameVi: row.name_vi,
    mesManaged: row.mes_managed,
    materialInputManaged: row.material_input_managed,
    productionResultManaged: row.production_result_managed,
    inspectionManaged: row.inspection_managed,
    isOutsourced: row.is_subcontract,
    outputLotRequired: row.output_lot_required,
    equipmentRequired: row.equipment_required,
    moldRequired: row.mold_required,
    standardCycleTimeSec:
      row.standard_cycle_time_sec === null ? null : Number(row.standard_cycle_time_sec),
    standardYieldRate: row.standard_yield_rate === null ? null : Number(row.standard_yield_rate),
  };
}
