import { PrismaService } from '../../prisma/prisma.service';
import { NumberingService } from '../../core/numbering';
import { InspectionPlanService, InspectionPlanWrite } from './inspection-plan.service';

/** omf-all-around#215 — 품목 전용 IQC 기준의 「기본 생략」을 저장하면 품목 「수입검사 대상」이 반대로 맞춰진다. */
function harness() {
  const itemUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    inspection_plan: {
      create: jest.fn().mockResolvedValue({ inspection_plan_id: 1n, item_id: 40n, process_id: null, routing_id: null, approved_by: null, approved_at: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ inspection_type_code: 'IQC', item_id: 40n, default_skip: true }),
    },
    item: { updateMany: itemUpdateMany },
    routing_operation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
    // 다시 사용 전 「제품당 PQC 하나」 검사가 읽는다 — IQC 라 그 검사는 그냥 지나간다.
    inspection_plan: { findUnique: jest.fn().mockResolvedValue({ inspection_type_code: 'IQC', item_id: 40n }) },
  } as unknown as PrismaService;
  const numbering = { next: jest.fn().mockResolvedValue('QP-20261111-0001') };
  const service = new InspectionPlanService(prisma, numbering as unknown as NumberingService);
  // 검증·조회는 이 스위트가 보지 않는다 — 저장 트랜잭션 안의 연동만 본다.
  const internals = service as unknown as Record<string, unknown>;
  internals.assertWritable = jest.fn().mockResolvedValue(undefined);
  internals.assertExists = jest.fn().mockResolvedValue(undefined);
  internals.get = jest.fn().mockResolvedValue({});
  return { service, tx, itemUpdateMany, numbering };
}

const plan = (overrides: Partial<InspectionPlanWrite>): InspectionPlanWrite => ({
  inspectionPlanCode: 'IQC-1',
  inspectionPlanName: 'IQC 기준',
  inspectionTypeCode: 'IQC',
  itemId: 40,
  defaultSkip: true,
  ...overrides,
});

describe('검사 기준 등록 — 기준코드 자동 등록 (omf-all-around#262)', () => {
  it('기준코드를 비우면 QP 번호를 붙이고, 넣으면 앞뒤 빈칸만 걷어 쓴다', async () => {
    const { service, tx, numbering } = harness();

    await service.create(plan({ inspectionPlanCode: '  ' }));
    await service.create(plan({ inspectionPlanCode: ' IQC-9 ' }));

    expect(numbering.next).toHaveBeenCalledTimes(1);
    expect(numbering.next).toHaveBeenCalledWith('INSPECTION_PLAN', null, expect.any(String));
    expect(tx.inspection_plan.create.mock.calls.map((call) => call[0].data.inspection_plan_code)).toEqual([
      'QP-20261111-0001',
      'IQC-9',
    ]);
  });
});

describe('검사 기준 저장 — 품목 「수입검사 대상」 연동 (omf-all-around#215)', () => {
  it('품목 전용 IQC 기준을 기본 생략으로 저장하면 품목 수입검사 대상을 끈다(어긋난 품목만)', async () => {
    const { service, itemUpdateMany } = harness();
    await service.update(1, 1, plan({ defaultSkip: true }));

    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { item_id: 40, inspection_required: true },
      data: { inspection_required: false, version_no: { increment: 1 } },
    });
  });

  it('기본 생략을 끄면 품목 수입검사 대상을 켠다 — 등록도 같다', async () => {
    const { service, itemUpdateMany } = harness();
    await service.create(plan({ defaultSkip: false }));

    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { item_id: 40, inspection_required: false },
      data: { inspection_required: true, version_no: { increment: 1 } },
    });
  });

  it.each([
    ['PQC 기준', { inspectionTypeCode: 'PQC' }],
    ['OQC 기준', { inspectionTypeCode: 'OQC' }],
    ['기본 생략을 보내지 않은 저장', { defaultSkip: undefined }],
  ])('%s 은 품목을 건드리지 않는다', async (_label, overrides) => {
    const { service, itemUpdateMany } = harness();
    await service.update(1, 1, plan(overrides));

    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it('저장이 0행(낙관적 잠금 충돌)이면 품목을 건드리지 않는다', async () => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.update(1, 1, plan({}));

    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it('품목 전용 IQC 기준을 다시 사용하면 품목 IQC 대상을 그 기준에 맞춘다', async () => {
    const { service, itemUpdateMany } = harness();
    await service.setActive(1, 1, true);

    expect(itemUpdateMany).toHaveBeenCalledWith({
      where: { item_id: 40, inspection_required: true },
      data: { inspection_required: false, version_no: { increment: 1 } },
    });
  });

  it('사용 중지는 품목을 건드리지 않는다', async () => {
    const { service, itemUpdateMany } = harness();
    await service.setActive(1, 1, false);

    expect(itemUpdateMany).not.toHaveBeenCalled();
  });
});

/** 「전 품목 공통」 IQC 기준 — 전용 IQC 기준이 없는 품목의 「수입검사 대상」을 맞춘다(사용자 결정 2026-11-04). */
describe('검사 기준 저장 — 공통 IQC 기준의 품목 연동', () => {
  const common = (overrides: Record<string, unknown> = {}) => ({
    inspection_plan_id: 1n, item_id: null, process_id: null, routing_id: null, approved_by: null, approved_at: null,
    inspection_type_code: 'IQC', is_active: true, default_skip: false, ...overrides,
  });
  const syncAll = (skip: boolean) => ({
    where: { inspection_required: skip, inspection_plan: { none: { inspection_type_code: 'IQC', is_active: true } } },
    data: { inspection_required: !skip, version_no: { increment: 1 } },
  });

  it('공통 IQC 기준을 등록하면 전용 기준이 없는 품목을 맞춘다', async () => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.create.mockResolvedValueOnce(common());
    await service.create(plan({ itemId: null, defaultSkip: false }));

    expect(itemUpdateMany).toHaveBeenCalledWith(syncAll(false));
  });

  it('기본 생략을 바꿔 저장하면 맞춘다', async () => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.findUnique.mockResolvedValueOnce(common({ default_skip: false })).mockResolvedValueOnce(common({ default_skip: true }));
    await service.update(1, 1, plan({ itemId: null, defaultSkip: true }));

    expect(itemUpdateMany).toHaveBeenCalledWith(syncAll(true));
  });

  it('기본 생략이 그대로인 저장(이름만 고침)은 품목을 건드리지 않는다', async () => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.findUnique.mockResolvedValueOnce(common()).mockResolvedValueOnce(common());
    await service.update(1, 1, plan({ itemId: null, defaultSkip: false }));

    expect(itemUpdateMany).not.toHaveBeenCalled();
  });

  it('공통 IQC 기준을 다시 사용하면 맞춘다', async () => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.findUnique.mockResolvedValueOnce(common({ default_skip: true }));
    await service.setActive(1, 1, true);

    expect(itemUpdateMany).toHaveBeenCalledWith(syncAll(true));
  });

  it.each<[string, Record<string, unknown>]>([
    ['공통 PQC 기준', { inspection_type_code: 'PQC' }],
    ['공통 OQC 기준', { inspection_type_code: 'OQC' }],
    ['사용 중지된 공통 IQC 기준', { is_active: false }],
  ])('%s 은 품목을 건드리지 않는다', async (_label, overrides) => {
    const { service, tx, itemUpdateMany } = harness();
    tx.inspection_plan.create.mockResolvedValueOnce(common(overrides));
    await service.create(plan({ itemId: null, inspectionTypeCode: String(overrides.inspection_type_code ?? 'IQC') }));

    expect(itemUpdateMany).not.toHaveBeenCalled();
  });
});

