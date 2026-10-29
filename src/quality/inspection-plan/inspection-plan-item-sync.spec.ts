import { PrismaService } from '../../prisma/prisma.service';
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
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const service = new InspectionPlanService(prisma);
  // 검증·조회는 이 스위트가 보지 않는다 — 저장 트랜잭션 안의 연동만 본다.
  const internals = service as unknown as Record<string, unknown>;
  internals.assertWritable = jest.fn().mockResolvedValue(undefined);
  internals.assertExists = jest.fn().mockResolvedValue(undefined);
  internals.get = jest.fn().mockResolvedValue({});
  return { service, tx, itemUpdateMany };
}

const plan = (overrides: Partial<InspectionPlanWrite>): InspectionPlanWrite => ({
  inspectionPlanCode: 'IQC-1',
  inspectionPlanName: 'IQC 기준',
  inspectionTypeCode: 'IQC',
  itemId: 40,
  defaultSkip: true,
  ...overrides,
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
    ['공통 기준(품목 없음)', { itemId: null }],
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
