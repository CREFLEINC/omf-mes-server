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

const PREFIX = 'E2E-DPA';
const WRITER = 'E2E-DPA-W';

describe('부서 중지·되살리기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let writerToken: string;
  let businessUnitId: bigint;
  let plantId: bigint;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, [
      'MASTER_READ',
      'MASTER_ORGANIZATION_DEACTIVATE',
    ]));
    ({ token: writerToken } = await createUserWithPermissions(app, WRITER, [
      'MASTER_READ',
      'MASTER_ORGANIZATION_WRITE',
    ]));
    ({ businessUnitId, plantId } = await createOrganization(prisma, PREFIX));
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-member` } } });
    await deleteDepartments(prisma, PREFIX);
    await prisma.business_unit.update({
      where: { business_unit_id: businessUnitId },
      data: { is_active: true },
    });
  });

  afterAll(async () => {
    await deleteDepartments(prisma, PREFIX);
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await deleteUserWithPermissions(app, WRITER);
    await app.close();
  });

  /** 부서를 만들고 상세 조회로 ETag 를 받는다 — 화면이 버튼을 누르기 전에 하는 일이다. */
  async function given(
    options: { isActive?: boolean; parentDepartmentId?: bigint; withBusinessUnit?: boolean } = {},
  ): Promise<{ id: bigint; etag: string }> {
    counter += 1;
    const row = await prisma.department.create({
      data: {
        department_code: `${PREFIX}-${counter}`,
        department_name: 'e2e 부서',
        parent_department_id: options.parentDepartmentId ?? null,
        business_unit_id: options.withBusinessUnit ? businessUnitId : null,
        is_active: options.isActive ?? true,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${row.department_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: row.department_id, etag: detail.headers.etag };
  }

  function act(
    action: 'deactivate' | 'activate',
    id: bigint | number,
    options: { etag?: string; key?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .post(`/api/mdm/departments/${id}:${action}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', options.key ?? randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send();
  }

  describe('중지 — 안쪽을 본다', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 거짓이다', async () => {
      const { id, etag } = await given();

      const response = await act('deactivate', id, { etag }).expect(200);

      expect(response.body).toMatchObject({ departmentId: Number(id), isActive: false });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('사용 중인 하위 부서가 있으면 400 이다 — 아래에서부터 꺼야 한다', async () => {
      const parent = await given();
      await given({ parentDepartmentId: parent.id });

      const { body } = await act('deactivate', parent.id, { etag: parent.etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('하위 부서가 이미 중지되어 있으면 중지된다', async () => {
      const parent = await given();
      await given({ parentDepartmentId: parent.id, isActive: false });

      await act('deactivate', parent.id, { etag: parent.etag }).expect(200);
    });

    it('소속 사용자가 있으면 400 이다 — 소속 없는 사람이 생긴다', async () => {
      const { id, etag } = await given();
      await prisma.app_user.create({
        data: {
          login_id: `${PREFIX}-member-1`,
          user_name: '소속 인원',
          status_code: 'ACTIVE',
          department_id: id,
        },
      });

      const { body } = await act('deactivate', id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('소속 작업자가 있으면 400 이다', async () => {
      const { id, etag } = await given();
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}-W1`,
          worker_name: '소속 작업자',
          business_unit_id: businessUnitId,
          plant_id: plantId,
          status_code: 'ACTIVE',
          department_id: id,
        },
      });

      await act('deactivate', id, { etag }).expect(400);
    });

    it('사용자가 이미 중지되어 있으면 중지된다 — 살아 있는 것만 막는다', async () => {
      const { id, etag } = await given();
      await prisma.app_user.create({
        data: {
          login_id: `${PREFIX}-member-2`,
          user_name: '퇴사자',
          status_code: 'INACTIVE',
          department_id: id,
          is_active: false,
        },
      });

      // 참조 건수는 0 이 아니다 — 중지된 사용자도 이 부서를 가리킨다. 코드 편집을
      // 잠글 때 쓰는 그 값과 중지 판단이 다르다는 것을 여기서 못 박는다.
      const detail = await request(app.getHttpServer())
        .get(`/api/mdm/departments/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(detail.body.editability.referenceCount).toBeGreaterThan(0);

      await act('deactivate', id, { etag }).expect(200);
    });

    it('이미 중지된 부서는 400 이다', async () => {
      const { id, etag } = await given({ isActive: false });

      const { body } = await act('deactivate', id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });

    it('틀린 If-Match 면 409 다 — ConflictResponse', async () => {
      const { id, etag } = await given();

      const { body } = await act('deactivate', id, { etag: String(Number(etag) + 5) }).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });
  });

  describe('되살리기 — 위쪽을 본다', () => {
    it('맞는 If-Match 면 200 이고 isActive 가 참이다', async () => {
      const { id, etag } = await given({ isActive: false });

      const response = await act('activate', id, { etag }).expect(200);

      expect(response.body).toMatchObject({ departmentId: Number(id), isActive: true });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('상위 부서가 중지되어 있으면 400 이다 — 위에서부터 켜야 한다', async () => {
      const parent = await given({ isActive: false });
      const child = await given({ parentDepartmentId: parent.id, isActive: false });

      const { body } = await act('activate', child.id, { etag: child.etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('상위 부서가 살아 있으면 켜진다', async () => {
      const parent = await given();
      const child = await given({ parentDepartmentId: parent.id, isActive: false });

      await act('activate', child.id, { etag: child.etag }).expect(200);
    });

    it('사업부가 중지되어 있으면 400 이다', async () => {
      const { id, etag } = await given({ isActive: false, withBusinessUnit: true });
      await prisma.business_unit.update({
        where: { business_unit_id: businessUnitId },
        data: { is_active: false },
      });

      const { body } = await act('activate', id, { etag }).expect(400);

      expect(body.errors[0]).toMatchObject({ scope: 'screen', code: 'STATE_LOCKED' });
    });

    it('사업부가 없으면 사업부는 보지 않는다 — 부서는 사업부에 속하지 않을 수 있다', async () => {
      const { id, etag } = await given({ isActive: false });
      await prisma.business_unit.update({
        where: { business_unit_id: businessUnitId },
        data: { is_active: false },
      });

      await act('activate', id, { etag }).expect(200);
    });

    it('하위 부서는 함께 켜지지 않는다 — 끌 때 하나씩 껐다', async () => {
      const parent = await given({ isActive: false });
      const child = await given({ parentDepartmentId: parent.id, isActive: false });

      await act('activate', parent.id, { etag: parent.etag }).expect(200);

      const row = await prisma.department.findUniqueOrThrow({
        where: { department_id: child.id },
      });
      expect(row.is_active).toBe(false);
    });

    it('이미 사용 중인 부서는 400 이다', async () => {
      const { id, etag } = await given();

      const { body } = await act('activate', id, { etag }).expect(400);
      expect(body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
    });
  });

  describe('그 외', () => {
    it.each([['deactivate'], ['activate']])('%s — 없는 부서는 404 다', async (action) => {
      await act(action as 'deactivate' | 'activate', 999999999, { etag: '1' }).expect(404);
    });

    it.each([['deactivate'], ['activate']])('%s — If-Match 가 없으면 400 이다', async (action) => {
      const { id } = await given({ isActive: action === 'activate' });

      const { body } = await act(action as 'deactivate' | 'activate', id).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });

    it.each([['deactivate'], ['activate']])(
      '%s — MASTER_ORGANIZATION_WRITE 만 있으면 403 이다',
      async (action) => {
        const { id, etag } = await given({ isActive: action === 'activate' });

        await act(action as 'deactivate' | 'activate', id, {
          etag,
          bearer: writerToken,
        }).expect(403);
      },
    );

    it('같은 키로 재전송하면 저장된 200 을 받는다', async () => {
      const { id, etag } = await given();
      const key = randomUUID();

      const first = await act('deactivate', id, { etag, key }).expect(200);
      const second = await act('deactivate', id, { etag, key }).expect(200);

      expect(second.body).toEqual(first.body);
      expect(second.headers.etag).toBe(first.headers.etag);
    });

    it('감사 컬럼에 주체를 기록한다', async () => {
      const { id, etag } = await given();
      await act('deactivate', id, { etag }).expect(200);

      const row = await prisma.department.findUniqueOrThrow({ where: { department_id: id } });
      expect(row.updated_by).not.toBeNull();
    });
  });
});
