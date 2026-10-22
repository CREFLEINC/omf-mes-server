import { NumberingService } from '../../core/numbering';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService } from '../defect/defect-record-write.service';
import { InspectionConfirmService } from './inspection-confirm.service';
import { reopenInspectionRequestWithin, startInspectionRequestWithin } from './inspection-request-reopen';
import { InspectionResultCreate, InspectionResultWriteContext } from './inspection-result-write-input';
import { preparePqcWrite } from './inspection-result-write-rules';
import { InspectionResultWriteService } from './inspection-result-write.service';

jest.mock('./inspection-request-reopen');
jest.mock('./inspection-result-write-rules', () => ({
  ...jest.requireActual('./inspection-result-write-rules'),
  assertCodes: jest.fn(),
  resolveInspector: jest.fn().mockResolvedValue(5n),
  assertReferences: jest.fn().mockResolvedValue(1),
  preparePqcWrite: jest.fn(),
  assertAccountWorker: jest.fn().mockResolvedValue(5n),
  assertJudgmentChange: jest.fn(),
}));
jest.mock('./four-m-change', () => ({
  prepareFourMChange: jest.fn().mockResolvedValue(null),
  prepareFourMChangeOfResult: jest.fn().mockResolvedValue(null),
  writeFourMChangeWithin: jest.fn(),
}));
jest.mock('./inspection-rejection-defects', () => ({
  prepareRejectionDefects: jest.fn().mockResolvedValue(null),
  prepareDraftDefects: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./oqc-serials', () => ({ prepareOqcSerials: jest.fn().mockResolvedValue(null) }));
jest.mock('./iqc-nonconformance', () => ({ allocateIqcNonconformanceNo: jest.fn() }));
jest.mock('./inspection-result-view', () => ({ INSPECTION_RESULT_JOIN: {}, inspectionResultView: jest.fn((row: unknown) => row) }));

/** 작성중 회차 저장이 대기 의뢰를 «진행»으로 옮긴다(omf-all-around#164) — IQC·OQC·PQC 가 같은 `POST` 를 탄다. */
const serviceFor = (pqcDraftId: bigint | null = null, stored = { status_code: 'DRAFT', version_no: 8, inspection_request_id: 7n }) => {
  jest.mocked(preparePqcWrite).mockResolvedValue(pqcDraftId);
  const tx = {
    inspection_result: {
      create: jest.fn().mockResolvedValue({ inspection_result_id: 21n }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ inspection_result_id: 21n }),
      findUnique: jest.fn().mockResolvedValue(stored),
    },
    inspection_measurement: { deleteMany: jest.fn() },
  };
  const prisma = { $transaction: jest.fn((run: (client: typeof tx) => unknown) => Promise.resolve(run(tx))) } as unknown as PrismaService;
  const numbering = { next: jest.fn().mockResolvedValue('IRS-1') } as unknown as NumberingService;
  const confirms = { applyConfirmEffects: jest.fn() } as unknown as InspectionConfirmService;
  return new InspectionResultWriteService(prisma, numbering, confirms, {} as DefectRecordWriteService);
};

const body = (patch: Partial<InspectionResultCreate> = {}): InspectionResultCreate => ({
  inspectionRequestId: 7,
  inspectedQty: 10,
  acceptedQty: 10,
  rejectedQty: 0,
  heldQty: 0,
  uomId: 1,
  inspectedAt: '2026-10-22T01:00:00Z',
  statusCode: 'DRAFT',
  ...patch,
});
const context: InspectionResultWriteContext = { workerNo: undefined, idempotencyKey: 'k', version: undefined, appUserId: 3, terminalId: null };

describe('InspectionResultWriteService.create — 의뢰 진행 전이(#164)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('⭐ 작성중 저장이면 의뢰를 대기 → 진행으로 옮긴다', async () => {
    await serviceFor().create(body(), context);

    expect(startInspectionRequestWithin).toHaveBeenCalledWith(expect.anything(), 7n, 3);
    expect(reopenInspectionRequestWithin).not.toHaveBeenCalled();
  });

  it('PQC 작성중 1회차를 덮어도(P-49) 같은 전이를 탄다', async () => {
    await serviceFor(12n).create(body(), context);

    expect(startInspectionRequestWithin).toHaveBeenCalledWith(expect.anything(), 7n, 3);
  });

  it('재검사 회차를 작성중으로 더하면 끝난 의뢰도 다시 연다(P-43)', async () => {
    await serviceFor().create(body({ previousResultId: 11, reinspectionReasonCode: 'RE' }), context);

    expect(startInspectionRequestWithin).toHaveBeenCalledWith(expect.anything(), 7n, 3);
    expect(reopenInspectionRequestWithin).toHaveBeenCalledWith(expect.anything(), 7n, 3);
  });

  it('⛔ 확정으로 태어나는 저장은 진행을 거치지 않는다 — 확정이 완료로 닫는다', async () => {
    await serviceFor().create(body({ statusCode: 'CONFIRMED', overallJudgmentCode: 'ACCEPTED' }), context);

    expect(startInspectionRequestWithin).not.toHaveBeenCalled();
    expect(reopenInspectionRequestWithin).not.toHaveBeenCalled();
  });
});

describe('InspectionResultWriteService.update — 작성중 회차 다시 저장(#164)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('⭐ 작성중 회차를 PUT 으로 다시 저장해도 대기 의뢰를 진행으로 옮긴다', async () => {
    await serviceFor().update(21, 8, { acceptedQty: 9 }, context);

    expect(startInspectionRequestWithin).toHaveBeenCalledWith(expect.anything(), 7n, 3);
  });

  it('⛔ 확정된 회차는 409 로 막히고 의뢰도 건드리지 않는다', async () => {
    await expect(
      serviceFor(null, { status_code: 'CONFIRMED', version_no: 8, inspection_request_id: 7n }).update(21, 8, {}, context),
    ).rejects.toThrow();

    expect(startInspectionRequestWithin).not.toHaveBeenCalled();
  });

  it('⛔ 버전이 다르면 막히고 의뢰도 건드리지 않는다', async () => {
    await expect(serviceFor().update(21, 7, {}, context)).rejects.toThrow();

    expect(startInspectionRequestWithin).not.toHaveBeenCalled();
  });
});
