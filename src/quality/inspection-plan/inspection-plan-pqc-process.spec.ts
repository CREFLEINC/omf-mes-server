import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionPlanService, InspectionPlanWrite } from './inspection-plan.service';

/** PQC 기준은 공정이 필수다(사용자 결정 2026-11-04). */
function harness(storedProcessId: bigint | null = null) {
  const prisma = {
    inspection_plan: { findUnique: jest.fn().mockResolvedValue({ process_id: storedProcessId }) },
  } as unknown as PrismaService;
  const service = new InspectionPlanService(prisma);
  const assertPqcProcess = (service as unknown as Record<string, (input: InspectionPlanWrite, self: number | null) => Promise<void>>)
    .assertPqcProcess.bind(service);
  return { assertPqcProcess, prisma };
}

const plan = (overrides: Partial<InspectionPlanWrite>): InspectionPlanWrite => ({
  inspectionPlanCode: 'P-1', inspectionPlanName: '기준', inspectionTypeCode: 'PQC', ...overrides,
});

describe('PQC 기준 — 공정 필수', () => {
  it('공정 없이 등록하면 400 REQUIRED(processId)', async () => {
    const { assertPqcProcess } = harness();
    const error = await assertPqcProcess(plan({ processId: null }), null).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).getResponse()).toMatchObject({ errors: [{ field: 'processId', code: 'REQUIRED' }] });
  });

  it('공정이 있으면 통과한다', async () => {
    await expect(harness().assertPqcProcess(plan({ processId: 2 }), null)).resolves.toBeUndefined();
  });

  it('수정 본문에 공정이 없으면 저장된 값을 본다', async () => {
    await expect(harness(2n).assertPqcProcess(plan({}), 1)).resolves.toBeUndefined();
    await expect(harness(null).assertPqcProcess(plan({}), 1)).rejects.toBeInstanceOf(ContractException);
  });

  it.each(['IQC', 'OQC'])('%s 는 공정을 비워도 된다', async (type) => {
    const { assertPqcProcess, prisma } = harness();
    await expect(assertPqcProcess(plan({ inspectionTypeCode: type, processId: null }), null)).resolves.toBeUndefined();
    expect(prisma.inspection_plan.findUnique).not.toHaveBeenCalled();
  });
});
