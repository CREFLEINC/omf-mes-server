/**
 * Routing 공정 라인과 선후행.
 *
 * ⭐ 전체 치환이 「행 교체」가 아니다 — `work_order.routing_operation_id` 가 NOT NULL 이라
 * 지우고 다시 넣으면 진행 중 작업지시가 무너진다. 이 파일의 본체가 그 확인이다.
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
import { REVISION_STATUS } from '../src/planning/revision-status';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-routingop-probe';
const NOPERM_ID = 'e2e-routingop-noperm';
const PASSWORD = '공정라인-검사-비밀번호';
const PREFIX = 'E2E_ROUTINGOP';
const ROLE = 'E2E_ROUTINGOP_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

interface Line {
  routingOperationId: number;
  operationSeq: number;
  processId: number;
  operationName: string;
}

describe('Routing 공정 라인·선후행 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let processIds: number[] = [];
  let routingId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '공정검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '공정검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-01' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    for (let i = 0; i < 3; i += 1) {
      const process = await prisma.process.create({
        data: {
          process_code: `${PREFIX}-P${i}`,
          process_name: `검사공정${i}`,
          process_type_code: 'ASSEMBLY',
        },
      });
      processIds.push(Number(process.process_id));
    }
    routingId = await createRouting();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 라인을 통째로 저장하고 순서대로 낸다', async () => {
    const saved = await putOperations([line(1, 0, '첫 공정'), line(2, 1, '둘째 공정')]);
    const validate = validator('PUT /planning/routings/{routingId}/operations');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items.map((i: Line) => i.operationName)).toEqual(['첫 공정', '둘째 공정']);

    const read = await request(app.getHttpServer())
      .get(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .expect(200);
    const readValidate = validator('GET /planning/routings/{routingId}/operations');
    expect(readValidate(read.body)).toBe(true);
    expect(read.body.items).toHaveLength(2);
  });

  it('⭐⭐ 순서를 맞바꿔도 «같은 행»이 남는다 — 지우고 다시 넣지 않는다', async () => {
    const before = await currentLines();
    expect(before).toHaveLength(2);

    // 두 줄의 순서를 맞바꾼다. 유일 제약이 중간 상태를 막으므로 서버가 밀어 두고 바꾼다.
    const swapped = await putOperations([
      { ...upsert(before[1]), operationSeq: 1 },
      { ...upsert(before[0]), operationSeq: 2 },
    ]);

    expect(swapped.body.items.map((i: Line) => i.operationName)).toEqual([
      '둘째 공정',
      '첫 공정',
    ]);
    // ⛔ 여기가 이 검사의 핵심이다 — id 가 그대로여야 작업지시·BOM 이 무너지지 않는다.
    expect(swapped.body.items.map((i: Line) => i.routingOperationId).sort()).toEqual(
      before.map((l) => l.routingOperationId).sort(),
    );
  });

  it('⭐ 새 공정은 만들고, 빠진 공정은 지운다', async () => {
    const before = await currentLines();
    const added = await putOperations([
      ...before.map((l) => upsert(l)),
      line(3, 2, '셋째 공정'),
    ]);
    expect(added.body.items).toHaveLength(3);

    const shrunk = await putOperations([upsert(before[0])]);
    expect(shrunk.body.items).toHaveLength(1);
    expect(shrunk.body.items[0].routingOperationId).toBe(before[0].routingOperationId);
  });

  it('⛔ 다른 Routing 의 공정 id 는 400 이다', async () => {
    const otherRouting = await createRouting(2);
    const mine = (await currentLines())[0];

    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${otherRouting}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        operations: [{ ...upsert(mine), routingId: otherRouting, operationSeq: 1 }],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'operations[0].routingOperationId',
      code: 'INVALID',
    });
  });

  it('⛔ 같은 순서를 두 줄에 주면 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ operations: [line(1, 0, 'A'), line(1, 1, 'B')] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'operations[1].operationSeq',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⛔ 없는 공정 id 는 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        operations: [{ ...line(1, 0, 'A'), processId: 999999999 }],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'operations[0].processId',
      code: 'INVALID',
    });
  });

  // ── 선후행 ──────────────────────────────────────────────────────────────

  it('⭐ 선후행을 통째로 저장한다 — 기본 유형은 서버가 채운다', async () => {
    const lines = await putOperations([
      line(1, 0, 'A'),
      line(2, 1, 'B'),
      line(3, 2, 'C'),
    ]);
    const ids = lines.body.items.map((l: Line) => l.routingOperationId);

    const saved = await putDependencies([
      { predecessorOperationId: ids[0], successorOperationId: ids[1] },
      {
        predecessorOperationId: ids[1],
        successorOperationId: ids[2],
        dependencyTypeCode: 'START_TO_START',
      },
    ]);
    const validate = validator('PUT /planning/routings/{routingId}/operation-dependencies');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items[0].dependencyTypeCode).toBe('FINISH_TO_START');
    expect(saved.body.items[1].dependencyTypeCode).toBe('START_TO_START');

    const cleared = await putDependencies([]);
    expect(cleared.body.items).toEqual([]);
  });

  it('⭐ START_TO_FINISH 를 받는다 — 사전이 넷으로 닫은 축(CD-ROUTING-OPERATION-DEPENDENCY-TYPE)', async () => {
    // 위 검사가 남긴 세 줄을 그대로 쓴다 — 뒤 검사들도 그 줄 수에 기댄다.
    const ids = (await currentLines()).map((l) => l.routingOperationId);

    const saved = await putDependencies([
      {
        predecessorOperationId: ids[0],
        successorOperationId: ids[1],
        dependencyTypeCode: 'START_TO_FINISH',
      },
    ]);
    expect(saved.body.items[0].dependencyTypeCode).toBe('START_TO_FINISH');

    await putDependencies([]);
  });

  it('⛔ 순환은 400 이다 — DB 가 막지 않으므로 서버가 본다', async () => {
    const ids = (await currentLines()).map((l) => l.routingOperationId);

    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operation-dependencies`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        dependencies: [
          { predecessorOperationId: ids[0], successorOperationId: ids[1] },
          { predecessorOperationId: ids[1], successorOperationId: ids[2] },
          { predecessorOperationId: ids[2], successorOperationId: ids[0] },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0].message).toContain('순환');
  });

  it('⛔ 자기 자신·중복·어휘 밖 유형·남의 공정은 400 이다', async () => {
    const ids = (await currentLines()).map((l) => l.routingOperationId);

    const self = await putDependenciesRaw([
      { predecessorOperationId: ids[0], successorOperationId: ids[0] },
    ]);
    expect(self.status).toBe(400);

    const duplicated = await putDependenciesRaw([
      { predecessorOperationId: ids[0], successorOperationId: ids[1] },
      { predecessorOperationId: ids[0], successorOperationId: ids[1] },
    ]);
    expect(duplicated.body.errors[0].code).toBe('UNIQUE_VIOLATION');

    const badType = await putDependenciesRaw([
      {
        predecessorOperationId: ids[0],
        successorOperationId: ids[1],
        dependencyTypeCode: '없는유형',
      },
    ]);
    expect(badType.body.errors[0]).toMatchObject({
      field: 'dependencies[0].dependencyTypeCode',
      code: 'INVALID',
    });

    const outsider = await putDependenciesRaw([
      { predecessorOperationId: 999999999, successorOperationId: ids[1] },
    ]);
    expect(outsider.body.errors[0]).toMatchObject({
      field: 'dependencies[0].predecessorOperationId',
      code: 'INVALID',
    });
  });

  it('⛔ 선후행이 걸린 공정은 뺄 수 없다', async () => {
    const lines = await currentLines();
    const ids = lines.map((l) => l.routingOperationId);
    await putDependencies([
      { predecessorOperationId: ids[0], successorOperationId: ids[1] },
    ]);

    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ operations: [upsert(lines[2])] })
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');

    await putDependencies([]);
  });

  it('⛔ 확정된 Rev 는 라인·선후행 저장이 400 STATE_LOCKED 다', async () => {
    const locked = await createRouting(3);
    await prisma.routing.update({
      where: { routing_id: locked },
      data: { status_code: REVISION_STATUS.CONFIRMED },
    });

    for (const [path, body] of [
      ['operations', { operations: [] }],
      ['operation-dependencies', { dependencies: [] }],
    ] as const) {
      const rejected = await request(app.getHttpServer())
        .put(`/api/planning/routings/${locked}/${path}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send(body)
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');
    }
  });

  it('⛔ 권한이 없으면 저장이 403 이고, 없는 Routing 은 404 다', async () => {
    await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ operations: [] })
      .expect(403);

    for (const path of ['operations', 'operation-dependencies']) {
      await request(app.getHttpServer())
        .get(`/api/planning/routings/999999999/${path}`)
        .set('Cookie', cookie)
        .expect(404);
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function line(seq: number, processIndex: number, name: string): object {
    return {
      routingId,
      operationSeq: seq,
      processId: processIds[processIndex],
      operationName: name,
      mesManaged: true,
      materialInputManaged: false,
      productionResultManaged: true,
      inspectionManaged: false,
      outputLotRequired: false,
      equipmentRequired: false,
      moldRequired: false,
    };
  }

  function upsert(existing: Line): Record<string, unknown> {
    return {
      ...(line(existing.operationSeq, 0, existing.operationName) as Record<string, unknown>),
      routingOperationId: existing.routingOperationId,
      processId: existing.processId,
    };
  }

  async function currentLines(): Promise<Line[]> {
    const response = await request(app.getHttpServer())
      .get(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body.items;
  }

  async function putOperations(operations: object[]): Promise<{ body: { items: Line[] } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operations`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ operations })
      .expect(200);
    return { body: response.body };
  }

  async function putDependencies(
    dependencies: object[],
  ): Promise<{ body: { items: { dependencyTypeCode: string }[] } }> {
    const response = await putDependenciesRaw(dependencies);
    expect(response.status).toBe(200);
    return { body: response.body };
  }

  async function putDependenciesRaw(
    dependencies: object[],
  ): Promise<{
    status: number;
    body: { items: { dependencyTypeCode: string }[]; errors: { code: string }[] };
  }> {
    const response = await request(app.getHttpServer())
      .put(`/api/planning/routings/${routingId}/operation-dependencies`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ dependencies });
    return { status: response.status, body: response.body };
  }

  async function createRouting(suffix = 1): Promise<number> {
    const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-I${suffix}`,
        item_name: `검사품목${suffix}`,
        item_type_code: 'FINISHED',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const created = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-R${suffix}`,
        routing_version: 1,
        status_code: REVISION_STATUS.DRAFT,
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
    processIds = [];
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
    const operationIds = operations.map((row) => row.routing_operation_id);
    await prisma.routing_operation_dependency.deleteMany({
      where: { predecessor_operation_id: { in: operationIds } },
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
