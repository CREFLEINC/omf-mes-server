import { ContractException } from '../../common/errors';
import { parseUnallocatedQuery } from './inbound-allocation-view';

describe('parseUnallocatedQuery', () => {
  const errorsOf = (raw: Record<string, unknown>) => {
    try {
      parseUnallocatedQuery(raw);
    } catch (error) {
      return (error as ContractException).getResponse();
    }
    throw new Error('400 이 아니다');
  };

  it('excludeExceptionTypeCode 는 쉼표·반복을 모두 받고, 코드 모양이 아니면 400 INVALID', () => {
    expect(parseUnallocatedQuery({ excludeExceptionTypeCode: 'CUSTOMER_SUPPLY,FREE_SAMPLE' }).excludeExceptionTypeCodes).toEqual([
      'CUSTOMER_SUPPLY',
      'FREE_SAMPLE',
    ]);
    expect(parseUnallocatedQuery({ excludeExceptionTypeCode: ['CUSTOMER_SUPPLY', 'FREE_SAMPLE,X1'] }).excludeExceptionTypeCodes).toEqual([
      'CUSTOMER_SUPPLY',
      'FREE_SAMPLE',
      'X1',
    ]);
    expect(parseUnallocatedQuery({}).excludeExceptionTypeCodes).toBeUndefined();
    for (const bad of ['', 'CUSTOMER_SUPPLY,', 'customer_supply', 'A B', ['OK', 1]]) {
      expect(errorsOf({ excludeExceptionTypeCode: bad })).toMatchObject({
        errors: [expect.objectContaining({ field: 'excludeExceptionTypeCode', code: 'INVALID' })],
      });
    }
  });
});
