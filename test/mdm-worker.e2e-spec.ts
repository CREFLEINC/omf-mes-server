import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { deleteDepartments } from './support/department.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-WKR';
const READER = 'E2E-WKR-R';

describe('작업자 · 자격 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let businessUnitId: bigint;
  let plantId: bigint;
  let departmentId: bigint;
  let processId: bigint;
  let workerId: bigint;
  let otherWorkerId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, [
      'MASTER_READ',
      'MASTER_ORGANIZATION_WRITE',
    ]));
    ({ token: readerToken } = await createUserWithPermissions(app, READER, ['MASTER_READ']));
    ({ businessUnitId, plantId } = await createOrganization(prisma, PREFIX));

    departmentId = (
      await prisma.department.create({
        data: { department_code: `${PREFIX}-D1`, department_name: 'e2e 부서' },
      })
    ).department_id;

    processId = (
      await prisma.process.create({
        data: {
          process_code: `${PREFIX}-PR`,
          process_name: 'e2e 조립공정',
          process_type_code: 'ASSEMBLY',
        },
      })
    ).process_id;

    const worker = async (suffix: string, overrides: Record<string, unknown> = {}) =>
      (
        await prisma.worker.create({
          data: {
            worker_no: `${PREFIX}-${suffix}`,
            worker_name: `e2e 작업자 ${suffix}`,
            business_unit_id: businessUnitId,
            plant_id: plantId,
            status_code: 'ACTIVE',
            ...overrides,
          },
        })
      ).worker_id;

    workerId = await worker('01', { department_id: departmentId });
    otherWorkerId = await worker('02');
    await worker('03', { is_active: false });
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await prisma.worker_qualification.deleteMany({
      where: { worker_id: { in: [workerId, otherWorkerId] } },
    });
  });

  afterAll(async () => {
    await prisma.worker_qualification.deleteMany({
      where: { worker_id: { in: [workerId, otherWorkerId] } },
    });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await deleteDepartments(prisma, PREFIX);
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/workers${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function put(
    body: Record<string, unknown>,
    options: { id?: bigint | number; bearer?: string } = {},
  ) {
    return request(app.getHttpServer())
      .put(`/api/mdm/workers/${options.id ?? workerId}/qualifications`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  const qualification = (overrides: Record<string, unknown> = {}) => ({
    qualificationTypeCode: 'WELDING',
    validFrom: '2026-01-01',
    ...overrides,
  });

  describe('목록', () => {
    it('계약 봉투로 내려온다', async () => {
      const { body } = await get(`?q=${PREFIX}`).expect(200);

      expect(body.items).toHaveLength(2);
      expect(body.page).toEqual({ page: 1, size: 50, total: 2 });
    });

    it('성명으로도 검색된다 — 코드만 보면 화면에서 못 찾는다', async () => {
      // 검색어는 **성명에만** 있어야 한다. `q=E2E-WKR` 은 사번에도 걸린다.
      expect(`${PREFIX}-`).not.toContain('작업자');

      const { body } = await get('?q=작업자').expect(200);

      expect(body.items.length).toBeGreaterThan(0);
      expect(
        body.items.every(
          (row: { workerName: string; workerNo: string }) =>
            row.workerName.includes('작업자') && !row.workerNo.includes('작업자'),
        ),
      ).toBe(true);
    });

    it.each([
      ['departmentId', () => departmentId],
      ['plantId', () => plantId],
      ['businessUnitId', () => businessUnitId],
    ])('%s 로 거른다', async (field, value) => {
      const { body } = await get(`?q=${PREFIX}&${field}=${value()}`).expect(200);

      expect(body.items.length).toBeGreaterThan(0);
    });

    it('부서 필터가 실제로 좁힌다 — 소속 없는 작업자는 빠진다', async () => {
      const { body } = await get(`?q=${PREFIX}&departmentId=${departmentId}`).expect(200);

      expect(body.items.map((row: { workerNo: string }) => row.workerNo)).toEqual([`${PREFIX}-01`]);
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const { body } = await get(`?q=${PREFIX}&includeInactive=true`).expect(200);

      expect(body.items).toHaveLength(3);
    });
  });

  describe('상세 — 읽기 전용', () => {
    it('{worker, editability} 로 감싸 내린다', async () => {
      const { body } = await get(`/${workerId}`).expect(200);

      expect(Object.keys(body).sort()).toEqual(['editability', 'worker']);
      expect(body.worker.workerNo).toBe(`${PREFIX}-01`);
    });

    it('언제나 RECEIVED_FROM_ERP 다 — 테이블 전체가 수신본이다', async () => {
      const { body } = await get(`/${workerId}`).expect(200);

      expect(body.editability).toEqual({
        codeEditable: false,
        reason: 'RECEIVED_FROM_ERP',
        referenceCount: null,
      });
    });

    it('없는 작업자는 404 다', async () => {
      await get('/999999999').expect(404);
    });

    it.each([['put'], ['post']])('%s 로 작업자를 바꾸는 경로가 없다 — 404 다', async (method) => {
      await request(app.getHttpServer())
        [method as 'put' | 'post'](`/api/mdm/workers/${workerId}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ workerName: '고치기' })
        .expect(404);
    });
  });

  describe('자격 — 전체 치환', () => {
    it('안 보낸 행은 지워진다', async () => {
      await put({
        qualifications: [
          qualification(),
          qualification({ validFrom: '2026-06-01' }),
          qualification({ validFrom: '2026-09-01' }),
        ],
      }).expect(200);

      const { body } = await put({
        qualifications: [qualification(), qualification({ validFrom: '2026-09-01' })],
      }).expect(200);

      expect(body.items.map((row: { validFrom: string }) => row.validFrom)).toEqual([
        '2026-01-01',
        '2026-09-01',
      ]);
    });

    it('빈 배열을 보내면 전부 지워진다', async () => {
      await put({ qualifications: [qualification()] }).expect(200);

      const { body } = await put({ qualifications: [] }).expect(200);

      expect(body.items).toEqual([]);
    });

    it('다른 작업자의 자격은 건드리지 않는다', async () => {
      await put({ qualifications: [qualification()] }, { id: otherWorkerId }).expect(200);

      await put({ qualifications: [] }).expect(200);

      const { body } = await get(`/${otherWorkerId}/qualifications`).expect(200);
      expect(body.items).toHaveLength(1);
    });

    it('만든 값이 그대로 내려온다', async () => {
      const { body } = await put({
        qualifications: [
          qualification({
            processId: Number(processId),
            certificateNo: 'CERT-1',
            validTo: '2026-12-31',
            certifiedBy: 7,
          }),
        ],
      }).expect(200);

      expect(body.items[0]).toMatchObject({
        workerId: Number(workerId),
        qualificationTypeCode: 'WELDING',
        processId: Number(processId),
        certificateNo: 'CERT-1',
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        certifiedBy: 7,
      });
    });

    it('공정을 비우면 (전체 공정)이다 — processId 가 null', async () => {
      const { body } = await put({ qualifications: [qualification()] }).expect(200);

      expect(body.items[0].processId).toBeNull();
    });

    it('공정을 비운 것과 null 로 보낸 것이 같은 자리다 — COALESCE(process_id, 0)', async () => {
      await put({ qualifications: [qualification()] }).expect(200);

      const { body } = await put({
        qualifications: [qualification(), qualification({ processId: null })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({
        field: '[1].qualificationTypeCode',
        code: 'RANGE',
      });

      // 검증에서 걸렸으므로 기존 행이 살아 있어야 한다.
      const kept = await get(`/${workerId}/qualifications`).expect(200);
      expect(kept.body.items).toHaveLength(1);
    });

    it('공정이 다르면 같은 자격을 둘 수 있다', async () => {
      const { body } = await put({
        qualifications: [qualification(), qualification({ processId: Number(processId) })],
      }).expect(200);

      expect(body.items).toHaveLength(2);
    });

    it('종료일이 시작일보다 앞서면 400 이다', async () => {
      const { body } = await put({
        qualifications: [qualification({ validTo: '2025-12-31' })],
      }).expect(400);

      expect(body.errors[0]).toMatchObject({ field: '[0].validTo', code: 'RANGE' });
    });

    it('없는 공정이면 400 이다', async () => {
      await put({ qualifications: [qualification({ processId: 999999999 })] }).expect(400);
    });

    it('날짜에 시각을 붙이면 400 이다 — @db.Date 다', async () => {
      await put({ qualifications: [qualification({ validFrom: '2026-01-01T00:00:00Z' })] }).expect(
        400,
      );
    });

    it('상한을 넘기면 400 이다', async () => {
      const day = (index: number) =>
        new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
      const qualifications = Array.from({ length: 501 }, (_, index) =>
        qualification({ validFrom: day(index) }),
      );
      expect(new Set(qualifications.map((row) => row.validFrom)).size).toBe(501);

      await put({ qualifications }).expect(400);
    });

    it('없는 작업자는 404 다', async () => {
      await put({ qualifications: [] }, { id: 999999999 }).expect(404);
    });

    it('MASTER_READ 만 있으면 403 이다', async () => {
      await put({ qualifications: [] }, { bearer: readerToken }).expect(403);
    });
  });

  it('토큰이 없으면 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/mdm/workers').expect(401);
  });
});
