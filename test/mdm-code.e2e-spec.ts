import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { createUserWithPermissions, deleteUserWithPermissions } from './support/auth.fixture';

const PREFIX = 'E2E-CD';

describe('코드그룹 · 코드값 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let groupId: bigint;
  let otherGroupId: bigint;
  let tieGroupId: bigint;
  let valueId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    ({ token } = await createUserWithPermissions(app, PREFIX, ['MASTER_READ']));

    const group = async (suffix: string) =>
      (
        await prisma.code_group.create({
          data: { group_code: `${PREFIX}-${suffix}`, group_name: `e2e 그룹 ${suffix}` },
        })
      ).code_group_id;

    groupId = await group('G1');
    otherGroupId = await group('G2');
    tieGroupId = await group('G3');

    valueId = (
      await prisma.code_value.create({
        data: {
          code_group_id: groupId,
          code: 'ALPHA',
          code_name: '알파',
          display_order: 10,
          effective_from: new Date('2026-08-07T00:00:00.000Z'),
        },
      })
    ).code_value_id;
    await prisma.code_value.create({
      data: { code_group_id: groupId, code: 'BETA', code_name: '베타', display_order: 20 },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: groupId,
        code: 'GAMMA',
        code_name: '감마',
        display_order: 30,
        is_active: false,
      },
    });
    await prisma.code_value.create({
      data: { code_group_id: otherGroupId, code: 'ALPHA', code_name: '다른 그룹의 알파' },
    });
    // display_order 에는 유일 제약이 없다 — 동점만 모은 그룹으로 페이지 안정성을 본다.
    for (const code of ['TIE-B', 'TIE-A', 'TIE-C']) {
      await prisma.code_value.create({
        data: { code_group_id: tieGroupId, code, code_name: `동점 ${code}`, display_order: 5 },
      });
    }
  });

  afterAll(async () => {
    await prisma.code_value.deleteMany({
      where: { code_group: { group_code: { startsWith: PREFIX } } },
    });
    await prisma.code_group.deleteMany({ where: { group_code: { startsWith: PREFIX } } });
    await deleteUserWithPermissions(app, PREFIX);
    await app.close();
  });

  function get(path: string) {
    return request(app.getHttpServer())
      .get(`/api/mdm/${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  describe('인덱스', () => {
    it.each([['mdm.code_group'], ['mdm.code_value']])(
      '%s 를 가리키는 모든 FK 컬럼에 쓸 수 있는 인덱스가 있다',
      async (target) => {
        const uncovered = await prisma.$queryRawUnsafe<{ key: string }[]>(
          `SELECT n.nspname || '.' || t.relname || '.' || a.attname AS key
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           JOIN unnest(c.conkey) AS k(attnum) ON true
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           WHERE c.contype = 'f' AND c.confrelid = $1::regclass
             AND NOT EXISTS (
               SELECT 1 FROM pg_index x
               WHERE x.indrelid = c.conrelid AND x.indkey[0] = a.attnum AND x.indpred IS NULL
             )`,
          target,
        );

        expect(uncovered.map((r) => r.key)).toEqual([]);
      },
    );

    it('code_value 를 FK 로 가리키는 곳이 하나도 없다 — NOT_COUNTABLE 의 근거다', async () => {
      // 이 전제가 깨지면(누군가 FK 를 걸면) 셀 수 있게 되므로 판정을 다시 봐야 한다.
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'mdm.code_value'::regclass
      `;

      expect(Number(rows[0].count)).toBe(0);
    });
  });

  describe('코드그룹', () => {
    it('목록이 계약 봉투로 내려온다', async () => {
      const { body } = await get(`code-groups?q=${PREFIX}`).expect(200);

      expect(body.items).toHaveLength(3);
      expect(body.page).toEqual({ page: 1, size: 50, total: 3 });
      expect(Object.keys(body.items[0]).sort()).toEqual([
        'codeGroupId',
        'description',
        'groupCode',
        'groupName',
        'isActive',
      ]);
    });

    it('상세가 {codeGroup, editability} 로 감싸 내려온다', async () => {
      const { body } = await get(`code-groups/${groupId}`).expect(200);

      expect(Object.keys(body).sort()).toEqual(['codeGroup', 'editability']);
      expect(body.codeGroup.groupCode).toBe(`${PREFIX}-G1`);
    });

    it('값이 있어도 NOT_COUNTABLE 이다 — 세는 것은 값 개수이지 코드 글자를 쓰는 곳이 아니다', async () => {
      const { body } = await get(`code-groups/${groupId}`).expect(200);

      expect(body.editability).toEqual({
        codeEditable: false,
        reason: 'NOT_COUNTABLE',
        referenceCount: null,
      });
    });

    it('ETag 헤더에 version_no 를 싣는다 — 본문에는 없다', async () => {
      const response = await get(`code-groups/${groupId}`).expect(200);
      const row = await prisma.code_group.findUniqueOrThrow({
        where: { code_group_id: groupId },
      });

      expect(response.headers.etag).toBe(String(row.version_no));
      expect(JSON.stringify(response.body)).not.toContain('version');
    });

    it('없는 코드그룹은 404 다', async () => {
      await get('code-groups/999999999').expect(404);
    });
  });

  describe('코드값', () => {
    it('codeGroupId 를 안 보내면 400 이다 — 그룹을 고른 뒤에 본다', async () => {
      await get('code-values').expect(400);
    });

    it('그 그룹의 코드값만 나온다', async () => {
      const { body } = await get(`code-values?codeGroupId=${groupId}`).expect(200);

      expect(body.items.map((v: { code: string }) => v.code)).toEqual(['ALPHA', 'BETA']);
    });

    it('다른 그룹에 같은 코드가 있어도 섞이지 않는다 — uq_code_value 는 그룹 안에서만이다', async () => {
      const { body } = await get(`code-values?codeGroupId=${otherGroupId}`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].codeName).toBe('다른 그룹의 알파');
    });

    it('기본은 사용 중인 것만 — includeInactive 로 켠다', async () => {
      const { body } = await get(
        `code-values?codeGroupId=${groupId}&includeInactive=true`,
      ).expect(200);

      expect(body.items).toHaveLength(3);
    });

    it('displayOrder 차례로 내려온다 — 화면에 보이는 순서다', async () => {
      const { body } = await get(
        `code-values?codeGroupId=${groupId}&includeInactive=true`,
      ).expect(200);

      expect(body.items.map((v: { displayOrder: number }) => v.displayOrder)).toEqual([10, 20, 30]);
    });

    it('display_order 가 같으면 code 로 차례가 정해진다 — 유일 제약이 없어 동점이 생긴다', async () => {
      const { body } = await get(`code-values?codeGroupId=${tieGroupId}`).expect(200);

      expect(body.items.map((v: { code: string }) => v.code)).toEqual(['TIE-A', 'TIE-B', 'TIE-C']);
    });

    it('동점이 있어도 페이지를 넘길 때 같은 행이 두 번 나오지 않는다', async () => {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const { body } = await get(
          `code-values?codeGroupId=${tieGroupId}&size=1&page=${page}`,
        ).expect(200);
        seen.push(body.items[0].code);
      }

      expect(new Set(seen).size).toBe(3);
    });

    it('코드·코드명으로 검색된다', async () => {
      const { body } = await get(`code-values?codeGroupId=${groupId}&q=베타`).expect(200);

      expect(body.items).toHaveLength(1);
      expect(body.items[0].code).toBe('BETA');
    });

    it('유효기간 날짜가 밀리지 않는다 — @db.Date 는 타임존을 태우지 않는다', async () => {
      const { body } = await get(`code-values/${valueId}`).expect(200);

      expect(body.codeValue.effectiveFrom).toBe('2026-08-07');
      expect(body.codeValue.effectiveTo).toBeNull();
    });

    it('언제나 NOT_COUNTABLE 이다 — FK 가 하나도 없어 셀 수 없다', async () => {
      const { body } = await get(`code-values/${valueId}`).expect(200);

      expect(body.editability).toEqual({
        codeEditable: false,
        reason: 'NOT_COUNTABLE',
        referenceCount: null,
      });
    });

    it('없는 코드값은 404 다', async () => {
      await get('code-values/999999999').expect(404);
    });
  });

  describe('만들지 않은 것', () => {
    it.each([
      ['post', '/api/mdm/code-groups'],
      ['post', '/api/mdm/code-values'],
      ['put', '/api/mdm/code-groups/1'],
      ['put', '/api/mdm/code-values/1'],
      ['post', '/api/mdm/code-groups/1:deactivate'],
      ['post', '/api/mdm/code-values/1:deactivate'],
    ])('%s %s 는 404 다 — 공통코드는 배포로만 바뀐다', async (method, path) => {
      // 계약에 있으나 만들지 않기로 한 6개. 나중에 누가 슬쩍 열면 여기서 걸린다.
      await request(app.getHttpServer())
        [method as 'post' | 'put'](path)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(404);
    });
  });

  it('토큰이 없으면 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/mdm/code-groups').expect(401);
  });
});
