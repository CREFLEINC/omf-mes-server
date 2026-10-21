import { Prisma } from '@prisma/client';

import { EmitInput, NotificationEmitter } from './notification-emitter';

type User = { app_user_id: bigint; is_active: boolean; phone_number: string | null };
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ON = { app_user_id: 1n, is_active: true, phone_number: '84912345678' };
const NO_PHONE = { app_user_id: 2n, is_active: true, phone_number: null };
const GONE = { app_user_id: 3n, is_active: false, phone_number: '84987654321' };

/** 생성기가 읽고 쓰는 표만 흉내낸다. 쓴 행을 그대로 담아 단언한다. */
function fake(seed: {
  existing?: boolean;
  setting?: { is_enabled: boolean; zalo_enabled: boolean; users: User[] } | null;
  approver?: User | null;
  paramMaxLength?: number;
}) {
  const written = { events: [] as Args[], notifications: [] as Args[], deliveries: [] as Args[] };
  let nextId = 500n;
  const tx = {
    notification_event: {
      findUnique: async () => (seed.existing ? { notification_event_id: 1n } : null),
      create: async (a: Args) => {
        written.events.push(a.data);
        return { notification_event_id: 900n };
      },
    },
    notification_department_setting: {
      findUnique: async () =>
        seed.setting === undefined || seed.setting === null
          ? null
          : {
              is_enabled: seed.setting.is_enabled,
              zalo_enabled: seed.setting.zalo_enabled,
              recipients: seed.setting.users.map((app_user) => ({ app_user })),
            },
    },
    app_user: { findUnique: async () => seed.approver ?? null },
    notification: { createMany: async (a: Args) => written.notifications.push(...a.data) },
    zalo_connection: {
      findUnique: async () => (seed.paramMaxLength === undefined ? null : { param_max_length: seed.paramMaxLength }),
    },
    $queryRaw: async (sql: Prisma.Sql) => {
      const count = Number(sql.values[0]);
      return Array.from({ length: count }, () => ({ id: nextId++ }));
    },
    zalo_delivery: { createMany: async (a: Args) => written.deliveries.push(...a.data) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, written };
}

const OCCURRED = new Date('2026-10-21T07:30:00.000Z');

function input(extra: Partial<EmitInput> = {}): EmitInput {
  return {
    eventCode: 'WORK_SESSION_STARTED',
    aggregateTypeCode: 'WORK_ORDER',
    aggregateId: 42n,
    occurredAt: OCCURRED,
    departmentId: 7n,
    values: { wo_no: 'WO-1', item: 'P100 커버', process: '사출', line: 'L1', actor: '홍길동' },
    ...extra,
  };
}

describe('NotificationEmitter', () => {
  const emitter = new NotificationEmitter();

  it('US1-1 활성 수신자마다 알림 1행 — 비활성은 뺀다, 제목은 이벤트 이름', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: false, users: [ON, NO_PHONE, GONE] } });
    const result = await emitter.emit(tx, input());

    expect(result).toEqual({ notificationEventId: 900n, skipReason: null, notificationCount: 2, zaloCount: 0 });
    expect(written.notifications.map((n) => n.recipient_user_id)).toEqual([1n, 2n]);
    expect(written.notifications[0]).toMatchObject({ title: '생산 실행', message: 'WO-1 · P100 커버 · 사출 · L1 · 홍길동 · 10-21 14:30' });
    expect(written.events[0]).toMatchObject({
      department_id: 7n,
      dispatch_status_code: 'NOTIFIED',
      skip_reason_code: null,
      aggregate_type_code: 'WORK_ORDER',
    });
    expect(written.deliveries).toEqual([]);
  });

  it('US1-2 Zalo 켬 + 번호 있는 수신자만 PENDING 건 — 번호 스냅샷·24시간 만료·zd-{id}', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: true, users: [ON, NO_PHONE] }, paramMaxLength: 5 });
    const result = await emitter.emit(tx, input());

    expect(result.zaloCount).toBe(1);
    expect(written.deliveries).toHaveLength(1);
    expect(written.deliveries[0]).toMatchObject({
      zalo_delivery_id: 500n,
      tracking_id: 'zd-500',
      recipient_user_id: 1n,
      phone_number: '84912345678',
      event_type_code: 'WORK_SESSION_STARTED',
      department_id: 7n,
      expires_at: new Date('2026-10-22T07:30:00.000Z'),
    });
    expect(written.deliveries[0].template_data).toMatchObject({ wo_no: 'WO-1', item: 'P100 ', event_time: '21/10' });
  });

  it.each([
    ['REPORTER_OPTED_OUT', { optOut: true }, { is_enabled: true, zalo_enabled: true, users: [ON] }],
    ['DEPARTMENT_UNRESOLVED', { departmentId: null }, { is_enabled: true, zalo_enabled: true, users: [ON] }],
    ['EVENT_DISABLED', {}, null],
    ['EVENT_DISABLED', {}, { is_enabled: false, zalo_enabled: true, users: [ON] }],
    ['NO_RECIPIENTS', {}, { is_enabled: true, zalo_enabled: true, users: [GONE] }],
  ] as const)('%s — 사건만 SKIPPED 로 남고 알림·Zalo 는 0건', async (reason, extra, setting) => {
    const { tx, written } = fake({ setting: setting === null ? null : { ...setting, users: [...setting.users] } });
    const result = await emitter.emit(tx, input(extra));

    expect(result).toEqual({ notificationEventId: 900n, skipReason: reason, notificationCount: 0, zaloCount: 0 });
    expect(written.events[0]).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: reason });
    expect(written.notifications).toEqual([]);
    expect(written.deliveries).toEqual([]);
  });

  it('APPROVER 모드면 설정 수신자 대신 지정된 결재자 1명에게 쓴다', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: true, users: [NO_PHONE] }, approver: ON });
    const result = await emitter.emit(
      tx,
      input({ eventCode: 'APPROVAL_ACTION_REQUIRED', aggregateTypeCode: 'APPROVAL_REQUEST', approverUserId: 1n, values: { request_no: 'AR-1' } }),
    );

    expect(result.notificationCount).toBe(1);
    expect(written.notifications.map((n) => n.recipient_user_id)).toEqual([1n]);
    expect(written.deliveries.map((d) => d.recipient_user_id)).toEqual([1n]);
  });

  it('APPROVER 모드에서 결재자가 비활성이면 APPROVER_INACTIVE 다', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: false, users: [] }, approver: GONE });
    const result = await emitter.emit(
      tx,
      input({ eventCode: 'APPROVAL_ACTION_REQUIRED', aggregateTypeCode: 'APPROVAL_REQUEST', approverUserId: 3n }),
    );
    expect(result.skipReason).toBe('APPROVER_INACTIVE');
    expect(written.notifications).toEqual([]);
  });

  it('SC-004 같은 (이벤트, 대상, 발생 시각) 사건이 이미 있으면 아무것도 쓰지 않는다', async () => {
    const { tx, written } = fake({ existing: true, setting: { is_enabled: true, zalo_enabled: true, users: [ON] } });
    const result = await emitter.emit(tx, input());

    expect(result.notificationEventId).toBeNull();
    expect(written.events).toEqual([]);
    expect(written.notifications).toEqual([]);
  });

  it('payload 에 값과 참조 ID 를 함께 남긴다', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: false, users: [ON] } });
    await emitter.emit(tx, input({ refs: { breakdownId: 11 } }));
    expect(written.events[0].payload).toMatchObject({ breakdownId: 11, wo_no: 'WO-1', actor: '홍길동' });
  });
});
