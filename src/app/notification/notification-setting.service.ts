import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTIFICATION_EVENTS, NotificationEventView, notificationEvent } from './notification-events';

/** 행이 없는 부서×이벤트는 이 판으로 읽는다 — 첫 저장의 If-Match 가 이 값을 담는다. */
export const INITIAL_SETTING_VERSION = 1;

const ZALO_CONNECTION_ID = 1;

export interface NotificationSettingSummary {
  departmentId: number;
  departmentName: string;
  zaloStatus: string;
  items: {
    eventCode: string;
    enabled: boolean;
    zaloEnabled: boolean;
    recipientCount: number;
    noPhoneCount: number;
  }[];
}

export interface NotificationSettingView {
  departmentId: number;
  eventCode: string;
  enabled: boolean;
  zaloEnabled: boolean;
  recipients: {
    appUserId: number;
    loginId: string;
    userName: string;
    departmentName: string | null;
    active: boolean;
    hasPhone: boolean;
  }[];
}

export interface NotificationSettingReplace {
  enabled: boolean;
  zaloEnabled: boolean;
  recipientUserIds: number[];
}

export interface RecipientCandidateQuery {
  keyword?: string;
  page?: number;
  size?: number;
}

const RECIPIENT_USER = {
  app_user: {
    select: {
      app_user_id: true,
      login_id: true,
      user_name: true,
      is_active: true,
      phone_number: true,
      department: { select: { department_name: true } },
    },
  },
} as const;

type RecipientRow = Prisma.notification_department_recipientGetPayload<{ include: typeof RECIPIENT_USER }>;

/**
 * 부서×이벤트 알림 설정(W-CO-11 · 장부 P-92). 기존 이벤트 단위 구독(`notification_subscription*`)은
 * 보존만 하고 쓰지 않는다(research R-10).
 */
