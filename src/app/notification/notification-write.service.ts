import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class NotificationWriteService {
  async readWithin(
    tx: Prisma.TransactionClient,
    actorUserId: number,
    notificationId: number,
  ): Promise<void> {
    const where = {
      notification_id: BigInt(notificationId),
      recipient_user_id: BigInt(actorUserId),
    };
    const updated = await tx.notification.updateMany({
      where: { ...where, read_at: null },
      data: { read_at: new Date() },
    });
    if (updated.count === 0) {
      const own = await tx.notification.findFirst({
        where,
        select: { notification_id: true },
      });
      if (!own) throw new NotFoundException('알림을 찾을 수 없습니다.');
    }
  }

  async readAllWithin(
    tx: Prisma.TransactionClient,
    actorUserId: number,
  ): Promise<{ readCount: number }> {
    const updated = await tx.notification.updateMany({
      where: { recipient_user_id: BigInt(actorUserId), read_at: null },
      data: { read_at: new Date() },
    });
    return { readCount: updated.count };
  }
}
