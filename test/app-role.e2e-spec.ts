/**
 * 역할 마스터와 기능 권한 목록.
 *
 * ⭐ 이 화면은 자기 자신을 잠글 수 있는 유일한 자리다 — 관리 권한 보유자를 0명으로
 * 만드는 저장이 400 `LAST_ADMIN` 으로 막히는지가 이 파일의 본체다.
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
import { ROLE_REFERRERS } from '../src/app/access/role.service';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-approle-probe';
const NOPERM_ID = 'e2e-approle-noperm';
/**
 * ⛔ 「관리자를 한 명 더 세운다」 용도 전용 계정. NOPERM 을 빌려 쓰면 그 순간 그 계정이
 * `W-CO-02` 를 얻어, 뒤따르는 403 검사가 조용히 200 이 된다(실제로 그렇게 깨졌다).
 */
const HOLDER_ID = 'e2e-approle-holder';
const PASSWORD = '역할-검사-비밀번호';
const PREFIX = 'E2E_APPROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${method === 'POST' && !path.includes(':') ? '201' : '200'}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('역할·기능 권한 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let adminRoleId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '역할검사', status_code: 'ACTIVE' },
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
    await prisma.app_user.create({
      data: { login_id: HOLDER_ID, user_name: '관리자보유', status_code: 'ACTIVE' },
    });

    const role = await prisma.role.create({
      data: { role_code: `${PREFIX}_ADMIN`, role_name: '역할검사용 관리자' },
    });
    adminRoleId = Number(role.role_id);
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-CO-02' },
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
      WHERE c.contype = 'f' AND tn.nspname = 'app' AND t.relname = 'role'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(ROLE_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  // ── 기능 권한 목록 ──────────────────────────────────────────────────────

  it('⭐ 권한 목록이 격자의 열 117개를 쪽 없이 통째로 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/app/permissions')
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /app/permissions');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items).toHaveLength(117);
    // 이 화면 자신의 권한이 목록에 있어야 격자에서 관리자를 만들 수 있다.
    expect(response.body.items.map((p: { code: string }) => p.code)).toContain('W-CO-02');
    expect(response.body.page).toBeUndefined();
  });

  // ── 역할 마스터 ─────────────────────────────────────────────────────────

  it('목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const created = await create(`${PREFIX}_A`);

    const list = await request(app.getHttpServer())
      .get(`/api/app/roles?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /app/roles');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/app/roles/${created.roleId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /app/roles/{roleId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    // 아무도 안 쓰는 새 역할이라 코드가 열려 있다.
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
    expect(detail.body.assignedUserCount).toBe(0);
  });

  it('⭐ 배정이 생기면 코드가 잠기고 배정 건수가 함께 오른다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/app/roles/${adminRoleId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 이 역할은 검사 사용자에게 배정돼 있고 권한도 한 줄 붙어 있다.
    expect(detail.body.editability.reason).toBe('REFERENCED');
    expect(detail.body.editability.codeEditable).toBe(false);
    expect(detail.body.editability.referenceCount).toBeGreaterThanOrEqual(2);
    expect(detail.body.assignedUserCount).toBe(1);
  });

  it('수정하면 버전이 오르고 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const created = await create(`${PREFIX}_B`);

    const saved = await request(app.getHttpServer())
      .put(`/api/app/roles/${created.roleId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ roleCode: `${PREFIX}_B`, roleName: '고친 이름', description: '설명' })
      .expect(200);
    expect(saved.body.roleName).toBe('고친 이름');
    expect(saved.headers.etag).toBe('2');

    const stale = await request(app.getHttpServer())
      .put(`/api/app/roles/${created.roleId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ roleCode: `${PREFIX}_B`, roleName: '또 고친 이름' })
      .expect(409);
    expect(stale.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⛔ 역할코드 중복은 400 이고 유일키 범위를 담는다', async () => {
    await create(`${PREFIX}_C`);

    const rejected = await request(app.getHttpServer())
      .post('/api/app/roles')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ roleCode: `${PREFIX}_C`, roleName: '같은 코드' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'roleCode',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['roleCode'],
    });
  });

  it('⛔ 공백만으로는 채울 수 없다 — 계약이 두 칸에 그렇게 적었다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/app/roles')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ roleCode: '   ', roleName: '\t' })
      .expect(400);

    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'roleCode',
      'roleName',
    ]);
    expect(rejected.body.errors[0].code).toBe('REQUIRED');
  });

  it('사용 중지·다시 사용이 목록 기본값을 가른다', async () => {
    const created = await create(`${PREFIX}_D`);

    await request(app.getHttpServer())
      .post(`/api/app/roles/${created.roleId}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    const defaults = await request(app.getHttpServer())
      .get(`/api/app/roles?q=${PREFIX}_D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(defaults.body.items).toHaveLength(0);

    const included = await request(app.getHttpServer())
      .get(`/api/app/roles?q=${PREFIX}_D&includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);
    expect(included.body.items).toHaveLength(1);
    expect(included.body.items[0].isActive).toBe(false);

    await request(app.getHttpServer())
      .post(`/api/app/roles/${created.roleId}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  // ── 마지막 관리자 ───────────────────────────────────────────────────────

  it('⭐ 마지막 관리자 역할은 중지되지 않는다 — 400 LAST_ADMIN', async () => {
    // 시드 관리자가 같은 권한을 들고 있어 그대로는 「마지막」이 아니다. 그 계정을 잠시
    // 내려 검사 사용자만 관리자인 상태를 만든다 — API 를 거치지 않으므로 판정을 안 탄다.
    const seeded = await prisma.app_user.findMany({
      where: {
        is_active: true,
        login_id: { not: LOGIN_ID },
        user_role: {
          some: {
            role: { is_active: true, role_permission: { some: { permission_code: 'W-CO-02' } } },
          },
        },
      },
      select: { app_user_id: true },
    });
    const ids = seeded.map((row) => row.app_user_id);
    await prisma.app_user.updateMany({
      where: { app_user_id: { in: ids } },
      data: { is_active: false },
    });

    try {
      const rejected = await request(app.getHttpServer())
        .post(`/api/app/roles/${adminRoleId}:deactivate`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', '1')
        .expect(400);
      expect(rejected.body.errors[0].code).toBe('LAST_ADMIN');

      // ⛔ 막혔으면 «되돌아가» 있어야 한다 — 트랜잭션이 통째로 취소되므로 버전도 그대로다.
      const after = await request(app.getHttpServer())
        .get(`/api/app/roles/${adminRoleId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.role.isActive).toBe(true);
      expect(after.headers.etag).toBe('1');
    } finally {
      await prisma.app_user.updateMany({
        where: { app_user_id: { in: ids } },
        data: { is_active: true },
      });
    }
  });

  it('⭐ 중지는 관리자 자물쇠를 «지나간다» — 안 그러면 동시 저장이 서로를 못 본다', async () => {
    // READ COMMITTED 에서 A 가 역할 하나를 내리고 세는 사이 B 가 다른 역할을 내리고 세면,
    // 둘 다 상대의 미커밋 변경을 못 봐 각자 「아직 한 명 남았다」로 통과하고 0명이 된다.
    // HTTP 로 둘을 동시에 쏘는 검사는 «겹치지 않으면» 그냥 통과해 버려 아무것도 못 가른다.
    // 그래서 자물쇠 자체를 잡아 두고, 중지가 그 앞에 서는지를 본다.
    const target = await create(`${PREFIX}_LOCK`);
    let released = false;

    const blocker = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(20260901::bigint)');
      await new Promise((resolve) => setTimeout(resolve, 400));
      released = true;
    });
    // 요청이 자물쇠 앞에 서도록 먼저 잡히게 둔다.
    await new Promise((resolve) => setTimeout(resolve, 60));

    await request(app.getHttpServer())
      .post(`/api/app/roles/${target.roleId}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    // 자물쇠를 안 탔다면 400ms 를 기다릴 이유가 없어 released 가 아직 false 다.
    expect(released).toBe(true);
    await blocker;
  });

  it('관리자가 둘이면 하나를 중지할 수 있다', async () => {
    const spare = await prisma.role.create({
      data: { role_code: `${PREFIX}_ADMIN2`, role_name: '예비 관리자' },
    });
    await prisma.role_permission.create({
      data: { role_id: spare.role_id, permission_code: 'W-CO-02' },
    });
    const holder = await prisma.app_user.findUniqueOrThrow({ where: { login_id: HOLDER_ID } });
    await prisma.user_role.create({
      data: { app_user_id: holder.app_user_id, role_id: spare.role_id },
    });

    await request(app.getHttpServer())
      .post(`/api/app/roles/${Number(spare.role_id)}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);
  });

  // ── 게이트 ──────────────────────────────────────────────────────────────

  it('⛔ 권한이 없으면 목록·등록·전이가 403 이다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/roles')
      .set('Cookie', noPermCookie)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/app/roles')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ roleCode: `${PREFIX}_X`, roleName: '막힘' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/app/roles/${adminRoleId}:deactivate`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(403);
  });

  it('⛔ 없는 역할은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/app/roles/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .post('/api/app/roles/999999999:deactivate')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function create(roleCode: string): Promise<{ roleId: number }> {
    const response = await request(app.getHttpServer())
      .post('/api/app/roles')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ roleCode, roleName: roleCode })
      .expect(201);
    const validate = validator('POST /app/roles');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return { roleId: response.body.roleId };
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
    for (const id of [LOGIN_ID, NOPERM_ID, HOLDER_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const roles = await prisma.role.findMany({
      where: { role_code: { startsWith: PREFIX } },
      select: { role_id: true },
    });
    const ids = roles.map((row) => row.role_id);
    await prisma.user_role.deleteMany({ where: { role_id: { in: ids } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: ids } } });
    await prisma.role.deleteMany({ where: { role_id: { in: ids } } });
  }
});
