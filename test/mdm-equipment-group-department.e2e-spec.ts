/**
 * 라인(설비 그룹) 담당 부서 — 알림 부서 판정 기준(omf-all-around#160 · 장부 P-90).
 *
 * 노드 «자신»의 부서만 저장·응답한다. 상속 규칙은 부서 판정(생성기) 쪽 검사가 본다.
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

const LOGIN_ID = 'e2e-mdmgrpdept-probe';
const PASSWORD = '라인부서-검사-비밀번호';
const PREFIX = 'MDMGRPDEPT';
const ROLE = 'E2E_MDMGRPDEPT';

function validator(operation: string, status = 200): ValidateFunction {
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

describe('라인 담당 부서 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let plantId: number;
  let deptA: number;
  let deptB: number;
  let inactiveDept: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '라인부서검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '라인부서검사용' } });
    await prisma.role_permission.createMany({
      data: ['W-05-12', 'W-CO-05'].map((code) => ({ role_id: role.role_id, permission_code: code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    deptA = await makeDepartment('A', true);
    deptB = await makeDepartment('B', true);
    inactiveDept = await makeDepartment('X', false);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('US6-1 생성 때 담당 부서를 저장하고 응답에 부서 ID·이름이 있다', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(`${PREFIX}-L1`, { departmentId: deptA }))
      .expect(201);
    expect(created.body).toMatchObject({ departmentId: deptA, departmentName: `${PREFIX} 부서A` });

    const detail = await getGroup(created.body.equipmentGroupId);
    expect(detail.body.equipmentGroup).toMatchObject({ departmentId: deptA, departmentName: `${PREFIX} 부서A` });
    const validate = validator('GET /mdm/equipment-groups/{equipmentGroupId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('US6-1 수정에서 생략하면 유지, 다른 부서면 바뀌고, null 이면 해제한다', async () => {
    const id = await createGroup(`${PREFIX}-L2`, { departmentId: deptA });

    let saved = await update(id, {});
    expect(saved.body.departmentId).toBe(deptA);

    saved = await update(id, { departmentId: deptB });
    expect(saved.body).toMatchObject({ departmentId: deptB, departmentName: `${PREFIX} 부서B` });

    saved = await update(id, { departmentId: null });
    expect(saved.body).toMatchObject({ departmentId: null, departmentName: null });
  });

  it('US6-1 사용 중지되거나 없는 부서는 400 departmentId 다', async () => {
    for (const departmentId of [inactiveDept, 987654321]) {
      const rejected = await request(app.getHttpServer())
        .post('/api/mdm/equipment-groups')
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .send(body(`${PREFIX}-BAD`, { departmentId }))
        .expect(400);
      expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['departmentId']);
    }
    const id = await createGroup(`${PREFIX}-L3`);
    const etag = (await getGroup(id)).headers.etag;
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody(`${PREFIX}-L3`, { departmentId: inactiveDept }))
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['departmentId']);
  });

  it('US6-1 목록과 조회 전용 생산라인 목록에도 부서 ID·이름이 있다', async () => {
    await createGroup(`${PREFIX}-L4`, { departmentId: deptB });

    const groups = await request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups?q=${PREFIX}-L4`)
      .set('Cookie', cookie)
      .expect(200);
    expect(groups.body.items[0]).toMatchObject({ departmentId: deptB, departmentName: `${PREFIX} 부서B` });

    const lines = await request(app.getHttpServer())
      .get(`/api/mdm/production-lines?q=${PREFIX}-L4`)
      .set('Cookie', cookie)
      .expect(200);
    expect(lines.body.items[0]).toMatchObject({ departmentId: deptB, departmentName: `${PREFIX} 부서B` });
    const validate = validator('GET /mdm/production-lines');
    expect(validate(lines.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function updateBody(groupCode: string, extra: Record<string, unknown> = {}): object {
    return { groupCode, groupName: groupCode, groupTypeCode: 'LINE', ...extra };
  }

  function body(groupCode: string, extra: Record<string, unknown> = {}): object {
    return { plantId, ...updateBody(groupCode, extra) };
  }

  function getGroup(id: number): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);
  }

  async function createGroup(groupCode: string, extra: Record<string, unknown> = {}): Promise<number> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/equipment-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(body(groupCode, extra))
      .expect(201);
    return created.body.equipmentGroupId;
  }

  async function update(id: number, extra: Record<string, unknown>): Promise<request.Response> {
    const current = await getGroup(id);
    return request(app.getHttpServer())
      .put(`/api/mdm/equipment-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', current.headers.etag)
      .send(updateBody(current.body.equipmentGroup.groupCode, extra))
      .expect(200);
  }

  async function makeDepartment(suffix: string, isActive: boolean): Promise<number> {
    const row = await prisma.department.create({
      data: {
        department_code: `${PREFIX}-D${suffix}`,
        department_name: `${PREFIX} 부서${suffix}`,
        is_active: isActive,
      },
    });
    return Number(row.department_id);
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
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
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
