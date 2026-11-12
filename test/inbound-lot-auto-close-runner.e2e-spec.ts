/**
 * 피처 005 S6 — 입하 LOT 날짜 자동 마감 러너(omf-all-around#254 · T038 · research R-21). 앱의 러너는 global-setup 이 끄고
 * (`INBOUND_LOT_AUTO_CLOSE_ENABLED='false'`), 시험이 러너를 직접 만들어 `tick(now)` 로 시각을 움직인다. 리스는 SC-009 만 진짜다.
 * 마감 취소가 `open_since_date` 를 실제 오늘로 두므로 날짜는 실제 오늘(하노이) 기준이다.
 */
import { FactoryProvider, INestApplication, Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { NumberingService } from '../src/core/numbering';
import { SyncLease } from '../src/integration/erp/sync-lease';
import {
  INBOUND_LOT_AUTO_CLOSE_LEASE, INBOUND_LOT_AUTO_CLOSE_STARTUP_DELAY_MS, InboundLotAutoCloseRunner,
} from '../src/logistics/inbound-lot/inbound-lot-auto-close.runner';
import { InboundLotCloseService } from '../src/logistics/inbound-lot/inbound-lot-close';
import { LogisticsModule } from '../src/logistics/logistics.module';
import { localDate, zonedToUtc } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  InboundLotFixture, ReceivedInboundLot, closeInboundLotFixture, idempotencyKey, issueAndReceive, issueMaterialLots, receiveScan, sessionAuth,
} from './support/inbound-lot-fixture';

const PREFIX = 'E5AC';
const HANOI = 'Asia/Ho_Chi_Minh';
const SEOUL = 'Asia/Seoul';
const DAY = localDate(new Date(), HANOI);
const shift = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const YESTERDAY = shift(DAY, -1);
const TOMORROW = shift(DAY, 1);
const LOTS = '/api/logistics/inbound-lots';
const at = (day: string, time: string, timezone = HANOI): Date => zonedToUtc(day, time, timezone);
const always = { acquire: async () => true, release: async () => undefined };

