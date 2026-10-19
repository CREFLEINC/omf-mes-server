import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordCreate, DefectRecordWriteService } from './defect-record-write.service';

jest.mock('../../common/master', () => ({
  ...jest.requireActual('../../common/master'),
  assertCodeValues: async () => undefined,
}));

type Row = Record<string, unknown>;

/** omf-all-around#106 — 불량 기록 등록(장부 P-42). */
function harness(options: {
  iqcProcess?: boolean;
  result?: { lot_id: bigint | null; work_order_id: bigint | null } | null;
  consumption?: Row | null;
} = {}) {
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
    material_consumption: {
      findFirst: async () =>
        options.consumption === undefined
          ? { material_consumption_id: 61n, work_order_id: 41n, actual_use_process_id: 33n, work_order: { routing_operation: { process_id: 34n } } }
          : options.consumption,
    },
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
    await service.create(iqc(), { appUserId: 9 });

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
    const error = await service.create(iqc(), { appUserId: 9 }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it('IQC 가 아니면 공정이 필수다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ sourceCode: 'PQC' }), { appUserId: 9 }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'occurrenceProcessId', code: 'REQUIRED' });
  });

  it('공정을 주면 그대로 쓴다(#108 PQC 자재 불량)', async () => {
    const { service, created } = harness();
    await service.create(iqc({ sourceCode: 'PQC', occurrenceProcessId: 11, detectionProcessId: 12 }), { appUserId: 9 });

    expect(created[0]).toMatchObject({ occurrence_process_id: 11n, detection_process_id: 12n });
  });

  it('검사 결과의 LOT 과 다른 LOT 을 실으면 400 이다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ lotId: 21 }), { appUserId: 9 }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'lotId', code: 'INVALID' });
  });

  it('없는 검사 결과는 400 이다', async () => {
    const { service } = harness({ result: null });
    const error = await service.create(iqc(), { appUserId: 9 }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'inspectionResultId', code: 'INVALID' });
  });

  it('검사 결과도 생산 실적도 없으면 500 이 아니라 400 REQUIRED 다(ck_defect_source)', async () => {
    const { service, created } = harness();
    const error = await service.create(iqc({ inspectionResultId: null }), { appUserId: 9 }).catch((caught: unknown) => caught);
    expect(firstError(error)).toMatchObject({ field: 'inspectionResultId', code: 'REQUIRED' });
    expect(created).toHaveLength(0);
  });

  it('수량이 0 이하면 400 RANGE 다', async () => {
    const { service } = harness();
    const error = await service.create(iqc({ defectQty: 0 }), { appUserId: 9 }).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'defectQty', code: 'RANGE' });
  });

  /* 오프라인 확정 본문의 사유(P-42) — 트랜잭션 밖 검증과 안의 쓰기가 갈린다. */
  it('검사 결과 본문의 사유를 수입검사 공정으로 준비하고, 0 이하 수량은 400 이다', async () => {
    const { service } = harness();

    await expect(service.prepareInspectionDefects([{ defectCodeId: 5, defectQty: 2 }], 1)).resolves.toMatchObject({
      processId: 70n,
      uomId: 1,
    });
    const error = await service.prepareInspectionDefects([{ defectCodeId: 5, defectQty: 0 }], 1).catch((e: unknown) => e);
    expect(firstError(error)).toMatchObject({ field: 'defects[0].defectQty', code: 'RANGE' });
  });

  it('사유를 검사 결과·LOT 에 붙여 같은 트랜잭션에서 쓴다', async () => {
    const { service } = harness();
    const rows: Record<string, unknown>[] = [];
    const tx = { defect_record: { create: async ({ data }: { data: Record<string, unknown> }) => rows.push(data) } };

    await service.writeInspectionDefectsWithin(
      tx as never,
      { rows: [{ defectCodeId: 5, defectQty: 2, defectDescription: '찍힘' }], processId: 70n, uomId: 1 },
      { inspectionResultId: 40n, lotId: 20n, workOrderId: null, detectedAt: new Date('2026-10-16T02:00:00Z') },
      { workerId: 8n },
    );

    expect(rows[0]).toMatchObject({
      source_type_code: 'IQC',
      inspection_result_id: 40n,
      lot_id: 20n,
      occurrence_process_id: 70n,
      detection_process_id: 70n,
      defect_description: '찍힘',
      worker_id: 8n,
      created_by: null,
    });
  });
});

/** omf-all-around#108 — 투입 뒤 자재 불량(장부 P-52). */
describe('자재 불량(MATERIAL)', () => {
  const material = (extra: Partial<DefectRecordCreate> = {}): DefectRecordCreate => ({
    sourceCode: 'MATERIAL',
    defectCodeId: 5,
    defectQty: 3,
    uomId: 1,
    detectedAt: '2026-10-16T01:00:00Z',
    lotId: 20,
    ...extra,
  });

  it('투입 기록에서 작업지시와 투입 공정을 채운다', async () => {
    const { service, created } = harness();
    await service.create(material(), { appUserId: 9 });
    expect(created[0]).toMatchObject({
      source_type_code: 'MATERIAL', lot_id: 20n, work_order_id: 41n,
      occurrence_process_id: 33n, detection_process_id: 33n,
      source_document_id: 61n, // ck_defect_source — 투입 기록이 원천 문서다
    });
  });

  it('투입 공정이 비면 그 작업지시의 라우팅 공정이다', async () => {
    const { service, created } = harness({
      consumption: { work_order_id: 41n, actual_use_process_id: null, work_order: { routing_operation: { process_id: 34n } } },
    });
    await service.create(material(), { appUserId: 9 });
    expect(created[0]).toMatchObject({ occurrence_process_id: 34n, detection_process_id: 34n });
  });

  it('LOT 이 없거나 투입 기록이 없으면 400 이다', async () => {
    const { service } = harness({ consumption: null });
    await expect(service.create(material({ lotId: null }), { appUserId: 9 })).rejects.toBeInstanceOf(ContractException);
    await expect(service.create(material(), { appUserId: 9 })).rejects.toBeInstanceOf(ContractException);
  });

  it('단말 작업자가 주체면 계정 없이 그 작업자로 남긴다', async () => {
    const { service, created } = harness();
    await service.create(material(), { workerId: 77n });
    expect(created[0]).toMatchObject({ worker_id: 77n, created_by: null });
  });
});
