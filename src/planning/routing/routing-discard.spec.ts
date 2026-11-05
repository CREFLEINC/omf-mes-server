import { DocumentStateService } from '../../core/document-state';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutingRevisionService } from './routing-revision.service';

/**
 * omf-all-around#231 — 작성중 Rev 취소(`DELETE /planning/routings/{routingId}`).
 * 프리즈마는 목이다 — `$transaction` 은 같은 목을 트랜잭션 클라이언트로 넘긴다.
 */
function harness(
  row: { status_code: string } | null,
  refs: { plans?: number; inspectionPlans?: number; workOrders?: number; components?: number } = {},
) {
  const calls: string[] = [];
  const track = (name: string, value: unknown = {}) =>
    jest.fn().mockImplementation(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const prisma: Record<string, unknown> = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(
        row === null ? [] : [{ ...row, routing_version: 3, routing_code: 'R-01' }],
      ),
    routing_operation: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ routing_operation_id: 11n }, { routing_operation_id: 12n }]),
      deleteMany: track('routing_operation.deleteMany'),
    },
    routing_operation_dependency: { deleteMany: track('dependency.deleteMany') },
    routing: { delete: track('routing.delete') },
    production_plan: { count: jest.fn().mockResolvedValue(refs.plans ?? 0) },
    inspection_plan: { count: jest.fn().mockResolvedValue(refs.inspectionPlans ?? 0) },
    work_order: { count: jest.fn().mockResolvedValue(refs.workOrders ?? 0) },
    bom_component: { count: jest.fn().mockResolvedValue(refs.components ?? 0) },
    audit_event: { create: track('audit.create') },
  };
  prisma.$transaction = jest.fn((run: (tx: unknown) => unknown) => run(prisma));
  const service = new RoutingRevisionService(
    prisma as unknown as PrismaService,
    {} as DocumentStateService,
  );
  return { service, prisma, calls };
}

describe('작성중 Rev 취소 (omf-all-around#231)', () => {
  it('작성중 Rev 는 선후행 → 라인 → Rev 순으로 지우고 DELETE 이력을 남긴다', async () => {
    const { service, prisma, calls } = harness({ status_code: 'DRAFT' });

    await service.discard(7, 9);

    expect(calls).toEqual([
      'dependency.deleteMany',
      'routing_operation.deleteMany',
      'routing.delete',
      'audit.create',
    ]);
    const audit = (prisma.audit_event as { create: jest.Mock }).create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(audit.data).toMatchObject({
      target_type_code: 'ROUTING',
      target_id: 7n,
      event_type_code: 'DELETE',
      performed_by: 9n,
      before_value: { routingCode: 'R-01', routingVersion: 3, statusCode: 'DRAFT' },
    });
  });

  it.each(['CONFIRMED', 'OBSOLETE'])('%s Rev 는 지우지 않고 400 STATE_LOCKED', async (code) => {
    const { service, calls } = harness({ status_code: code });

    await expect(service.discard(7)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it.each([
    ['생산계획', { plans: 1 }],
    ['검사기준', { inspectionPlans: 1 }],
    ['작업지시', { workOrders: 1 }],
    ['BOM', { components: 1 }],
  ])('%s 이 가리키면 지우지 않는다', async (_name, refs) => {
    const { service, calls } = harness({ status_code: 'DRAFT' }, refs);

    await expect(service.discard(7)).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it('없는 Rev 는 404', async () => {
    const { service } = harness(null);

    await expect(service.discard(7)).rejects.toMatchObject({ status: 404 });
  });
});
