import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { NotificationValues, notificationMessage, templateData } from './message-format';
import { HandoverAggregate, handoverAlertType } from './handover-alert-types';
import { notificationEvent } from './notification-events';

type Tx = Prisma.TransactionClient;

/** 알림 대상 — 계약 `Notification.targetTypeCode` enum 안의 값만 쓴다(생산 4종은 W/O · research R-6). */
export type NotificationAggregate = 'WORK_ORDER' | 'EQUIPMENT' | 'APPROVAL_REQUEST';

export type SkipReason =
  | 'DEPARTMENT_UNRESOLVED'
  | 'EVENT_DISABLED'
  | 'NO_RECIPIENTS'
  | 'REPORTER_OPTED_OUT'
  | 'APPROVER_INACTIVE';

export interface EmitInput {
  eventCode: string;
  aggregateTypeCode: NotificationAggregate;
  aggregateId: bigint;
  /** 실제 조작 시각 — 단말이 보낸 시각이지 서버 수신 시각이 아니다(research R-6). */
  occurredAt: Date;
  /** `resolveByLine`·`resolveByUser` 의 결과. 판정 실패면 `null`. */
  departmentId: bigint | null;
  /** `APPROVER` 이벤트만 — 그 차례 결재자. */
  approverUserId?: bigint;
  /** 고장 보고의 「설비 담당에게 알림」이 꺼졌다. */
  optOut?: boolean;
  /** data-model §6 의 파라미터 값(`event_time` 은 생성기가 만든다). */
  values: NotificationValues;
  /** 값 말고 함께 남길 ID(예: `breakdownId`). */
  refs?: Record<string, number>;
}

export interface EmitResult {
  /** 같은 사건이 이미 있으면 `null` 이고 아무것도 쓰지 않았다. */
  notificationEventId: bigint | null;
  skipReason: SkipReason | null;
  notificationCount: number;
  zaloCount: number;
}

export interface HandoverEmitInput {
  alertTypeCode: string;
  /** 담당자 설정을 찾는 공장 — 종류마다 정해진 공장(research R-3 표). */
  plantId: bigint;
  aggregateTypeCode: HandoverAggregate;
  aggregateId: bigint;
  occurredAt: Date;
  /** zalo-templates.md 의 파라미터 값(`event_time` 은 생성기가 만든다). */
  values: NotificationValues;
  refs?: Record<string, number>;
}

interface WriteInput {
  eventCode: string;
  title: string;
  aggregateTypeCode: string;
  aggregateId: bigint;
  occurredAt: Date;
  departmentId: bigint | null;
  values: NotificationValues;
  refs?: Record<string, number>;
  priority: number;
  skipReason: SkipReason | null;
  recipients: Recipient[];
  zaloEnabled: boolean;
}

interface Recipient {
  app_user_id: bigint;
  is_active: boolean;
  phone_number: string | null;
}

const ZALO_CONNECTION_ID = 1;
/** `zalo_connection` 행이 없을 때의 자르기 길이 — 마이그 DEFAULT 와 같다. */
const DEFAULT_PARAM_MAX_LENGTH = 100;
const ZALO_TTL_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_SELECT = { app_user_id: true, is_active: true, phone_number: true } as const;
/** Zalo 발송 순서 — 작을수록 먼저. 기존 6종이 인계 알림 몰림에 밀리지 않게 한다(FR-023 · SC-008). */
const EVENT_PRIORITY = 0;
const HANDOVER_PRIORITY = 1;

const logger = new Logger('NotificationEmitter');

/**
 * 알림 생성기 — 업무 트랜잭션 «안»에서 부른다(research R-5). 업무가 롤백되면 알림도 없다(FR-008).
 * 외부(Zalo)는 부르지 않는다 — 발송 대기 건만 쓰고 러너가 tx 밖에서 보낸다(C11).
 *
 * ⛔ UNIQUE 위반(P2002)을 잡지 않는다 — 잡으면 tx 가 abort 된다(`OutboxService.enqueue` 선례).
 * 같은 사건(`uq_notification_event`)은 «먼저 조회»해서 건너뛴다.
 */
@Injectable()
export class NotificationEmitter {
  async emit(tx: Tx, input: EmitInput): Promise<EmitResult> {
    const event = notificationEvent(input.eventCode);
    if (event === undefined) throw new Error(`알림 이벤트 목록에 없는 코드입니다: ${input.eventCode}`);

    const existing = await tx.notification_event.findUnique({
      where: {
        event_type_code_aggregate_type_code_aggregate_id_occurred_at: {
          event_type_code: input.eventCode,
          aggregate_type_code: input.aggregateTypeCode,
          aggregate_id: input.aggregateId,
          occurred_at: input.occurredAt,
        },
      },
      select: { notification_event_id: true },
    });
    if (existing !== null) return { notificationEventId: null, skipReason: null, notificationCount: 0, zaloCount: 0 };

    const { skipReason, recipients, zaloEnabled } = await this.decide(tx, input, event.recipientMode);
    return this.write(tx, {
      eventCode: input.eventCode,
      title: event.eventName,
      aggregateTypeCode: input.aggregateTypeCode,
      aggregateId: input.aggregateId,
      occurredAt: input.occurredAt,
      departmentId: input.departmentId,
      values: input.values,
      refs: input.refs,
      priority: EVENT_PRIORITY,
      skipReason,
      recipients,
      zaloEnabled,
    });
  }

