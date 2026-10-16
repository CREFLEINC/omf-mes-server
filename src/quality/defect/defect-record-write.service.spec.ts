import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordCreate, DefectRecordWriteService } from './defect-record-write.service';

jest.mock('../../common/master', () => ({
  ...jest.requireActual('../../common/master'),
  assertCodeValues: async () => undefined,
}));

type Row = Record<string, unknown>;

/** omf-all-around#106 — 불량 기록 등록(장부 P-39). */
function harness(options: { iqcProcess?: boolean; result?: { lot_id: bigint | null; work_order_id: bigint | null } | null } = {}) {
  const created: Row[] = [];
  const prisma = {
    inspection_result: {
      findUnique: async () =>
        options.result === null ? null : { inspection_request: options.result ?? { lot_id: 20n, work_order_id: null } },
    },
    process: {
      findUnique: async ({ where }: { where: Row }) =>
        where.process_code === 'IQC'
          ? options.iqcProcess === false
            ? null
            : { process_id: 70n, is_active: true }
          : { process_id: where.process_id },
    },
    defect_code: { findUnique: async () => ({ is_active: true }) },
    uom: { findUnique: async () => ({ uom_id: 1n }) },
    lot: { findUnique: async () => ({ lot_id: 20n }) },
    worker: { findFirst: async () => ({ worker_id: 8n }) },
    defect_record: {
      create: async ({ data }: { data: Row }) => {
        created.push(data);
        return {
          ...data,
          defect_record_id: 1n,
          detected_at: data.detected_at,
          occurred_at: data.occurred_at,
          defect_qty: data.defect_qty,
        };
      },
    },
  } as unknown as PrismaService;
  return { service: new DefectRecordWriteService(prisma), created };
}

const iqc = (extra: Partial<DefectRecordCreate> = {}): DefectRecordCreate => ({
  sourceCode: 'IQC',
  defectCodeId: 5,
  defectQty: 3,
  uomId: 1,
  detectedAt: '2026-10-16T02:00:00.000Z',
  inspectionResultId: 40,
  defectDescription: '외관 스크래치',
  ...extra,
});

const firstError = (error: unknown) => (error as ContractException).errors[0];

describe('DefectRecordWriteService', () => {
  it('IQC 는 공정을 생략하면 수입검사 공정으로 채우고, LOT 은 검사 의뢰의 것을 따른다', async () => {
    const { service, created } = harness();
    await service.create(iqc(), 9);

    expect(created[0]).toMatchObject({
      source_type_code: 'IQC',
      occurrence_process_id: 70n,
      detection_process_id: 70n,
      inspection_result_id: 40n,
      lot_id: 20n,
      defect_description: '외관 스크래치',
      worker_id: 8n,
      created_by: 9n,
    });
  });

  it('수입검사 공정이 기준정보에 없으면 400 STATE_LOCKED 다', async () => {
    const { service } = harness({ iqcProcess: false });
    const error = await service.create(iqc(), 9).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('IQC 가 아니면 공정이 필수다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ sourceCode: 'PQC' }), 9).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'occurrenceProcessId', code: 'REQUIRED' });
  });

  it('공정을 주면 그대로 쓴다(#108 PQC 자재 불량)', async () => {
    const { service, created } = harness();
    await service.create(iqc({ sourceCode: 'PQC', occurrenceProcessId: 11, detectionProcessId: 12, inspectionResultId: null }), 9);

    expect(created[0]).toMatchObject({ occurrence_process_id: 11n, detection_process_id: 12n });
  });

  it('검사 결과의 LOT 과 다른 LOT 을 실으면 400 이다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ lotId: 21 }), 9).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'lotId', code: 'INVALID' });
  });

  it('없는 검사 결과는 400 이다', async () => {
    const { service } = harness({ result: null });
    const error = await service.create(iqc(), 9).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'inspectionResultId', code: 'INVALID' });
  });

  it('수량이 0 이하면 400 RANGE 다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ defectQty: 0 }), 9).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'defectQty', code: 'RANGE' });
  });
});
