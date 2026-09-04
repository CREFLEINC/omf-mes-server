/**
 * 공정 마스터 — MES 정본(REQ-PR-0026), 관리 화면 `W-06-01` 《공정 마스터》 탭(6d03a44).
 *
 * 표준 마스터 패턴: 상세 ETag → If-Match · editability 는 FK 참조 건수(공유계약 B-4) ·
 * 코드 중복·참조 중 코드 변경은 409 가 아니라 400.
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
import { PROCESS_REFERRERS } from '../src/mdm/process/process.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mdmproc-probe';
const NOPERM_ID = 'e2e-mdmproc-noperm';
const PASSWORD = '공정-검사-비밀번호';
const PREFIX = 'MDMPROC';
const ROLE = 'E2E_MDMPROC';

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

describe('공정 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

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
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
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
      WHERE c.contype = 'f' AND tn.nspname = 'mdm' AND t.relname = 'process'
    `);
    const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
    expect(PROCESS_REFERRERS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/processes')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-X`))
      .expect(403);
  });

  it('⭐ 등록하고 상세가 계약 스키마·ETag·편집 가능성을 준다', async () => {
    const { id, etag } = await create(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/processes/{processId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.process).toMatchObject({ processCode: `${PREFIX}-A`, isActive: true });
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⛔ 마스터에 없는 공정 유형은 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/processes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ ...body(`${PREFIX}-BAD`), processTypeCode: '없는유형' })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'processTypeCode', code: 'INVALID' });
  });

  it('⛔ 공정 코드 중복은 409 가 아니라 400 이다', async () => {
    await create(`${PREFIX}-DUP`);
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/processes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-DUP`))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'processCode',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['processCode'],
    });
  });

  it('⭐ 참조가 붙으면 코드가 잠기고(B-4) 코드 변경은 400, 이름 변경은 된다', async () => {
    const { id } = await create(`${PREFIX}-REF`);
    await prisma.cause_code.create({
      data: { cause_code: `${PREFIX}-CAUSE`, cause_name: '참조용 원인', process_id: id },
    });

    const detail = await detailOf(id);
    expect(detail.editability).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.etag)
      .send(body(`${PREFIX}-REF2`))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'processCode', code: 'STATE_LOCKED' });

    const renamed = await request(app.getHttpServer())
      .put(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.etag)
      .send({ ...body(`${PREFIX}-REF`), processName: '이름만 고침' })
      .expect(200);
    expect(renamed.body.processName).toBe('이름만 고침');
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await create(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ ...body(`${PREFIX}-V2`), processTypeCode: 'ASSEMBLY' })
      .expect(200);
    expect(updated.body).toMatchObject({ processCode: `${PREFIX}-V2`, processTypeCode: 'ASSEMBLY' });
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(body(`${PREFIX}-V2`))
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠지고 includeInactive 로 보인다', async () => {
    const { id, etag } = await create(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/processes/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const ids = async (suffix: string): Promise<number[]> => {
      const list = await request(app.getHttpServer())
        .get(`/api/mdm/processes?q=${PREFIX}-D${suffix}`)
        .set('Cookie', cookie)
        .expect(200);
      const validate = validator('GET /mdm/processes');
      expect(validate(list.body)).toBe(true);
      return list.body.items.map((p: { processId: number }) => p.processId);
    };
    expect(await ids('')).not.toContain(id);
    expect(await ids('&includeInactive=true')).toContain(id);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/processes/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⛔ 없는 공정은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/processes/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function body(processCode: string): object {
    // 실재하는 코드 값을 쓴다 — 시드 PROCESS_TYPE(MACHINING·ASSEMBLY·INSPECTION·PACKAGING).
    return { processCode, processName: processCode, processTypeCode: 'MACHINING' };
  }

  async function detailOf(
    id: number,
  ): Promise<{ etag: string; editability: Record<string, unknown> }> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/processes/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: detail.headers.etag, editability: detail.body.editability };
  }

  async function create(processCode: string): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/processes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(processCode))
      .expect(201);
    return { id: created.body.processId, etag: (await detailOf(created.body.processId)).etag };
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
    await prisma.cause_code.deleteMany({ where: { cause_code: { startsWith: PREFIX } } });
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
