import type { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { assertRejectionRecorded } from './inspection-confirm.service';

/** omf-all-around#106 — IQC 불합격 확정은 불량 기록(사유)이 있어야 한다(장부 P-39). */
function tx(type: string, recorded: number) {
  return {
    inspection_request: { findUnique: jest.fn().mockResolvedValue({ inspection_type_code: type }) },
    defect_record: { count: jest.fn().mockResolvedValue(recorded) },
  } as unknown as Prisma.TransactionClient;
}

describe('assertRejectionRecorded', () => {
  it('IQC 불합격인데 불량 기록이 없으면 400 defectRecords REQUIRED 다', async () => {
    const error = await assertRejectionRecorded(tx('IQC', 0), 8n, 9n, 'REJECTED').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContractException);
    expect((error as ContractException).errors[0]).toMatchObject({ field: 'defectRecords', code: 'REQUIRED' });
  });

  it('IQC 불합격이어도 불량 기록이 있으면 통과한다', async () => {
    await expect(assertRejectionRecorded(tx('IQC', 1), 8n, 9n, 'REJECTED')).resolves.toBeUndefined();
  });

  it.each([
    ['IQC', 'ACCEPTED'],
    ['IQC', 'HELD'],
    ['PQC', 'REJECTED'],
    ['OQC', 'REJECTED'],
  ])('%s %s 은 보지 않는다', async (type, judgment) => {
    await expect(assertRejectionRecorded(tx(type, 0), 8n, 9n, judgment)).resolves.toBeUndefined();
  });
});
