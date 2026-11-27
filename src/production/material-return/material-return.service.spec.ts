import { ContractException, ErrorItem } from '../../common/errors';
import { MaterialReturnReceive, assertReceiveBody } from './material-return.service';

function errorsOf(body: MaterialReturnReceive): ErrorItem[] {
  try {
    assertReceiveBody(body);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ContractException);
    return ((error as ContractException).getResponse() as { errors: ErrorItem[] }).errors;
  }
}

const BODY: MaterialReturnReceive = {
  businessDate: '2026-11-28', occurredAt: '2026-11-28T09:10:00+07:00', lines: [{ lotId: 1, returnQty: 20 }],
};

describe('반납 입고 본문 형식(피처 019 §4)', () => {
  it('US1-2 업무일·발생 시각·LOT 줄이 맞으면 통과한다', () => {
    expect(errorsOf(BODY)).toEqual([]);
  });

  it('C-8 업무일은 YYYY-MM-DD, 발생 시각은 시각 형식이다', () => {
    expect(errorsOf({ ...BODY, businessDate: '2026/11/28', occurredAt: 'nope' }).map((item) => item.field)).toEqual(['businessDate', 'occurredAt']);
  });

  it('US1-5 한 건에 같은 LOT 이 두 줄이면 400 — 반납 가능 양이 두 벌이 된다', () => {
    const errors = errorsOf({ ...BODY, lines: [{ lotId: 1, returnQty: 5 }, { lotId: 2, returnQty: 5 }, { lotId: 1, returnQty: 5 }] });
    expect(errors).toEqual([expect.objectContaining({ field: 'lines[2].lotId', code: 'INVALID' })]);
  });
});