  /**
   * 인계 작업 알림(omf-all-around#190) — 수신자는 공장 × 종류 담당자다(부서 판정 없음 · research R-2).
   * 같은 (종류, 대상) 사건이 있으면 쓰지 않는다 — 발생 시각이 달라도 대상 기준 한 번이다(FR-002).
   *
   * ⭐ SAVEPOINT 로 감싼다 — 알림을 못 써도 업무 트랜잭션은 이어 간다(SC-005). 외부 호출은 없다.
   */
  async emitHandover(tx: Tx, input: HandoverEmitInput): Promise<EmitResult> {
    const type = handoverAlertType(input.alertTypeCode);
    if (type === undefined) throw new Error(`인계 작업 종류 목록에 없는 코드입니다: ${input.alertTypeCode}`);
    await tx.$executeRawUnsafe('SAVEPOINT handover_alert');
    try {
      const result = await this.writeHandover(tx, input, type.name);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT handover_alert');
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT handover_alert');
      logger.error(`인계 작업 알림을 쓰지 못했습니다 — ${input.alertTypeCode} ${input.aggregateTypeCode} ${input.aggregateId}`, error);
      return { notificationEventId: null, skipReason: null, notificationCount: 0, zaloCount: 0 };
    }
  }

  private async writeHandover(tx: Tx, input: HandoverEmitInput, title: string): Promise<EmitResult> {
    const existing = await tx.notification_event.findFirst({
      where: {
        event_type_code: input.alertTypeCode,
        aggregate_type_code: input.aggregateTypeCode,
        aggregate_id: input.aggregateId,
      },
      select: { notification_event_id: true },
    });
    if (existing !== null) return { notificationEventId: null, skipReason: null, notificationCount: 0, zaloCount: 0 };

    const decision = await this.decideHandover(tx, input);
    return this.write(tx, {
      eventCode: input.alertTypeCode,
      title,
      aggregateTypeCode: input.aggregateTypeCode,
      aggregateId: input.aggregateId,
      occurredAt: input.occurredAt,
      departmentId: null,
      values: input.values,
      refs: input.refs,
      priority: HANDOVER_PRIORITY,
      ...decision,
    });
  }

  /** 설정 없음·꺼짐 → `EVENT_DISABLED`, 활성 담당자 0 → `NO_RECIPIENTS` — 기존 건너뜀 값 그대로(FR-024). */
  private async decideHandover(
    tx: Tx,
    input: HandoverEmitInput,
  ): Promise<{ skipReason: SkipReason | null; recipients: Recipient[]; zaloEnabled: boolean }> {
    const skip = (skipReason: SkipReason) => ({ skipReason, recipients: [], zaloEnabled: false });
    const setting = await tx.handover_alert_setting.findUnique({
      where: { plant_id_alert_type_code: { plant_id: input.plantId, alert_type_code: input.alertTypeCode } },
      select: {
        is_enabled: true,
        zalo_enabled: true,
        recipients: { orderBy: { app_user_id: 'asc' }, select: { app_user: { select: RECIPIENT_SELECT } } },
      },
    });
    if (setting === null || !setting.is_enabled) return skip('EVENT_DISABLED');
    const recipients = setting.recipients.map((r) => r.app_user).filter((user) => user.is_active);
    if (recipients.length === 0) return skip('NO_RECIPIENTS');
    return { skipReason: null, recipients, zaloEnabled: setting.zalo_enabled };
  }

