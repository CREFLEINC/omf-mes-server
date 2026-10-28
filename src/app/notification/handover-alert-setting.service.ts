import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { SessionScope } from '../../auth/session.types';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { HANDOVER_ALERT_TYPES, handoverAlertType } from '../../core/notification/handover-alert-types';
import { PrismaService } from '../../prisma/prisma.service';
import { INITIAL_SETTING_VERSION } from './notification-setting.service';

/** 공장 × 종류 담당자 상한(FR-006). 화면도 같은 수로 잠근다. */
export const HANDOVER_RECIPIENT_LIMIT = 5;

const ZALO_CONNECTION_ID = 1;

export interface HandoverAlertSettingSummary {
  plantId: number;
  plantName: string;
  zaloStatus: string;
  items: {
    alertTypeCode: string;
    enabled: boolean;
    zaloEnabled: boolean;
    recipientCount: number;
    noPhoneCount: number;
    inactiveCount: number;
  }[];
}

export interface HandoverAlertSettingView {
  plantId: number;
  alertTypeCode: string;
  enabled: boolean;
  zaloEnabled: boolean;
  recipients: {
    userId: number;
    loginId: string;
    name: string;
    departmentName: string | null;
    active: boolean;
    hasPhone: boolean;
  }[];
}

export interface HandoverAlertSettingReplace {
  enabled: boolean;
  zaloEnabled: boolean;
  recipientUserIds: number[];
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
const RECIPIENTS = { include: RECIPIENT_USER, orderBy: { app_user_id: 'asc' } } as const;

type RecipientRow = Prisma.handover_alert_recipientGetPayload<{ include: typeof RECIPIENT_USER }>;

/**
 * 공장 × 인계 작업 종류 알림 설정(W-CO-14 · omf-all-around#190 · 장부 P-134).
 * 부서×이벤트 설정(W-CO-11)과 같은 저장 순서를 따르되 목록·표가 따로다(research R-1).
 */
@Injectable()
export class HandoverAlertSettingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(plantId: number, scopes: readonly SessionScope[]): Promise<HandoverAlertSettingSummary> {
    const plant = await this.plant(plantId, scopes);
    const [settings, zaloStatus] = await Promise.all([
      this.prisma.handover_alert_setting.findMany({
        where: { plant_id: plantId },
        include: { recipients: { include: RECIPIENT_USER } },
      }),
      this.zaloStatus(),
    ]);
    const byType = new Map(settings.map((row) => [row.alert_type_code, row]));
    return {
      plantId,
      plantName: plant.plant_name,
      zaloStatus,
      items: HANDOVER_ALERT_TYPES.map((type) => {
        const users = (byType.get(type.alertTypeCode)?.recipients ?? []).map((r) => r.app_user);
        // 비활성 담당자는 발생 때 빠진다 — 「켬 + 0명」 안내가 활성 수를 봐야 한다.
        const active = users.filter((user) => user.is_active);
        const row = byType.get(type.alertTypeCode);
        return {
          alertTypeCode: type.alertTypeCode,
          enabled: row?.is_enabled ?? false,
          zaloEnabled: row?.zalo_enabled ?? false,
          recipientCount: active.length,
          noPhoneCount: active.filter((user) => user.phone_number === null).length,
          inactiveCount: users.length - active.length,
        };
      }),
    };
  }

  /** ⛔ 행을 만들지 않는다 — 없으면 꺼짐·꺼짐·0명·판 1 로 읽는다. */
  async detail(
    plantId: number,
    alertTypeCode: string,
    scopes: readonly SessionScope[],
  ): Promise<{ setting: HandoverAlertSettingView; versionNo: number }> {
    readType(alertTypeCode);
    await this.plant(plantId, scopes);
    const row = await this.prisma.handover_alert_setting.findUnique({
      where: { plant_id_alert_type_code: { plant_id: plantId, alert_type_code: alertTypeCode } },
      include: { recipients: RECIPIENTS },
    });
    return {
      setting: settingView(plantId, alertTypeCode, row),
      versionNo: row?.version_no ?? INITIAL_SETTING_VERSION,
    };
  }

