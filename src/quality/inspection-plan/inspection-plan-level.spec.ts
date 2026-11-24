import { ConflictException, ContractException } from '../../common/errors';
import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanService, InspectionPlanWrite } from './inspection-plan.service';

/** omf-all-around#357 — 「기본 정보 수정」의 검사 수준은 기본 정보와 한 트랜잭션에서 저장한다. */
function harness(options: { after?: Record<string, unknown>; level?: Record<string, unknown> | null; levelUpdated?: number } = {}) {
  const histories: Record<string, unknown>[] = [];
  const tx = {
    inspection_plan: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ inspection_type_code: 'IQC', item_id: 40n, default_skip: false, ...options.after }),
    },
    item: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    routing_operation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    item_inspection_level: {
      findUnique: jest.fn().mockResolvedValue(options.level === undefined ? null : options.level),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: options.levelUpdated ?? 1 }),
    },
    item_inspection_level_history: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => histories.push(data)),
    },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const service = new InspectionPlanService(prisma, { next: jest.fn() } as unknown as NumberingService);
  const internals = service as unknown as Record<string, unknown>;
  internals.assertWritable = jest.fn().mockResolvedValue(undefined);
  internals.assertExists = jest.fn().mockResolvedValue(undefined);
  internals.get = jest.fn().mockResolvedValue({});
  return { service, tx, histories };
}

const plan = (overrides: Partial<InspectionPlanWrite> = {}): InspectionPlanWrite => ({
  inspectionPlanCode: 'IQC-1',
  inspectionPlanName: 'IQC 기준',
  inspectionTypeCode: 'IQC',
  itemId: 40,
  ...overrides,
});

const LEVEL_ROW = { item_inspection_level_id: 5n, inspection_level_code: 'NORMAL', version_no: 3 };

describe('검사 기준 수정 — 검사 수준 동시 저장(omf-all-around#357)', () => {
  it('수준이 없던 품목이면 수준 행과 최초 지정 이력을 같은 트랜잭션에서 만든다', async () => {
    const { service, tx, histories } = harness();
    await service.update(1, 1, plan({ inspectionLevelCode: 'REDUCED', inspectionLevelReason: ' 연속 합격 ' }), 7);

    expect(tx.item_inspection_level.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ item_id: 40n, inspection_level_code: 'REDUCED', created_by: 7 }),
    });
    expect(histories).toEqual([
      expect.objectContaining({ from_level_code: null, to_level_code: 'REDUCED', reason: '연속 합격', change_type_code: 'MANUAL' }),
    ]);
  });

  it('수준이 바뀌면 읽은 판으로 잠가 고치고 이전→새 이력을 남긴다', async () => {
    const { service, tx, histories } = harness({ level: LEVEL_ROW });
    await service.update(1, 1, plan({ inspectionLevelCode: 'TIGHTENED' }), 7);

    expect(tx.item_inspection_level.updateMany).toHaveBeenCalledWith({
      where: { item_inspection_level_id: 5n, version_no: 3 },
      data: expect.objectContaining({ inspection_level_code: 'TIGHTENED', consecutive_accept_count: 0 }),
    });
    expect(histories).toEqual([expect.objectContaining({ from_level_code: 'NORMAL', to_level_code: 'TIGHTENED', reason: null })]);
  });

  it('같은 수준이면 아무것도 쓰지 않는다', async () => {
    const { service, tx, histories } = harness({ level: LEVEL_ROW });
    await service.update(1, 1, plan({ inspectionLevelCode: 'NORMAL' }), 7);

    expect(tx.item_inspection_level.updateMany).not.toHaveBeenCalled();
    expect(histories).toEqual([]);
  });

  it('수준을 생략하면 수준 표를 건드리지 않는다 — 종전 저장과 같다', async () => {
    const { service, tx } = harness();
    await service.update(1, 1, plan(), 7);
    expect(tx.item_inspection_level.findUnique).not.toHaveBeenCalled();
  });

  it('그 사이 수준이 바뀌었으면 409 — 트랜잭션째 실패해 기본 정보도 저장되지 않는다', async () => {
    const { service, histories } = harness({ level: LEVEL_ROW, levelUpdated: 0 });
    const error = await service.update(1, 1, plan({ inspectionLevelCode: 'TIGHTENED' }), 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(histories).toEqual([]);
  });

  it.each([
    ['IQC 가 아닌 기준', { inspection_type_code: 'OQC' }],
    ['품목이 없는 IQC 기준', { item_id: null }],
  ])('%s 이면 400 inspectionLevelCode INVALID — 트랜잭션째 실패한다', async (_label, after) => {
    const { service, tx } = harness({ after });
    const error = await service.update(1, 1, plan({ inspectionLevelCode: 'NORMAL' }), 7).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect(error).toMatchObject({ response: { errors: [expect.objectContaining({ field: 'inspectionLevelCode', code: 'INVALID' })] } });
    expect(tx.item_inspection_level.create).not.toHaveBeenCalled();
  });
});
