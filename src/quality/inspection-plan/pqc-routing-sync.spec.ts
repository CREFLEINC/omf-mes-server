import { Prisma } from '@prisma/client';

import { isRoutingLinkedPqc, syncPqcPlanToRoutingOperation, syncRoutingOperationsToPqcPlan } from './pqc-routing-sync';

/** PQC 기준 「기본 생략」 ↔ 라우팅 공정 「검사 관리」(사용자 결정 2026-11-04 · IQC 품목 연동과 같은 결). */
const plan = (overrides: Record<string, unknown> = {}) => ({
  inspection_type_code: 'PQC', item_id: 40n as bigint | null, process_id: 2n, routing_id: null as bigint | null,
  is_active: true, default_skip: true, ...overrides,
}) as Parameters<typeof syncRoutingOperationsToPqcPlan>[1];

describe('isRoutingLinkedPqc', () => {
  it.each([
    ['공정이 지정된 사용 중 PQC 기준', {}, true],
    ['공정이 빈 PQC 기준', { process_id: null }, false],
    ['사용 중지된 기준', { is_active: false }, false],
    ['IQC 기준', { inspection_type_code: 'IQC' }, false],
  ])('%s → %s', (_label, overrides, expected) => {
    expect(isRoutingLinkedPqc(plan(overrides))).toBe(expected);
  });
});

describe('syncRoutingOperationsToPqcPlan — 기준 → 라우팅', () => {
  const confirmedRev = { routing_id: 9n, item_id: 40n, routing_code: 'R-01', routing_version: 2, effective_from: null, effective_to: null, is_default: true };
  const tx = (confirmed: unknown[] = []) => ({
    routing_operation: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([
        { routing_operation_id: 1n, operation_seq: 10, process_id: 2n, inspection_managed: true },
        { routing_operation_id: 2n, operation_seq: 20, process_id: 3n, inspection_managed: true },
      ]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ routing_operation_id: 100n + BigInt(data.operation_seq) })),
    },
    routing_operation_dependency: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    routing: {
      findMany: jest.fn().mockResolvedValue(confirmed),
      aggregate: jest.fn().mockResolvedValue({ _max: { routing_version: 3 } }),
      create: jest.fn().mockResolvedValue({ routing_id: 11n }),
      update: jest.fn().mockResolvedValue({}),
    },
    inspection_plan: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  });
  const run = (client: ReturnType<typeof tx>, overrides: Record<string, unknown> = {}) =>
    syncRoutingOperationsToPqcPlan(client as unknown as Prisma.TransactionClient, plan(overrides));

  it('작성중 Rev 는 그 품목 라우팅의 그 공정 검사 관리를 그 자리에서 반대로 맞춘다(어긋난 공정만)', async () => {
    const client = tx();
    await run(client);

    expect(client.routing_operation.updateMany).toHaveBeenCalledWith({
      where: { process_id: 2n, inspection_managed: true, routing: { item_id: 40n, status_code: 'DRAFT' } },
      data: { inspection_managed: false, version_no: { increment: 1 } },
    });
    expect(client.routing.findMany.mock.calls[0][0].where).toEqual({
      item_id: 40n, status_code: 'CONFIRMED', routing_operation: { some: { process_id: 2n, inspection_managed: true } },
    });
    expect(client.routing.create).not.toHaveBeenCalled();
  });

  it('확정 Rev 는 새 Rev 로 복사해 바로 확정하고 그 공정만 고친 뒤 옛 Rev 를 폐기한다', async () => {
    const client = tx([confirmedRev]);
    await run(client, { routing_id: 9n });

    expect(client.routing.create.mock.calls[0][0].data).toMatchObject({ item_id: 40n, routing_code: 'R-01', routing_version: 4, status_code: 'CONFIRMED' });
    expect(client.routing_operation.create.mock.calls.map(([arg]) => [arg.data.process_id, arg.data.inspection_managed, arg.data.routing_id]))
      .toEqual([[2n, false, 11n], [3n, true, 11n]]);
    expect(client.routing.update.mock.calls).toEqual([
      [{ where: { routing_id: 9n }, data: { status_code: 'OBSOLETE', is_default: false, version_no: { increment: 1 } } }],
      [{ where: { routing_id: 11n }, data: { is_default: true } }],
    ]);
    expect(client.inspection_plan.updateMany).toHaveBeenCalledWith({
      where: { routing_id: 9n }, data: { routing_id: 11n, version_no: { increment: 1 } },
    });
  });

  it('기본 Rev 가 아니던 확정 Rev 는 기본 지정을 옮기지 않는다', async () => {
    const client = tx([{ ...confirmedRev, is_default: false }]);
    await run(client);

    expect(client.routing.update).toHaveBeenCalledTimes(1);
  });

  it('라우팅이 지정된 기준은 그 라우팅만', async () => {
    const client = tx();
    await run(client, { routing_id: 9n, default_skip: false });

    expect(client.routing_operation.updateMany.mock.calls[0][0]).toMatchObject({
      where: { process_id: 2n, inspection_managed: false, routing: { item_id: 40n, routing_id: 9n } },
      data: { inspection_managed: true },
    });
  });

  it('품목이 빈 기준은 그 공정에 품목 전용 PQC 기준이 없는 품목만', async () => {
    const client = tx();
    await run(client, { item_id: null });

    expect(client.routing_operation.updateMany.mock.calls[0][0].where.routing).toEqual({
      item: { inspection_plan: { none: { inspection_type_code: 'PQC', is_active: true, item_id: { not: null }, process_id: 2n } } },
      status_code: 'DRAFT',
    });
  });
});

