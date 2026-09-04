/**
 * 품목 「부속 정보」 세 탭 — 사업부매핑 · 외부코드 · 단위환산.
 *
 * 셋이 잠금 축을 공유한다(품목의 `version_no`). 그 성질이 실제로 그런지, 그리고
 * 통째 교체가 트랜잭션 안에서만 일어나는지가 이 검사의 뼈대다.
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

const LOGIN_ID = 'e2e-mdmitemdet-probe';
const NOPERM_ID = 'e2e-mdmitemdet-noperm';
const PASSWORD = '품목-부속-검사-비밀번호';
const PREFIX = 'MDMITEMDET';
const ROLE = 'E2E_MDMITEMDET';

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

describe('품목 부속 정보 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let itemId: number;
  let otherItemId: number;
  let units: number[];
  let businessUnits: number[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '부속검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '부속검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-05' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    const uoms = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    units = uoms.map((u) => Number(u.uom_id));
    const bus = await prisma.business_unit.findMany({ take: 2, orderBy: { business_unit_id: 'asc' } });
    businessUnits = bus.map((b) => Number(b.business_unit_id));
    itemId = await createItem(`${PREFIX}-A`);
    otherItemId = await createItem(`${PREFIX}-B`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 축을 공유한다 ────────────────────────────────────────────────────────

  it('⭐ 세 탭의 ETag 가 모두 품목의 version_no 다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/items/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);

    for (const tab of ['bu-item-maps', 'external-codes', 'uom-conversions']) {
      const response = await request(app.getHttpServer())
        .get(`/api/mdm/items/${itemId}/${tab}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(response.headers.etag).toBe(detail.headers.etag);
    }
  });

  it('⭐ 한 탭을 저장하면 다른 탭의 ETag 도 낡는다 — 축이 하나다', async () => {
    const before = await etagOf('external-codes');

    await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('uom-conversions'))
      .send({ conversions: [] })
      .expect(200);

    // 계약이 B-6 로 「통째로 교체하는 저장이라 보호가 없으면 남이 방금 넣은 줄이
    // 조용히 사라진다」고 적었다. 축이 하나라 다른 탭의 낡은 토큰도 함께 막힌다.
    await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/external-codes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before)
      .send({ externalCodes: [] })
      .expect(409);
  });

  // ── 사업부 매핑 ──────────────────────────────────────────────────────────

  it('⭐ 사업부 매핑을 통째로 저장한다 — fromItemId 는 경로로 고정된다', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/bu-item-maps`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('bu-item-maps'))
      .send({
        maps: [
          {
            fromBusinessUnitId: businessUnits[0],
            toBusinessUnitId: businessUnits[1],
            toItemId: otherItemId,
            effectiveFrom: '2026-01-01',
            effectiveTo: '2026-12-31',
          },
        ],
      })
      .expect(200);

    const validate = validator('PUT /mdm/items/{itemId}/bu-item-maps');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 본문에 자리가 없는데도 채워져 나온다 — 경로에서 왔다.
    expect(saved.body.items[0].fromItemId).toBe(itemId);
  });

  it('⛔ 보내는 사업부와 받는 사업부가 같으면 400 — ck_item_bu_map_distinct', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/bu-item-maps`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('bu-item-maps'))
      .send({
        maps: [
          {
            fromBusinessUnitId: businessUnits[0],
            toBusinessUnitId: businessUnits[0],
            toItemId: otherItemId,
            effectiveFrom: '2026-01-01',
          },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'maps[0].toBusinessUnitId',
      code: 'INVALID',
    });
  });

  it('⛔ 종료일이 시작일보다 앞서면 400 — ck_item_bu_map_dates', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/bu-item-maps`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('bu-item-maps'))
      .send({
        maps: [
          {
            fromBusinessUnitId: businessUnits[0],
            toBusinessUnitId: businessUnits[1],
            toItemId: otherItemId,
            effectiveFrom: '2026-06-01',
            effectiveTo: '2026-01-01',
          },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'maps[0].effectiveTo', code: 'PAIR' });
  });

  // ── 외부 코드 ───────────────────────────────────────────────────────────

  it('⭐ 외부코드는 거래처를 비우면 (전체)로 접혀 유일 판정된다 — A-7', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/external-codes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('external-codes'))
      .send({
        externalCodes: [
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-E1` },
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-E2` },
        ],
      })
      .expect(200);
    expect(saved.body.items).toHaveLength(2);
    expect(saved.body.items[0].partnerId).toBeNull();

    // 같은 시스템·같은 코드에 거래처가 둘 다 비어 있으면 uq 가 접어 같은 줄이 된다.
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/external-codes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('external-codes'))
      .send({
        externalCodes: [
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-DUP` },
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-DUP` },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'externalCodes[1].externalItemCode',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['externalSystemCode', 'partnerId', 'externalItemCode'],
    });
  });

  it('⭐ 통째로 교체한다 — 두 줄을 넣고 한 줄만 보내면 하나가 남는다', async () => {
    await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/external-codes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('external-codes'))
      .send({
        externalCodes: [
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-X1` },
          { externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-X2` },
        ],
      })
      .expect(200);

    const shrunk = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/external-codes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('external-codes'))
      .send({ externalCodes: [{ externalSystemCode: 'UNIERP', externalItemCode: `${PREFIX}-X1` }] })
      .expect(200);

    expect(shrunk.body.items).toHaveLength(1);
    expect(shrunk.body.items[0].externalItemCode).toBe(`${PREFIX}-X1`);
  });

  // ── 단위 환산 ───────────────────────────────────────────────────────────

  it('⭐ 단위환산을 저장하고 계약 스키마를 만족한다', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('uom-conversions'))
      .send({
        conversions: [
          {
            fromUomId: units[0],
            toUomId: units[1],
            conversionRate: 2.5,
            effectiveFrom: '2026-01-01',
          },
        ],
      })
      .expect(200);

    const validate = validator('GET /mdm/items/{itemId}/uom-conversions');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.items[0].conversionRate).toBe(2.5);
  });

  it('⛔ 같은 단위끼리는 환산할 수 없다 — ck_item_uom_distinct', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('uom-conversions'))
      .send({
        conversions: [
          {
            fromUomId: units[0],
            toUomId: units[0],
            conversionRate: 1,
            effectiveFrom: '2026-01-01',
          },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'conversions[0].toUomId',
      code: 'INVALID',
    });
  });

  it('⛔ 환산율 0 은 계약 검증이 거른다 — exclusiveMinimum', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('uom-conversions'))
      .send({
        conversions: [
          {
            fromUomId: units[0],
            toUomId: units[1],
            conversionRate: 0,
            effectiveFrom: '2026-01-01',
          },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'conversions[0].conversionRate' });
  });

  // ── 공통 성질 ───────────────────────────────────────────────────────────

  it('⛔ 거절된 저장은 아무것도 바꾸지 않는다 — 한 트랜잭션이다', async () => {
    await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await etagOf('uom-conversions'))
      .send({
        conversions: [
          {
            fromUomId: units[0],
            toUomId: units[1],
            conversionRate: 3,
            effectiveFrom: '2026-02-01',
          },
        ],
      })
      .expect(200);

    const before = await listOf('uom-conversions');

    await request(app.getHttpServer())
      .put(`/api/mdm/items/${itemId}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.etag)
      .send({
        conversions: [
          {
            fromUomId: units[0],
            toUomId: units[0],
            conversionRate: 1,
            effectiveFrom: '2026-01-01',
          },
        ],
      })
      .expect(400);

    const after = await listOf('uom-conversions');
    expect(after.etag).toBe(before.etag);
    expect(after.items).toEqual(before.items);
  });

  it('⛔ 권한이 없으면 세 탭의 저장이 모두 403 이다', async () => {
    const bodies: Record<string, object> = {
      'bu-item-maps': { maps: [] },
      'external-codes': { externalCodes: [] },
      'uom-conversions': { conversions: [] },
    };
    for (const [tab, body] of Object.entries(bodies)) {
      await request(app.getHttpServer())
        .put(`/api/mdm/items/${itemId}/${tab}`)
        .set('Cookie', noPermCookie)
        .set('Idempotency-Key', key())
        .set('If-Match', await etagOf(tab))
        .send(body)
        .expect(403);
    }
  });

  it('⛔ 없는 품목은 세 탭 모두 404 다', async () => {
    for (const tab of ['bu-item-maps', 'external-codes', 'uom-conversions']) {
      await request(app.getHttpServer())
        .get(`/api/mdm/items/999999999/${tab}`)
        .set('Cookie', cookie)
        .expect(404);
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function listOf(tab: string): Promise<{ etag: string; items: unknown[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/items/${itemId}/${tab}`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: response.headers.etag, items: response.body.items };
  }

  async function etagOf(tab: string): Promise<string> {
    return (await listOf(tab)).etag;
  }

  async function createItem(itemCode: string): Promise<number> {
    const uom = await prisma.uom.findFirstOrThrow();
    const created = await prisma.item.create({
      data: {
        item_code: itemCode,
        item_name: itemCode,
        item_type_code: 'RAW',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    return Number(created.item_id);
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
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    const ids = items.map((i) => i.item_id);
    await prisma.item_bu_item_map.deleteMany({ where: { from_item_id: { in: ids } } });
    await prisma.item_external_code.deleteMany({ where: { item_id: { in: ids } } });
    await prisma.item_uom_conversion.deleteMany({ where: { item_id: { in: ids } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
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
