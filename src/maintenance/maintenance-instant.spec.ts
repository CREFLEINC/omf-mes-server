import { ContractException, ERROR_CODE } from '../common/errors';
import { ContractRegistry } from '../common/contract/contract-registry';
import { ContractValidator } from '../common/contract/contract-validator';
import { maintenanceInstantFromEpoch, parseMaintenanceInstant } from './maintenance-instant';

const validator = new ContractValidator(ContractRegistry.load());

function expectInputError(value: string, code: string, fieldName = 'startedAt'): void {
  let caught: unknown;
  try {
    parseMaintenanceInstant(value, fieldName);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContractException);
  expect((caught as ContractException).getStatus()).toBe(400);
  expect((caught as ContractException).errors).toEqual([
    { scope: 'field', field: fieldName, code, message: expect.any(String) },
  ]);
}

function expectContractDateTime(value: string): void {
  expect(
    validator.validate('POST /maintenance/downtimes', {
      body: { equipmentId: 1, reasonCode: 'OTHER', startedAt: value },
    }),
  ).toEqual([]);
}

describe('maintenance instant', () => {
  it.each([
    ['2026-09-06T03:00:00.123456Z', '1788663600123456', '2026-09-06T03:00:00.123456Z'],
    ['2026-09-06t10:00:00.123456+07:00', '1788663600123456', '2026-09-06T03:00:00.123456Z'],
    ['2026-09-06 10:00:00.1+07', '1788663600100000', '2026-09-06T03:00:00.100000Z'],
    ['2026-09-06T10:00:00+0700', '1788663600000000', '2026-09-06T03:00:00.000000Z'],
    ['2026-09-06T03:00:00z', '1788663600000000', '2026-09-06T03:00:00.000000Z'],
  ])('Ajv 문법 %s를 같은 순간의 ISO6로 정규화한다', (value, epoch, iso) => {
    expectContractDateTime(value);
    expect(parseMaintenanceInstant(value, 'startedAt')).toMatchObject({
      epochMicroseconds: BigInt(epoch),
      utcIso: iso,
    });
  });

  it.each([
    ['2026-09-07T00:00:00.123456000Z', '2026-09-07T00:00:00.123456Z'],
    ['2026-09-07T00:00:00.1200Z', '2026-09-07T00:00:00.120000Z'],
    ['2026-09-07T00:00:00Z', '2026-09-07T00:00:00.000000Z'],
  ])('물리 정밀도 안의 %s를 절삭이나 반올림 없이 보존한다', (value, iso) => {
    expectContractDateTime(value);
    expect(parseMaintenanceInstant(value, 'endedAt').utcIso).toBe(iso);
  });

  it('연도 0000·0099와 윤년을 Date의 0..99 특례 없이 해석한다', () => {
    const yearZero = parseMaintenanceInstant('0000-02-29T00:00:00Z', 'startedAt');
    expect(yearZero.utcIso).toBe('0000-02-29T00:00:00.000000Z');
    expect(yearZero.sqlTimestamp).toBe('0001-02-29 00:00:00.000000+00 BC');
    expect(parseMaintenanceInstant('0099-12-31T23:59:59.9Z', 'startedAt').utcIso).toBe(
      '0099-12-31T23:59:59.900000Z',
    );
    expect(parseMaintenanceInstant('2000-02-29T12:00:00Z', 'startedAt').utcIso).toBe(
      '2000-02-29T12:00:00.000000Z',
    );
  });

  it.each([
    ['2026-09-07T00:00:00+23:59', '2026-09-06T00:01:00.000000Z'],
    ['2026-09-07T00:00:00-23:59', '2026-09-07T23:59:00.000000Z'],
  ])('큰 offset %s를 UTC로 먼저 옮긴다', (value, iso) => {
    expectContractDateTime(value);
    expect(parseMaintenanceInstant(value, 'startedAt').utcIso).toBe(iso);
  });

  it.each([
    ['-1', '1969-12-31T23:59:59.999999Z'],
    ['-1000', '1969-12-31T23:59:59.999000Z'],
    ['-1001', '1969-12-31T23:59:59.998999Z'],
    ['0', '1970-01-01T00:00:00.000000Z'],
  ])('음수 epoch %s를 floor millisecond와 양의 나머지로 복원한다', (epoch, iso) => {
    expect(maintenanceInstantFromEpoch(epoch).utcIso).toBe(iso);
  });

  it.each(['2016-12-31T23:59:60Z', '2016-12-31T23:59:60.1Z'])(
    'Ajv가 허용하는 윤초 %s는 익일로 접지 않고 RANGE다',
    (value) => {
      expectContractDateTime(value);
      expectInputError(value, ERROR_CODE.RANGE);
    },
  );

  it.each([
    '2026-09-07T00:00:00.1234561Z',
    '2026-09-07T00:00:00.0000000001Z',
  ])('6자리 뒤 비영 소수 %s는 RANGE다', (value) => {
    expectContractDateTime(value);
    expectInputError(value, ERROR_CODE.RANGE);
  });

  it.each([
    '2026-02-29T00:00:00Z',
    '2026-09-07T24:00:00Z',
    '2026-09-07T00:00:00+24:00',
    '2026-09-07T00:00:00',
    '2026-9-7T00:00:00Z',
  ])('잘못된 문법이나 달력 %s는 INVALID다', (value) => {
    expectInputError(value, ERROR_CODE.INVALID, 'endedAt');
  });

  it.each([
    '0000-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59.999999-00:01',
  ])('offset 정규화 뒤 UTC 4자리 연도 밖인 %s는 입력 RANGE다', (value) => {
    expectContractDateTime(value);
    expectInputError(value, ERROR_CODE.RANGE);
  });

  it('서버 현재시각과 비교하지 않아 먼 미래도 허용한다', () => {
    expect(parseMaintenanceInstant('9999-01-01T00:00:00Z', 'startedAt').utcIso).toBe(
      '9999-01-01T00:00:00.000000Z',
    );
  });

  it.each(['', '1.5', ' 1', '0x10'])('잘못된 저장 epoch %s는 일반 Error다', (value) => {
    expect(() => maintenanceInstantFromEpoch(value)).toThrow(Error);
    expect(() => maintenanceInstantFromEpoch(value)).not.toThrow(ContractException);
  });

  it.each([0, false, null, undefined, new Date(0)])(
    '선언 타입 밖 저장 epoch %p를 조용히 변환하지 않는다',
    (value) => {
      expect(() => maintenanceInstantFromEpoch(value as never)).toThrow(
        'Invalid stored maintenance epoch microseconds',
      );
    },
  );

  it.each(['-62167219200000001', '253402300800000000'])(
    '저장 UTC 응답연도 밖 %s는 일반 Error다',
    (value) => {
      expect(() => maintenanceInstantFromEpoch(value)).toThrow('outside the UTC response range');
    },
  );
});
