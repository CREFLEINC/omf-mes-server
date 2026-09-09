import { ContractException, ERROR_CODE } from '../../common/errors';
import {
  assertNotificationRecipientRules,
  directRecipientUserIds,
  roleRecipientRules,
} from './notification-recipient-rules';

describe('notification recipient rules', () => {
  it('ROLE과 USER 규칙을 분리한다', () => {
    const recipients = [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: 11, roleId: 21 },
      { recipientTypeCode: 'USER' as const, userId: 31 },
    ];
    expect(roleRecipientRules(recipients)).toEqual([{ businessUnitId: 11, roleId: 21 }]);
    expect(directRecipientUserIds(recipients)).toEqual([31]);
  });

  it.each([
    [{ recipientTypeCode: 'ROLE' as const, roleId: 21 }, 'recipients[0].businessUnitId'],
    [{ recipientTypeCode: 'ROLE' as const, businessUnitId: 11 }, 'recipients[0].roleId'],
    [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: 11, roleId: 21, userId: 31 },
      'recipients[0].userId',
    ],
    [{ recipientTypeCode: 'USER' as const }, 'recipients[0].userId'],
    [
      { recipientTypeCode: 'USER' as const, userId: 31, businessUnitId: 11 },
      'recipients[0].businessUnitId',
    ],
    [{ recipientTypeCode: 'USER' as const, userId: 31, roleId: 21 }, 'recipients[0].roleId'],
  ])('조건부 필드가 어긋나면 %s의 정확한 필드를 PAIR로 가리킨다', (recipient, field) => {
    expect(() => assertNotificationRecipientRules([recipient])).toThrow(ContractException);
    try {
      assertNotificationRecipientRules([recipient]);
    } catch (error) {
      expect((error as ContractException).errors).toContainEqual(
        expect.objectContaining({ field, code: ERROR_CODE.PAIR }),
      );
    }
  });

  it.each([
    [
      [
        { recipientTypeCode: 'ROLE' as const, businessUnitId: 11, roleId: 21 },
        { recipientTypeCode: 'ROLE' as const, businessUnitId: 11, roleId: 21 },
      ],
      ['businessUnitId', 'roleId'],
    ],
    [
      [
        { recipientTypeCode: 'USER' as const, userId: 31 },
        { recipientTypeCode: 'USER' as const, userId: 31 },
      ],
      ['userId'],
    ],
  ])('같은 규칙은 두 번째 행과 정확한 uniqueScope로 거부한다', (recipients, uniqueScope) => {
    try {
      assertNotificationRecipientRules(recipients);
      throw new Error('예외가 필요합니다.');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractException);
      expect((error as ContractException).errors).toEqual([
        expect.objectContaining({
          field: 'recipients[1]',
          code: ERROR_CODE.UNIQUE_VIOLATION,
          uniqueScope,
        }),
      ]);
    }
  });

  it('빈 배열과 서로 다른 규칙은 허용한다', () => {
    expect(() => assertNotificationRecipientRules([])).not.toThrow();
    expect(() =>
      assertNotificationRecipientRules([
        { recipientTypeCode: 'ROLE', businessUnitId: 11, roleId: 21 },
        { recipientTypeCode: 'ROLE', businessUnitId: 11, roleId: 22 },
        { recipientTypeCode: 'USER', userId: 31 },
      ]),
    ).not.toThrow();
  });

  it.each([
    { recipientTypeCode: 'ROLE' as const, businessUnitId: Number.MAX_SAFE_INTEGER, roleId: 0 },
    { recipientTypeCode: 'ROLE' as const, businessUnitId: -1, roleId: Number.MIN_SAFE_INTEGER },
    { recipientTypeCode: 'USER' as const, userId: Number.MAX_SAFE_INTEGER },
    { recipientTypeCode: 'USER' as const, userId: 0 },
    { recipientTypeCode: 'USER' as const, userId: Number.MIN_SAFE_INTEGER },
  ])('안전한 정수 경계·0·음수는 RANGE가 아니라 기존 FK 판정으로 넘긴다 (%j)', (recipient) => {
    expect(() => assertNotificationRecipientRules([recipient])).not.toThrow();
  });

  it.each([
    [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: Number.MAX_SAFE_INTEGER + 1, roleId: 1 },
      'recipients[0].businessUnitId',
    ],
    [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: Number.MIN_SAFE_INTEGER - 1, roleId: 1 },
      'recipients[0].businessUnitId',
    ],
    [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: 1, roleId: Number.MAX_SAFE_INTEGER + 1 },
      'recipients[0].roleId',
    ],
    [
      { recipientTypeCode: 'ROLE' as const, businessUnitId: 1, roleId: Number.MIN_SAFE_INTEGER - 1 },
      'recipients[0].roleId',
    ],
    [
      { recipientTypeCode: 'USER' as const, userId: Number.MAX_SAFE_INTEGER + 1 },
      'recipients[0].userId',
    ],
    [
      { recipientTypeCode: 'USER' as const, userId: Number.MIN_SAFE_INTEGER - 1 },
      'recipients[0].userId',
    ],
  ])('안전 범위 밖 ID는 참조 조회 전에 정확한 field의 RANGE다', (recipient, field) => {
    // 결정 — I-28 R-11 통보
    try {
      assertNotificationRecipientRules([recipient]);
      throw new Error('예외가 필요합니다.');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractException);
      expect((error as ContractException).errors).toEqual([
        expect.objectContaining({ field, code: ERROR_CODE.RANGE }),
      ]);
    }
  });

  it('숫자로 alias된 두 ROLE ID도 중복으로 접지 않고 각각 RANGE다', () => {
    const first = Number('9007199254740992');
    const second = Number('9007199254740993');
    expect(first).toBe(second);
    try {
      assertNotificationRecipientRules([
        { recipientTypeCode: 'ROLE', businessUnitId: first, roleId: 1 },
        { recipientTypeCode: 'ROLE', businessUnitId: second, roleId: 1 },
      ]);
      throw new Error('예외가 필요합니다.');
    } catch (error) {
      expect((error as ContractException).errors).toEqual([
        expect.objectContaining({ field: 'recipients[0].businessUnitId', code: ERROR_CODE.RANGE }),
        expect.objectContaining({ field: 'recipients[1].businessUnitId', code: ERROR_CODE.RANGE }),
      ]);
    }
  });
});
