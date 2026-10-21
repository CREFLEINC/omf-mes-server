import { ConflictException, ContractException } from '../../common/errors';
import { InspectionSheetService } from '../../core/inspection-sheet';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionSheetEntryService } from './inspection-sheet-entry.service';

/** omf-all-around#89 · 장부 P-102 — 검사표 쓰기는 검사표 한 장의 잠금 버전으로 묶인다. */
function harness(
  status = 'IN_PROGRESS',
  locked = 1,
  workers: { worker_no: string; worker_id: bigint }[] = [],
  approvedBy: bigint | null = null,
) {
  const tx = {
    inspection_sheet: {
      findUnique: jest.fn().mockResolvedValue({ serial_number_id: 3n, status_code: status, approved_by: approvedBy, checked_by: null }),
      updateMany: jest.fn().mockResolvedValue({ count: locked }),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        template: { steps: [{ step_code: 'PROCESS_1', items: [{ inspection_sheet_template_item_id: 101n }] }] },
        step_results: [],
      }),
    },
    inspection_sheet_step_result: { upsert: jest.fn() },
    inspection_sheet_item_result: { upsert: jest.fn() },
    inspection_sheet_ng: { deleteMany: jest.fn(), createMany: jest.fn() },
    inspection_sheet_event: { create: jest.fn() },
    worker: { findMany: jest.fn().mockResolvedValue(workers) },
  };
  const prisma = { $transaction: jest.fn().mockImplementation((work: (client: typeof tx) => unknown) => work(tx)) };
  const service = new InspectionSheetEntryService(prisma as unknown as PrismaService, new InspectionSheetService());
  jest.spyOn(service, 'get').mockResolvedValue({ inspectionSheet: {} as never, versionNo: 2 });
  return { service, tx };
}

const NG = { ngContent: '나사 누락', repairWorkerNo: 'W-01' };
const ITEMS = [{ inspectionSheetTemplateItemId: 101, judgmentCode: 'OK' as const }];
const errorOf = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as ContractException).errors[0];

describe('InspectionSheetEntryService', () => {
  it('완료된 검사표의 머리 값은 고칠 수 없다 — 400 STATE_LOCKED', async () => {
    const { service, tx } = harness('COMPLETED');
    const error = await service.updateHeader(9, 1, { rohsFlag: true }, { workerId: 8n }).catch((e: unknown) => e);

    expect((error as ContractException).errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    expect(tx.inspection_sheet.update).not.toHaveBeenCalled();
  });

  it('승인·확인 중 하나만 된 검사표를 고치면 그 승인·확인을 풀고 고친 작업자를 이력에 남긴다', async () => {
    const { service, tx } = harness('IN_PROGRESS', 1, [], 7n);

    await service.updateHeader(9, 1, { rohsFlag: true }, { workerId: 8n });

    expect(tx.inspection_sheet.updateMany.mock.calls[0][0].data).toMatchObject({
      approved_by: null,
      approved_at: null,
      checked_by: null,
      checked_at: null,
    });
    expect(tx.inspection_sheet_event.create).toHaveBeenCalledWith({
      data: { inspection_sheet_id: 9, event_code: 'APPROVAL_CLEARED', acted_by: null, acted_worker_id: 8n },
    });
  });

  it('승인·확인이 없던 검사표를 고칠 때는 이력을 남기지 않는다', async () => {
    const { service, tx } = harness();

    await service.updateHeader(9, 1, { rohsFlag: true }, { workerId: 8n });

    expect(tx.inspection_sheet_event.create).not.toHaveBeenCalled();
  });

  it('잠금 버전이 다르면 409 다', async () => {
    const { service } = harness('IN_PROGRESS', 0);

    await expect(service.updateHeader(9, 1, { rohsFlag: true }, { workerId: 8n })).rejects.toBeInstanceOf(ConflictException);
  });

  it('판정 두 칸을 빼면 항목 판정만 임시 저장한다 — 단계 판정 줄은 만들지 않고 검사표 잠금 버전은 올린다', async () => {
    const { service, tx } = harness();

    await service.writeStep(9, 'PROCESS_1', 1, { items: ITEMS }, { workerId: 8n });

    expect(tx.inspection_sheet.updateMany).toHaveBeenCalled();
    expect(tx.inspection_sheet_step_result.upsert).not.toHaveBeenCalled();
    expect(tx.inspection_sheet_item_result.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { inspection_sheet_id: 9, inspection_sheet_template_item_id: 101n, judgment_code: 'OK' } }),
    );
  });

  it('판정을 하나만 주면 400 이다 — 빠진 칸 INVALID', async () => {
    const { service, tx } = harness();

    expect(await errorOf(service.writeStep(9, 'PROCESS_1', 1, { firstJudgmentCode: 'OK', items: ITEMS }, { workerId: 8n }))).toMatchObject({
      field: 'finalJudgmentCode',
      code: 'INVALID',
    });
    expect(tx.inspection_sheet.updateMany).not.toHaveBeenCalled();
  });

  it('임시 저장에 항목이 없으면 400 items REQUIRED 다', async () => {
    const { service } = harness();

    expect(await errorOf(service.writeStep(9, 'PROCESS_1', 1, { items: [] }, { workerId: 8n }))).toMatchObject({
      field: 'items',
      code: 'REQUIRED',
    });
  });

  it('판정이 기록된 단계는 임시 저장할 수 없다 — 400 stepCode STATE_LOCKED', async () => {
    const { service, tx } = harness();
    tx.inspection_sheet.findUniqueOrThrow.mockResolvedValue({
      template: { steps: [{ step_code: 'PROCESS_1', items: [{ inspection_sheet_template_item_id: 101n }] }] },
      step_results: [{ step_code: 'PROCESS_1' }],
    });

    expect(await errorOf(service.writeStep(9, 'PROCESS_1', 1, { items: ITEMS }, { workerId: 8n }))).toMatchObject({
      field: 'stepCode',
      code: 'STATE_LOCKED',
    });
    expect(tx.inspection_sheet_item_result.upsert).not.toHaveBeenCalled();
  });

  it('임시 저장의 항목이 그 단계 것이 아니면 400 items INVALID 다', async () => {
    const { service } = harness();

    expect(
      await errorOf(service.writeStep(9, 'PROCESS_1', 1, { items: [{ inspectionSheetTemplateItemId: 999, judgmentCode: 'OK' }] }, { workerId: 8n })),
    ).toMatchObject({ field: 'items', code: 'INVALID' });
  });

  it('NG 블록은 통째로 갈아 끼우고, 수리 담당은 사번을 작업자로 푼다', async () => {
    const { service, tx } = harness('IN_PROGRESS', 1, [{ worker_no: 'W-01', worker_id: 21n }]);

    await service.replaceNgs(9, 1, [NG], { workerId: 8n });

    expect(tx.inspection_sheet_ng.deleteMany).toHaveBeenCalledWith({ where: { inspection_sheet_id: 9 } });
    expect(tx.inspection_sheet_ng.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ sequence_no: 1, ng_content: '나사 누락', repair_worker_id: 21n })],
    });
  });

  it('없는 사번이면 400 ngs[i].repairWorkerNo INVALID 다', async () => {
    const { service, tx } = harness();
    const error = await service.replaceNgs(9, 1, [NG], { workerId: 8n }).catch((e: unknown) => e);

    expect((error as ContractException).errors[0]).toMatchObject({ field: 'ngs[0].repairWorkerNo', code: 'INVALID' });
    expect(tx.inspection_sheet_ng.createMany).not.toHaveBeenCalled();
  });
});
