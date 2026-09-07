import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import {
  assertNotificationRecipientRules,
  directRecipientUserIds,
  NotificationRecipientInput,
  NotificationSubscriptionReplaceInput,
  roleRecipientRules,
} from './notification-recipient-rules';
import {
  countActiveRecipients,
  NotificationPreviewUser,
  NotificationPreviewView,
} from './notification-preview-view';

interface PreviewUserRow {
  app_user_id: bigint;
  user_name: string;
  is_active: boolean;
  department_name: string | null;
}

@Injectable()
export class NotificationPreviewService {
  async previewWithin(
    tx: Prisma.TransactionClient,
    input: NotificationSubscriptionReplaceInput,
  ): Promise<NotificationPreviewView> {
    assertNotificationRecipientRules(input.recipients);
    await this.assertReferencesExist(tx, input.recipients);

    const roleRules = roleRecipientRules(input.recipients);
    const directUserIds = directRecipientUserIds(input.recipients);
    const rows = await this.readUsersInOneSnapshot(tx, directUserIds, roleRules);
    const users: NotificationPreviewUser[] = rows.map((row) => ({
      userId: Number(row.app_user_id),
      userName: row.user_name,
      isActive: row.is_active,
      ...(row.department_name === null ? {} : { departmentName: row.department_name }),
    }));

    return {
      resolvedAt: new Date().toISOString(),
      // 설계 미정 — 문의 101: inactive는 표시하되 실제 수신 인원에서는 제외한다.
      totalCount: countActiveRecipients(users),
      users,
    };
  }

  private readUsersInOneSnapshot(
    tx: Prisma.TransactionClient,
    directUserIds: number[],
    roleRules: { businessUnitId: number; roleId: number }[],
  ): Promise<PreviewUserRow[]> {
    const predicates = roleRules.map(
      (rule) => Prisma.sql`
        (d.business_unit_id = ${BigInt(rule.businessUnitId)} AND EXISTS (
          SELECT 1 FROM app.user_role ur
           WHERE ur.app_user_id = u.app_user_id
             AND ur.role_id = ${BigInt(rule.roleId)}
        ))`,
    );
    if (directUserIds.length > 0) {
      predicates.push(
        Prisma.sql`u.app_user_id IN (${Prisma.join(directUserIds.map(BigInt))})`,
      );
    }
    const recipientMatch =
      predicates.length === 0 ? Prisma.sql`FALSE` : Prisma.join(predicates, ' OR ');

    return tx.$queryRaw<PreviewUserRow[]>(Prisma.sql`
      SELECT u.app_user_id, u.user_name, u.is_active, d.department_name
        FROM app.app_user u
        LEFT JOIN mdm.department d ON d.department_id = u.department_id
       WHERE ${recipientMatch}
       ORDER BY u.app_user_id ASC
    `);
  }

  private async assertReferencesExist(
    tx: Prisma.TransactionClient,
    recipients: NotificationRecipientInput[],
  ): Promise<void> {
    const businessUnitIds = uniqueIds(
      roleRecipientRules(recipients).map((rule) => rule.businessUnitId),
    );
    const roleIds = uniqueIds(roleRecipientRules(recipients).map((rule) => rule.roleId));
    const userIds = uniqueIds(directRecipientUserIds(recipients));
    const [businessUnits, roles, users] = await Promise.all([
      tx.business_unit.findMany({
        where: { business_unit_id: { in: businessUnitIds.map(BigInt) } },
        select: { business_unit_id: true },
      }),
      tx.role.findMany({
        where: { role_id: { in: roleIds.map(BigInt) } },
        select: { role_id: true },
      }),
      tx.app_user.findMany({
        where: { app_user_id: { in: userIds.map(BigInt) } },
        select: { app_user_id: true },
      }),
    ]);
    const knownBusinessUnits = new Set(businessUnits.map((row) => Number(row.business_unit_id)));
    const knownRoles = new Set(roles.map((row) => Number(row.role_id)));
    const knownUsers = new Set(users.map((row) => Number(row.app_user_id)));
    const errors = recipients.flatMap((recipient, index) =>
      missingReferenceErrors(recipient, index, knownBusinessUnits, knownRoles, knownUsers),
    );
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function missingReferenceErrors(
  recipient: NotificationRecipientInput,
  index: number,
  businessUnitIds: Set<number>,
  roleIds: Set<number>,
  userIds: Set<number>,
): ErrorItem[] {
  const errors: ErrorItem[] = [];
  if (
    recipient.recipientTypeCode === 'ROLE' &&
    recipient.businessUnitId !== undefined &&
    !businessUnitIds.has(recipient.businessUnitId)
  ) {
    errors.push(invalidReference(index, 'businessUnitId', '없는 사업부입니다.'));
  }
  if (
    recipient.recipientTypeCode === 'ROLE' &&
    recipient.roleId !== undefined &&
    !roleIds.has(recipient.roleId)
  ) {
    errors.push(invalidReference(index, 'roleId', '없는 역할입니다.'));
  }
  if (
    recipient.recipientTypeCode === 'USER' &&
    recipient.userId !== undefined &&
    !userIds.has(recipient.userId)
  ) {
    errors.push(invalidReference(index, 'userId', '없는 사용자입니다.'));
  }
  return errors;
}

function invalidReference(index: number, field: string, message: string): ErrorItem {
  return {
    scope: 'field',
    field: `recipients[${index}].${field}`,
    code: ERROR_CODE.INVALID,
    message,
  };
}
