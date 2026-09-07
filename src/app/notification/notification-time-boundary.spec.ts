import { ContractRegistry, ContractValidator } from '../../common/contract';
import { notificationTimeBoundary } from './notification-time-boundary';

describe('알림 기간의 마이크로초 경계', () => {
  const validator = new ContractValidator(ContractRegistry.load());

  it.each([
    '2026-09-07T00:00:00Z',
    '2026-09-07T00:00:00.1+07:00',
    '2026-09-07T00:00:00.000001Z',
    '2026-09-07T00:00:00.999999-05:00',
  ])('6자리 이하 %s는 원문 그대로 유지한다', (value) => {
    expect(notificationTimeBoundary(value)).toBe(value);
  });

  it.each([
    ['0000010', '000001'],
    ['000001000', '000001'],
    ['0000010000', '000001'],
    ['0000001', '000001'],
    ['000000001', '000001'],
    ['0000000001', '000001'],
    ['0000011', '000002'],
    ['000001001', '000002'],
    ['0000010001', '000002'],
    ['1234564999', '123457'],
    ['1234569999', '123457'],
    ['9999990000', '999999'],
  ])('7·9·10자리 소수 %s는 버리는 숫자가 0이 아닐 때만 올린다', (input, expected) => {
    expect(notificationTimeBoundary(`2026-09-07T00:00:00.${input}+07:00`)).toBe(
      `2026-09-07T00:00:00.${expected}+07:00`,
    );
  });

  it.each([
    ['2026-12-31T23:59:58', '2026-12-31T23:59:59'],
    ['2026-12-31T23:58:59', '2026-12-31T23:59:00'],
    ['2026-12-31T22:59:59', '2026-12-31T23:00:00'],
    ['2026-12-30T23:59:59', '2026-12-31T00:00:00'],
    ['2026-04-30T23:59:59', '2026-05-01T00:00:00'],
    ['2026-12-31T23:59:59', '2027-01-01T00:00:00'],
    ['2028-02-28T23:59:59', '2028-02-29T00:00:00'],
    ['2028-02-29T23:59:59', '2028-03-01T00:00:00'],
    ['2100-02-28T23:59:59', '2100-03-01T00:00:00'],
    ['2000-02-28T23:59:59', '2000-02-29T00:00:00'],
  ])('%s의 .999999 초과분은 날짜 자리까지 이월한다', (input, expected) => {
    for (const fraction of ['9999991', '999999001', '9999990001']) {
      for (const offset of ['Z', '+07:00', '-05:30']) {
        expect(notificationTimeBoundary(`${input}.${fraction}${offset}`)).toBe(
          `${expected}.000000${offset}`,
        );
      }
    }
  });

  it.each([
    'T',
    't',
    ' ',
    '\t',
    '\n',
    '\r',
    '\v',
    '\f',
    '\u00a0',
    '\u1680',
    '\u2000',
    '\u2001',
    '\u2002',
    '\u2003',
    '\u2004',
    '\u2005',
    '\u2006',
    '\u2007',
    '\u2008',
    '\u2009',
    '\u200a',
    '\u2028',
    '\u2029',
    '\u202f',
    '\u205f',
    '\u3000',
    '\ufeff',
  ])('고정 Ajv 허용 구분자 %j와 offset 조합을 정규화한다', (separator) => {
    for (const [offset, expectedOffset] of [
      ['Z', 'Z'],
      ['z', 'Z'],
      ['+07', '+07:00'],
      ['+0700', '+07:00'],
      ['+07:00', '+07:00'],
      ['-05', '-05:00'],
      ['-0530', '-05:30'],
      ['-05:30', '-05:30'],
    ]) {
      for (const [fraction, expectedSeconds, expectedFraction] of [
        ['', '2026-12-31T23:59:59', ''],
        ['.000001', '2026-12-31T23:59:59', '.000001'],
        ['.9999991', '2027-01-01T00:00:00', '.000000'],
        ['.9999990001', '2027-01-01T00:00:00', '.000000'],
      ]) {
        const input = `2026-12-31${separator}23:59:59${fraction}${offset}`;
        expect(
          validator.validate('GET /app/notifications', {
            query: { occurredFrom: input, occurredTo: input },
          }),
        ).toEqual([]);
        expect(notificationTimeBoundary(input)).toBe(
          `${expectedSeconds}${expectedFraction}${expectedOffset}`,
        );
      }
    }
  });
});
