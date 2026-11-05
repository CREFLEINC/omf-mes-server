import { Prisma } from '@prisma/client';

import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutingOperationService } from './routing-operation.service';
import { RoutingRevisionService } from './routing-revision.service';
import { RoutingService } from './routing.service';

/**
 * omf-all-around#231 — Routing 쓰기마다 `audit.audit_event`(대상 ROUTING)에 이력을 남긴다.
 * 프리즈마는 목이다 — `$transaction` 은 같은 목을 트랜잭션 클라이언트로 넘긴다.
 */
type Mock = jest.Mock;

const routingRow = (over: Partial<Prisma.routingGetPayload<object>> = {}) => ({
  routing_id: 7n,
  item_id: 40n,
  routing_code: 'R-01',
  routing_version: 1,
  status_code: 'DRAFT',
  effective_from: null,
  effective_to: null,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
  is_default: false,
  confirmed_at: null,
  ...over,
});

const opRow = (id: number, seq: number, cycle: number | null = null) => ({
  routing_operation_id: BigInt(id),
  routing_id: 7n,
  operation_seq: seq,
  process_id: 300n,
  operation_name: `OP${seq}`,
  name_ko: null,
  name_vi: null,
  mes_managed: true,
  material_input_managed: false,
  production_result_managed: true,
  inspection_managed: false,
  is_subcontract: false,
  output_lot_required: false,
  equipment_required: false,
  mold_required: false,
  standard_cycle_time_sec: cycle === null ? null : new Prisma.Decimal(cycle),
  standard_yield_rate: null,
  version_no: 1,
});

function prismaMock(extra: Record<string, unknown> = {}) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma: Record<string, unknown> = {
    audit_event: { create: auditCreate },
    ...extra,
  };
  prisma.$transaction = jest.fn((run: (tx: unknown) => unknown) => run(prisma));
  return { prisma: prisma as unknown as PrismaService, auditCreate };
}

const auditData = (auditCreate: Mock, index = 0) =>
  (auditCreate.mock.calls[index]?.[0] as { data: Record<string, unknown> }).data;

const documentState = {
  assertTransition: jest.fn((_column: string, kind: string) => ({
    to: kind === 'routing-confirm' ? 'CONFIRMED' : 'OBSOLETE',
  })),
} as unknown as DocumentStateService;

