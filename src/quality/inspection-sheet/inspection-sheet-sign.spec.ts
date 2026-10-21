import { ConflictException, ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { InspectionSheetEntryService } from './inspection-sheet-entry.service';
import { assertDecidable, InspectionSheetSignService } from './inspection-sheet-sign.service';

/** omf-all-around#89 · 장부 P-102 — 단계 서명·승인·확인·승인 취소. */
const STEPS = [
  { step_code: 'PROCESS_1', name_ko: '공정검사1', sign_required: true },
  { step_code: 'SHIPMENT', name_ko: '출하검사', sign_required: false },
];
const signed = new Date('2026-10-21T03:00:00Z');

const OQC = {
  first_judgment_code: 'NG',
  final_judgment_code: 'OK',
  inspection_result_id: 41n,
  inspected_worker_id: 8n,
  inspected_at: new Date('2026-10-21T04:00:00Z'),
  updated_at: new Date('2026-10-21T04:00:00Z'),
  inspected_worker: null,
};

function harness(sheet: Record<string, unknown> = {}, locked = 1, stepUpdated = 1, oqc: typeof OQC | null = null) {
  const tx = {
    inspection_sheet: {
      findUnique: jest.fn().mockResolvedValue({
        serial_number_id: 3n,
        status_code: 'IN_PROGRESS',
        approved_by: null,
        checked_by: null,
        template: { steps: STEPS },
        step_results: [{ step_code: 'PROCESS_1', source_code: 'SHEET', final_judgment_code: 'OK', signed_at: signed }],
        ...sheet,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: locked }),
    },
    inspection_sheet_step_result: { updateMany: jest.fn().mockResolvedValue({ count: stepUpdated }), upsert: jest.fn() },
    oqc_serial_result: { findUnique: jest.fn().mockResolvedValue(oqc) },
    inspection_sheet_event: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn().mockImplementation((work: (client: typeof tx) => unknown) => work(tx)) };
  const entries = { get: jest.fn().mockResolvedValue({ inspectionSheet: {}, versionNo: 9 }) };
  const service = new InspectionSheetSignService(prisma as unknown as PrismaService, entries as unknown as InspectionSheetEntryService);
  return { service, tx };
}

const thrown = (work: () => void) => {
  try {
    work();
  } catch (error) {
    return (error as ContractException).errors[0];
  }
  return undefined;
};

const errorOf = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as ContractException).errors[0];

