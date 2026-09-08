import { ContractRegistry, ContractValidator } from '../../common/contract';
import { documentIssueTimeBoundary } from './document-issue-time-boundary';

describe('발행 이력 기간의 마이크로초 경계 (I-27 P1t)', () => {
  const validator = new ContractValidator(ContractRegistry.load());

  it.each([
    ['2026-09-07T00:00:00.0000001Z', '2026-09-07T00:00:00.000001Z'],
    ['2026-09-07T00:00:00.1234560+07:00', '2026-09-07T00:00:00.123456+07:00'],
    ['2026-09-07T00:00:00.1234561-05:30', '2026-09-07T00:00:00.123457-05:30'],
  ])('%s를 PostgreSQL 마이크로초 격자의 올림값으로 바꾼다', (input, expected) => {
    expect(documentIssueTimeBoundary(input)).toBe(expected);
  });

  it.each([
    ['2026-12-31T23:59:59.9999991Z', '2027-01-01T00:00:00.000000Z'],
    ['2028-02-29T23:59:59.9999991+07:00', '2028-03-01T00:00:00.000000+07:00'],
    ['2100-02-28T23:59:59.9999991-05:30', '2100-03-01T00:00:00.000000-05:30'],
  ])('%s의 초 올림을 날짜 자리까지 전파한다', (input, expected) => {
    expect(documentIssueTimeBoundary(input)).toBe(expected);
  });

  it('계약이 허용한 구분자와 offset을 Prisma가 읽는 표기로 정규화한다', () => {
    const input = '2026-09-07 00:00:00.0000001+0700';
    expect(
      validator.validate('GET /app/document-issues', {
        query: { issuedFrom: input },
      }),
    ).toEqual([]);
    expect(documentIssueTimeBoundary(input)).toBe('2026-09-07T00:00:00.000001+07:00');
  });

  it.each([
    '2026-09-07T00:00:00Z',
    '2026-09-07T00:00:00.1+07:00',
    '2026-09-07T00:00:00.000001-05:30',
  ])('마이크로초 이하 정규 표기 %s는 유지한다', (input) => {
    expect(documentIssueTimeBoundary(input)).toBe(input);
  });
});
