import { Prisma } from '@prisma/client';

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
});