@Injectable()
export class NotificationSettingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(departmentId: number): Promise<NotificationSettingSummary> {
    const department = await this.department(departmentId);
    const [settings, zaloStatus] = await Promise.all([
      this.prisma.notification_department_setting.findMany({
        where: { department_id: departmentId },
        include: { recipients: { include: RECIPIENT_USER } },
      }),
      this.zaloStatus(),
    ]);
    const byEvent = new Map(settings.map((row) => [row.event_type_code, row]));
    return {
      departmentId,
      departmentName: department.department_name,
      zaloStatus,
      items: NOTIFICATION_EVENTS.map((event) => {
        const row = byEvent.get(event.eventCode);
        // 비활성 수신자는 발생 때 빠진다 — 「켬 + 0명」 경고가 그 수를 봐야 한다.
        const active = (row?.recipients ?? []).filter((r) => r.app_user.is_active);
        return {
          eventCode: event.eventCode,
          enabled: row?.is_enabled ?? false,
          zaloEnabled: row?.zalo_enabled ?? false,
          recipientCount: active.length,
          noPhoneCount: active.filter((r) => r.app_user.phone_number === null).length,
        };
      }),
    };
  }

  /** ⛔ 행을 만들지 않는다 — 없으면 끔·끔·0명·판 1 로 읽는다. */
  async detail(
    departmentId: number,
    eventCode: string,
  ): Promise<{ setting: NotificationSettingView; versionNo: number }> {
    readEvent(eventCode);
    await this.department(departmentId);
    const row = await this.prisma.notification_department_setting.findUnique({
      where: { department_id_event_type_code: { department_id: departmentId, event_type_code: eventCode } },
      include: { recipients: { include: RECIPIENT_USER, orderBy: { app_user_id: 'asc' } } },
    });
    return {
      setting: {
        departmentId,
        eventCode,
        enabled: row?.is_enabled ?? false,
        zaloEnabled: row?.zalo_enabled ?? false,
        recipients: (row?.recipients ?? []).map(recipientView),
      },
      versionNo: row?.version_no ?? INITIAL_SETTING_VERSION,
    };
  }

  /** 기존 구독 PUT 과 같은 순서 — 헤더 UPSERT → FOR UPDATE → 판 대조 → 수신자 치환 → 판 +1. */
  async replaceWithin(
    tx: Prisma.TransactionClient,
    departmentId: number,
    eventCode: string,
    expectedVersion: number,
    input: NotificationSettingReplace,
    actorId?: number,
  ): Promise<{ setting: NotificationSettingView; versionNo: number }> {
    const event = readEvent(eventCode);
    await this.department(departmentId, tx);
    await assertRecipients(tx, event, input.recipientUserIds);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO app.notification_department_setting (department_id, event_type_code, created_by, updated_by)
      VALUES (${departmentId}, ${eventCode}, ${actorId ?? null}, ${actorId ?? null})
      ON CONFLICT (department_id, event_type_code) DO NOTHING
    `);
    const [header] = await tx.$queryRaw<{ notification_department_setting_id: bigint; version_no: number }[]>(
      Prisma.sql`
        SELECT notification_department_setting_id, version_no
          FROM app.notification_department_setting
         WHERE department_id = ${departmentId} AND event_type_code = ${eventCode}
         FOR UPDATE
      `,
    );
    if (header === undefined) throw new Error('알림 설정 행을 만든 뒤 다시 읽지 못했습니다.');
    assertUpdated(header.version_no === expectedVersion ? 1 : 0);

    const settingId = header.notification_department_setting_id;
    await tx.notification_department_recipient.deleteMany({
      where: { notification_department_setting_id: settingId },
    });
    if (input.recipientUserIds.length > 0) {
      await tx.notification_department_recipient.createMany({
        data: input.recipientUserIds.map((appUserId) => ({
          notification_department_setting_id: settingId,
          app_user_id: appUserId,
          created_by: actorId ?? null,
        })),
      });
    }
    const saved = await tx.notification_department_setting.update({
      where: { notification_department_setting_id: settingId },
      data: {
        is_enabled: input.enabled,
        zalo_enabled: input.zaloEnabled,
        updated_at: new Date(),
        updated_by: actorId ?? null,
        version_no: { increment: 1 },
      },
      include: { recipients: { include: RECIPIENT_USER, orderBy: { app_user_id: 'asc' } } },
    });
    return {
      setting: {
        departmentId,
        eventCode,
        enabled: saved.is_enabled,
        zaloEnabled: saved.zalo_enabled,
        recipients: saved.recipients.map(recipientView),
      },
      versionNo: saved.version_no,
    };
  }

  /** 후보는 부서와 상관없이 활성 사용자 전체다(FR-014). ⛔ 번호 원문은 내리지 않는다(FR-019). */
  async candidates(query: RecipientCandidateQuery): Promise<PagedResponse<unknown>> {
    const page = pageRequest(query);
    const keyword = query.keyword?.trim();
    const where: Prisma.app_userWhereInput = {
      is_active: true,
      ...(keyword
        ? {
            OR: [
              { login_id: { contains: keyword, mode: 'insensitive' } },
              { user_name: { contains: keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.app_user.findMany({
        where,
        orderBy: [{ user_name: 'asc' }, { app_user_id: 'asc' }],
        select: RECIPIENT_USER.app_user.select,
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.app_user.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => ({
        appUserId: Number(row.app_user_id),
        loginId: row.login_id,
        userName: row.user_name,
        departmentName: row.department?.department_name ?? null,
        hasPhone: row.phone_number !== null,
      })),
      total,
      page,
    );
  }

  private async department(
    departmentId: number,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ department_name: string }> {
    const row = await client.department.findUnique({
      where: { department_id: departmentId },
      select: { department_name: true },
    });
    if (!row) throw new NotFoundException('없는 부서입니다.');
    return row;
  }

  /** 상태만 내린다 — W-CO-12 권한 없이도 W-CO-11 이 안내 배너를 띄울 수 있게. */
  private async zaloStatus(): Promise<string> {
    const row = await this.prisma.zalo_connection.findUnique({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      select: { status_code: true },
    });
    return row?.status_code ?? 'NOT_CONFIGURED';
  }
}

function readEvent(eventCode: string): NotificationEventView {
  const event = notificationEvent(eventCode);
  if (event) return event;
  throw new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'eventCode', code: ERROR_CODE.INVALID, message: '알림 이벤트 목록에 없는 코드입니다.' },
  ]);
}

async function assertRecipients(
  tx: Prisma.TransactionClient,
  event: NotificationEventView,
  recipientUserIds: number[],
): Promise<void> {
  if (event.recipientMode === 'APPROVER' && recipientUserIds.length > 0) {
    throw recipientError(ERROR_CODE.RECIPIENTS_NOT_ALLOWED, '결재 알림은 그 차례 결재자에게 갑니다. 수신자를 지정할 수 없습니다.');
  }
  if (new Set(recipientUserIds).size !== recipientUserIds.length) {
    throw recipientError(ERROR_CODE.INVALID, '같은 사용자가 두 번 들어 있습니다.');
  }
  if (recipientUserIds.length === 0) return;
  const users = await tx.app_user.findMany({
    where: { app_user_id: { in: recipientUserIds } },
    select: { app_user_id: true, is_active: true },
  });
  if (users.length !== recipientUserIds.length) {
    throw recipientError(ERROR_CODE.INVALID, '없는 사용자가 들어 있습니다.');
  }
  if (users.some((user) => !user.is_active)) {
    throw recipientError(ERROR_CODE.INVALID, '사용 중지된 사용자는 수신자로 지정할 수 없습니다.');
  }
}

function recipientError(code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    { scope: 'field', field: 'recipientUserIds', code, message },
  ]);
}

function recipientView(row: RecipientRow): NotificationSettingView['recipients'][number] {
  return {
    appUserId: Number(row.app_user.app_user_id),
    loginId: row.app_user.login_id,
    userName: row.app_user.user_name,
    departmentName: row.app_user.department?.department_name ?? null,
    active: row.app_user.is_active,
    hasPhone: row.app_user.phone_number !== null,
  };
}
