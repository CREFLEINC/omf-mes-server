/**
 * 작업자 마스터.
 *
 * ⛔ 기본 정보는 **쓰기 경로가 없다** — 전부 ERP 수신본이다(W-06-06 §5-4). MES 가
 * 고치는 것은 다국어 명칭과 자격·인증 둘뿐이고, 그 둘만 여기서 돈다.
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

const LOGIN_ID = 'e2e-mdmworker-probe';
const NOPERM_ID = 'e2e-mdmworker-noperm';
const PASSWORD = '작업자-마스터-검사-비밀번호';
const PREFIX = 'MDMWORKER';
const ROLE = 'E2E_MDMWORKER';

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

describe('작업자 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let workerId: number;
  let plantId: bigint;
  let businessUnitId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '작업자검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '작업자검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-06' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 작업자는 «쓰기 경로가 없다» — ERP 수신본이라 계약에 등록 엔드포인트가 없다.
    // 검사 대상을 만들 길이 DB 뿐이고, 그 사실 자체가 이 자원의 성질이다.
    const plant = await prisma.plant.findFirstOrThrow();
    plantId = plant.plant_id;
    // plant.business_unit_id 는 nullable 이다 — 작업자 쪽은 NOT NULL 이라 직접 집는다.
    businessUnitId = (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`,
        worker_name: 'Nguyen Van A',
        business_unit_id: businessUnitId,
        plant_id: plantId,
        status_code: 'ACTIVE',
      },
    });
    workerId = Number(worker.worker_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });


  it('목록이 계약 스키마를 만족하고 사번으로 정확히 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/workers?workerNo=${PREFIX}-W1`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/workers');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].workerId).toBe(workerId);
  });

  it('⛔ 작업자 editability 는 항상 RECEIVED_FROM_ERP 다 — 계약이 고정했다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/workers/{workerId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'RECEIVED_FROM_ERP',
      referenceCount: null,
    });
    // ⚠ 계약이 이 자리에 ETag 를 선언하지 않았다. 붙이지 않으면 아래 다국어 편집의
    // If-Match 를 채울 값을 화면이 얻을 곳이 없다.
    expect(detail.headers.etag).toMatch(/^\d+$/);
  });

  it('⭐ 다국어 명칭만 고친다 — 원본 명칭은 그대로다 (QA #33·#34)', async () => {
    const before = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}`)
      .set('Cookie', cookie)
      .expect(200);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}:update-name-translation`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.headers.etag)
      .send({ nameKo: '응우옌반아', nameVi: 'Nguyen Van A' })
      .expect(200);

    expect(updated.body.nameKo).toBe('응우옌반아');
    expect(updated.body.workerName).toBe('Nguyen Van A');
    expect(Number(updated.headers.etag)).toBe(Number(before.headers.etag) + 1);
  });

  it('⭐ 자격을 통째로 치환한다 — ETag 축이 «작업자»의 version_no 다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/workers/{workerId}/qualifications');
    expect(validate(list.body)).toBe(true);
    // ⛔ 자식 표에 version_no 가 없다(계약이 그 사실을 적었다). 이 ETag 는 작업자의 것이다.
    const worker = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.headers.etag).toBe(worker.headers.etag);

    const replaced = await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', list.headers.etag)
      .send({
        qualifications: [
          { qualificationTypeCode: 'STANDARD', validFrom: '2026-01-01', validTo: '2026-12-31' },
          { qualificationTypeCode: 'SPECIAL', validFrom: '2026-03-01' },
        ],
      })
      .expect(200);

    expect(validate(replaced.body)).toBe(true);
    expect(replaced.body.items).toHaveLength(2);
    expect(Number(replaced.headers.etag)).toBe(Number(list.headers.etag) + 1);

    // 통째로 교체다 — 하나만 보내면 앞의 둘이 사라진다.
    const shrunk = await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', replaced.headers.etag)
      .send({ qualifications: [{ qualificationTypeCode: 'STANDARD', validFrom: '2026-02-01' }] })
      .expect(200);
    expect(shrunk.body.items).toHaveLength(1);
    expect(shrunk.body.items[0].validFrom).toBe('2026-02-01');
  });

  it('⭐ 같은 자격·공정이 두 줄이면 몇 번째 줄인지 짚는다 — uq 는 못 짚는다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', list.headers.etag)
      .send({
        qualifications: [
          { qualificationTypeCode: 'DUP', validFrom: '2026-01-01' },
          // process_id 를 비우면 uq 가 COALESCE(process_id,0) 으로 접어 같은 줄이 된다.
          { qualificationTypeCode: 'DUP', validFrom: '2026-05-01' },
        ],
      })
      .expect(400);

    expect(rejected.body.errors).toEqual([
      {
        scope: 'field',
        field: 'qualifications[1].qualificationTypeCode',
        code: 'UNIQUE_VIOLATION',
        uniqueScope: ['qualificationTypeCode', 'processId'],
        message: expect.any(String),
      },
    ]);
    // 거절됐으면 아무것도 지워지지 않아야 한다 — 교체는 한 트랜잭션이다.
    const after = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .expect(200);
    expect(after.body.items).toEqual(list.body.items);
    expect(after.headers.etag).toBe(list.headers.etag);
  });

  it('⛔ 만료일이 시작일보다 앞서면 PAIR 로 거른다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .expect(200);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', list.headers.etag)
      .send({
        qualifications: [
          { qualificationTypeCode: 'BAD', validFrom: '2026-06-01', validTo: '2026-01-01' },
        ],
      })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'qualifications[0].validTo',
      code: 'PAIR',
    });
  });

  it('⛔ 자격 편집은 권한을 본다 — 다국어 편집은 계약이 403 을 선언하지 않았다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', cookie)
      .expect(200);

    await request(app.getHttpServer())
      .put(`/api/mdm/workers/${workerId}/qualifications`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', list.headers.etag)
      .send({ qualifications: [] })
      .expect(403);
  });

  it('⛔ 없는 작업자는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/workers/999999999')
      .set('Cookie', cookie)
      .expect(404);
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
    const workers = await prisma.worker.findMany({
      where: { worker_no: { startsWith: PREFIX } },
      select: { worker_id: true },
    });
    await prisma.worker_qualification.deleteMany({
      where: { worker_id: { in: workers.map((w) => w.worker_id) } },
    });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
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
