/**
 * 연계 정의.
 *
 * ⭐ 트리거 짝(`TIME_SCHEDULE`↔`scheduleExpression` · `EVENT`↔`eventCondition`)을 서버가
 * 본다 — 「한쪽만 채워 보내면 400」(계약).
 * ⭐ 연계 코드는 메시지가 «문자열로» 가리키므로 참조가 있으면 못 바꾼다.
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
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-ifdef-probe';
const NOPERM_ID = 'e2e-ifdef-noperm';
const PASSWORD = '연계정의-검사-비밀번호';
const PREFIX = 'E2E_IFDEF';
const ROLE = 'E2E_IFDEF_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const status = method === 'POST' && !path.includes(':') ? '201' : '200';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('연계 정의 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '연계검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '연계검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-09' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('등록·목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const id = await create();

    const list = await request(app.getHttpServer())
      .get(`/api/integration/interface-definitions?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /integration/interface-definitions');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator(
      'GET /integration/interface-definitions/{interfaceDefinitionId}',
    );
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    expect(detail.body.pendingMessageCount).toBe(0);
  });

  it('⭐ 확정 목록 안이면 표식이 붙고, 밖이면 «막지 않고» 표식만 빠진다', async () => {
    const inside = await create({ targetCode: 'ITEM' });
    const outside = await create({ targetCode: `${PREFIX}_UNKNOWN` });

    const one = await detailOf(inside);
    const two = await detailOf(outside);

    expect(one.interfaceDefinition.withinConfirmedScope).toBe(true);
    // ⛔ 저장은 그대로 됐다 — 계약이 「막지 않고 표식만 한다」로 적었다.
    expect(two.interfaceDefinition.withinConfirmedScope).toBe(false);
    expect(two.interfaceDefinition.targetCode).toBe(`${PREFIX}_UNKNOWN`);
  });

  it('⭐⭐ 트리거 짝을 서버가 본다 — 한쪽만 채우면 400', async () => {
    const scheduleMissing = await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(), triggerTypeCode: 'TIME_SCHEDULE', scheduleExpression: null })
      .expect(400);
    expect(scheduleMissing.body.errors[0]).toMatchObject({
      field: 'scheduleExpression',
      code: 'PAIR',
    });

    const eventMissing = await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(), triggerTypeCode: 'EVENT', scheduleExpression: '매시 정각' })
      .expect(400);
    expect(eventMissing.body.errors[0]).toMatchObject({ field: 'eventCondition', code: 'PAIR' });
  });

  it('⭐ 칸 잇기가 통째로 교체되고 순서가 되돌아온다', async () => {
    const id = await create({
      columnMappings: [
        { relayColumn: 'GR_QTY', targetTable: 'logistics.goods_receipt', targetColumn: 'received_qty' },
        { relayColumn: 'GR_NO', targetTable: 'logistics.goods_receipt', targetColumn: 'goods_receipt_no' },
      ],
    });

    const first = await detailOf(id);
    // ⛔ 순서가 보낸 그대로여야 같은 화면이 된다.
    expect(first.columnMappings.map((m) => m.relayColumn)).toEqual(['GR_QTY', 'GR_NO']);

    const saved = await request(app.getHttpServer())
      .put(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        ...body(),
        columnMappings: [
          { relayColumn: 'ONLY', targetTable: 'mdm.item', targetColumn: 'item_code' },
        ],
      })
      .expect(200);
    expect(saved.headers.etag).toBe('2');

    const after = await detailOf(id);
    // 「보내지 않은 줄은 사라진다」(계약).
    expect(after.columnMappings).toEqual([
      { relayColumn: 'ONLY', targetTable: 'mdm.item', targetColumn: 'item_code' },
    ]);
  });

  it('⭐⭐ 메시지가 가리키면 연계 코드를 못 바꾼다 — FK 가 아니라 문자열이다', async () => {
    const id = await create();
    const current = await detailOf(id);
    await prisma.integration_message.create({
      data: {
        message_key: `${PREFIX}-MSG-${current.interfaceDefinition.interfaceCode}`,
        interface_code: current.interfaceDefinition.interfaceCode,
        direction_code: 'INBOUND',
        target_type_code: 'ITEM',
        target_id: 1,
        payload: {},
        status_code: 'FAILED',
        available_at: new Date(),
      },
    });

    const rejected = await request(app.getHttpServer())
      .put(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ ...body(), interfaceCode: `${PREFIX}_RENAMED` })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'interfaceCode',
      code: 'STATE_LOCKED',
    });

    // 상세가 참조 건수와 「보내지 못한 건수」를 함께 낸다.
    const after = await detailOf(id);
    expect(after.editability).toMatchObject({ reason: 'REFERENCED', referenceCount: 1 });
    expect(after.pendingMessageCount).toBe(1);
  });

  it('⭐ 연결 시험이 원인을 가른다 — 「연결 실패」로 뭉치지 않는다', async () => {
    const missing = await create({ relayTableName: `${PREFIX}_no_such.table` });
    const denied = await create({ relayTableName: 'mdm.item' });

    const notFound = await testConnection(missing);
    expect(notFound.body).toMatchObject({ succeeded: false, failureCauseCode: 'TABLE_NOT_FOUND' });

    const ok = await testConnection(denied);
    const validate = validator(
      'POST /integration/interface-definitions/{interfaceDefinitionId}:test-connection',
    );
    expect(validate(ok.body)).toBe(true);
    expect(ok.body.succeeded).toBe(true);

    const blank = await create({ relayTableName: null });
    const empty = await testConnection(blank);
    expect(empty.body).toMatchObject({ succeeded: false, failureCauseCode: 'TABLE_NOT_FOUND' });
  });

  it('⛔ 중복 코드·공백만 이름은 400 이다', async () => {
    const id = await create();
    const taken = (await detailOf(id)).interfaceDefinition.interfaceCode;

    const duplicated = await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(), interfaceCode: taken })
      .expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'interfaceCode',
      code: 'UNIQUE_VIOLATION',
    });

    const blank = await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(), interfaceName: '   ' })
      .expect(400);
    expect(blank.body.errors[0]).toMatchObject({ field: 'interfaceName', code: 'REQUIRED' });
  });

  it('사용 중지·다시 사용이 목록 기본값을 가른다', async () => {
    const id = await create();

    await request(app.getHttpServer())
      .post(`/api/integration/interface-definitions/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    const defaults = await request(app.getHttpServer())
      .get(`/api/integration/interface-definitions?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(defaults.body.items.map((d: { interfaceDefinitionId: number }) => d.interfaceDefinitionId))
      .not.toContain(id);

    await request(app.getHttpServer())
      .post(`/api/integration/interface-definitions/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  it('⛔ 낡은 If-Match 는 409 이고 봉투는 ConflictResponse 다', async () => {
    const id = await create();
    await request(app.getHttpServer())
      .put(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ ...body(), interfaceName: '한 번' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ ...body(), interfaceName: '두 번' })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 정의는 404 다', async () => {
    await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body())
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/integration/interface-definitions/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/integration/interface-definitions/999999999:test-connection')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  interface Detail {
    interfaceDefinition: {
      interfaceCode: string;
      targetCode: string;
      withinConfirmedScope: boolean;
    };
    columnMappings: { relayColumn: string; targetTable: string; targetColumn: string }[];
    editability: { reason: string; referenceCount: number | null };
    pendingMessageCount: number;
  }

  function body(): Record<string, unknown> {
    counter += 1;
    return {
      interfaceCode: `${PREFIX}_${counter}`,
      interfaceName: `연계 ${counter}`,
      directionCode: 'INBOUND',
      targetCode: 'ITEM',
      externalSystemCode: 'UNIERP',
      triggerTypeCode: 'TIME_SCHEDULE',
      scheduleExpression: '매시 정각',
    };
  }

  async function create(extra: Record<string, unknown> = {}): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/integration/interface-definitions')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(), ...extra })
      .expect(201);
    const validate = validator('POST /integration/interface-definitions');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.interfaceDefinitionId;
  }

  async function detailOf(id: number): Promise<Detail> {
    const response = await request(app.getHttpServer())
      .get(`/api/integration/interface-definitions/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as Detail;
  }

  async function testConnection(
    id: number,
  ): Promise<{ body: { succeeded: boolean; failureCauseCode?: string } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/integration/interface-definitions/${id}:test-connection`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    return { body: response.body };
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
    await prisma.integration_message.deleteMany({
      where: { message_key: { startsWith: PREFIX } },
    });
    const definitions = await prisma.interface_definition.findMany({
      where: { interface_code: { startsWith: PREFIX } },
      select: { interface_definition_id: true },
    });
    await prisma.interface_column_mapping.deleteMany({
      where: {
        interface_definition_id: { in: definitions.map((d) => d.interface_definition_id) },
      },
    });
    await prisma.interface_definition.deleteMany({
      where: { interface_code: { startsWith: PREFIX } },
    });

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
