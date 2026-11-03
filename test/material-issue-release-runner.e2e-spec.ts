/**
 * 출고 작업일 00:00 자동 배포 러너(피처 003 · omf-all-around#66 · US3 · US7-7 · FR-022 · SC-001·002).
 *
 * 시각은 `tick(now)` 로만 움직인다. 러너는 DB 의 모든 공장을 돌므로, 여기서는 이 시험이 만든 요청만 본다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { issueWorkDate } from '../src/core/calendar/issue-work-date';
import { dynamicShortages } from '../src/core/material-issue/planned-stock';
import { MaterialIssueReleaser } from '../src/core/material-issue/release-request';
import { NumberingService } from '../src/core/numbering';
import { SyncLease } from '../src/integration/erp/sync-lease';
import {
  MATERIAL_ISSUE_RELEASE_LEASE,
  MaterialIssueReleaseRunner,
} from '../src/logistics/material-issue-request/material-issue-release.runner';
import { zonedToUtc } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import { ItemKey, MaterialIssueFixture } from './support/material-issue-fixture';

const PREFIX = `MIR${randomUUID().slice(0, 6)}`;
const HANOI = 'Asia/Ho_Chi_Minh';
const SEOUL = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('00:00 출고 요청 배포 러너 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: MaterialIssueFixture;
  let runner: MaterialIssueReleaseRunner;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    runner = app.get(MaterialIssueReleaseRunner);
    fx = new MaterialIssueFixture(app, prisma, PREFIX);
    await fx.setup();
    fx.ids.p1 = await fx.plant('P1', HANOI);
    fx.ids.p2 = await fx.plant('P2', SEOUL);
    fx.ids.p6 = await fx.plant('P6', HANOI);
    await prisma.operation_policy.create({
      data: { policy_code: 'WEEKLY_WORKING_DAYS', plant_id: fx.ids.p6, value_numeric: 6, effective_from: new Date('2026-01-01T00:00:00Z') },
    });
  });

  afterAll(async () => {
    await prisma.sync_lease.deleteMany({ where: { lease_name: MATERIAL_ISSUE_RELEASE_LEASE } });
    await fx.cleanup();
    await app.close();
  });

  /** 생산 창고 하나(재고 `stock`)와 그 창고만 연결한 부서·라인. */
  async function line(plantKey: string, stock: [ItemKey, number][]) {
    const code = `S${++seq}`;
    const at = await fx.warehouse(fx.ids[plantKey.toLowerCase()], `${code}-A`);
    for (const [item, qty] of stock) await fx.stock(at, item, qty);
    const lineId = await fx.line(plantKey, `${code}-L`, await fx.department(`${code}-D`, [at.warehouseId]));
    return { ...at, lineId };
  }

  /** 다음 `weekday` 생산 W/O 를 배포해 대기 요청 하나를 만든다. */
  async function waiting(plantKey: string, at: { lineId: bigint }, operation: string, weekday: number, days = 5) {
    const productionDate = fx.nextWeekday(plantKey, weekday);
    const workOrderId = await fx.workOrder({ plantKey, lineId: at.lineId, operation, productionDate });
    await fx.release(workOrderId).expect(200);
    const [row] = await fx.requests(workOrderId);
    expect(row.status_code).toBe('WAITING');
    return { workOrderId, requestId: row.material_issue_request_id, workDate: issueWorkDate(productionDate, days as 5 | 6) };
  }

  const at = (date: string, time: string, timezone = HANOI) => zonedToUtc(date, time, timezone);
  const status = async (requestId: bigint) =>
    (await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: requestId } })).status_code;

  it('US3-1 출고 작업일 00:00 이 되면 배포 — 피킹 지시·T2, 23:59:59 에는 아직, 두 번 돌려도 그대로', async () => {
    const stock = await line('P1', [['X', 100]]);
    const { requestId, workDate } = await waiting('P1', stock, 'X20', 1);

    await runner.tick(at(new Date(new Date(`${workDate}T00:00:00Z`).getTime() - DAY_MS).toISOString().slice(0, 10), '23:59:59'));
    expect(await status(requestId)).toBe('WAITING');

    await runner.tick(at(workDate, '00:00:30'));
    const row = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: requestId } });
    expect(row).toMatchObject({ status_code: 'REGISTERED', release_error_text: null });
    expect(row.released_at).not.toBeNull();
    const pickings = await fx.pickings(requestId);
    expect(pickings).toHaveLength(1);
    expect(pickings[0]).toMatchObject({ warehouse_id: stock.warehouseId, status_code: 'REGISTERED', created_by: null });
    expect(await prisma.notification_event.count({ where: { aggregate_type_code: 'PICKING_ORDER', aggregate_id: pickings[0].picking_order_id } })).toBe(1);

    await runner.tick(at(workDate, '00:01:30'));
    expect(await fx.pickings(requestId)).toHaveLength(1);
  });

  it('US3-2 시간대가 다른 두 공장 — 각자의 00:00 에 배포된다', async () => {
    const hanoi = await waiting('P1', await line('P1', [['X', 100]]), 'X20', 2);
    const seoul = await waiting('P2', await line('P2', [['X', 100]]), 'X20', 2);
    expect(seoul.workDate).toBe(hanoi.workDate);

    // 서울 00:00:30 = 하노이 22:00:30(전날)
    await runner.tick(at(seoul.workDate, '00:00:30', SEOUL));
    expect(await status(seoul.requestId)).toBe('REGISTERED');
    expect(await status(hanoi.requestId)).toBe('WAITING');

    await runner.tick(at(hanoi.workDate, '00:00:30', HANOI));
    expect(await status(hanoi.requestId)).toBe('REGISTERED');
  });

  it('US7-7 주 6일 공장 — 출고 작업일이 토요일인 대기 요청이 토요일 00:00 에 배포된다', async () => {
    const { requestId, workDate } = await waiting('P6', await line('P6', [['X', 100]]), 'X20', 1, 6);
    expect(new Date(`${workDate}T00:00:00Z`).getUTCDay()).toBe(6);
    await runner.tick(at(workDate, '00:00:30'));
    expect(await status(requestId)).toBe('REGISTERED');
  });

  it('US3-3 SC-002 두 인스턴스가 동시에 돌고 밀린 3일치가 있어도 요청마다 한 번만 배포', async () => {
    const stock = await line('P1', [['X', 1000]]);
    const made = [];
    for (const weekday of [1, 2, 3, 4, 5, 1]) made.push(await waiting('P1', stock, 'X20', weekday));
    const ids = made.map((m) => m.requestId);
    // 출고 작업일을 사흘에 걸친 지난 날짜로 — 러너가 멈춰 있던 동안 밀린 것이다.
    const latest = made.map((m) => m.workDate).sort().at(-1) as string;
    for (const [index, id] of ids.entries()) {
      const day = new Date(new Date(`${latest}T00:00:00Z`).getTime() - (index % 3) * DAY_MS);
      await prisma.material_issue_request.update({ where: { material_issue_request_id: id }, data: { issue_work_date: day } });
    }
    const second = new MaterialIssueReleaseRunner(
      true, prisma, { acquire: async () => true, release: async () => undefined },
      app.get(MaterialIssueReleaser), app.get(NumberingService),
    );
    const third = new MaterialIssueReleaseRunner(
      true, prisma, new SyncLease(prisma, MATERIAL_ISSUE_RELEASE_LEASE), app.get(MaterialIssueReleaser), app.get(NumberingService),
    );
    const now = at(latest, '00:05:00');
    await Promise.all([runner.tick(now), second.tick(now), third.tick(now)]);

    for (const id of ids) {
      expect(await status(id)).toBe('REGISTERED');
      expect(await fx.pickings(id)).toHaveLength(1);
    }
  });

  it('US3-4 배포 때 재고가 모자라면 집을 수 있는 만큼만 피킹하고 부족으로 보인다', async () => {
    const stock = await line('P1', [['X', 100]]);
    const { requestId, workDate } = await waiting('P1', stock, 'X50', 3);
    const balance = await prisma.inventory_balance.findFirstOrThrow({ where: { warehouse_id: stock.warehouseId } });
    await prisma.inventory_balance.update({ where: { inventory_balance_id: balance.inventory_balance_id }, data: { on_hand_qty: 30 } });

    await runner.tick(at(workDate, '00:00:30'));
    expect(await status(requestId)).toBe('REGISTERED');
    const [picking] = await fx.pickings(requestId);
    expect(picking.picking_line.map((l) => l.planned_qty.toNumber())).toEqual([30]);
    const shortages = await dynamicShortages(prisma, { plantId: fx.ids.p1, warehouseId: stock.warehouseId });
    expect(shortages.map((s) => s.shortageQty.toNumber())).toEqual([20]);
  });

  it('FR-022 한 건의 실패는 나머지를 막지 않고 원인을 남긴다 — 다음 회차 간격 뒤 다시 시도', async () => {
    const good = await line('P1', [['X', 100]]);
    const bad = await line('P1', [['X', 100]]);
    const ok = await waiting('P1', good, 'X20', 4);
    const broken = await waiting('P1', bad, 'X20', 4);
    await prisma.warehouse.update({ where: { warehouse_id: bad.warehouseId }, data: { is_active: false } });

    await runner.tick(at(ok.workDate, '00:00:30'));
    expect(await status(ok.requestId)).toBe('REGISTERED');
    const failed = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: broken.requestId } });
    expect(failed.status_code).toBe('WAITING');
    expect(failed.release_error_text).toContain('사용 중지');
    expect(failed.release_attempted_at).not.toBeNull();

    await prisma.warehouse.update({ where: { warehouse_id: bad.warehouseId }, data: { is_active: true } });
    await runner.tick(at(ok.workDate, '00:05:30'));
    expect(await status(broken.requestId)).toBe('WAITING');
    await runner.tick(at(ok.workDate, '00:11:00'));
    const recovered = await prisma.material_issue_request.findUniqueOrThrow({ where: { material_issue_request_id: broken.requestId } });
    expect(recovered).toMatchObject({ status_code: 'REGISTERED', release_error_text: null });
  });

  it('US3-6 00:00 배포는 알림센터 즉시 · Zalo 는 현장 07:00, 07:00 이후 배포는 Zalo 도 바로', async () => {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}-ZALO`, user_name: 'Zalo 담당', status_code: 'EMPLOYED', phone_number: '84912345670' },
    });
    const setting = await prisma.handover_alert_setting.create({
      data: { plant_id: fx.ids.p1, alert_type_code: 'MATERIAL_PICKING_REQUESTED', is_enabled: true, zalo_enabled: true },
    });
    await prisma.handover_alert_recipient.create({ data: { handover_alert_setting_id: setting.handover_alert_setting_id, app_user_id: user.app_user_id } });
    const stock = await line('P1', [['X', 100]]);
    const zalo = async (requestId: bigint) => {
      const [picking] = await fx.pickings(requestId);
      const event = await prisma.notification_event.findFirstOrThrow({ where: { aggregate_type_code: 'PICKING_ORDER', aggregate_id: picking.picking_order_id } });
      return {
        notifications: await prisma.notification.count({ where: { notification_event_id: event.notification_event_id } }),
        deliveries: await prisma.zalo_delivery.findMany({ where: { notification_event_id: event.notification_event_id } }),
      };
    };

    const night = await waiting('P1', stock, 'X20', 5);
    await runner.tick(at(night.workDate, '00:00:30'));
    const first = await zalo(night.requestId);
    expect(first.notifications).toBe(1);
    expect(first.deliveries.map((d) => d.next_attempt_at.toISOString())).toEqual([at(night.workDate, '07:00:00').toISOString()]);

    // 같은 출고 작업일의 요청이 07:00 이후에 배포되면(밀린 처리) Zalo 를 미루지 않는다 — 대기 행 기본값(쓴 순간)이다.
    const late = await waiting('P1', stock, 'X20', 5);
    const writtenBefore = Date.now();
    await runner.tick(at(late.workDate, '07:30:00'));
    const second = await zalo(late.requestId);
    expect(second.deliveries).toHaveLength(1);
    expect(second.deliveries[0].next_attempt_at.getTime()).toBeGreaterThanOrEqual(writtenBefore - 1000);
    expect(second.deliveries[0].next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
