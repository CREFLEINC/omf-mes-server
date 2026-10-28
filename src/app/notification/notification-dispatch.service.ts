import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PagedResponse, pageRequest, pagedResponse } from '../../common/pagination';
import { handoverAlertType } from '../../core/notification';
import { PrismaService } from '../../prisma/prisma.service';

/** 조회 기간 상한 — 화면이 기본 7일·최대 31일로 묻는다(W-CO-13). */
const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

export interface DispatchQuery {
  from: string;
  to: string;
  eventCode?: string;
  departmentId?: number;
  status?: string;
  page?: number;
  size?: number;
}

export interface DeliveryQuery extends DispatchQuery {
  notificationEventId?: number;
}

type Payload = Record<string, unknown>;

/** 대상 칸 — 사건 payload 의 값으로 짓는다(W/O 번호·설비 코드 이름·결재 요청 번호). */
const TARGET_LABEL_KEY: Readonly<Record<string, string>> = {
  WORK_ORDER: 'wo_no',
  EQUIPMENT: 'equipment',
  APPROVAL_REQUEST: 'request_no',
  // 인계 작업 알림 대상(omf-all-around#190 · 장부 P-135). LOT 은 T10 단건 등록 — 번호를 `receipt_no` 에 싣는다.
  GOODS_RECEIPT: 'receipt_no',
  PICKING_ORDER: 'picking_no',
  STOCK_TRANSFER: 'transfer_no',
  SHIPMENT_REQUEST: 'request_no',
  SHIPMENT: 'shipment_no',
  INBOUND_RECEIPT: 'receipt_no',
  LOT: 'receipt_no',
};

/**
 * 알림 발송 이력(W-CO-13 · 장부 P-98) — 이벤트 단위 처리 결과와 수신자 단위 Zalo 결과(FR-030~032).
 * ⛔ 전화번호는 가운데를 가린 형태로만 내린다.
 */
@Injectable()
export class NotificationDispatchService {
  constructor(private readonly prisma: PrismaService) {}

