import { Prisma } from '@prisma/client';

import { NotificationEmitter } from '../core/notification';
import { LogisticsHandoverNotifier } from './logistics-handover';

describe('물류 인계 알림 — 값 모으기 보호', () => {
  it('FR-003 SC-005 값 모으기 조회가 실패해도 SAVEPOINT 로 되돌리고 던지지 않는다', async () => {
    const sql: string[] = [];
    const tx = {
      $executeRawUnsafe: async (statement: string) => sql.push(statement),
      goods_receipt: { findUniqueOrThrow: async () => Promise.reject(new Error('주입 — 대상 조회 실패')) },
    } as unknown as Prisma.TransactionClient;
    const notifier = new LogisticsHandoverNotifier(new NotificationEmitter());

    await expect(notifier.putaway(tx, 1n, 1, { appUserId: 1 })).resolves.toBeUndefined();
    expect(sql).toEqual(['SAVEPOINT handover_alert', 'ROLLBACK TO SAVEPOINT handover_alert']);
  });
});
