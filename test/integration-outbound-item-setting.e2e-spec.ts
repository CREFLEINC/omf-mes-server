/**
 * 송신 항목 설정.
 *
 * ⭐ 「필수」와 「비연계」를 기본값이 아니라 **구조로** 표현했다(설계 §9-1) — 생산 실적은
 * `locked` 라 서버가 거부하고, 검사 결과는 **값 목록에 넣지 않아** 꺼진 채로도 안 보인다.
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
import { OUTBOUND_ITEMS } from '../src/integration/outbound/outbound-item';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-outbound-probe';
const NOPERM_ID = 'e2e-outbound-noperm';
const PASSWORD = '송신항목-검사-비밀번호';
const PREFIX = 'E2E_OUTBOUND';
const ROLE = 'E2E_OUTBOUND_ROLE';

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

interface Setting {
  outboundItemCode: string;
  enabled: boolean;
  locked: boolean;
  lockReason?: string;
  interfaceDefinitionId?: number;
  pendingMessageCount: number;
}

describe('송신 항목 설정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let definitionId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '송신검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '송신검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-12' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    const definition = await prisma.interface_definition.create({
      data: {
        interface_code: `${PREFIX}_IF`,
        interface_name: '송신 검사용',
        direction_code: 'OUTBOUND',
        target_code: 'ITEM',
        external_system_code: 'UNIERP',
        trigger_type_code: 'EVENT',
        event_condition: '실적 등록 시',
      },
    });
    definitionId = Number(definition.interface_definition_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 저장한 적이 없어도 다섯을 낸다 — 「검사 결과」는 목록에 없다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /integration/outbound-item-settings');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const codes = response.body.items.map((i: Setting) => i.outboundItemCode);
    expect(codes).toEqual([
      'PRODUCTION_RESULT',
      'GOODS_RECEIPT',
      'SHIPMENT_PGI',
      'RETURN',
      'STOCK_ADJUSTMENT',
    ]);
    // ⛔ 값으로 두고 끄면 누군가 켤 수 있다 — 아예 넣지 않는다(계약).
    expect(codes).not.toContain('INSPECTION_RESULT');
    // 저장된 줄이 없으면 「켜짐」이다(되돌림 §X-5).
    expect(response.body.items.every((i: Setting) => i.enabled)).toBe(true);
  });

  it('⭐⭐ 생산 실적은 잠겨 있고 사유에 확정 번호가 붙는다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .expect(200);

    const production = response.body.items.find(
      (i: Setting) => i.outboundItemCode === 'PRODUCTION_RESULT',
    ) as Setting;
    expect(production.locked).toBe(true);
    // 「왜 못 바꾸나」를 물을 때 추적 가능한 근거가 화면에 있어야 한다(공유계약).
    expect(production.lockReason).toContain('QA #35');

    const others = response.body.items.filter(
      (i: Setting) => i.outboundItemCode !== 'PRODUCTION_RESULT',
    );
    expect(others.every((i: Setting) => !i.locked)).toBe(true);
  });

  it('⭐⭐ 잠긴 항목을 끄려 하면 400 이다 — 화면이 막는 것과 별개로 서버도 막는다', async () => {
    const rejected = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'PRODUCTION_RESULT', enabled: false }] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'items[0].enabled',
      code: 'STATE_LOCKED',
    });
    expect(rejected.body.errors[0].message).toContain('QA #35');
  });

  it('⭐ 묶음으로 저장한다 — 켜짐·꺼짐과 연계 정의가 함께 남는다', async () => {
    const saved = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        items: [
          { outboundItemCode: 'GOODS_RECEIPT', enabled: false },
          { outboundItemCode: 'SHIPMENT_PGI', enabled: true, interfaceDefinitionId: definitionId },
        ],
      })
      .expect(200);
    const validate = validator('PUT /integration/outbound-item-settings');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const byCode = new Map(saved.body.items.map((i: Setting) => [i.outboundItemCode, i]));
    expect(byCode.get('GOODS_RECEIPT')).toMatchObject({ enabled: false });
    expect(byCode.get('SHIPMENT_PGI')).toMatchObject({ enabled: true, interfaceDefinitionId: definitionId });
    // 보내지 않은 항목은 그대로 켜져 있다 — 저장된 줄이 없다.
    expect(byCode.get('RETURN')).toMatchObject({ enabled: true });

    // 다시 켜면 되돌아온다.
    const again = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'GOODS_RECEIPT', enabled: true }] })
      .expect(200);
    const back = again.body.items.find((i: Setting) => i.outboundItemCode === 'GOODS_RECEIPT');
    expect(back.enabled).toBe(true);
    // ⛔ 한 항목만 보낸 저장이 «다른 항목의 저장분»을 지우지 않는다. 화면은 바꾼 것만
    //   보낼 수 있고, 그때 나머지가 기본값으로 되돌아가면 조용히 송신이 켜진다.
    const kept = again.body.items.find((i: Setting) => i.outboundItemCode === 'SHIPMENT_PGI');
    expect(kept).toMatchObject({ enabled: true, interfaceDefinitionId: definitionId });

    // 같은 항목을 두 번 저장해도 줄은 하나다 — upsert 라 매번 넣지 않는다.
    const rows = await prisma.outbound_item_setting.findMany({
      where: { outbound_item_code: 'GOODS_RECEIPT' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].version_no).toBeGreaterThan(1);
  });

  it('⭐ 이어 둔 연계 정의의 「보내지 못한 건수」를 함께 낸다', async () => {
    await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'RETURN', enabled: true, interfaceDefinitionId: definitionId }] })
      .expect(200);

    for (const suffix of ['A', 'B']) {
      await prisma.integration_message.create({
        data: {
          message_key: `${PREFIX}-${suffix}`,
          interface_code: `${PREFIX}_IF`,
          direction_code: 'OUTBOUND',
          target_type_code: 'ITEM',
          target_id: 1,
          payload: {},
          status_code: 'FAILED',
          available_at: new Date(),
        },
      });
    }

    const response = await request(app.getHttpServer())
      .get('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .expect(200);
    const item = response.body.items.find((i: Setting) => i.outboundItemCode === 'RETURN');
    // 확인 문구가 이 값을 쓴다 — 남은 것이 있는데 끄면 그대로 멈춘다(계약).
    expect(item.pendingMessageCount).toBe(2);

    // 이어 두지 않은 항목은 0 이다.
    const unlinked = response.body.items.find(
      (i: Setting) => i.outboundItemCode === 'STOCK_ADJUSTMENT',
    );
    expect(unlinked.pendingMessageCount).toBe(0);
  });

  it('⛔ 없는 연계 정의·같은 항목 두 번은 400 이다', async () => {
    const noDefinition = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'RETURN', enabled: true, interfaceDefinitionId: 999999999 }] })
      .expect(400);
    expect(noDefinition.body.errors[0]).toMatchObject({
      field: 'items[0].interfaceDefinitionId',
      code: 'INVALID',
    });

    const duplicated = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        items: [
          { outboundItemCode: 'RETURN', enabled: true },
          { outboundItemCode: 'RETURN', enabled: false },
        ],
      })
      .expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'items[1].outboundItemCode',
      code: 'UNIQUE_VIOLATION',
    });
  });

  it('⛔ 어휘 밖 항목은 계약 검증이 거른다 — 「검사 결과」도 그렇다', async () => {
    const rejected = await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'INSPECTION_RESULT', enabled: true }] })
      .expect(400);

    expect(rejected.body.errors[0].code).toBe('INVALID');
  });

  it('⛔ 권한이 없으면 저장이 403 이다 — 조회는 계약이 403 을 안 걸었다', async () => {
    await request(app.getHttpServer())
      .put('/api/integration/outbound-item-settings')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ items: [{ outboundItemCode: 'RETURN', enabled: true }] })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/integration/outbound-item-settings')
      .set('Cookie', noPermCookie)
      .expect(200);
  });

  it('앱 상수가 다섯이고 잠긴 것은 하나다', () => {
    expect(OUTBOUND_ITEMS).toHaveLength(5);
    expect(OUTBOUND_ITEMS.filter((item) => item.locked)).toHaveLength(1);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

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
    await prisma.outbound_item_setting.deleteMany({});
    await prisma.integration_message.deleteMany({
      where: { message_key: { startsWith: PREFIX } },
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
