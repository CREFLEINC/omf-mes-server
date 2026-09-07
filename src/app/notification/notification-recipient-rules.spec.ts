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
});
