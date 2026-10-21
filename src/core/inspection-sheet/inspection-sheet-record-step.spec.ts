import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { InspectionSheetService, RecordStepInput } from './inspection-sheet.service';

/** omf-all-around#89 · 장부 P-102 — 한 단계의 판정을 쓴다. 출하검사 줄은 시리얼 OQC(#68)도 이 길로 쓴다. */
const STEPS = [
  { step_code: 'PROCESS_1', items: [{ inspection_sheet_template_item_id: 101n }, { inspection_sheet_template_item_id: 102n }] },
  { step_code: 'SHIPMENT', items: [] },
];

function tx(sheet: { status_code?: string; previousSource?: string } = {}) {
  return {
    inspection_sheet: {
      findUnique: jest.fn().mockResolvedValue({ inspection_sheet_id: 9n }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        status_code: sheet.status_code ?? 'IN_PROGRESS',
        template: { steps: STEPS },
        step_results: sheet.previousSource === undefined ? [] : [{ source_code: sheet.previousSource }],
      }),
    },
    inspection_sheet_step_result: { upsert: jest.fn() },
    inspection_sheet_item_result: { upsert: jest.fn() },
  };
}

const INPUT: RecordStepInput = {
  stepCode: 'PROCESS_1',
  firstJudgmentCode: 'NG',
  finalJudgmentCode: 'OK',
  items: [{ templateItemId: 101n, judgmentCode: 'NG' }],
  source: 'SHEET',
  inspectedAt: new Date('2026-10-21T03:00:00Z'),
};

const run = (client: ReturnType<typeof tx>, input: Partial<RecordStepInput> = {}) =>
  new InspectionSheetService().recordStep(client as unknown as Prisma.TransactionClient, 3n, { ...INPUT, ...input }, { workerId: 8n });

const errorOf = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as ContractException).errors[0];

describe('InspectionSheetService.recordStep', () => {
  it('단계 판정과 항목 판정을 쓰고, 다시 쓰면 서명을 푼다', async () => {
    const client = tx();

    await run(client);

    const upsert = client.inspection_sheet_step_result.upsert.mock.calls[0][0];
    expect(upsert.create).toMatchObject({
      step_code: 'PROCESS_1',
      source_code: 'SHEET',
      first_judgment_code: 'NG',
      final_judgment_code: 'OK',
      inspected_worker_id: 8n,
    });
    expect(upsert.update).toMatchObject({ signed_by: null, signed_at: null });
    expect(client.inspection_sheet_item_result.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ inspection_sheet_template_item_id: 101n, judgment_code: 'NG' }) }),
    );
  });

  it('시리얼 OQC 가 출하검사 줄을 OQC 결과와 함께 쓴다', async () => {
    const client = tx();

    await run(client, { stepCode: 'SHIPMENT', items: undefined, source: 'OQC', inspectionResultId: 55n, firstJudgmentCode: 'OK' });

    expect(client.inspection_sheet_step_result.upsert.mock.calls[0][0].create).toMatchObject({
      step_code: 'SHIPMENT',
      source_code: 'OQC',
      inspection_result_id: 55n,
    });
  });

  it('⛔ 다른 원천이 이미 쓴 단계는 400 STATE_LOCKED 다', async () => {
    await expect(errorOf(run(tx({ previousSource: 'OQC' })))).resolves.toMatchObject({ field: 'stepCode', code: 'STATE_LOCKED' });
  });

  it('⛔ 완료된 검사표는 400 STATE_LOCKED 다', async () => {
    await expect(errorOf(run(tx({ status_code: 'COMPLETED' })))).resolves.toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('기준에 없는 단계는 400 stepCode INVALID 다', async () => {
    await expect(errorOf(run(tx(), { stepCode: 'PROCESS_5' }))).resolves.toMatchObject({ field: 'stepCode', code: 'INVALID' });
  });

  it('그 단계의 항목이 아니면 400 items INVALID 다', async () => {
    const items = [{ templateItemId: 999n, judgmentCode: 'OK' as const }];
    await expect(errorOf(run(tx(), { items }))).resolves.toMatchObject({ field: 'items', code: 'INVALID' });
  });

  it('1차가 OK 인데 최종이 NG 면 400 이다', async () => {
    const client = tx();

    await expect(errorOf(run(client, { firstJudgmentCode: 'OK', finalJudgmentCode: 'NG' }))).resolves.toMatchObject({
      field: 'finalJudgmentCode',
    });
    expect(client.inspection_sheet_step_result.upsert).not.toHaveBeenCalled();
  });
});
