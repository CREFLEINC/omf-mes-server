import { PrismaService } from '../../prisma/prisma.service';
import { RoutingOperationService } from './routing-operation.service';

/** 라우팅 공정 「검사 관리」를 바꾸면 그 품목 · 공정 PQC 기준의 「기본 생략」이 반대로 맞춰진다(사용자 결정 2026-11-04). */
function harness(existing: { routing_operation_id: bigint; process_id: bigint; inspection_managed: boolean }[]) {
  const tx = {
    routing_operation: { deleteMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    routing: { findUnique: jest.fn().mockResolvedValue({ item_id: 40n }) },
    inspection_plan: {
      count: jest.fn().mockResolvedValue(1),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    item: { findUnique: jest.fn() },
    process: { findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  const prisma = {
    routing_operation: { findMany: jest.fn().mockResolvedValue(existing) },
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const service = new RoutingOperationService(prisma);
  // 검증 · 조회는 이 스위트가 보지 않는다 — 저장 트랜잭션 안의 연동만 본다.
  const internals = service as unknown as Record<string, unknown>;
  for (const name of ['assertDraft', 'assertProcesses', 'assertRemovable']) internals[name] = jest.fn().mockResolvedValue(undefined);
  internals.read = jest.fn().mockResolvedValue([]);
  return { service, tx };
}

const op = (overrides: Record<string, unknown>) => ({
  routingId: 1, operationSeq: 1, processId: 2, operationName: '사출', mesManaged: true, materialInputManaged: true,
  productionResultManaged: true, inspectionManaged: false, outputLotRequired: true, equipmentRequired: true,
  moldRequired: false, ...overrides,
}) as never;

jest.mock('./routing-operation.service', () => {
  const actual = jest.requireActual('./routing-operation.service');
  return actual;
});

describe('라우팅 공정 저장 — PQC 기준 「기본 생략」 연동', () => {
  it('검사 관리를 켜면 그 품목 · 공정 기준의 기본 생략을 끈다', async () => {
    const { service, tx } = harness([{ routing_operation_id: 11n, process_id: 2n, inspection_managed: false }]);
    await service.replace(1, [op({ routingOperationId: 11, inspectionManaged: true })]);

    expect(tx.inspection_plan.updateMany).toHaveBeenCalledWith({
      where: { item_id: 40n, process_id: 2n, inspection_type_code: 'PQC', is_active: true, default_skip: true },
      data: { default_skip: false, pqc_skip_allowed: false, version_no: { increment: 1 } },
    });
  });

  it('검사 관리를 바꾸지 않은 저장은 기준을 건드리지 않는다', async () => {
    const { service, tx } = harness([{ routing_operation_id: 11n, process_id: 2n, inspection_managed: true }]);
    await service.replace(1, [op({ routingOperationId: 11, inspectionManaged: true })]);

    expect(tx.inspection_plan.count).not.toHaveBeenCalled();
  });

  it('새 공정은 켠 경우만 맞춘다', async () => {
    const off = harness([]);
    await off.service.replace(1, [op({ inspectionManaged: false })]);
    expect(off.tx.inspection_plan.count).not.toHaveBeenCalled();

    const on = harness([]);
    await on.service.replace(1, [op({ inspectionManaged: true })]);
    expect(on.tx.inspection_plan.count).toHaveBeenCalledTimes(1);
  });
});
