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

const PREFIX = 'E2E-DPW';
const READER = 'E2E-DPW-R';

describe('부서 등록·수정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let readerToken: string;
  let businessUnitId: bigint;
  let counter = 0;

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
    ({ businessUnitId } = await createOrganization(prisma, PREFIX));
  });

  afterEach(async () => {
    await prisma.idempotency_record.deleteMany({});
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
    await deleteUserWithPermissions(app, READER);
    await app.close();
  });

  function code(): string {
    counter += 1;

    return `${PREFIX}-${counter}`;
  }

  function payload(overrides: Record<string, unknown> = {}) {
    return { departmentCode: code(), departmentName: '생산본부', ...overrides };
  }

  function post(body: Record<string, unknown>, options: { bearer?: string } = {}) {
    return request(app.getHttpServer())
      .post('/api/mdm/departments')
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

  function put(
    id: bigint | number,
    body: Record<string, unknown>,
    options: { etag?: string; bearer?: string } = {},
  ) {
    const req = request(app.getHttpServer())
      .put(`/api/mdm/departments/${id}`)
      .set('Authorization', `Bearer ${options.bearer ?? token}`)
      .set('Idempotency-Key', randomUUID());

    if (options.etag !== undefined) req.set('If-Match', options.etag);

    return req.send(body);
  }

  /** 만들고 상세 조회로 ETag 를 받는다 — 화면이 편집 전에 하는 일 그대로다. */
  async function given(parentDepartmentId?: bigint): Promise<{
    id: bigint;
    etag: string;
    code: string;
  }> {
    const departmentCode = code();
    const row = await prisma.department.create({
      data: {
        department_code: departmentCode,
        department_name: '기존 부서',
        parent_department_id: parentDepartmentId ?? null,
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/departments/${row.department_id}`)
      .set('Authorization', `Bearer ${token}`);

    return { id: row.department_id, etag: detail.headers.etag, code: departmentCode };
  }

  describe('등록', () => {
    it('만들면 201 이고 계약 모양으로 내려온다', async () => {
      const body = payload();

      const response = await post(body).expect(201);

      expect(response.body).toMatchObject({
        departmentCode: body.departmentCode,
        departmentName: '생산본부',
        parentDepartmentId: null,
        businessUnitId: null,
        isActive: true,
      });
    });

    it('사업부 없이 만들 수 있다 — 부서는 사업부에 속하지 않을 수 있다', async () => {
      const { body } = await post(payload()).expect(201);

      expect(body.businessUnitId).toBeNull();
    });

    it('사업부를 붙여 만들 수 있다', async () => {
      const { body } = await post(
        payload({ businessUnitId: Number(businessUnitId) }),
      ).expect(201);

      expect(body.businessUnitId).toBe(Number(businessUnitId));
    });

    it('없는 사업부면 400 이다', async () => {
      const { body } = await post(payload({ businessUnitId: 999999999 })).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'businessUnitId', code: 'RANGE' });
    });

    it('중지된 사업부에는 둘 수 없다', async () => {
      await prisma.business_unit.update({
        where: { business_unit_id: businessUnitId },
        data: { is_active: false },
      });

      const { body } = await post(
        payload({ businessUnitId: Number(businessUnitId) }),
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'businessUnitId', code: 'STATE_LOCKED' });
    });

    it('같은 코드면 400 UNIQUE_VIOLATION 이다 — 부서 코드는 전역 유일이다', async () => {
      const first = payload();
      await post(first).expect(201);

      const { body } = await post({ ...first, departmentName: '중복' }).expect(400);

      expect(body.errors[0]).toMatchObject({
        field: 'departmentCode',
        code: 'UNIQUE_VIOLATION',
        uniqueScope: ['departmentCode'],
      });
    });

    it('없는 상위 부서를 지정하면 400 이다', async () => {
      const { body } = await post(payload({ parentDepartmentId: 999999999 })).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentDepartmentId', code: 'RANGE' });
    });

    it('상위 부서를 붙여 만들 수 있다', async () => {
      const parent = await given();

      const { body } = await post(payload({ parentDepartmentId: Number(parent.id) })).expect(201);

      expect(body.parentDepartmentId).toBe(Number(parent.id));
    });

    it('MASTER_READ 만 있으면 403 이다', async () => {
      await post(payload(), { bearer: readerToken }).expect(403);
    });
  });

  describe('수정 — 계층 재배치', () => {
    it('자기 자신을 상위로 지정하면 400 이다', async () => {
      const { id, etag, code: departmentCode } = await given();

      const { body } = await put(
        id,
        { departmentCode, departmentName: 'x', parentDepartmentId: Number(id) },
        { etag },
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentDepartmentId', code: 'RANGE' });
    });

    it('자기 자식을 상위로 지정하면 400 이다 — A→B→A', async () => {
      const parent = await given();
      const child = await given(parent.id);

      const { body } = await put(
        parent.id,
        {
          departmentCode: parent.code,
          departmentName: 'x',
          parentDepartmentId: Number(child.id),
        },
        { etag: parent.etag },
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'parentDepartmentId', code: 'RANGE' });
    });

    it('손자를 상위로 지정해도 400 이다 — A→B→C→A 도 순환이다', async () => {
      const a = await given();
      const b = await given(a.id);
      const c = await given(b.id);

      await put(
        a.id,
        { departmentCode: a.code, departmentName: 'x', parentDepartmentId: Number(c.id) },
        { etag: a.etag },
      ).expect(400);
    });

    it('형제를 상위로 지정하는 것은 순환이 아니다', async () => {
      const parent = await given();
      const one = await given(parent.id);
      const two = await given(parent.id);

      const { body } = await put(
        two.id,
        { departmentCode: two.code, departmentName: 'x', parentDepartmentId: Number(one.id) },
        { etag: two.etag },
      ).expect(200);

      expect(body.parentDepartmentId).toBe(Number(one.id));
    });

    it('상위를 떼어 최상위로 올릴 수 있다', async () => {
      const parent = await given();
      const child = await given(parent.id);

      const { body } = await put(
        child.id,
        { departmentCode: child.code, departmentName: 'x' },
        { etag: child.etag },
      ).expect(200);

      expect(body.parentDepartmentId).toBeNull();
    });

    it.each([['등록'], ['수정']])(
      '이미 순환이 든 계층 아래에는 %s 도 막는다',
      async (mode) => {
        // 마이그레이션이나 손질로 이미 A→B→A 가 들어간 상황. ck_department_parent 는
        // 자기 자신만 막으므로 이 상태가 DB 에 들어갈 수 있다.
        const a = await given();
        const b = await given(a.id);
        await prisma.$executeRaw`
          UPDATE mdm.department SET parent_department_id = ${b.id} WHERE department_id = ${a.id}
        `;

        try {
          if (mode === '등록') {
            const { body } = await post(payload({ parentDepartmentId: Number(a.id) })).expect(400);
            expect(body.errors[0]).toMatchObject({ field: 'parentDepartmentId', code: 'RANGE' });
          } else {
            const target = await given();
            const { body } = await put(
              target.id,
              {
                departmentCode: target.code,
                departmentName: 'x',
                parentDepartmentId: Number(a.id),
              },
              { etag: target.etag },
            ).expect(400);
            expect(body.errors[0]).toMatchObject({ field: 'parentDepartmentId', code: 'RANGE' });
          }
        } finally {
          await prisma.$executeRaw`
            UPDATE mdm.department SET parent_department_id = NULL WHERE department_id = ${a.id}
          `;
        }
      },
    );
  });

  describe('수정 — 그 외', () => {
    it('맞는 If-Match 면 200 이고 ETag 가 오른다', async () => {
      const { id, etag, code: departmentCode } = await given();

      const response = await put(
        id,
        { departmentCode, departmentName: '고친 이름' },
        { etag },
      ).expect(200);

      expect(response.body).toMatchObject({ departmentName: '고친 이름' });
      expect(Number(response.headers.etag)).toBe(Number(etag) + 1);
    });

    it('틀린 If-Match 면 409 다 — ConflictResponse', async () => {
      const { id, etag, code: departmentCode } = await given();

      const { body } = await put(
        id,
        { departmentCode, departmentName: 'x' },
        { etag: String(Number(etag) + 5) },
      ).expect(409);

      expect(body).toMatchObject({ conflictCause: 'user' });
      expect(body.errors).toBeUndefined();
    });

    it('isActive 를 보내면 400 이다 — 이 경로로 못 바꾼다', async () => {
      const { id, etag, code: departmentCode } = await given();

      await put(id, { departmentCode, departmentName: 'x', isActive: false }, { etag }).expect(400);
    });

    it('사업부를 바꿀 수 있다 — 조직 개편이 그것이다', async () => {
      const { id, etag, code: departmentCode } = await given();

      const { body } = await put(
        id,
        { departmentCode, departmentName: 'x', businessUnitId: Number(businessUnitId) },
        { etag },
      ).expect(200);

      expect(body.businessUnitId).toBe(Number(businessUnitId));
    });

    it('안 보낸 사업부는 지워진다 — 전체 교체다', async () => {
      const { id, code: departmentCode } = await given();
      await prisma.department.update({
        where: { department_id: id },
        data: { business_unit_id: businessUnitId },
      });
      const refreshed = await request(app.getHttpServer())
        .get(`/api/mdm/departments/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const { body } = await put(
        id,
        { departmentCode, departmentName: 'x' },
        { etag: refreshed.headers.etag },
      ).expect(200);

      expect(body.businessUnitId).toBeNull();
    });

    it('쓰이고 있으면 코드를 바꿀 수 없다 — 상세가 잠갔다고 한 것을 쓰기도 지킨다', async () => {
      const parent = await given();
      await given(parent.id);

      const { body } = await put(
        parent.id,
        { departmentCode: `${parent.code}-NEW`, departmentName: 'x' },
        { etag: parent.etag },
      ).expect(400);

      expect(body.errors[0]).toMatchObject({ field: 'departmentCode', code: 'STATE_LOCKED' });
    });

    it('쓰이고 있어도 이름은 고칠 수 있다 — 잠그는 것은 코드뿐이다', async () => {
      const parent = await given();
      await given(parent.id);

      await put(
        parent.id,
        { departmentCode: parent.code, departmentName: '이름만 변경' },
        { etag: parent.etag },
      ).expect(200);
    });

    it('아무도 안 쓰면 코드를 바꿀 수 있다', async () => {
      const { id, etag, code: departmentCode } = await given();

      const { body } = await put(
        id,
        { departmentCode: `${departmentCode}-NEW`, departmentName: 'x' },
        { etag },
      ).expect(200);

      expect(body.departmentCode).toBe(`${departmentCode}-NEW`);
    });

    it('If-Match 가 없으면 400 이다', async () => {
      const { id, code: departmentCode } = await given();

      const { body } = await put(id, { departmentCode, departmentName: 'x' }).expect(400);
      expect(body.errors[0]).toMatchObject({ field: 'If-Match', code: 'REQUIRED' });
    });

    it('없는 부서는 404 다', async () => {
      await put(999999999, { departmentCode: 'X', departmentName: 'x' }, { etag: '1' }).expect(404);
    });
  });
});
