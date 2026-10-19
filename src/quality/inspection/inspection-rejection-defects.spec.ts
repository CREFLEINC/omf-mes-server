import { ContractException } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DefectRecordWriteService } from '../defect/defect-record-write.service';
import { prepareRejectionDefects } from './inspection-rejection-defects';

/** omf-all-around#106 — 오프라인 확정(`POST …/inspection-results` statusCode=CONFIRMED)도 IQC 불합격 사유를 요구한다. */
function harness(type: string) {
  const prisma = {
    inspection_request: {
      findUnique: jest.fn().mockResolvedValue({ inspection_type_code: type, lot_id: 20n, work_order_id: null }),
    },
  } as unknown as PrismaService;
  const defects = {
    prepareInspectionDefects: jest.fn().mockResolvedValue({ rows: [], processId: 70n, uomId: 1 }),
  } as unknown as DefectRecordWriteService;
  return { prisma, defects };
}

const body = (extra: Record<string, unknown> = {}) => ({
  inspectionRequestId: 9,
  overallJudgmentCode: 'REJECTED',
  uomId: 1,
  ...extra,
});
const reason = [{ defectCodeId: 5, defectQty: 3, defectDescription: '스크래치' }];
const firstError = (error: unknown) => (error as ContractException).errors[0];

describe('prepareRejectionDefects', () => {
  it('IQC 불합격으로 확정하는데 사유가 없으면 400 defects REQUIRED 다', async () => {
    const { prisma, defects } = harness('IQC');
    const error = await prepareRejectionDefects(prisma, defects, body(), true).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'defects', code: 'REQUIRED' });
  });

  it('IQC 불합격 + 사유면 검증한 사유와 LOT 을 돌려준다', async () => {
    const { prisma, defects } = harness('IQC');
    const prepared = await prepareRejectionDefects(prisma, defects, body({ defects: reason }), true);

    expect(defects.prepareInspectionDefects).toHaveBeenCalledWith(reason, 1);
    expect(prepared?.target).toEqual({ lotId: 20n, workOrderId: null });
  });

  it.each([
    ['작성중 저장', body(), false],
    ['IQC 합격 확정', body({ overallJudgmentCode: 'ACCEPTED' }), true],
  ])('%s 은 사유를 요구하지 않는다', async (_label, input, bornConfirmed) => {
    const { prisma, defects } = harness('IQC');
    await expect(prepareRejectionDefects(prisma, defects, input, bornConfirmed)).resolves.toBeNull();
  });

  it('PQC 불합격 확정은 이번 규칙 밖이다(POP 오프라인 PQC 를 막지 않는다)', async () => {
    const { prisma, defects } = harness('PQC');
    await expect(prepareRejectionDefects(prisma, defects, body(), true)).resolves.toBeNull();
  });

  it('IQC 가 아닌 결과에 사유를 실으면 400 이다', async () => {
    const { prisma, defects } = harness('OQC');
    const error = await prepareRejectionDefects(prisma, defects, body({ defects: reason }), true).catch((e: unknown) => e);

    expect(firstError(error)).toMatchObject({ field: 'defects', code: 'INVALID' });
  });
});
