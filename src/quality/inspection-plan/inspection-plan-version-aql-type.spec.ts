import { ContractException, ERROR_CODE } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanVersionService, ItemSpecUpsert } from './inspection-plan-version.service';

/** 검사를 지나면 다음 단계에서 멈춘다 — 저장 트랜잭션은 이 스위트가 보지 않는다. */
const PASSED = new Error('passed');

/** omf-all-around#264 — AQL 샘플링은 IQC 기준에서만 쓴다(사용자 결정 2026-11-12). */
describe('검사기준 버전 — AQL 샘플링은 IQC 기준만', () => {
  function harness(inspectionTypeCode: string) {
    const prisma = {
      inspection_plan: { findUnique: jest.fn().mockResolvedValue({ inspection_type_code: inspectionTypeCode }) },
      inspection_plan_version: { findFirst: jest.fn().mockRejectedValue(PASSED) },
    } as unknown as PrismaService;
    const service = new InspectionPlanVersionService(prisma);
    (service as unknown as Record<string, unknown>).assertWritable = jest.fn().mockResolvedValue(undefined);
    return service;
  }
  const aql = {
    inspectionPlanId: 1,
    effectiveFrom: '2026-11-12',
    samplingMethodCode: 'AQL',
    aqlValue: 0.4,
    aqlInspectionLevelCode: 'G-II',
  } as Parameters<InspectionPlanVersionService['create']>[0];

  it.each(['PQC', 'OQC'])('%s 기준에 AQL 샘플링 버전을 만들면 400 samplingMethodCode INVALID', async (type) => {
    const error = await harness(type).create(aql).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors[0]).toMatchObject({
      field: 'samplingMethodCode',
      code: ERROR_CODE.INVALID,
    });
  });

  it('IQC 기준은 AQL 샘플링을 받는다', async () => {
    await expect(harness('IQC').create(aql)).rejects.toBe(PASSED);
  });

  it('AQL 이 아니면 기준을 읽지 않는다', async () => {
    await expect(harness('PQC').create({ ...aql, samplingMethodCode: 'FULL_INSPECTION' })).rejects.toBe(PASSED);
  });
});

/** omf-all-around#262 — 저장된 항목을 코드 없이 다시 보내면 저장된 코드를 그대로 둔다. */
describe('검사 항목 저장 — 비운 항목코드', () => {
  const item = (overrides: Partial<ItemSpecUpsert>): ItemSpecUpsert => ({
    inspectionPlanVersionId: 1,
    sequenceNo: 1,
    inspectionItemName: '외관',
    dataTypeCode: 'BOOLEAN',
    measurementCount: 1,
    requiredFlag: true,
    automaticJudgment: true,
    ...overrides,
  });

  async function codesSent(items: ItemSpecUpsert[]): Promise<string[]> {
    const prisma = {
      inspection_item_spec: { findMany: jest.fn().mockResolvedValue([{ inspection_item_spec_id: 11n }]) },
    } as unknown as PrismaService;
    const service = new InspectionPlanVersionService(prisma);
    const internals = service as unknown as Record<string, unknown>;
    internals.assertDraft = jest.fn().mockResolvedValue(undefined);
    internals.readItems = jest.fn().mockResolvedValue([{ inspectionItemSpecId: 11, inspectionItemCode: 'VIS-01' }]);
    const targets = jest.fn().mockRejectedValue(PASSED);
    internals.assertItemTargets = targets;
    await expect(service.replaceItems(1, items)).rejects.toBe(PASSED);
    return (targets.mock.calls[0][0] as { inspectionItemCode: string }[]).map((row) => row.inspectionItemCode);
  }

  it('저장된 항목은 순서가 바뀌어도 저장된 코드, 새 항목은 ITEM-{순서}', async () => {
    await expect(
      codesSent([item({ sequenceNo: 1 }), item({ sequenceNo: 2, inspectionItemSpecId: 11 })]),
    ).resolves.toEqual(['ITEM-001', 'VIS-01']);
  });
});
