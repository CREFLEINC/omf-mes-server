import { ContractException } from '../../common/errors';
import { parseQuery } from './dashboard-quality-lots.service';

function errorsOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractException) return error.getResponse();
    throw error;
  }
  throw new Error('400 이 나지 않았다');
}

describe('dashboard quality lots query', () => {
  it('inspectionType 은 INSPECTION_HELD 에만 걸고, 다른 status 에서는 버린다', () => {
    expect(parseQuery({ status: 'INSPECTION_HELD', inspectionType: 'IQC' }).inspectionType).toBe('IQC');
    expect(parseQuery({ status: 'INSPECTION_HELD' }).inspectionType).toBeUndefined();
    expect(parseQuery({ status: 'RECEIPT_HOLD', inspectionType: 'PQC' }).inspectionType).toBeUndefined();
  });

  it('inspectionType 이 IQC·PQC·OQC 가 아니면 400 field INVALID 다', () => {
    expect(errorsOf(() => parseQuery({ status: 'INSPECTION_HELD', inspectionType: 'iqc' }))).toMatchObject({
      errors: [{ scope: 'field', field: 'inspectionType', code: 'INVALID' }],
    });
  });
});