  /** 사건·알림센터 알림·Zalo 대기 쓰기 — `emit`·`emitHandover` 가 함께 쓴다(수신자 판정만 다르다). */
  private async write(tx: Tx, input: WriteInput): Promise<EmitResult> {
    const { skipReason, recipients, zaloEnabled } = input;
    const created = await tx.notification_event.create({
      data: {
        event_type_code: input.eventCode,
        aggregate_type_code: input.aggregateTypeCode,
        aggregate_id: input.aggregateId,
        occurred_at: input.occurredAt,
        department_id: input.departmentId,
        dispatch_status_code: skipReason === null ? 'NOTIFIED' : 'SKIPPED',
        skip_reason_code: skipReason,
        payload: {
          ...input.refs,
          ...input.values,
          // 번호가 없어 Zalo 건을 만들지 않은 수신자 수 — 건이 없어 발송 이력(W-CO-13)이 따로 셀 수 없다(data-model §5).
          ...(zaloEnabled ? { zaloSkippedNoPhone: recipients.filter((r) => r.phone_number === null).length } : {}),
        } as Prisma.InputJsonObject,
      },
      select: { notification_event_id: true },
    });
    const eventId = created.notification_event_id;
    if (skipReason !== null) return { notificationEventId: eventId, skipReason, notificationCount: 0, zaloCount: 0 };

    const message = notificationMessage(input.eventCode, input.values, input.occurredAt);
    await tx.notification.createMany({
      data: recipients.map((recipient) => ({
        notification_event_id: eventId,
        recipient_user_id: recipient.app_user_id,
        title: input.title,
        message,
      })),
    });
    // 번호가 없는 수신자는 건을 만들지 않는다 — 알림센터는 이미 받았다(data-model §5).
    const zaloTargets = zaloEnabled ? recipients.filter((r) => r.phone_number !== null) : [];
    if (zaloTargets.length > 0) await this.queueZalo(tx, eventId, input, zaloTargets);
    return { notificationEventId: eventId, skipReason: null, notificationCount: recipients.length, zaloCount: zaloTargets.length };
  }

  /** 알리지 않는 이유를 앞에서부터 본다. 비활성 수신자는 빼고 센다. */
  private async decide(
    tx: Tx,
    input: EmitInput,
    mode: 'CONFIGURED' | 'APPROVER',
  ): Promise<{ skipReason: SkipReason | null; recipients: Recipient[]; zaloEnabled: boolean }> {
    const skip = (skipReason: SkipReason) => ({ skipReason, recipients: [], zaloEnabled: false });
    if (input.optOut === true) return skip('REPORTER_OPTED_OUT');
    if (input.departmentId === null) return skip('DEPARTMENT_UNRESOLVED');

    const setting = await tx.notification_department_setting.findUnique({
      where: { department_id_event_type_code: { department_id: input.departmentId, event_type_code: input.eventCode } },
      select: {
        is_enabled: true,
        zalo_enabled: true,
        // 결재자 모드는 설정에 수신자가 없다 — 읽지 않는다.
        recipients: { take: mode === 'APPROVER' ? 0 : undefined, select: { app_user: { select: RECIPIENT_SELECT } } },
      },
    });
    if (setting === null || !setting.is_enabled) return skip('EVENT_DISABLED');

    let recipients: Recipient[];
    if (mode === 'APPROVER') {
      if (input.approverUserId === undefined) throw new Error(`결재자 없이 ${input.eventCode} 를 보낼 수 없습니다.`);
      const approver = await tx.app_user.findUnique({ where: { app_user_id: input.approverUserId }, select: RECIPIENT_SELECT });
      if (approver === null || !approver.is_active) return skip('APPROVER_INACTIVE');
      recipients = [approver];
    } else {
      recipients = setting.recipients.map((r) => r.app_user).filter((user) => user.is_active);
    }
    if (recipients.length === 0) return skip('NO_RECIPIENTS');
    return { skipReason: null, recipients, zaloEnabled: setting.zalo_enabled };
  }

  /**
   * `tracking_id` 가 `zd-{id}` 라 id 를 먼저 뽑는다 — 식별 칸이 `BY DEFAULT` 라 명시 id 를 받는다.
   * 템플릿 ID·연결 상태는 여기서 보지 않는다 — 러너가 보낼 때 판정해 건의 실패로 남긴다.
   */
  private async queueZalo(tx: Tx, eventId: bigint, input: WriteInput, targets: Recipient[]): Promise<void> {
    const connection = await tx.zalo_connection.findUnique({
      where: { zalo_connection_id: ZALO_CONNECTION_ID },
      select: { param_max_length: true },
    });
    const data = templateData(
      input.eventCode,
      input.values,
      input.occurredAt,
      connection?.param_max_length ?? DEFAULT_PARAM_MAX_LENGTH,
    );
    const ids = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT nextval(pg_get_serial_sequence('app.zalo_delivery', 'zalo_delivery_id')) AS id
        FROM generate_series(1, ${targets.length}::int)
    `);
    await tx.zalo_delivery.createMany({
      data: targets.map((target, index) => ({
        zalo_delivery_id: ids[index].id,
        notification_event_id: eventId,
        recipient_user_id: target.app_user_id,
        // 발생 시점 번호를 스냅샷으로 남긴다 — 뒤에 번호를 고쳐도 이 건은 그때 번호다.
        phone_number: target.phone_number as string,
        event_type_code: input.eventCode,
        department_id: input.departmentId,
        template_data: data,
        tracking_id: `zd-${ids[index].id}`,
        expires_at: new Date(input.occurredAt.getTime() + ZALO_TTL_MS),
        priority: input.priority,
      })),
    });
  }
}