describe('InspectionSheetSignService', () => {
  it('단계에 관리자 이름·시각으로 서명하고 이력을 남긴다', async () => {
    const { service, tx } = harness();

    await service.signStep(9, 'PROCESS_1', 3, 7);

    expect(tx.inspection_sheet_step_result.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { inspection_sheet_id: 9, step_code: 'PROCESS_1' }, data: expect.objectContaining({ signed_by: 7 }) }),
    );
    expect(tx.inspection_sheet_event.create).toHaveBeenCalledWith({
      data: { inspection_sheet_id: 9, event_code: 'SIGN_STEP', step_code: 'PROCESS_1', acted_by: 7 },
    });
  });

  it('판정이 기록되지 않은 단계는 서명할 수 없다 — 400 stepCode STATE_LOCKED', async () => {
    const { service, tx } = harness({}, 1, 0);

    await expect(errorOf(service.signStep(9, 'PROCESS_2', 3, 7))).resolves.toMatchObject({ field: 'stepCode', code: 'STATE_LOCKED' });
    expect(tx.inspection_sheet_event.create).not.toHaveBeenCalled();
  });

  it('서명이 필요한 단계가 서명 전이면 승인할 수 없다', () => {
    expect(thrown(() => assertDecidable(STEPS, [{ step_code: 'PROCESS_1', final_judgment_code: 'OK', signed_at: null }]))).toMatchObject({ code: 'STATE_LOCKED' });
    expect(thrown(() => assertDecidable(STEPS, []))?.message).toContain('공정검사1');
  });

  it('기록된 단계의 최종 판정이 NG 면 승인할 수 없다', () => {
    const error = thrown(() =>
      assertDecidable(STEPS, [
        { step_code: 'PROCESS_1', final_judgment_code: 'OK', signed_at: signed },
        { step_code: 'SHIPMENT', final_judgment_code: 'NG', signed_at: null },
      ]),
    );
    expect(error?.message).toContain('출하검사');
  });

  it('승인만 되면 작성중으로 남고, 확인까지 되면 완료다', async () => {
    const first = harness();
    await first.service.decide(9, 'APPROVE', 3, 7);
    expect(first.tx.inspection_sheet.updateMany.mock.calls[0][0].data).toMatchObject({ approved_by: 7, status_code: 'IN_PROGRESS' });

    const second = harness({ approved_by: 7n });
    await second.service.decide(9, 'CHECK', 4, 8);
    expect(second.tx.inspection_sheet.updateMany.mock.calls[0][0].data).toMatchObject({ checked_by: 8, status_code: 'COMPLETED' });
    expect(second.tx.inspection_sheet_event.create).toHaveBeenCalledWith({ data: { inspection_sheet_id: 9, event_code: 'CHECK', acted_by: 8 } });
  });

  it('잠금 버전이 다르면 409 다', async () => {
    const { service } = harness({}, 0);

    await expect(service.decide(9, 'APPROVE', 2, 7)).rejects.toBeInstanceOf(ConflictException);
  });

  it('승인 취소는 사유가 필수다 — 400 reason REQUIRED', async () => {
    const { service, tx } = harness({ approved_by: 7n, checked_by: 8n, status_code: 'COMPLETED' });

    await expect(errorOf(service.reopen(9, 5, '  ', 7))).resolves.toMatchObject({ field: 'reason', code: 'REQUIRED' });
    expect(tx.inspection_sheet.updateMany).not.toHaveBeenCalled();
  });

  it('승인 취소는 승인·확인을 비우고 작성중으로 돌리며 사유를 이력에 남긴다', async () => {
    const { service, tx } = harness({ approved_by: 7n, checked_by: 8n, status_code: 'COMPLETED' });

    await service.reopen(9, 5, ' 머리 값 오기 ', 7);

    expect(tx.inspection_sheet.updateMany.mock.calls[0][0].data).toMatchObject({
      status_code: 'IN_PROGRESS',
      approved_by: null,
      checked_by: null,
    });
    expect(tx.inspection_sheet_event.create).toHaveBeenCalledWith({
      data: { inspection_sheet_id: 9, event_code: 'REOPEN', reason: '머리 값 오기', acted_by: 7 },
    });
  });

  it('승인·확인된 적이 없으면 승인 취소할 수 없다', async () => {
    const { service } = harness();

    await expect(errorOf(service.reopen(9, 5, '사유', 7))).resolves.toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('출하검사를 시리얼 OQC 가 기록했으면 그 판정을 단계 줄(원천 OQC)에 옮겨 적고 서명한다 — #68 연결', async () => {
    const { service, tx } = harness({}, 1, 1, OQC);

    await service.signStep(9, 'SHIPMENT', 3, 7);

    const upsert = tx.inspection_sheet_step_result.upsert.mock.calls[0][0];
    expect(upsert.create).toMatchObject({
      step_code: 'SHIPMENT',
      source_code: 'OQC',
      first_judgment_code: 'NG',
      final_judgment_code: 'OK',
      inspection_result_id: 41n,
      signed_by: 7,
    });
    expect(tx.inspection_sheet_step_result.updateMany).not.toHaveBeenCalled();
  });

  it('승인 판단은 출하검사를 OQC 최종 판정으로 본다 — OQC 최종 NG 면 400', async () => {
    const { service } = harness({}, 1, 1, { ...OQC, final_judgment_code: 'NG' });

    expect(await errorOf(service.decide(9, 'APPROVE', 3, 7))).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('OQC 재검으로 기록이 서명보다 늦게 바뀌면 출하검사 서명은 풀린 것으로 본다', async () => {
    const steps = [{ step_code: 'SHIPMENT', name_ko: '출하검사', sign_required: true }];
    const { service } = harness(
      {
        template: { steps },
        step_results: [{ step_code: 'SHIPMENT', source_code: 'OQC', final_judgment_code: 'OK', signed_at: signed }],
      },
      1,
      1,
      { ...OQC, updated_at: new Date('2026-10-21T05:00:00Z') },
    );

    expect(await errorOf(service.decide(9, 'APPROVE', 3, 7))).toMatchObject({ code: 'STATE_LOCKED' });
  });
});
