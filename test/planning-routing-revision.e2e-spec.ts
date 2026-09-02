/**
 * Routing Rev 상태 전이 — 확정 · 폐기 · 신규 Rev 발행.
 *
 * ⭐ 폐기는 dead end 다(결정 07 §5-4 「폐기 → (없음)」).
 * ⭐ 신규 Rev 는 라인과 선후행을 함께 복제한다 — 라인만 옮기면 순서 관계를 잃는다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { ROUTING_STATUS } from '../src/planning/routing/routing-status';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-routingrev-probe';
const NOPERM_ID = 'e2e-routingrev-noperm';
const PASSWORD = 'Rev-검사-비밀번호';
const PREFIX = 'E2E_ROUTINGREV';
const ROLE = 'E2E_ROUTINGREV_ROLE';

function validator(operation: string, status: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('Routing Rev 전이 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let processId = 0;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'Rev검사', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'ACTIVE' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'Rev검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-01' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    const process = await prisma.process.create({
      data: {
        process_code: `${PREFIX}-P`,
        process_name: '검사공정',
        process_type_code: 'ASSEMBLY',
      },
    });
    processId = Number(process.process_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 라인이 없으면 확정이 400 LINE_REQUIRED 다', async () => {
    const routingId = await createRouting();

    const rejected = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('LINE_REQUIRED');
  });

  it('⭐ 라인이 있으면 확정되고, 확정 뒤에는 다시 확정되지 않는다', async () => {
    const routingId = await createRouting();
    await addLines(routingId, 2);

    const confirmed = await confirm(routingId);
    const validate = validator('POST /planning/routings/{routingId}:confirm', '200');
    expect(validate(confirmed.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(confirmed.body.statusCode).toBe(ROUTING_STATUS.CONFIRMED);

    // ⛔ 400 이다 — 계약이 이 자리에 409 를 «선언하지 않았다».
    const again = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(again.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⭐ 확정된 Rev 만 폐기되고, 폐기는 dead end 다', async () => {
    const routingId = await createRouting();
    await addLines(routingId, 1);

    // 작성중은 폐기가 안 된다.
    const tooEarly = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:obsolete`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(tooEarly.body.errors[0].code).toBe('STATE_LOCKED');

    await confirm(routingId);
    const obsoleted = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:obsolete`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    expect(obsoleted.body.statusCode).toBe(ROUTING_STATUS.OBSOLETE);

    // ⛔ 되돌아오는 길이 없다 — 확정도, 신규 Rev 의 원본도 안 된다.
    for (const action of ['confirm', 'new-revision']) {
      const rejected = await request(app.getHttpServer())
        .post(`/api/planning/routings/${routingId}:${action}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');
    }
  });

  it('⭐⭐ 신규 Rev 가 라인과 «선후행»을 함께 복제한다', async () => {
    const routingId = await createRouting();
    const lineIds = await addLines(routingId, 3);
    await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operation-dependencies`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        dependencies: [
          { predecessorOperationId: lineIds[0], successorOperationId: lineIds[1] },
          { predecessorOperationId: lineIds[1], successorOperationId: lineIds[2] },
        ],
      })
      .expect(200);
    await confirm(routingId);

    const created = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);
    const validate = validator('POST /planning/routings/{routingId}:new-revision', '201');
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(created.body.routingVersion).toBe(2);
    expect(created.body.statusCode).toBe(ROUTING_STATUS.DRAFT);
    // 헤더 속성을 물려받는다.
    expect(created.body.routingCode).toBe(`${PREFIX}-R${counter}`);
    // ⛔ 새 초안이 기본 Rev 를 빼앗지 않는다.
    expect(created.body.isDefault).toBe(false);

    const lines = await request(app.getHttpServer())
      .get(`/api/planning/routings/${created.body.routingId}/operations`)
      .set('Cookie', cookie)
      .expect(200);
    expect(lines.body.items).toHaveLength(3);
    // ⛔ 새 행이다 — 원본 라인 id 를 그대로 쓰면 두 Rev 가 한 행을 공유한다.
    expect(lines.body.items.map((l: { routingOperationId: number }) => l.routingOperationId)).not.toEqual(
      lineIds,
    );

    const dependencies = await request(app.getHttpServer())
      .get(`/api/planning/routings/${created.body.routingId}/operation-dependencies`)
      .set('Cookie', cookie)
      .expect(200);
    // ⭐ 라인만 옮기고 선후행을 버리면 새 Rev 가 공정 순서 관계를 잃는다.
    expect(dependencies.body.items).toHaveLength(2);
    const newIds = lines.body.items.map((l: { routingOperationId: number }) => l.routingOperationId);
    expect(dependencies.body.items[0]).toMatchObject({
      predecessorOperationId: newIds[0],
      successorOperationId: newIds[1],
    });
  });

  it('⛔ 작성중 Rev 에서는 신규 Rev 를 발행하지 못한다 — 초안을 편집하면 된다', async () => {
    const routingId = await createRouting();

    const rejected = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⭐ 최신이 아닌 확정 Rev 에서 발행해도 번호가 부딪히지 않는다', async () => {
    const first = await createRouting();
    await addLines(first, 1);
    await confirm(first);

    const second = await request(app.getHttpServer())
      .post(`/api/planning/routings/${first}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);
    expect(second.body.routingVersion).toBe(2);

    // 원본 +1 로 잡으면 여기서 uq_routing 이 깨진다 — 최댓값 +1 이라 3이 나온다.
    const third = await request(app.getHttpServer())
      .post(`/api/planning/routings/${first}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(201);
    expect(third.body.routingVersion).toBe(3);
  });

  it('⭐ 같은 멱등키로 다시 부르면 같은 Rev 를 돌려준다', async () => {
    const routingId = await createRouting();
    await addLines(routingId, 1);
    await confirm(routingId);
    const idempotencyKey = key();

    const first = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(201);
    const again = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:new-revision`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .expect(201);

    // 새로 만들면 Rev 가 둘 생기고, 화면은 어느 것을 편집할지 모른다.
    expect(again.body.routingId).toBe(first.body.routingId);
  });

  it('⛔ 권한이 없으면 전이가 403 이고, 없는 Routing 은 404 다', async () => {
    const routingId = await createRouting();

    await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:confirm`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .expect(403);

    for (const action of ['confirm', 'obsolete', 'new-revision']) {
      await request(app.getHttpServer())
        .post(`/api/planning/routings/999999999:${action}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .expect(404);
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function confirm(routingId: number): Promise<{ body: { statusCode: string } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:confirm`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    return { body: response.body };
  }

  async function addLines(routingId: number, count: number): Promise<number[]> {
    const response = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        operations: Array.from({ length: count }, (_, index) => ({
          routingId,
          operationSeq: index + 1,
          processId,
          operationName: `공정${index + 1}`,
          mesManaged: true,
          materialInputManaged: false,
          productionResultManaged: true,
          inspectionManaged: false,
          outputLotRequired: false,
          equipmentRequired: false,
          moldRequired: false,
        })),
      })
      .expect(200);
    return response.body.items.map((l: { routingOperationId: number }) => l.routingOperationId);
  }

  async function createRouting(): Promise<number> {
    counter += 1;
    const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-I${counter}`,
        item_name: `검사품목${counter}`,
        item_type_code: 'FG',
        base_uom_id: uom.uom_id,
        lot_control_type_code: 'LOT',
      },
    });
    const created = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-R${counter}`,
        routing_version: 1,
        status_code: ROUTING_STATUS.DRAFT,
      },
    });
    return Number(created.routing_id);
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    counter = 0;
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    const routings = await prisma.routing.findMany({
      where: { item_id: { in: items.map((row) => row.item_id) } },
      select: { routing_id: true },
    });
    const routingIds = routings.map((row) => row.routing_id);
    const operations = await prisma.routing_operation.findMany({
      where: { routing_id: { in: routingIds } },
      select: { routing_operation_id: true },
    });
    await prisma.routing_operation_dependency.deleteMany({
      where: { predecessor_operation_id: { in: operations.map((r) => r.routing_operation_id) } },
    });
    await prisma.routing_operation.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.routing.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.item.deleteMany({ where: { item_id: { in: items.map((r) => r.item_id) } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });

    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