  /**
   * W-CO-11 저장과 같은 순서 — 헤더 UPSERT → FOR UPDATE → 판 대조 → 담당자 치환 → 판 +1.
   * If-Match 가 없으면(`expectedVersion` undefined) 행이 아직 없을 때만 받는다 — 첫 저장은 판을 몰라도 된다.
   */
  async replaceWithin(
    tx: Prisma.TransactionClient,
    plantId: number,
    alertTypeCode: string,
    expectedVersion: number | undefined,
    input: HandoverAlertSettingReplace,
    scopes: readonly SessionScope[],
    actorId?: number,
  ): Promise<{ setting: HandoverAlertSettingView; versionNo: number }> {
    readType(alertTypeCode);
    await this.plant(plantId, scopes, tx);
    if (input.zaloEnabled && !input.enabled) {
      throw fieldError('zaloEnabled', ERROR_CODE.INVALID, '알림이 꺼져 있으면 Zalo 를 켤 수 없습니다.');
    }
    await assertRecipients(tx, input.recipientUserIds);

    const inserted = await tx.$executeRaw(Prisma.sql`
      INSERT INTO app.handover_alert_setting (plant_id, alert_type_code, created_by, updated_by)
      VALUES (${plantId}, ${alertTypeCode}, ${actorId ?? null}, ${actorId ?? null})
      ON CONFLICT (plant_id, alert_type_code) DO NOTHING
    `);
    const [header] = await tx.$queryRaw<{ handover_alert_setting_id: bigint; version_no: number }[]>(Prisma.sql`
      SELECT handover_alert_setting_id, version_no
        FROM app.handover_alert_setting
       WHERE plant_id = ${plantId} AND alert_type_code = ${alertTypeCode}
         FOR UPDATE
    `);
    if (header === undefined) throw new Error('인계 알림 설정 행을 만든 뒤 다시 읽지 못했습니다.');
    assertUpdated(
      expectedVersion === undefined ? (inserted === 1 ? 1 : 0) : header.version_no === expectedVersion ? 1 : 0,
    );

    const settingId = header.handover_alert_setting_id;
    await tx.handover_alert_recipient.deleteMany({ where: { handover_alert_setting_id: settingId } });
    if (input.recipientUserIds.length > 0) {
      await tx.handover_alert_recipient.createMany({
        data: input.recipientUserIds.map((appUserId) => ({
          handover_alert_setting_id: settingId,
          app_user_id: appUserId,
          created_by: actorId ?? null,
        })),
      });
    }
    const saved = await tx.handover_alert_setting.update({
      where: { handover_alert_setting_id: settingId },
      data: {
        is_enabled: input.enabled,
        zalo_enabled: input.zaloEnabled,
        updated_at: new Date(),
        updated_by: actorId ?? null,
        version_no: { increment: 1 },
      },
      include: { recipients: RECIPIENTS },
    });
    return { setting: settingView(plantId, alertTypeCode, saved), versionNo: saved.version_no };
  }

  /** 없는 공장은 404, 세션 데이터 범위 밖이면 403(출하지시 이행 공장 지정과 같은 판정). */
  private async plant(
    plantId: number,
    scopes: readonly SessionScope[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ plant_name: string }> {
    const row = await client.plant.findUnique({
      where: { plant_id: plantId },
      select: { plant_name: true, business_unit_id: true },
    });
    if (!row) throw new NotFoundException('없는 공장입니다.');
    const authorized = scopes.some(
      (scope) =>
        scope.plantId === plantId ||
        (scope.plantId === undefined &&
          row.business_unit_id !== null &&
          scope.businessUnitId === Number(row.business_unit_id)),
    );
    if (!authorized) {
      throw new ContractException(HttpStatus.FORBIDDEN, [
        { scope: 'field', field: 'plantId', code: ERROR_CODE.PERMISSION_DENIED, message: '이 공장에 대한 데이터 권한이 없습니다.' },
      ]);
    }
    return row;
  }

  private async zaloStatus(): Promise<string> {
    const row = await this.prisma.zalo_connection.findUnique({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      select: { status_code: true },
    });
    return row?.status_code ?? 'NOT_CONFIGURED';
  }
}

function readType(alertTypeCode: string): void {
  if (handoverAlertType(alertTypeCode) === undefined) {
    throw fieldError('alertTypeCode', ERROR_CODE.INVALID, '인계 작업 종류 목록에 없는 코드입니다.');
  }
}

async function assertRecipients(tx: Prisma.TransactionClient, recipientUserIds: number[]): Promise<void> {
  if (recipientUserIds.length > HANDOVER_RECIPIENT_LIMIT) {
    throw fieldError('recipientUserIds', ERROR_CODE.RECIPIENT_LIMIT, `담당자는 최대 ${HANDOVER_RECIPIENT_LIMIT}명까지 지정할 수 있습니다.`);
  }
  if (new Set(recipientUserIds).size !== recipientUserIds.length) {
    throw fieldError('recipientUserIds', ERROR_CODE.INVALID, '같은 사용자가 두 번 들어 있습니다.');
  }
  if (recipientUserIds.length === 0) return;
  const users = await tx.app_user.findMany({
    where: { app_user_id: { in: recipientUserIds } },
    select: { is_active: true },
  });
  if (users.length !== recipientUserIds.length) {
    throw fieldError('recipientUserIds', ERROR_CODE.INVALID, '없는 사용자가 들어 있습니다.');
  }
  if (users.some((user) => !user.is_active)) {
    throw fieldError('recipientUserIds', ERROR_CODE.INVALID, '사용 중지된 사용자는 담당자로 지정할 수 없습니다.');
  }
}

function fieldError(field: string, code: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [{ scope: 'field', field, code, message }]);
}

function settingView(
  plantId: number,
  alertTypeCode: string,
  row: { is_enabled: boolean; zalo_enabled: boolean; recipients: RecipientRow[] } | null,
): HandoverAlertSettingView {
  return {
    plantId,
    alertTypeCode,
    enabled: row?.is_enabled ?? false,
    zaloEnabled: row?.zalo_enabled ?? false,
    recipients: (row?.recipients ?? []).map(recipientView),
  };
}

function recipientView(row: RecipientRow): HandoverAlertSettingView['recipients'][number] {
  return {
    userId: Number(row.app_user.app_user_id),
    loginId: row.app_user.login_id,
    name: row.app_user.user_name,
    departmentName: row.app_user.department?.department_name ?? null,
    active: row.app_user.is_active,
    hasPhone: row.app_user.phone_number !== null,
  };
}
