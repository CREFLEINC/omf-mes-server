import { Prisma } from '@prisma/client';

import { HandoverEmitInput, NotificationEmitter } from './notification-emitter';

type User = { app_user_id: bigint; is_active: boolean; phone_number: string | null };
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PHONE = { app_user_id: 1n, is_active: true, phone_number: '84912345678' };
const NO_PHONE = { app_user_id: 2n, is_active: true, phone_number: null };
const GONE = { app_user_id: 3n, is_active: false, phone_number: '84987654321' };

/** 인계 생성기가 읽고 쓰는 표만 흉내낸다. */
function fake(seed: { existing?: boolean; setting?: { is_enabled: boolean; zalo_enabled: boolean; users: User[] } | null; failOn?: string }) {
  const written = { events: [] as Args[], notifications: [] as Args[], deliveries: [] as Args[], sql: [] as string[], settingWhere: [] as Args[] };
  let nextId = 700n;
  const tx = {
    $executeRawUnsafe: async (sql: string) => written.sql.push(sql),
    notification_event: {
      findFirst: async () => (seed.existing ? { notification_event_id: 1n } : null),
      create: async (a: Args) => {
        if (seed.failOn === 'event') throw new Error('주입한 실패');
        written.events.push(a.data);
        return { notification_event_id: 901n };
      },
    },
    handover_alert_setting: {
      findUnique: async (a: Args) => {
        written.settingWhere.push(a.where);
        return seed.setting === undefined || seed.setting === null
          ? null
          : {
              is_enabled: seed.setting.is_enabled,
              zalo_enabled: seed.setting.zalo_enabled,
              recipients: seed.setting.users.map((app_user) => ({ app_user })),
            };
      },
    },
    notification: { createMany: async (a: Args) => written.notifications.push(...a.data) },
    zalo_connection: { findUnique: async () => null },
    $queryRaw: async (sql: Prisma.Sql) => Array.from({ length: Number(sql.values[0]) }, () => ({ id: nextId++ })),
    zalo_delivery: { createMany: async (a: Args) => written.deliveries.push(...a.data) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, written };
}

const OCCURRED = new Date('2026-10-28T02:05:00.000Z');

function input(extra: Partial<HandoverEmitInput> = {}): HandoverEmitInput {
  return {
    alertTypeCode: 'MATERIAL_PICKING_REQUESTED',
    plantId: 5n,
    aggregateTypeCode: 'PICKING_ORDER',
    aggregateId: 77n,
    occurredAt: OCCURRED,
    values: { picking_no: 'PK-1', wo_no: 'WO-1', item_count: 2, warehouse: '자재창고 A' },
    ...extra,
  };
}

describe('NotificationEmitter.emitHandover', () => {
  const emitter = new NotificationEmitter();

  it.each([
    ['설정 행이 없다', null],
    ['알림이 꺼져 있다', { is_enabled: false, zalo_enabled: false, users: [PHONE] }],
  ])('US1-4 FR-024 %s → SKIPPED EVENT_DISABLED, 부서는 null', async (_label, setting) => {
    const { tx, written } = fake({ setting });
    const result = await emitter.emitHandover(tx, input());

    expect(result).toEqual({ notificationEventId: 901n, skipReason: 'EVENT_DISABLED', notificationCount: 0, zaloCount: 0 });
    expect(written.events[0]).toMatchObject({
      event_type_code: 'MATERIAL_PICKING_REQUESTED',
      aggregate_type_code: 'PICKING_ORDER',
      aggregate_id: 77n,
      department_id: null,
      dispatch_status_code: 'SKIPPED',
      skip_reason_code: 'EVENT_DISABLED',
    });
    expect(written.notifications).toEqual([]);
    expect(written.deliveries).toEqual([]);
    expect(written.settingWhere[0]).toEqual({
      plant_id_alert_type_code: { plant_id: 5n, alert_type_code: 'MATERIAL_PICKING_REQUESTED' },
    });
  });

  it('US1-4 FR-024 켜져 있어도 활성 담당자가 없으면 SKIPPED NO_RECIPIENTS', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: true, users: [GONE] } });
    const result = await emitter.emitHandover(tx, input());

    expect(result.skipReason).toBe('NO_RECIPIENTS');
    expect(written.events[0]).toMatchObject({ dispatch_status_code: 'SKIPPED', skip_reason_code: 'NO_RECIPIENTS', department_id: null });
    expect(written.notifications).toEqual([]);
  });

  it('활성 담당자마다 알림센터 1행 — 비활성은 빠지고 제목은 종류 이름이다', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: false, users: [PHONE, NO_PHONE, GONE] } });
    const result = await emitter.emitHandover(tx, input());

    expect(result).toEqual({ notificationEventId: 901n, skipReason: null, notificationCount: 2, zaloCount: 0 });
    expect(written.notifications.map((n) => n.recipient_user_id)).toEqual([1n, 2n]);
    expect(written.notifications[0]).toMatchObject({ title: '자재 출고 피킹', message: 'PK-1 · WO-1 · 품목 2 · 자재창고 A · 10-28 09:05' });
    expect(written.events[0]).toMatchObject({ dispatch_status_code: 'NOTIFIED', skip_reason_code: null, department_id: null });
    expect(written.deliveries).toEqual([]);
  });

  it('US1-2 Zalo 가 켜져 있고 번호가 있는 담당자만 Zalo 대기 1행, priority 1', async () => {
    const { tx, written } = fake({ setting: { is_enabled: true, zalo_enabled: true, users: [PHONE, NO_PHONE] } });
    const result = await emitter.emitHandover(tx, input());

    expect(result.zaloCount).toBe(1);
    expect(written.deliveries).toHaveLength(1);
    expect(written.deliveries[0]).toMatchObject({
      recipient_user_id: 1n,
      phone_number: '84912345678',
      event_type_code: 'MATERIAL_PICKING_REQUESTED',
      department_id: null,
      priority: 1,
      tracking_id: 'zd-700',
    });
    expect(Object.keys(written.deliveries[0].template_data)).toEqual([
      'picking_no', 'wo_no', 'item_count', 'warehouse', 'required_at', 'event_time',
    ]);
    expect(written.events[0].payload).toMatchObject({ zaloSkippedNoPhone: 1 });
  });

  it('FR-002 같은 (종류, 대상) 사건이 이미 있으면 아무것도 쓰지 않는다', async () => {
    const { tx, written } = fake({ existing: true, setting: { is_enabled: true, zalo_enabled: true, users: [PHONE] } });
    const result = await emitter.emitHandover(tx, input());

    expect(result).toEqual({ notificationEventId: null, skipReason: null, notificationCount: 0, zaloCount: 0 });
    expect(written.events).toEqual([]);
    expect(written.notifications).toEqual([]);
  });

  it('모르는 종류 코드는 던진다 — 기존 이벤트 코드도 인계 목록에 없다', async () => {
    const { tx } = fake({});
    await expect(emitter.emitHandover(tx, input({ alertTypeCode: 'NOPE' }))).rejects.toThrow('인계 작업 종류 목록에 없는 코드');
    await expect(emitter.emitHandover(tx, input({ alertTypeCode: 'WORK_ORDER_CLOSED' }))).rejects.toThrow();
  });

  it('SC-005 쓰다 실패하면 SAVEPOINT 로 되돌리고 던지지 않는다 — 업무 트랜잭션은 이어 간다', async () => {
    const { tx, written } = fake({ failOn: 'event', setting: { is_enabled: true, zalo_enabled: true, users: [PHONE] } });
    const result = await emitter.emitHandover(tx, input());

    expect(result).toEqual({ notificationEventId: null, skipReason: null, notificationCount: 0, zaloCount: 0 });
    expect(written.sql).toEqual(['SAVEPOINT handover_alert', 'ROLLBACK TO SAVEPOINT handover_alert']);
  });

  it('성공하면 SAVEPOINT 를 풀어 준다', async () => {
    const { tx, written } = fake({ setting: null });
    await emitter.emitHandover(tx, input());

    expect(written.sql).toEqual(['SAVEPOINT handover_alert', 'RELEASE SAVEPOINT handover_alert']);
  });
});
