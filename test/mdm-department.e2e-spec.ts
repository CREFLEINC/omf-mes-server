import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DEPARTMENT_REFERENCES } from '../src/mdm/department/department.references';
import { referenceKey } from '../src/mdm/reference-count';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';
import { createOrganization, deleteOrganization } from './support/organization.fixture';

const PREFIX = 'E2E-DEP';

describe('부서 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let businessUnitId: bigint;
  let rootId: bigint;
  let childId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_READ']));
    ({ businessUnitId } = await createOrganization(prisma, PREFIX));

    rootId = (
      await prisma.department.create({
        data: { department_code: `${PREFIX}-01`, department_name: '생산본부' },
      })
    ).department_id;

    childId = (
      await prisma.department.create({
        data: {
          department_code: `${PREFIX}-02`,
          department_name: '제조1팀',
          parent_department_id: rootId,
          business_unit_id: businessUnitId,
        },
      })
    ).department_id;

    await prisma.department.create({
      data: { department_code: `${PREFIX}-03`, department_name: '폐지된팀', is_active: false },
    });
  });

  afterAll(async () => {
    // 자식이 부모를 가리키므로 깊은 것부터 지운다.
    await prisma.department.deleteMany({ where: { parent_department_id: { not: null } } });
    await prisma.department.deleteMany({ where: { department_code: { startsWith: PREFIX } } });
    await deleteOrganization(prisma, PREFIX);
    await deleteUserWithPermissions(app, PREFIX);
    await app.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/departments${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  describe('참조 목록', () => {
    it('손으로 적은 7개가 정본 물리 모델의 외래키와 일치한다', async () => {
      const rows = await prisma.$queryRaw<{ key: string }[]>`
        SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f' AND c.confrelid = 'mdm.department'::regclass
      `;

      expect(rows.map((r) => r.key).sort()).toEqual(DEPARTMENT_REFERENCES.map(referenceKey).sort());
    });

    it('mdm.department 를 가리키는 모든 FK 컬럼에 쓸 수 있는 인덱스가 있다', async () => {
      // 부서는 7개 전부 비어 있었다 — 자기참조 컬럼조차 없었다.
      const uncovered = await prisma.$queryRaw<{ key: string }[]>`
        SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'f' AND c.confrelid = 'mdm.department'::regclass
          AND NOT EXISTS (
            SELECT 1 FROM pg_index x
            WHERE x.indrelid = c.conrelid AND x.indkey[0] = a.attnum AND x.indpred IS NULL
          )
      `;

      expect(uncovered.map((r) => r.key)).toEqual([]);
    });
  });

  describe('목록', () => {
    it('사업부를 안 골라도 나온다 — 부서는 사업부에 속하지 않을 수 있다', async () => {
      const { body } = await get(`?q=${PREFIX}`).expect(200);

      expect(body.items).toHaveLength(2);
      expect(body.page).toEqual({ page: 1, size: 50, total: 2 });
    });

    it('사업부로 거르면 그 사업부 것만 나온다', async () => {
      const { body } = await get(`?q=${PREFIX}&businessUnitId=${businessUnitId}`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].departmentName).toBe('제조1팀');
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const { body } = await get(`?q=${PREFIX}&includeInactive=true`).expect(200);

      expect(body.items).toHaveLength(3);
    });

    it('부서코드·부서명으로 검색된다', async () => {
      const { body } = await get('?q=제조1팀').expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].departmentCode).toBe(`${PREFIX}-02`);
    });

    it('페이지를 넘겨도 같은 행이 두 번 나오지 않는다', async () => {
      const first = await get(`?q=${PREFIX}&size=1&page=1`).expect(200);
      const second = await get(`?q=${PREFIX}&size=1&page=2`).expect(200);

      expect(first.body.items[0].departmentId).not.toBe(second.body.items[0].departmentId);
    });

    it('size 상한을 넘기면 400 이다', async () => {
      await get('?size=1000000').expect(400);
    });
  });

  describe('상세', () => {
    it('{department, editability} 로 감싸 내린다', async () => {
      const { body } = await get(`/${childId}`).expect(200);

      expect(Object.keys(body).sort()).toEqual(['department', 'editability']);
      expect(body.department.departmentName).toBe('제조1팀');
      expect(body.department.parentDepartmentId).toBe(Number(rootId));
    });

    it('사업부가 없으면 null 이다', async () => {
      const { body } = await get(`/${rootId}`).expect(200);

      expect(body.department.businessUnitId).toBeNull();
    });

    it('ETag 헤더에 version_no 를 싣는다 — 본문에는 없다(공유계약 A-4)', async () => {
      const response = await get(`/${childId}`).expect(200);
      const row = await prisma.department.findUniqueOrThrow({
        where: { department_id: childId },
      });

      expect(response.headers.etag).toBe(String(row.version_no));
      expect(JSON.stringify(response.body)).not.toContain('version');
    });

    it('아무도 안 쓰는 부서는 코드를 고칠 수 있다', async () => {
      const { body } = await get(`/${childId}`).expect(200);

      expect(body.editability).toEqual({
        codeEditable: true,
        reason: 'EDITABLE',
        referenceCount: 0,
      });
    });

    it('하위 부서를 가지면 코드가 잠긴다 — parent_department_id 도 참조다', async () => {
      const { body } = await get(`/${rootId}`).expect(200);

      expect(body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
      expect(body.editability.referenceCount).toBeGreaterThan(0);
    });

    it('없는 부서는 404 다', async () => {
      await get('/999999999').expect(404);
    });
  });

  it('토큰이 없으면 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/mdm/departments').expect(401);
  });
});