  async dispatches(query: DispatchQuery): Promise<PagedResponse<unknown>> {
    const page = pageRequest(query);
    const where: Prisma.notification_eventWhereInput = {
      occurred_at: period(query),
      ...(query.eventCode === undefined ? {} : { event_type_code: query.eventCode }),
      ...(query.departmentId === undefined ? {} : { department_id: query.departmentId }),
      ...(query.status === undefined ? {} : { dispatch_status_code: query.status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notification_event.findMany({
        where,
        orderBy: [{ occurred_at: 'desc' }, { notification_event_id: 'desc' }],
        include: { department: { select: { department_name: true } }, _count: { select: { notification: true } } },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.notification_event.count({ where }),
    ]);
    const counts = await this.prisma.zalo_delivery.groupBy({
      by: ['notification_event_id', 'status_code'],
      where: { notification_event_id: { in: rows.map((row) => row.notification_event_id) } },
      _count: { _all: true },
    });
    const zaloOf = (eventId: bigint, statuses: string[]) =>
      counts
        .filter((c) => c.notification_event_id === eventId && statuses.includes(c.status_code))
        .reduce((sum, c) => sum + c._count._all, 0);

    return pagedResponse(
      rows.map((row) => {
        const payload = (row.payload ?? {}) as Payload;
        return {
          notificationEventId: Number(row.notification_event_id),
          eventCode: row.event_type_code,
          occurredAt: row.occurred_at.toISOString(),
          departmentId: row.department_id === null ? null : Number(row.department_id),
          departmentName: row.department?.department_name ?? null,
          targetTypeCode: row.aggregate_type_code,
          targetId: Number(row.aggregate_id),
          targetLabel: targetLabel(row.aggregate_type_code, payload, row.event_type_code),
          dispatchStatus: row.dispatch_status_code,
          skipReasonCode: row.skip_reason_code,
          notificationCount: row._count.notification,
          zalo: {
            // 「대기」는 러너가 잡은 중(SENDING)도 포함한다 — 화면이 둘을 가르지 않는다.
            pending: zaloOf(row.notification_event_id, ['PENDING', 'SENDING']),
            sent: zaloOf(row.notification_event_id, ['SENT']),
            failed: zaloOf(row.notification_event_id, ['FAILED']),
            expired: zaloOf(row.notification_event_id, ['EXPIRED']),
            skippedNoPhone: typeof payload.zaloSkippedNoPhone === 'number' ? payload.zaloSkippedNoPhone : 0,
          },
        };
      }),
      total,
      page,
    );
  }

  async deliveries(query: DeliveryQuery): Promise<PagedResponse<unknown>> {
    const page = pageRequest(query);
    const where: Prisma.zalo_deliveryWhereInput = {
      notification_event: { occurred_at: period(query) },
      ...(query.eventCode === undefined ? {} : { event_type_code: query.eventCode }),
      ...(query.departmentId === undefined ? {} : { department_id: query.departmentId }),
      ...(query.status === undefined ? {} : { status_code: query.status }),
      ...(query.notificationEventId === undefined ? {} : { notification_event_id: query.notificationEventId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.zalo_delivery.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { zalo_delivery_id: 'desc' }],
        include: {
          app_user: { select: { user_name: true } },
          notification_event: {
            select: { occurred_at: true, aggregate_type_code: true, payload: true, department: { select: { department_name: true } } },
          },
        },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.zalo_delivery.count({ where }),
    ]);
    return pagedResponse(
      rows.map((row) => ({
        zaloDeliveryId: Number(row.zalo_delivery_id),
        notificationEventId: Number(row.notification_event_id),
        eventCode: row.event_type_code,
        occurredAt: row.notification_event.occurred_at.toISOString(),
        departmentName: row.notification_event.department?.department_name ?? null,
        targetLabel: targetLabel(
          row.notification_event.aggregate_type_code,
          (row.notification_event.payload ?? {}) as Payload,
          row.event_type_code,
        ),
        recipientUserId: Number(row.recipient_user_id),
        recipientName: row.app_user.user_name,
        phoneMasked: maskPhone(row.phone_number),
        status: row.status_code,
        attemptCount: row.attempt_count,
        lastErrorCode: row.last_error_code,
        lastErrorMessage: row.last_error_message,
        sentAt: row.sent_at?.toISOString() ?? null,
        trackingId: row.tracking_id,
      })),
      total,
      page,
    );
  }
}

/** `[from, to)` · 둘 다 필수 · 최대 31일. 계약 가드가 형식(date-time)을 본다. */
function period(query: DispatchQuery): Prisma.DateTimeFilter {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to.getTime() <= from.getTime()) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('to', ERROR_CODE.RANGE, '끝 시각이 시작 시각보다 뒤여야 합니다.')]);
  }
  if (to.getTime() - from.getTime() > MAX_PERIOD_MS) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [field('to', ERROR_CODE.RANGE, '조회 기간은 최대 31일입니다.')]);
  }
  return { gte: from, lt: to };
}

/** 인계 알림은 창고가 있으면 「번호 · 창고」다(대상이 어느 창고 일인지 · W-CO-13). 기존 6종은 그대로. */
function targetLabel(aggregateType: string, payload: Payload, eventCode: string): string | null {
  const value = payload[TARGET_LABEL_KEY[aggregateType] ?? ''];
  const label = typeof value === 'string' && value !== '' ? value : null;
  if (label === null || handoverAlertType(eventCode) === undefined) return label;
  const warehouse = payload.warehouse ?? payload.to_warehouse;
  return typeof warehouse === 'string' && warehouse !== '' ? `${label} · ${warehouse}` : label;
}

/** 표준형 `84XXXXXXXXX` → 국내형 `0XXXXXXXXX` 의 앞 3자리·끝 2자리만 남긴다. 예: `091*****78`. */
export function maskPhone(phone: string): string {
  const local = phone.startsWith('84') ? `0${phone.slice(2)}` : phone;
  if (local.length <= 5) return '*'.repeat(local.length);
  return `${local.slice(0, 3)}${'*'.repeat(local.length - 5)}${local.slice(-2)}`;
}