describe('피처 005 S6 — 입하 LOT 날짜 자동 마감 러너 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let fx: InboundLotFixture;
  const ids: Record<string, bigint> = {};
  const keys = new Set<string>();
  let seq = 0;

  const runner = (lease: Pick<SyncLease, 'acquire' | 'release'> = always, enabled = true): InboundLotAutoCloseRunner =>
    new InboundLotAutoCloseRunner(enabled, prisma, lease, app.get(InboundLotCloseService), app.get(NumberingService));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    fx = { app, issuer: sessionAuth(cookie), receiver: sessionAuth(cookie), businessDate: DAY, keys };
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  /** `day`(공장 현지)에 묶음을 발행하고 받는다 — 그날 연 입하 중 입하 LOT 하나. */
  async function openOn(day: string, plant: bigint, supplier: bigint, lotCount = 1, lotQty = 5): Promise<ReceivedInboundLot> {
    const { inboundLot } = await issueAndReceive({ ...fx, businessDate: day }, {
      plantId: Number(plant), supplierId: Number(supplier), itemId: Number(ids.itemA), lotQty, lotCount,
    });
    return inboundLot;
  }

  const rowOf = (inboundLotId: number) => prisma.inbound_lot.findUniqueOrThrow({ where: { inbound_lot_id: BigInt(inboundLotId) } });
  const day = (date: Date | null): string | null => (date === null ? null : date.toISOString().slice(0, 10));
  const closedEvents = (inboundLotId: number) =>
    prisma.inbound_lot_event.findMany({ where: { inbound_lot_id: BigInt(inboundLotId), event_type_code: 'RECEIPT_CLOSED' } });

  it('US2-11 어제 연 입하 LOT → 오늘 00:00:30(현지) tick 에 RECEIVED·자동 표시·RECEIPT_CLOSED{auto}·행위자 시스템·배정·IQC 요청·인계 알림, 오늘 연 것은 그대로', async () => {
    const order = await makeOrder(ids.supplierS, 7);
    const stale = await openOn(YESTERDAY, ids.plant, ids.supplierS, 2, 5);
    const fresh = await openOn(DAY, ids.plant, ids.supplierT);
    const tickAt = at(DAY, '00:00:30');
    // 0시 전에는 어제가 「오늘」이다.
    await runner().tick(at(YESTERDAY, '23:59:30'));
    expect(await rowOf(stale.inboundLotId)).toMatchObject({ status_code: 'RECEIVING' });

    expect(await runner().tick(tickAt)).toBeGreaterThanOrEqual(1);
    const row = await rowOf(stale.inboundLotId);
    expect(row).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true, received_closed_by: null, open_since_date: null });
    expect(row.received_closed_at?.toISOString()).toBe(tickAt.toISOString());
    const [event] = await closedEvents(stale.inboundLotId);
    expect(event).toMatchObject({
      actor_user_id: null, actor_worker_id: null,
      summary: expect.objectContaining({ auto: true, unallocatedQty: '3', allocations: [{ purchaseOrderLineId: String(order), qty: '7' }] }),
    });
    expect(Number((await prisma.purchase_order_line.findUniqueOrThrow({ where: { purchase_order_line_id: order } })).received_qty)).toBe(7);
    const iqc = await prisma.inspection_request.findFirstOrThrow({ where: { inbound_lot_id: row.inbound_lot_id } });
    expect(iqc).toMatchObject({ status_code: 'REQUESTED', created_by: null, target_type_code: 'INBOUND_LOT', lot_id: null });
    expect(Number(iqc.target_qty)).toBe(10);
    const line = await prisma.inbound_receipt_line.findUniqueOrThrow({
      where: { inbound_receipt_line_id: row.inbound_receipt_line_id }, select: { inbound_receipt: { select: { inbound_receipt_id: true, inbound_receipt_no: true } } },
    });
    const alert = await prisma.notification_event.findFirstOrThrow({
      where: { event_type_code: 'IQC_INSPECTION_REQUESTED', aggregate_id: line.inbound_receipt.inbound_receipt_id },
    });
    expect(alert.payload).toMatchObject({ receipt_no: `${line.inbound_receipt.inbound_receipt_no} (자동 마감)`, lot_count: 2 });
    expect(await rowOf(fresh.inboundLotId)).toMatchObject({ status_code: 'RECEIVING', closed_automatically: false });

    // 같은 날 다시 tick 해도 다시 닫지 않는다.
    await runner().tick(at(DAY, '00:01:30'));
    expect(await closedEvents(stale.inboundLotId)).toHaveLength(1);
    const listed = await request(app.getHttpServer()).get(LOTS).query({ plantId: Number(ids.plant), closedAutomatically: true }).set('Cookie', cookie).expect(200);
    expect((listed.body.items as { inboundLotId: number }[]).map((item) => item.inboundLotId)).toContain(stale.inboundLotId);
  });

  it('US2-11(받기 때 확인) 러너 없이 날짜를 넘겨 같은 조합을 스캔하면 먼저 자동 마감하고 새 입하 LOT 을 연다 — 응답 autoClosedInboundLotNo', async () => {
    const stale = await openOn(YESTERDAY, ids.plant, ids.supplierU);
    const { lots } = await issueMaterialLots(fx, { plantId: Number(ids.plant), supplierId: Number(ids.supplierU), itemId: Number(ids.itemA), lotQty: 5, lotCount: 1 });
    const today = await receiveScan(fx, { lotId: lots[0].lotId });
    expect(today).toMatchObject({ created: true, autoClosedInboundLotNo: stale.inboundLotNo, lotCount: 1 });
    expect(today.inboundLotId).not.toBe(stale.inboundLotId);
    expect(await rowOf(stale.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true, received_closed_by: null });
  });

  it('R21-1 마감 취소로 다시 연 지난 날짜 입하 LOT 은 오늘 회차에 닫히지 않고 스캔이 붙으며, 다음 0시 tick 에 닫힌다', async () => {
    const opened = await openOn(YESTERDAY, ids.plant, ids.supplierV);
    const closed = await closeInboundLotFixture({ ...fx, businessDate: YESTERDAY }, opened.inboundLotId);
    await request(app.getHttpServer()).post(`${LOTS}/${String(closed.inboundLotId)}:reopen-receipt`).set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey(fx)).send({ versionNo: closed.versionNo }).expect(200);
    const reopened = await rowOf(opened.inboundLotId);
    expect([reopened.status_code, day(reopened.receiving_date), day(reopened.open_since_date)]).toEqual(['RECEIVING', YESTERDAY, DAY]);

    await runner().tick(new Date());
    expect(await rowOf(opened.inboundLotId)).toMatchObject({ status_code: 'RECEIVING' });
    const { lots } = await issueMaterialLots(fx, { plantId: Number(ids.plant), supplierId: Number(ids.supplierV), itemId: Number(ids.itemA), lotQty: 5, lotCount: 1 });
    expect(await receiveScan(fx, { lotId: lots[0].lotId })).toMatchObject({
      inboundLotId: opened.inboundLotId, created: false, autoClosedInboundLotNo: null, lotCount: 2,
    });

    await runner().tick(at(TOMORROW, '00:00:30'));
    expect(await rowOf(opened.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true });
    const events = await closedEvents(opened.inboundLotId);
    expect(events.map((event) => (event.summary as { auto: boolean }).auto)).toEqual([false, true]);
  });

  it('R21-2 시간대가 다른 두 공장(하노이 UTC+7·서울 UTC+9)은 각 현지 0시가 지난 회차에만 닫힌다', async () => {
    const hanoi = await openOn(YESTERDAY, ids.plant, ids.supplierW);
    const seoul = await openOn(YESTERDAY, ids.plantSeoul, ids.supplierW);
    expect(day((await rowOf(seoul.inboundLotId)).open_since_date)).toBe(YESTERDAY);

    await runner().tick(at(YESTERDAY, '23:59:30', SEOUL));
    expect([(await rowOf(hanoi.inboundLotId)).status_code, (await rowOf(seoul.inboundLotId)).status_code]).toEqual(['RECEIVING', 'RECEIVING']);
    // 서울 0시 = 하노이 전날 22시 — 서울만 닫힌다.
    await runner().tick(at(DAY, '00:00:30', SEOUL));
    expect([(await rowOf(hanoi.inboundLotId)).status_code, (await rowOf(seoul.inboundLotId)).status_code]).toEqual(['RECEIVING', 'RECEIVED']);
    await runner().tick(at(DAY, '00:00:30', HANOI));
    expect([(await rowOf(hanoi.inboundLotId)).status_code, (await rowOf(seoul.inboundLotId)).status_code]).toEqual(['RECEIVED', 'RECEIVED']);
  });

  it('R21-3 한 건 실패(다른 트랜잭션이 잠금) → 로그만 남기고 다른 건은 닫힘, 다음 회차에 다시 해서 닫힌다', async () => {
    const busy = await openOn(YESTERDAY, ids.plant, ids.supplierX);
    const other = await openOn(YESTERDAY, ids.plant, ids.supplierY);
    expect(busy.inboundLotId).toBeLessThan(other.inboundLotId);
    const failing = runner();
    const warn = jest.spyOn((failing as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    let release!: () => void;
    let lockedSignal!: () => void;
    const locked = new Promise<void>((resolve) => { lockedSignal = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT inbound_lot_id FROM trace.inbound_lot WHERE inbound_lot_id = ${BigInt(busy.inboundLotId)} FOR UPDATE`;
      lockedSignal();
      await new Promise<void>((resolve) => { release = resolve; });
    }, { timeout: 30_000 });
    const warnings: string[] = [];
    try {
      await locked;
      await failing.tick(at(DAY, '00:00:30'));
    } finally {
      release();
      await holder;
      warnings.push(...warn.mock.calls.map(([message]) => String(message)));
      warn.mockRestore();
    }
    expect(await rowOf(busy.inboundLotId)).toMatchObject({ status_code: 'RECEIVING' });
    expect(await rowOf(other.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(`입하 LOT ${String(busy.inboundLotId)}`)]),
    );

    await runner().tick(at(DAY, '00:01:30'));
    expect(await rowOf(busy.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true });
    expect(await closedEvents(busy.inboundLotId)).toHaveLength(1);
  });

  it('SC-009 러너 인스턴스 둘이 같은 순간 tick → 리스로 한 쪽만 돌고 건마다 한 번, 지난 날짜 RECEIVING 0', async () => {
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${INBOUND_LOT_AUTO_CLOSE_LEASE}`;
    const opened = [
      await openOn(YESTERDAY, ids.plant, ids.supplierZ),
      await openOn(YESTERDAY, ids.plant, ids.supplierZ2),
      await openOn(YESTERDAY, ids.plantSeoul, ids.supplierZ),
    ];
    const first = runner(new SyncLease(prisma, INBOUND_LOT_AUTO_CLOSE_LEASE));
    const second = runner(new SyncLease(prisma, INBOUND_LOT_AUTO_CLOSE_LEASE));
    try {
      const counts = await Promise.all([first.tick(at(DAY, '00:00:30')), second.tick(at(DAY, '00:00:30'))]);
      expect(Math.min(...counts)).toBe(0);
      expect(Math.max(...counts)).toBeGreaterThanOrEqual(opened.length);
    } finally {
      await first.onApplicationShutdown();
      await second.onApplicationShutdown();
    }
    for (const lot of opened) {
      expect(await rowOf(lot.inboundLotId)).toMatchObject({ status_code: 'RECEIVED', closed_automatically: true });
      expect(await closedEvents(lot.inboundLotId)).toHaveLength(1);
      expect(await prisma.inspection_request.count({ where: { inbound_lot_id: BigInt(lot.inboundLotId) } })).toBe(1);
    }
    // 두 공장 모두 하노이 00:00:30(서울 02:00:30)의 현지 오늘은 DAY 다.
    expect(await prisma.inbound_lot.count({
      where: { plant_id: { in: [ids.plant, ids.plantSeoul] }, status_code: 'RECEIVING', open_since_date: { lt: new Date(`${DAY}T00:00:00.000Z`) } },
    })).toBe(0);
  });

  it('R21-4 환경값 — 모듈 팩토리는 INBOUND_LOT_AUTO_CLOSE_ENABLED 가 없으면 회차를 잡고, \'false\' 면 잡지 않는다', async () => {
    const providers = Reflect.getMetadata('providers', LogisticsModule) as Provider[];
    const factory = providers.find((provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === InboundLotAutoCloseRunner) as
      FactoryProvider<InboundLotAutoCloseRunner>;
    const make = async (value: string | undefined): Promise<InboundLotAutoCloseRunner> => factory.useFactory(
      { get: (key: string) => (key === 'INBOUND_LOT_AUTO_CLOSE_ENABLED' ? value : undefined) } as unknown as ConfigService,
      prisma, app.get(InboundLotCloseService), app.get(NumberingService),
    );
    const scheduled = async (value: string | undefined): Promise<boolean> => {
      const spy = jest.spyOn(global, 'setTimeout');
      const instance = await make(value);
      try {
        instance.onApplicationBootstrap();
        return spy.mock.calls.some(([, delay]) => delay === INBOUND_LOT_AUTO_CLOSE_STARTUP_DELAY_MS);
      } finally {
        await instance.onApplicationShutdown();
        spy.mockRestore();
      }
    };
    expect(await scheduled(undefined)).toBe(true);
    expect(await scheduled('true')).toBe(true);
    expect(await scheduled('false')).toBe(false);
    // 이 e2e 의 앱은 global-setup 이 끈 값으로 떴다.
    expect(process.env.INBOUND_LOT_AUTO_CLOSE_ENABLED).toBe('false');
    expect(app.get(InboundLotAutoCloseRunner)).toBeInstanceOf(InboundLotAutoCloseRunner);
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  /** 공급사·품목 A 의 P/O 라인 하나 — 라인 id. */
  async function makeOrder(supplier: bigint, ordered: number): Promise<bigint> {
    seq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${String(seq)}`, supplier_id: supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date('2026-11-01T00:00:00.000Z'), status_code: 'CONFIRMED',
      },
    });
    const line = await prisma.purchase_order_line.create({
      data: { purchase_order_id: order.purchase_order_id, line_no: 1, item_id: ids.itemA, uom_id: ids.ea, ordered_qty: ordered, received_qty: 0, tolerance_over_qty: 0 },
    });
    return line.purchase_order_line_id;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '자동마감법인', country_code: 'VN', timezone_code: HANOI },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '자동마감사업부' },
    })).business_unit_id;
    for (const [name, code, timezone] of [['plant', 'P', HANOI], ['plantSeoul', 'PS', SEOUL]] as const) {
      ids[name] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`, plant_name: `자동마감공장${code}`, timezone_code: timezone },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.itemA = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '자동마감자재A', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    for (const code of ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Z2']) {
      ids[`supplier${code}`] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${code}`, partner_name: `${PREFIX} 공급사 ${code}` } })).partner_id;
    }
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `자동마감 ${suffix}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `자동마감 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const inboundLots = `SELECT inbound_lot_id FROM trace.inbound_lot WHERE plant_id IN (${plants})`;
    const receipts = `SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`;
    const requests = `SELECT inspection_request_id FROM quality.inspection_request WHERE item_id IN (${items})`;
    const events = `SELECT notification_event_id FROM app.notification_event
      WHERE (aggregate_type_code = 'INBOUND_RECEIPT' AND aggregate_id IN (${receipts}))
         OR (aggregate_type_code = 'INSPECTION_REQUEST' AND aggregate_id IN (${requests}))`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const keyList = [...keys].map((key) => `'${key}'`).join(',');
    for (const sql of [
      `DELETE FROM integration.sync_lease WHERE lease_name = '${INBOUND_LOT_AUTO_CLOSE_LEASE}'`,
      `DELETE FROM app.zalo_delivery WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification WHERE notification_event_id IN (${events})`,
      `DELETE FROM app.notification_event WHERE notification_event_id IN (${events})`,
      `DELETE FROM quality.inspection_request_event WHERE inspection_request_id IN (${requests})`,
      `DELETE FROM quality.inspection_request WHERE item_id IN (${items})`,
      `DELETE FROM trace.inbound_lot_event WHERE inbound_lot_id IN (${inboundLots})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.inbound_lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts}))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (${receipts})`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.purchase_order WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      ...(keyList === '' ? [] : [`DELETE FROM app.idempotency_record WHERE idempotency_key IN (${keyList})`]),
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
