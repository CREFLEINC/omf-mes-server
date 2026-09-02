/**
 * Routing 헤더.
 *
 * ⭐ 확정 Rev 는 고치지 못한다 — 변경은 신규 Rev 로만 한다(설계 결정 07).
 * ⭐ `usableOnly` 의 판정은 서버가 한다 — 화면은 상태 문자열을 알 필요가 없다.
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
import { ROUTING_REFERRERS } from '../src/planning/routing/routing.service';
import { ROUTING_STATUS } from '../src/planning/routing/routing-status';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-routing-probe';
const NOPERM_ID = 'e2e-routing-noperm';
const PASSWORD = 'Routing-검사-비밀번호';
const PREFIX = 'E2E_ROUTING';
const ROLE = 'E2E_ROUTING_ROLE';

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

describe('Routing 헤더 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let itemIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'Routing검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'Routing검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-01' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    // Rev 는 품목당 한 줄기라 검사마다 새 품목이 필요하다.
    const uom = await prisma.uom.findFirstOrThrow({ select: { uom_id: true } });
    itemIds = [];
    for (let i = 0; i < 7; i += 1) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-I${i}`,
          item_name: `검사품목${i}`,
          item_type_code: 'FG',
          base_uom_id: uom.uom_id,
          lot_control_type_code: 'LOT',
        },
      });
      itemIds.push(Number(item.item_id));
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(`
      SELECT n.nspname || '.' || r.relname AS "table",
             (SELECT a.attname FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = 'planning' AND t.relname = 'routing'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(ROUTING_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('등록·목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const created = await create(itemIds[0]);
    expect(created.routingVersion).toBe(1);
    expect(created.statusCode).toBe(ROUTING_STATUS.DRAFT);
    expect(created.isDefault).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/planning/routings?itemId=${itemIds[0]}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /planning/routings');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /planning/routings/{routingId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    // 라인이 아직 없으므로 코드가 열려 있다.
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 유효 시작일을 비워 둘 수 있다 — 「시작 제한이 없다」(결정 07)', async () => {
    const created = await create(itemIds[1]);

    expect(created.effectiveFrom).toBeUndefined();

    const saved = await request(app.getHttpServer())
      .put(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ routingCode: `${PREFIX}-C2`, effectiveFrom: '2026-09-01', effectiveTo: '2026-12-31' })
      .expect(200);
    expect(saved.body.effectiveFrom).toBe('2026-09-01');
    expect(saved.headers.etag).toBe('2');
  });

  it('⭐ 라인이 붙으면 코드가 잠긴다 — 창고가 자기 로케이션을 세는 것과 같다', async () => {
    const created = await create(itemIds[2]);
    await addOperation(created.routingId);

    const detail = await request(app.getHttpServer())
      .get(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.editability).toMatchObject({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('⛔ 확정된 Rev 는 수정이 400 STATE_LOCKED 다 — 409 가 아니다', async () => {
    const created = await create(itemIds[3]);
    await prisma.routing.update({
      where: { routing_id: created.routingId },
      data: { status_code: ROUTING_STATUS.CONFIRMED },
    });

    const rejected = await request(app.getHttpServer())
      .put(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ routingCode: `${PREFIX}-LOCKED` })
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⭐ usableOnly 는 확정이고 기간 안인 Rev 만 낸다 — 판정은 서버가 한다', async () => {
    const draft = await create(itemIds[4]);
    // 같은 품목에 확정 Rev 를 하나 더 세운다(:new-revision 은 아직 없다).
    const confirmed = await prisma.routing.create({
      data: {
        item_id: itemIds[4],
        routing_code: `${PREFIX}-USABLE`,
        routing_version: 2,
        status_code: ROUTING_STATUS.CONFIRMED,
      },
    });
    const expired = await prisma.routing.create({
      data: {
        item_id: itemIds[4],
        routing_code: `${PREFIX}-EXPIRED`,
        routing_version: 3,
        status_code: ROUTING_STATUS.CONFIRMED,
        effective_to: new Date('2020-01-01'),
      },
    });

    const all = await request(app.getHttpServer())
      .get(`/api/planning/routings?itemId=${itemIds[4]}`)
      .set('Cookie', cookie)
      .expect(200);
    // 「Routing 관리 화면은 폐기 개정까지 보여야 하므로 이 파라미터를 쓰지 않는다」(계약).
    expect(all.body.items).toHaveLength(3);
    // 최신이 위다.
    expect(all.body.items[0].routingVersion).toBe(3);

    const usable = await request(app.getHttpServer())
      .get(`/api/planning/routings?itemId=${itemIds[4]}&usableOnly=true`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = usable.body.items.map((r: { routingId: number }) => r.routingId);
    expect(ids).toEqual([Number(confirmed.routing_id)]);
    expect(ids).not.toContain(draft.routingId);
    expect(ids).not.toContain(Number(expired.routing_id));
  });

  it('⭐ 기본 Rev 는 품목당 하나다 — 새로 지정하면 앞의 것이 내려온다', async () => {
    const first = await create(itemIds[5]);
    const second = await prisma.routing.create({
      data: {
        item_id: itemIds[5],
        routing_code: `${PREFIX}-D2`,
        routing_version: 2,
        status_code: ROUTING_STATUS.CONFIRMED,
      },
    });

    await setDefault(first.routingId);
    const swapped = await setDefault(Number(second.routing_id));
    expect(swapped.body.isDefault).toBe(true);

    const list = await request(app.getHttpServer())
      .get(`/api/planning/routings?itemId=${itemIds[5]}`)
      .set('Cookie', cookie)
      .expect(200);
    const defaults = list.body.items.filter((r: { isDefault: boolean }) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].routingId).toBe(Number(second.routing_id));
  });

  it('⛔ 품목에 Rev 가 이미 있으면 등록이 400 이다 — 신규 Rev 는 다른 경로다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[0], routingCode: `${PREFIX}-DUP` })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'itemId',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['itemId'],
    });
  });

  it('⛔ 공백만 코드·없는 품목·거꾸로 된 기간은 400 이다', async () => {
    const blank = await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[1], routingCode: '   ' })
      .expect(400);
    expect(blank.body.errors[0]).toMatchObject({ field: 'routingCode', code: 'REQUIRED' });

    const noItem = await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId: 999999999, routingCode: `${PREFIX}-NOITEM` })
      .expect(400);
    expect(noItem.body.errors[0]).toMatchObject({ field: 'itemId', code: 'INVALID' });

    const backwards = await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        itemId: 999999998,
        routingCode: `${PREFIX}-BACK`,
        effectiveFrom: '2026-12-31',
        effectiveTo: '2026-01-01',
      })
      .expect(400);
    expect(backwards.body.errors[0]).toMatchObject({ field: 'effectiveTo', code: 'PAIR' });
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const created = await create(itemIds[6]);
    await request(app.getHttpServer())
      .put(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ routingCode: `${PREFIX}-V2` })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/planning/routings/${created.routingId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ routingCode: `${PREFIX}-V3` })
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 Routing 은 404 다', async () => {
    await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ itemId: itemIds[3], routingCode: `${PREFIX}-DENY` })
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/planning/routings/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/planning/routings/999999999:set-default')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(
    itemId: number,
    suffix = 1,
  ): Promise<{ routingId: number; routingVersion: number; statusCode: string; isDefault: boolean; effectiveFrom?: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/planning/routings')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ itemId, routingCode: `${PREFIX}-C${suffix}` })
      .expect(201);
    const validate = validator('POST /planning/routings');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function setDefault(routingId: number): Promise<{ body: { isDefault: boolean } }> {
    const response = await request(app.getHttpServer())
      .post(`/api/planning/routings/${routingId}:set-default`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(200);
    return { body: response.body };
  }

  /** 공정 라인 API 는 다음 PR 이다 — 참조를 세우려면 DB 로 넣는다. */
  async function addOperation(routingId: number): Promise<void> {
    const process = await prisma.process.upsert({
      where: { process_code: `${PREFIX}-P` },
      update: {},
      create: {
        process_code: `${PREFIX}-P`,
        process_name: '검사공정',
        process_type_code: 'ASSEMBLY',
      },
    });
    await prisma.routing_operation.create({
      data: {
        routing_id: routingId,
        operation_seq: 1,
        process_id: process.process_id,
        operation_name: '검사라인',
      },
    });
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
    const ids = items.map((row) => row.item_id);
    const routings = await prisma.routing.findMany({
      where: { item_id: { in: ids } },
      select: { routing_id: true },
    });
    const routingIds = routings.map((row) => row.routing_id);
    await prisma.routing_operation.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.routing.deleteMany({ where: { routing_id: { in: routingIds } } });
    await prisma.item.deleteMany({ where: { item_id: { in: ids } } });
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