describe('Routing 변경 이력 (omf-all-around#231)', () => {
  it('첫 등록은 CREATE · after 에 코드 · 판 번호 · 상태를 적는다', async () => {
    const { prisma, auditCreate } = prismaMock({
      item: { findUnique: jest.fn().mockResolvedValue({ item_id: 40n }) },
      routing: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(routingRow()),
      },
    });

    await new RoutingService(prisma).create({ itemId: 40, routingCode: 'R-01' }, 9);

    expect(auditData(auditCreate)).toMatchObject({
      target_type_code: 'ROUTING',
      target_id: 7n,
      event_type_code: 'CREATE',
      performed_by: 9n,
      before_value: Prisma.DbNull,
      after_value: { routingCode: 'R-01', routingVersion: 1, statusCode: 'DRAFT' },
    });
  });

  it('헤더 수정은 바뀐 키만 UPDATE 로 적고, 바뀐 게 없으면 적지 않는다', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ status_code: 'DRAFT' }) // assertDraft
      .mockResolvedValueOnce(routingRow()) // before
      .mockResolvedValueOnce(routingRow({ routing_code: 'R-02', version_no: 2 })) // after
      .mockResolvedValue(routingRow({ routing_code: 'R-02', version_no: 2 })); // get
    const { prisma, auditCreate } = prismaMock({
      routing: { findUnique, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    });
    const service = new RoutingService(prisma);
    (service as unknown as { get: Mock }).get = jest.fn().mockResolvedValue({});

    await service.update(7, 1, { routingCode: 'R-02' }, 9);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditData(auditCreate)).toMatchObject({
      event_type_code: 'UPDATE',
      before_value: { routingCode: 'R-01' },
      after_value: { routingCode: 'R-02' },
    });

    const same = prismaMock({
      routing: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ status_code: 'DRAFT' })
          .mockResolvedValue(routingRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const unchanged = new RoutingService(same.prisma);
    (unchanged as unknown as { get: Mock }).get = jest.fn().mockResolvedValue({});
    await unchanged.update(7, 1, { routingCode: 'R-01' }, 9);
    expect(same.auditCreate).not.toHaveBeenCalled();
  });

  it('기본 지정은 지정된 줄과 해제된 이전 기본 줄을 각각 UPDATE 로 적는다', async () => {
    const { prisma, auditCreate } = prismaMock({
      routing: {
        findUnique: jest.fn().mockResolvedValue({ item_id: 40n, is_default: false }),
        findMany: jest.fn().mockResolvedValue([{ routing_id: 5n }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    const service = new RoutingService(prisma);
    (service as unknown as { get: Mock }).get = jest.fn().mockResolvedValue({});

    await service.setDefault(7, 9);

    expect(auditData(auditCreate, 0)).toMatchObject({
      target_id: 5n,
      before_value: { isDefault: true },
      after_value: { isDefault: false },
    });
    expect(auditData(auditCreate, 1)).toMatchObject({
      target_id: 7n,
      before_value: { isDefault: false },
      after_value: { isDefault: true },
    });
  });

  it('확정은 상태와 확정 일시를 UPDATE 로 적는다', async () => {
    const { prisma, auditCreate } = prismaMock({
      routing: {
        findUnique: jest.fn().mockResolvedValue(routingRow()),
        update: jest.fn().mockResolvedValue({}),
      },
      routing_operation: { count: jest.fn().mockResolvedValue(1) },
    });

    await new RoutingRevisionService(prisma, documentState).confirm(7, 9);

    const data = auditData(auditCreate);
    expect(data).toMatchObject({
      event_type_code: 'UPDATE',
      performed_by: 9n,
      before_value: { statusCode: 'DRAFT' },
      after_value: { statusCode: 'CONFIRMED' },
    });
    expect((data.after_value as { confirmedAt: string }).confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('폐기는 상태 변화를 UPDATE 로 적는다', async () => {
    const { prisma, auditCreate } = prismaMock({
      routing: {
        findUnique: jest.fn().mockResolvedValue(routingRow({ status_code: 'CONFIRMED' })),
        update: jest.fn().mockResolvedValue({}),
      },
    });

    await new RoutingRevisionService(prisma, documentState).obsolete(7, null);

    expect(auditData(auditCreate)).toMatchObject({
      event_type_code: 'UPDATE',
      performed_by: null,
      before_value: { statusCode: 'CONFIRMED' },
      after_value: { statusCode: 'OBSOLETE' },
    });
  });

  it('신규 Rev 발행은 새 줄을 CREATE 로 적고 어느 개정에서 복사했는지 남긴다', async () => {
    const { prisma, auditCreate } = prismaMock({
      routing: {
        findUnique: jest.fn().mockResolvedValue(routingRow({ status_code: 'CONFIRMED' })),
        aggregate: jest.fn().mockResolvedValue({ _max: { routing_version: 1 } }),
        create: jest
          .fn()
          .mockResolvedValue(routingRow({ routing_id: 8n, routing_version: 2 })),
      },
      routing_operation: { findMany: jest.fn().mockResolvedValue([]) },
      routing_operation_dependency: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await new RoutingRevisionService(prisma, documentState).newRevision(7, 9);

    expect(auditData(auditCreate)).toMatchObject({
      target_id: 8n,
      event_type_code: 'CREATE',
      after_value: {
        routingCode: 'R-01',
        routingVersion: 2,
        statusCode: 'DRAFT',
        copiedFromRoutingId: 7,
      },
    });
  });

  it('공정 라인 저장은 목록 전체를 operations 로 before · after 에 적고, 같으면 적지 않는다', async () => {
    const opFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ routing_operation_id: 11n }]) // existing ids
      .mockResolvedValueOnce([opRow(11, 1, 10)]) // before snapshot
      .mockResolvedValueOnce([opRow(11, 1, 12)]) // after snapshot
      .mockResolvedValue([opRow(11, 1, 12)]); // read
    const { prisma, auditCreate } = prismaMock({
      routing: { findUnique: jest.fn().mockResolvedValue({ status_code: 'DRAFT' }) },
      process: { findMany: jest.fn().mockResolvedValue([{ process_id: 300n }]) },
      routing_operation: { findMany: opFindMany, update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    });
    const service = new RoutingOperationService(prisma);
    (service as unknown as { assertRemovable: Mock }).assertRemovable = jest
      .fn()
      .mockResolvedValue(undefined);

    await service.replace(
      7,
      [
        {
          routingOperationId: 11,
          routingId: 7,
          operationSeq: 1,
          processId: 300,
          operationName: 'OP1',
          mesManaged: true,
          materialInputManaged: false,
          productionResultManaged: true,
          inspectionManaged: false,
          outputLotRequired: false,
          equipmentRequired: false,
          moldRequired: false,
          standardCycleTimeSec: 12,
        },
      ],
      9,
    );

    const data = auditData(auditCreate);
    expect(data.event_type_code).toBe('UPDATE');
    const before = (data.before_value as { operations: Record<string, unknown>[] }).operations;
    const after = (data.after_value as { operations: Record<string, unknown>[] }).operations;
    expect(before[0]).toMatchObject({ operationSeq: 1, processId: 300, standardCycleTimeSec: 10 });
    expect(after[0]).toMatchObject({ operationSeq: 1, processId: 300, standardCycleTimeSec: 12 });
    expect(after[0]).not.toHaveProperty('routingOperationId');
  });

  it('선후행 저장은 순서 번호로 dependencies 를 before · after 에 적는다', async () => {
    const opFindMany = jest
      .fn()
      .mockResolvedValueOnce([{ routing_operation_id: 11n }, { routing_operation_id: 12n }]) // known
      .mockResolvedValue([
        { routing_operation_id: 11n, operation_seq: 1 },
        { routing_operation_id: 12n, operation_seq: 2 },
      ]);
    const depFindMany = jest
      .fn()
      .mockResolvedValueOnce([]) // before
      .mockResolvedValue([
        { predecessor_operation_id: 11n, successor_operation_id: 12n, dependency_type_code: 'FS', routing_operation_dependency_id: 1n },
      ]);
    const { prisma, auditCreate } = prismaMock({
      routing: { findUnique: jest.fn().mockResolvedValue({ status_code: 'DRAFT' }) },
      routing_operation: { findMany: opFindMany },
      routing_operation_dependency: {
        findMany: depFindMany,
        deleteMany: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({}),
      },
      code_value: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ code: 'FS', code_group: { group_code: 'ROUTING_OPERATION_DEPENDENCY_TYPE' } }]),
      },
    });
    const service = new RoutingOperationService(prisma);

    await service.replaceDependencies(
      7,
      [{ predecessorOperationId: 11, successorOperationId: 12, dependencyTypeCode: 'FS' }],
      9,
    );

    expect(auditData(auditCreate)).toMatchObject({
      event_type_code: 'UPDATE',
      before_value: { dependencies: [] },
      after_value: {
        dependencies: [
          { predecessorOperationSeq: 1, successorOperationSeq: 2, dependencyTypeCode: 'FS' },
        ],
      },
    });
  });
});