/** PQC 기준은 제품에 붙는다 — 공정은 비우고 라우팅은 건드리지 않는다(사용자 결정 2026-11-04). */
describe('검사 기준 저장 — PQC 기준은 공정 없이 제품에', () => {
  it('등록 · 수정 모두 공정을 비워 저장하고 라우팅 공정을 건드리지 않는다', async () => {
    const { service, tx } = harness();
    await service.create(plan({ inspectionTypeCode: 'PQC', processId: 2, defaultSkip: false }));
    await service.update(1, 1, plan({ inspectionTypeCode: 'PQC', processId: 2, defaultSkip: true }));

    expect(tx.inspection_plan.create.mock.calls[0][0].data.process_id).toBeNull();
    expect(tx.inspection_plan.updateMany.mock.calls[0][0].data.process_id).toBeNull();
    expect(tx.routing_operation.updateMany).not.toHaveBeenCalled();
  });

  it('PQC 가 아니면 보낸 공정을 그대로 저장한다', async () => {
    const { service, tx } = harness();
    await service.create(plan({ inspectionTypeCode: 'OQC', processId: 2 }));

    expect(tx.inspection_plan.create.mock.calls[0][0].data.process_id).toBe(2);
  });
});

/** 같은 제품(또는 전 품목 공통)에 사용 중인 PQC 기준은 하나다 — 둘이면 의뢰가 기준을 고르지 못한다. */
describe('검사 기준 저장 — 제품당 PQC 기준 하나', () => {
  const guard = (other: { inspection_plan_code: string } | null, stored: { item_id: bigint | null } | null = null) => {
    const findFirst = jest.fn().mockResolvedValue(other);
    const prisma = { inspection_plan: { findFirst, findUnique: jest.fn().mockResolvedValue(stored) } } as unknown as PrismaService;
    const service = new InspectionPlanService(prisma, {} as NumberingService) as unknown as {
      assertSinglePqc: (target: { inspection_type_code: string; item_id: number | null | undefined }, self: number | null) => Promise<void>;
    };
    return { service, findFirst };
  };

  it('같은 제품에 사용 중인 PQC 기준이 있으면 막는다', async () => {
    const { service } = guard({ inspection_plan_code: 'PQC-A' });
    await expect(service.assertSinglePqc({ inspection_type_code: 'PQC', item_id: 40 }, null)).rejects.toMatchObject({
      errors: [expect.objectContaining({ field: 'itemId', code: 'UNIQUE_VIOLATION' })],
    });
  });

  it('자기 자신은 빼고 찾고, 품목을 안 보낸 수정은 저장된 품목으로 찾는다', async () => {
    const { service, findFirst } = guard(null, { item_id: 40n });
    await service.assertSinglePqc({ inspection_type_code: 'PQC', item_id: undefined }, 7);

    expect(findFirst.mock.calls[0][0].where).toEqual({
      inspection_type_code: 'PQC', is_active: true, item_id: 40n, inspection_plan_id: { not: 7 },
    });
  });

  it('PQC 가 아니면 보지 않는다', async () => {
    const { service, findFirst } = guard({ inspection_plan_code: 'X' });
    await service.assertSinglePqc({ inspection_type_code: 'IQC', item_id: 40 }, null);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
