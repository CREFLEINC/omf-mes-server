import { HttpStatus } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';

export type NotificationRecipientTypeCode = 'ROLE' | 'USER';

export interface NotificationRecipientInput {
  recipientTypeCode: NotificationRecipientTypeCode;
  businessUnitId?: number;
  roleId?: number;
  userId?: number;
}

export interface NotificationSubscriptionReplaceInput {
  recipients: NotificationRecipientInput[];
  zaloEnabled?: boolean;
}

export interface RoleRecipientRule {
  businessUnitId: number;
  roleId: number;
}

export function assertNotificationRecipientRules(
  recipients: NotificationRecipientInput[],
): void {
  const errors: ErrorItem[] = [];
  const seen = new Map<string, number>();

  recipients.forEach((recipient, index) => {
    const shapeErrors = recipientShapeErrors(recipient, index);
    errors.push(...shapeErrors);
    if (shapeErrors.length > 0) return;
    const rangeErrors = recipientIdRangeErrors(recipient, index);
    errors.push(...rangeErrors);
    if (rangeErrors.length > 0) return;

    const key = recipientKey(recipient);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    errors.push({
      scope: 'field',
      field: `recipients[${index}]`,
      code: ERROR_CODE.UNIQUE_VIOLATION,
      uniqueScope:
        recipient.recipientTypeCode === 'ROLE'
          ? ['businessUnitId', 'roleId']
          : ['userId'],
      message: `${first + 1}번째와 같은 수신자 규칙입니다.`,
    });
  });

  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

// 결정 — I-28 R-11 통보: JSON 숫자로 이미 받은 값의 안전 경계다.
function recipientIdRangeErrors(
  recipient: NotificationRecipientInput,
  index: number,
): ErrorItem[] {
  const ids: [string, number | undefined][] =
    recipient.recipientTypeCode === 'ROLE'
      ? [
          ['businessUnitId', recipient.businessUnitId],
          ['roleId', recipient.roleId],
        ]
      : [['userId', recipient.userId]];
  return ids.flatMap(([field, value]) =>
    Number.isSafeInteger(value)
      ? []
      : [
          {
            scope: 'field',
            field: `recipients[${index}].${field}`,
            code: ERROR_CODE.RANGE,
            message: '안전한 정수 범위여야 합니다.',
          },
        ],
  );
}

export function roleRecipientRules(
  recipients: NotificationRecipientInput[],
): RoleRecipientRule[] {
  return recipients.flatMap((recipient) => {
    if (
      recipient.recipientTypeCode !== 'ROLE' ||
      recipient.businessUnitId === undefined ||
      recipient.roleId === undefined
    ) {
      return [];
    }
    return [{ businessUnitId: recipient.businessUnitId, roleId: recipient.roleId }];
  });
}

export function directRecipientUserIds(recipients: NotificationRecipientInput[]): number[] {
  return recipients.flatMap((recipient) =>
    recipient.recipientTypeCode === 'USER' && recipient.userId !== undefined
      ? [recipient.userId]
      : [],
  );
}

function recipientShapeErrors(
  recipient: NotificationRecipientInput,
  index: number,
): ErrorItem[] {
  const fields: [string, boolean][] =
    recipient.recipientTypeCode === 'ROLE'
      ? [
          ['businessUnitId', recipient.businessUnitId === undefined],
          ['roleId', recipient.roleId === undefined],
          ['userId', recipient.userId !== undefined],
        ]
      : [
          ['userId', recipient.userId === undefined],
          ['businessUnitId', recipient.businessUnitId !== undefined],
          ['roleId', recipient.roleId !== undefined],
        ];
  return fields.flatMap(([field, invalid]) =>
    invalid
      ? [
          {
            scope: 'field' as const,
            field: `recipients[${index}].${field}`,
            code: ERROR_CODE.PAIR,
            message: '수신자 유형에 맞는 필드 조합을 지정해야 합니다.',
          },
        ]
      : [],
  );
}

function recipientKey(recipient: NotificationRecipientInput): string {
  return recipient.recipientTypeCode === 'ROLE'
    ? `ROLE:${recipient.businessUnitId}:${recipient.roleId}`
    : `USER:${recipient.userId}`;
}
