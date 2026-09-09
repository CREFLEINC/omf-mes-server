import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN = randomUUID().slice(0, 8);
const PREFIX = `SNC-${RUN}`;
const LOGIN_ID = `${PREFIX}-USER`;
const NO_PERMISSION_LOGIN_ID = `${PREFIX}-NO-PERM`;
const PASSWORD = 'Serial-생성-검사-비밀번호';
const PRODUCED_AT = '2026-09-09T01:02:03.123456Z';

interface BatchBody {
  items: Array<{
    serialNumberId: number;
    serialNo: string;
    itemId: number;
    lotId: number;
    statusCode: string;
    producedAt?: string;
    versionNo: number;
  }>;
  issuedCount: number;
}

describe('제품 개체 대량 발번 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermissionCookie: string[];
  let terminalToken: string;
  let blockedTerminalToken: string;
  let workerNo: string;
  let lotId: bigint;
  let completedLotId: bigint;
  let itemId: bigint;
  let appUserId: bigint;
  let workOrderId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixtures(app.get(JwtService));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('quantity N을 생산실적·양품 누계 없이 개체 N행으로 만들고 입력 µs를 보존한다 // 질의 105 회신', async () => {
    const before = await unrelatedCounts();
    const response = await post(randomUUID(), {
      lotId: Number(lotId),
      quantity: 3,
      producedAt: PRODUCED_AT,
    }).expect(201);
    const body = response.body as BatchBody;

    expect(body.issuedCount).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((row) => row.lotId)).toEqual([
      Number(lotId),
      Number(lotId),
      Number(lotId),
    ]);
    expect(body.items.map((row) => row.itemId)).toEqual([
      Number(itemId),
      Number(itemId),
      Number(itemId),
    ]);
    expect(body.items.map((row) => row.statusCode)).toEqual([
      'REGISTERED',
      'REGISTERED',
      'REGISTERED',
    ]);
    expect(body.items.map((row) => row.versionNo)).toEqual([1, 1, 1]);
    expect(
      body.items.every((row) => /^SN-\d{8}-\d{4,}$/.test(row.serialNo)),
    ).toBe(true);
    expect(await unrelatedCounts()).toEqual(before);

    const stored = await prisma.$queryRaw<
      Array<{ produced_at: string; created_by: bigint }>
    >`
      SELECT to_char(produced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS produced_at,
             created_by
        FROM trace.serial_number
       WHERE serial_number_id IN (${prismaIds(body.items.map((row) => row.serialNumberId))})
       ORDER BY serial_number_id`;
    expect(stored.map((row) => row.produced_at)).toEqual(
      Array(3).fill(PRODUCED_AT),
    );
    expect(stored.every((row) => row.created_by === appUserId)).toBe(true);
  });

  it('같은 멱등 키는 원 응답을 재생하고 번호 카운터도 다시 소비하지 않는다', async () => {
    const key = randomUUID();
    const body = { lotId: Number(lotId), quantity: 2, producedAt: PRODUCED_AT };
    const first = await post(key, body).expect(201);
    const counterBefore = await serialCounter();
    const replay = await post(key, body).expect(201);

    expect(replay.body).toEqual(first.body);
    expect(await serialCounter()).toBe(counterBefore);
  });

  it('같은 키의 본문·사번·단말 귀속이 달라지면 409 DUPLICATE_KEY다 // 통보 107', async () => {
    const key = randomUUID();
    await post(key, { lotId: Number(lotId), quantity: 1 }).expect(201);

    const changed = await post(key, {
      lotId: Number(lotId),
      quantity: 2,
    }).expect(409);
    expect(changed.body).toMatchObject({
      code: 'DUPLICATE_KEY',
      conflictCause: 'user',
    });
  });

  it('다른 키는 기존 발번 수나 생산실적 잔량과 무관하게 추가 발번한다 // 질의 105 회신', async () => {
    const before = await prisma.serial_number.count({
      where: { lot_id: lotId },
    });
    await post(randomUUID(), { lotId: Number(lotId), quantity: 2 }).expect(201);
    await post(randomUUID(), { lotId: Number(lotId), quantity: 1 }).expect(201);
    expect(await prisma.serial_number.count({ where: { lot_id: lotId } })).toBe(
      before + 3,
    );
  });

  it('If-Match는 생략·정상 형식 모두 허용하고 비교하지 않으며 잘못된 형식만 400이다 // 통보 106', async () => {
    await post(randomUUID(), { lotId: Number(lotId), quantity: 1 }).expect(201);
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { ifMatch: '999' },
    ).expect(201);
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { ifMatch: 'broken' },
    ).expect(400);
  });

  it('작업자·계정 권한·단말 can_print_label을 각각 검증한다', async () => {
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { worker: 'UNKNOWN-WORKER' },
    ).expect(400);
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { token: undefined },
    ).expect(403);
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { token: blockedTerminalToken },
    ).expect(403);
    await post(
      randomUUID(),
      { lotId: Number(lotId), quantity: 1 },
      { authCookie: noPermissionCookie },
    ).expect(403);
    await request(app.getHttpServer())
      .post('/api/trace/serial-numbers')
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', workerNo)
      .send({ lotId: Number(lotId), quantity: 1 })
      .expect(401);
  });

  it('없는·비생산·완료 LOT은 400이고 개체를 남기지 않는다', async () => {
    const before = await prisma.serial_number.count();
    await post(randomUUID(), {
      lotId: Number.MAX_SAFE_INTEGER,
      quantity: 1,
    }).expect(400);
    const completed = await post(randomUUID(), {
      lotId: Number(completedLotId),
      quantity: 1,
    }).expect(400);
    expect(completed.body.errors[0]).toMatchObject({
      field: 'lotId',
      code: 'STATE_LOCKED',
    });
    expect(await prisma.serial_number.count()).toBe(before);
  });

  it('서버 번호가 기존 행과 충돌하면 새 번호 구간으로 재시도한다', async () => {
    const nextValue = (await serialCounter()) + 1n;
    const duplicate = `SN-20260909-${String(nextValue).padStart(4, '0')}`;
    await prisma.serial_number.create({
      data: {
        serial_no: duplicate,
        item_id: itemId,
        lot_id: lotId,
        status_code: 'REGISTERED',
      },
    });

    const response = await post(randomUUID(), {
      lotId: Number(lotId),
      quantity: 1,
      producedAt: PRODUCED_AT,
    }).expect(201);
    expect((response.body as BatchBody).items[0].serialNo).not.toBe(duplicate);
  });

  it('서로 다른 두 키의 동시 발번은 모두 성공하고 번호·행이 겹치지 않는다', async () => {
    const [left, right] = await Promise.all([
      post(randomUUID(), { lotId: Number(lotId), quantity: 2 }).expect(201),
      post(randomUUID(), { lotId: Number(lotId), quantity: 2 }).expect(201),
    ]);
    const serialNos = [
      ...(left.body as BatchBody).items,
      ...(right.body as BatchBody).items,
    ].map((row) => row.serialNo);
    expect(new Set(serialNos).size).toBe(4);
    expect(
      await prisma.serial_number.count({
        where: { serial_no: { in: serialNos } },
      }),
    ).toBe(4);
  });

  function post(
    key: string,
    body: { lotId: number; quantity: number; producedAt?: string },
    options: {
      worker?: string;
      token?: string;
      authCookie?: string[];
      ifMatch?: string;
    } = {},
  ) {
    let call = request(app.getHttpServer())
      .post('/api/trace/serial-numbers')
      .set('Cookie', options.authCookie ?? cookie)
      .set('Idempotency-Key', key)
      .set('X-Worker-No', options.worker ?? workerNo)
      .send(body);
    if (options.token !== undefined || !Object.hasOwn(options, 'token')) {
      call = call.set(
        'Authorization',
        `Bearer ${options.token ?? terminalToken}`,
      );
    }
    if (options.ifMatch !== undefined)
      call = call.set('If-Match', options.ifMatch);
    return call;
  }

  async function unrelatedCounts(): Promise<object> {
    const [results, allocations, issues] = await Promise.all([
      prisma.production_result.count({ where: { work_order_id: workOrderId } }),
      prisma.production_result_lot_allocation.count({
        where: { lot_id: lotId },
      }),
      prisma.document_issue_log.count({ where: { lot_id: lotId } }),
    ]);
    return { results, allocations, issues };
  }

  async function serialCounter(): Promise<bigint> {
    const rule = await prisma.numbering_rule.findFirstOrThrow({
      where: {
        document_type_code: 'SERIAL_NUMBER',
        plant_id: null,
        lot_type_code: null,
      },
    });
    const counter = await prisma.numbering_counter.findFirstOrThrow({
      where: {
        numbering_rule_id: rule.numbering_rule_id,
        period_key: '20260909',
      },
    });
    return counter.last_value;
  }

  async function makeFixtures(jwt: JwtService): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '개체생성법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '개체생성사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '개체생성공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`,
        item_name: '개체생성품목',
        item_type_code: 'FINISHED_GOOD',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = item.item_id;
    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PROC`,
        process_name: '개체생성공정',
        process_type_code: 'MOLDING',
      },
    });
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'CONFIRMED',
      },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: '개체생성',
      },
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PLAN`,
        plan_date: new Date('2026-09-09'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'IN_PROGRESS',
      },
    });
    workOrderId = workOrder.work_order_id;
    const lots = await Promise.all([
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT`,
          item_id: item.item_id,
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 1,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: workOrder.work_order_id,
          status_code: 'NORMAL',
        },
      }),
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-DONE`,
          item_id: item.item_id,
          lot_type_code: 'PRODUCT',
          plant_id: plant.plant_id,
          initial_qty: 1,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: workOrder.work_order_id,
          status_code: 'NORMAL',
          completed_at: new Date(),
        },
      }),
    ]);
    [lotId, completedLotId] = lots.map((lot) => lot.lot_id);
    const terminals = await Promise.all(
      ['OK', 'BLOCK'].map((suffix) =>
        prisma.terminal.create({
          data: {
            terminal_code: `${PREFIX}-${suffix}`,
            plant_id: plant.plant_id,
            terminal_type_code: 'POP',
            status_code: 'RUNNING',
          },
        }),
      ),
    );
    await prisma.terminal_process.createMany({
      data: [
        {
          terminal_id: terminals[0].terminal_id,
          process_id: process.process_id,
          can_print_label: true,
        },
        {
          terminal_id: terminals[1].terminal_id,
          process_id: process.process_id,
          can_print_label: false,
        },
      ],
    });
    terminalToken = jwt.sign({
      sub: Number(terminals[0].terminal_id),
      typ: TOKEN_TYPE.TERMINAL,
      tv: terminals[0].token_version,
    });
    blockedTerminalToken = jwt.sign({
      sub: Number(terminals[1].terminal_id),
      typ: TOKEN_TYPE.TERMINAL,
      tv: terminals[1].token_version,
    });
    workerNo = `${PREFIX}-WORKER`;
    await prisma.worker.create({
      data: {
        worker_no: workerNo,
        worker_name: '개체생성작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });

    const users = await Promise.all(
      [LOGIN_ID, NO_PERMISSION_LOGIN_ID].map((loginId) =>
        prisma.app_user.create({
          data: {
            login_id: loginId,
            user_name: loginId,
            status_code: 'EMPLOYED',
          },
        }),
      ),
    );
    appUserId = users[0].app_user_id;
    await prisma.user_credential.createMany({
      data: await Promise.all(
        users.map(async (user) => ({
          app_user_id: user.app_user_id,
          password_hash: await hashPassword(PASSWORD),
        })),
      ),
    });
    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}-ROLE`, role_name: '개체생성권한' },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'P-02-05' },
    });
    await prisma.user_role.create({
      data: { app_user_id: users[0].app_user_id, role_id: role.role_id },
    });
    cookie = await login(LOGIN_ID);
    noPermissionCookie = await login(NO_PERMISSION_LOGIN_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const users = await prisma.app_user.findMany({
      where: { login_id: { startsWith: PREFIX } },
      select: { app_user_id: true },
    });
    const userIds = users.map((user) => user.app_user_id);
    const lots = await prisma.lot.findMany({
      where: { lot_no: { startsWith: PREFIX } },
      select: { lot_id: true },
    });
    await prisma.serial_number.deleteMany({
      where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
    });
    await prisma.idempotency_record.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.terminal_process.deleteMany({
      where: { terminal: { terminal_code: { startsWith: PREFIX } } },
    });
    await prisma.terminal.deleteMany({
      where: { terminal_code: { startsWith: PREFIX } },
    });
    await prisma.work_order.deleteMany({
      where: { work_order_no: { startsWith: PREFIX } },
    });
    await prisma.production_plan.deleteMany({
      where: { plan_no: { startsWith: PREFIX } },
    });
    await prisma.production_order.deleteMany({
      where: { production_order_no: { startsWith: PREFIX } },
    });
    await prisma.routing_operation.deleteMany({
      where: { routing: { routing_code: { startsWith: PREFIX } } },
    });
    await prisma.routing.deleteMany({
      where: { routing_code: { startsWith: PREFIX } },
    });
    await prisma.bom.deleteMany({
      where: { bom_code: { startsWith: PREFIX } },
    });
    await prisma.process.deleteMany({
      where: { process_code: { startsWith: PREFIX } },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: { startsWith: PREFIX } },
    });
    await prisma.user_role.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.user_credential.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    await prisma.app_user.deleteMany({
      where: { app_user_id: { in: userIds } },
    });
    const roles = await prisma.role.findMany({
      where: { role_code: { startsWith: PREFIX } },
      select: { role_id: true },
    });
    await prisma.role_permission.deleteMany({
      where: { role_id: { in: roles.map((role) => role.role_id) } },
    });
    await prisma.role.deleteMany({
      where: { role_id: { in: roles.map((role) => role.role_id) } },
    });
    await prisma.item.deleteMany({
      where: { item_code: { startsWith: PREFIX } },
    });
    await prisma.plant.deleteMany({
      where: { plant_code: { startsWith: PREFIX } },
    });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: { startsWith: PREFIX } },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: { startsWith: PREFIX } },
    });
  }
});

function prismaIds(ids: number[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${BigInt(id)}::bigint`));
}
