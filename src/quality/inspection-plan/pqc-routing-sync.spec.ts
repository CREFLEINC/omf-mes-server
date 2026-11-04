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
  const tx = () => ({ routing_operation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });

  it('품목 기준은 그 품목 라우팅(확정 Rev 포함)의 그 공정 검사 관리를 반대로 맞춘다(어긋난 공정만)', async () => {
    const client = tx();
    await syncRoutingOperationsToPqcPlan(client as unknown as Prisma.TransactionClient, plan());

    expect(client.routing_operation.updateMany).toHaveBeenCalledWith({
      where: { process_id: 2n, inspection_managed: true, routing: { item_id: 40n } },
      data: { inspection_managed: false, version_no: { increment: 1 } },
    });
  });

  it('라우팅이 지정된 기준은 그 라우팅만', async () => {
    const client = tx();
    await syncRoutingOperationsToPqcPlan(client as unknown as Prisma.TransactionClient, plan({ routing_id: 9n, default_skip: false }));

    expect(client.routing_operation.updateMany.mock.calls[0][0]).toMatchObject({
      where: { process_id: 2n, inspection_managed: false, routing: { item_id: 40n, routing_id: 9n } },
      data: { inspection_managed: true },
    });
  });

  it('품목이 빈 기준은 그 공정에 품목 전용 PQC 기준이 없는 품목만', async () => {
    const client = tx();
    await syncRoutingOperationsToPqcPlan(client as unknown as Prisma.TransactionClient, plan({ item_id: null }));

    expect(client.routing_operation.updateMany.mock.calls[0][0].where.routing).toEqual({
      item: { inspection_plan: { none: { inspection_type_code: 'PQC', is_active: true, item_id: { not: null }, process_id: 2n } } },
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
