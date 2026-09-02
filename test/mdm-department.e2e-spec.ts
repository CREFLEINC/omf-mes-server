/**
 * 부서 마스터.
 *
 * 「무엇을 고칠 수 있는가」가 출처(`source_system_code`)로 갈리는 것이 이 검사의 뼈대다.
 * 같은 질문에 코드 그룹은 「항상 잠금」으로 답했고(#113), 부서는 세어서 답한다.
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

const LOGIN_ID = 'e2e-mdmdept-probe';
const NOPERM_ID = 'e2e-mdmdept-noperm';
const PASSWORD = '부서-마스터-검사-비밀번호';
const PREFIX = 'MDMDEPT';
const ROLE = 'E2E_MDMDEPT';

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

describe('부서 마스터 (e2e)', () => {
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
      data: { login_id: LOGIN_ID, user_name: '부서검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '부서검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-06' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/departments?size=5')
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/departments');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⛔ 권한이 없으면 쓰기가 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/departments')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ departmentCode: `${PREFIX}-X`, departmentName: '거부' })
      .expect(403);
  });

  it('⭐ 등록하면 참조가 0이라 코드 칸이 열린다 — B-4', async () => {
    const { id, etag } = await createDepartment(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/departments/{departmentId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    expect(detail.body.department.sourceSystemCode).toBe('MES');
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 부서 코드는 계약 어디서도 «글자»로 불리지 않는다 — 그래서 셀 수 있다', () => {
    // 코드 그룹은 계약이 codeGroupCode=<리터럴> 로 151곳에서 부르는 탓에 셀 수 없었다(#113).
    // 부서가 그 판정과 갈리는 근거가 이 0 이다. 0 이 아니게 되면 부서도 다시 따져야 한다.
    const contract = readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8');
    expect(contract.match(/departmentCode=/g)).toBeNull();
  });

  it('⭐ 자식 부서가 붙으면 REFERENCED 로 잠긴다 — 역할을 가리지 않고 센다', async () => {
    const parent = await createDepartment(`${PREFIX}-P`);
    await createDepartment(`${PREFIX}-C`, { parentDepartmentId: parent.id });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${parent.id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'REFERENCED',
      referenceCount: 1,
    });
  });

  it('⛔ ERP 수신본은 고칠 수 없다 — RECEIVED_FROM_ERP', async () => {
    const { id } = await createDepartment(`${PREFIX}-ERP`);
    // ERP 연계가 서기 전이라 출처를 MES 밖에서 넣을 길이 없다. 연계가 넣을 값을 흉내낸다.
    await prisma.department.update({
      where: { department_id: id },
      data: { source_system_code: 'ERP' },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'RECEIVED_FROM_ERP',
      referenceCount: null,
    });

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/departments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.headers.etag)
      .send({ departmentCode: `${PREFIX}-ERP`, departmentName: '덮어쓰기 시도' })
      // ⛔ 400 이다 — 「업무 규칙 위반(상태 잠김)은 409 가 아니라 400」(계약).
      .expect(400);
    expect(rejected.body.errors[0].code).toBe('STATE_LOCKED');

    // 중지도 막는다 — 물리 삭제가 없으므로 중지가 곧 삭제 자리다.
    await request(app.getHttpServer())
      .post(`/api/mdm/departments/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.headers.etag)
      .expect(400);
  });

  it('⛔ 부서 계층에 순환을 만들 수 없다 — ck_department_parent 는 자기 자신만 막는다', async () => {
    const a = await createDepartment(`${PREFIX}-CY-A`);
    const b = await createDepartment(`${PREFIX}-CY-B`, { parentDepartmentId: a.id });

    // A 의 상위를 B 로 두면 A→B→A 가 된다. DB 제약은 이것을 통과시킨다.
    const current = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${a.id}`)
      .set('Cookie', cookie)
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/departments/${a.id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .send({
        departmentCode: `${PREFIX}-CY-A`,
        departmentName: '순환',
        parentDepartmentId: b.id,
      })
      .expect(400);

    expect(rejected.body.errors).toEqual([
      {
        scope: 'field',
        field: 'parentDepartmentId',
        code: 'INVALID',
        message: expect.any(String),
      },
    ]);
  });

  it('⭐ 수정이 If-Match 를 쓰고, 낡은 값은 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await createDepartment(`${PREFIX}-V`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/departments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ departmentCode: `${PREFIX}-V`, departmentName: '고친 이름', nameVi: 'Ten moi' })
      .expect(200);

    expect(updated.body.departmentName).toBe('고친 이름');
    expect(updated.body.nameVi).toBe('Ten moi');
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/departments/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ departmentCode: `${PREFIX}-V`, departmentName: '뒤늦게' })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('중지·재개가 돌고, 중지된 것은 기본 목록에서 빠진다', async () => {
    const { id, etag } = await createDepartment(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/departments/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/departments?q=${PREFIX}-D`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((d: { departmentId: number }) => d.departmentId)).not.toContain(id);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/departments/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⭐ 같은 멱등키로 다시 보내면 두 번 만들지 않는다', async () => {
    const idempotencyKey = key();
    const body = { departmentCode: `${PREFIX}-IDEM`, departmentName: '멱등' };

    const first = await request(app.getHttpServer())
      .post('/api/mdm/departments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/mdm/departments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(201);

    expect(second.body.departmentId).toBe(first.body.departmentId);
    expect(
      await prisma.department.count({ where: { department_code: `${PREFIX}-IDEM` } }),
    ).toBe(1);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function createDepartment(
    departmentCode: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/departments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ departmentCode, departmentName: departmentCode, ...extra })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${created.body.departmentId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.departmentId, etag: detail.headers.etag };
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
    // 자식 → 부모 순으로 지운다. parent_department_id 가 FK 다.
    await prisma.department.deleteMany({
      where: { department_code: { startsWith: PREFIX }, NOT: { parent_department_id: null } },
    });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
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
