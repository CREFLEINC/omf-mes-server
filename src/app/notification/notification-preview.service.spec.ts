import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { NotificationPreviewService } from './notification-preview.service';

describe('NotificationPreviewService', () => {
  it('사용자 포함 여부·이름·활성·부서명을 한 SQL 스냅샷에서 읽는다', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        app_user_id: 31n,
        user_name: '실제 이름',
        is_active: false,
        department_name: '실제 부서',
      },
    ]);
    const tx = {
      business_unit: {
        findMany: jest.fn().mockResolvedValue([{ business_unit_id: 11n }]),
      },
      role: { findMany: jest.fn().mockResolvedValue([{ role_id: 21n }]) },
      app_user: { findMany: jest.fn().mockResolvedValue([{ app_user_id: 31n }]) },
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;

    const result = await new NotificationPreviewService().previewWithin(tx, {
      recipients: [
        { recipientTypeCode: 'ROLE', businessUnitId: 11, roleId: 21 },
        { recipientTypeCode: 'USER', userId: 31 },
      ],
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const query = queryRaw.mock.calls[0][0] as { strings: readonly string[] };
    const sql = query.strings.join(' ');
    expect(sql).toContain('LEFT JOIN mdm.department');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('ORDER BY u.app_user_id ASC');
    expect(result.users).toEqual([
      {
        userId: 31,
        userName: '실제 이름',
        isActive: false,
        departmentName: '실제 부서',
      },
    ]);
    expect(result.totalCount).toBe(0);
  });

  it('빈 규칙도 같은 사용자 SELECT에서 빈 결과를 읽는다', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const tx = {
      business_unit: { findMany: jest.fn().mockResolvedValue([]) },
      role: { findMany: jest.fn().mockResolvedValue([]) },
      app_user: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;

    const result = await new NotificationPreviewService().previewWithin(tx, { recipients: [] });

    const query = queryRaw.mock.calls[0][0] as { strings: readonly string[] };
    expect(query.strings.join(' ')).toContain('FALSE');
    expect(result).toMatchObject({ totalCount: 0, users: [] });
  });

  it('unsafe recipient IDs fail RANGE before reference queries', async () => {
    const tx = {
      business_unit: { findMany: jest.fn() },
      role: { findMany: jest.fn() },
      app_user: { findMany: jest.fn() },
      $queryRaw: jest.fn(),
    } as unknown as Prisma.TransactionClient;

    await expect(
      new NotificationPreviewService().previewWithin(tx, {
        recipients: [{ recipientTypeCode: 'USER', userId: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).rejects.toBeInstanceOf(ContractException);
    expect(tx.business_unit.findMany).not.toHaveBeenCalled();
    expect(tx.role.findMany).not.toHaveBeenCalled();
    expect(tx.app_user.findMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('distinct unsafe stored user IDs fail the whole preview', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        app_user_id: 9007199254740992n,
        user_name: '큰 사용자 1',
        is_active: true,
        department_name: null,
      },
      {
        app_user_id: 9007199254740993n,
        user_name: '큰 사용자 2',
        is_active: true,
        department_name: null,
      },
    ]);
    const tx = {
      business_unit: { findMany: jest.fn().mockResolvedValue([]) },
      role: { findMany: jest.fn().mockResolvedValue([]) },
      app_user: { findMany: jest.fn().mockResolvedValue([{ app_user_id: 31n }]) },
      $queryRaw: queryRaw,
    } as unknown as Prisma.TransactionClient;

    await expect(
      new NotificationPreviewService().previewWithin(tx, {
        recipients: [{ recipientTypeCode: 'USER', userId: 31 }],
      }),
    ).rejects.toThrow('사용자 ID를 JSON 숫자로 안전하게 표현할 수 없습니다.');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});
