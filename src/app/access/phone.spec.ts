import { ContractException } from '../../common/errors';
import { readPhone } from './phone';

describe('readPhone', () => {
  it.each(['0912345678', '+84912345678', '84912345678', '0912 345-678'])(
    'US5-3 %s 는 표준형 84912345678 이 된다',
    (input) => {
      expect(readPhone(input)).toBe('84912345678');
    },
  );

  it.each([
    ['0212345678', '유선'],
    ['091234567', '9자리'],
    ['09123456ab', '문자 포함'],
    ['', '빈 문자열'],
    ['849123456789', '12자리'],
  ])('US5-2 %s(%s)는 400 phoneNumber 로 거부한다', (input) => {
    const error = catchError(() => readPhone(input));
    expect(error.getStatus()).toBe(400);
    expect(error.errors.map((item) => item.field)).toEqual(['phoneNumber']);
  });

  it('US5-2 문자열이 아닌 값은 거부한다', () => {
    expect(() => readPhone(912345678)).toThrow(ContractException);
  });

  it('null 은 지움, 생략은 유지로 그대로 넘긴다', () => {
    expect(readPhone(null)).toBeNull();
    expect(readPhone(undefined)).toBeUndefined();
  });
});

function catchError(run: () => unknown): ContractException {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractException) return error;
    throw error;
  }
  throw new Error('던지지 않았다');
}
