import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanCopyService } from './inspection-plan-copy.service';
import { InspectionPlanVersionService } from './inspection-plan-version.service';
import { InspectionPlanService } from './inspection-plan.service';

/** omf-all-around#255 — 검사기준 복사. */
const SOURCE_VERSION = {
  inspectionPlanVersionId: 21,
  inspectionPlanId: 3,
  planVersion: 2,
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  samplingMethodCode: 'SAMPLING',
  samplingRatio: 10,
  samplingQty: null,
  aqlValue: null,
  acceptanceNumber: 0,
  rejectionNumber: 1,
  inspectionFrequencyCode: 'LOT',
  frequencyIntervalValue: null,
  frequencyIntervalUomCode: null,
  statusCode: 'CONFIRMED',
};

const SOURCE_ITEM = {
  inspectionItemSpecId: 501,
  inspectionPlanVersionId: 21,
  sequenceNo: 1,
  inspectionItemCode: 'A',
  inspectionItemName: '외관',
  nameKo: null,
  nameVi: null,
  dataTypeCode: 'TEXT',
  uomId: null,
  targetValue: null,
  lowerLimit: null,
  upperLimit: null,
  measurementCount: 1,
  acceptanceNumber: null,
  inspectionMethodCode: null,
  defaultInspectionEquipmentId: null,
  requiredFlag: true,
  automaticJudgment: true,
};

const PLAN = { inspectionPlanCode: 'P-COPY', inspectionPlanName: '복사 기준', inspectionTypeCode: 'IQC', itemId: 8 };

function harness() {
  const prisma = { inspection_plan: { delete: jest.fn() } };
  const plans = { create: jest.fn().mockResolvedValue({ inspectionPlanId: 40 }) };
  const versions = {
    get: jest.fn().mockResolvedValue({ inspectionPlanVersion: SOURCE_VERSION }),
    listItems: jest.fn().mockResolvedValue([SOURCE_ITEM]),
    create: jest.fn().mockResolvedValue({ inspectionPlanVersionId: 41 }),
    replaceItems: jest.fn().mockResolvedValue([]),
    discard: jest.fn(),
  };
  const service = new InspectionPlanCopyService(
    prisma as unknown as PrismaService,
    plans as unknown as InspectionPlanService,
    versions as unknown as InspectionPlanVersionService,
  );
  return { service, prisma, plans, versions };
}

describe('InspectionPlanCopyService', () => {
  it('원본 버전의 설정 · 항목으로 새 기준과 작성중 버전 1 을 만든다 — 항목 id 는 싣지 않는다', async () => {
    const { service, plans, versions } = harness();

    const result = await service.copy(3, { ...PLAN, sourceVersionId: 21 }, 7);

    expect(result).toEqual({ inspectionPlanId: 40, inspectionPlanVersionId: 41 });
    expect(plans.create).toHaveBeenCalledWith(PLAN);
    expect(versions.create).toHaveBeenCalledWith(
      expect.objectContaining({ inspectionPlanId: 40, samplingMethodCode: 'SAMPLING', samplingRatio: 10, inspectionFrequencyCode: 'LOT' }),
      { allowMissingRatio: true },
      7,
    );
    const [, items] = versions.replaceItems.mock.calls[0] as [number, Record<string, unknown>[]];
    expect(items).toEqual([expect.objectContaining({ inspectionItemCode: 'A', inspectionPlanVersionId: 41 })]);
    expect(items[0]).not.toHaveProperty('inspectionItemSpecId');
  });

  it('원본 버전이 경로의 기준 것이 아니면 400 이고 아무것도 만들지 않는다', async () => {
    const { service, plans } = harness();

    const error = await service.copy(99, { ...PLAN, sourceVersionId: 21 }, 7).catch((e: unknown) => e);

    expect((error as ContractException).errors[0]).toMatchObject({ field: 'sourceVersionId', code: 'INVALID' });
    expect(plans.create).not.toHaveBeenCalled();
  });

  it('항목 저장이 실패하면 만든 버전과 기준을 지운다', async () => {
    const { service, prisma, versions } = harness();
    versions.replaceItems.mockRejectedValue(new Error('boom'));

    await expect(service.copy(3, { ...PLAN, sourceVersionId: 21 }, 7)).rejects.toThrow('boom');

    expect(versions.discard).toHaveBeenCalledWith(41, 7);
    expect(prisma.inspection_plan.delete).toHaveBeenCalledWith({ where: { inspection_plan_id: 40 } });
  });

  it('버전 등록이 실패하면 기준만 지운다', async () => {
    const { service, prisma, versions } = harness();
    versions.create.mockRejectedValue(new Error('boom'));

    await expect(service.copy(3, { ...PLAN, sourceVersionId: 21 }, 7)).rejects.toThrow('boom');

    expect(versions.discard).not.toHaveBeenCalled();
    expect(prisma.inspection_plan.delete).toHaveBeenCalledWith({ where: { inspection_plan_id: 40 } });
  });
});