describe('syncPqcPlanToRoutingOperation — 라우팅 → 기준', () => {
  const tx = (ownCount: number) => ({
    inspection_plan: {
      count: jest.fn().mockResolvedValue(ownCount),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    item: { findUnique: jest.fn().mockResolvedValue({ item_code: 'P-01', item_name: '부품' }) },
    process: { findUnique: jest.fn().mockResolvedValue({ process_code: 'INJ', process_name: '사출' }) },
  });

  it('품목 · 공정 기준이 있으면 그 기본 생략을 반대로 맞춘다(어긋난 기준만)', async () => {
    const client = tx(1);
    await syncPqcPlanToRoutingOperation(client as unknown as Prisma.TransactionClient, { itemId: 40n, processId: 2n, inspectionManaged: false });

    expect(client.inspection_plan.updateMany).toHaveBeenCalledWith({
      where: { item_id: 40n, process_id: 2n, inspection_type_code: 'PQC', is_active: true, default_skip: false },
      data: { default_skip: true, pqc_skip_allowed: true, version_no: { increment: 1 } },
    });
    expect(client.inspection_plan.create).not.toHaveBeenCalled();
  });

  it('없으면 품목 + 공정 기준을 만들어 설정을 고정한다', async () => {
    const client = tx(0);
    await syncPqcPlanToRoutingOperation(client as unknown as Prisma.TransactionClient, { itemId: 40n, processId: 2n, inspectionManaged: true });

    expect(client.inspection_plan.create).toHaveBeenCalledWith({
      data: {
        inspection_plan_code: 'PQC-P-01-INJ', inspection_plan_name: '부품 사출 공정검사', inspection_type_code: 'PQC',
        item_id: 40n, process_id: 2n, default_skip: false, pqc_skip_allowed: false,
      },
    });
  });

  it('코드가 이미 쓰였으면 품목 · 공정 id 로 만든다', async () => {
    const client = tx(0);
    client.inspection_plan.findUnique.mockResolvedValueOnce({ inspection_plan_id: 7n });
    await syncPqcPlanToRoutingOperation(client as unknown as Prisma.TransactionClient, { itemId: 40n, processId: 2n, inspectionManaged: true });

    expect(client.inspection_plan.create.mock.calls[0][0].data.inspection_plan_code).toBe('PQC-ITEM-40-2');
  });
});
