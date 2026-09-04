/**
 * 공통코드 마스터. **쓰기 경로 전체**가 도는지 본다 — 권한·멱등·낙관적 잠금·ETag.
 * Phase 0 가 세운 것들이 도메인에서 실제로 맞물리는지가 이 검사의 뜻이다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const CONTRACTS_DIR = join(__dirname, '../contracts');

const LOGIN_ID = 'e2e-mdmcode-probe';
const NOPERM_ID = 'e2e-mdmcode-noperm';
const PASSWORD = '공통코드-검사-비밀번호';
const PREFIX = 'MDMCODE';
const ROLE = 'E2E_MDMCODE';

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

describe('공통코드 마스터 (e2e)', () => {
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
      data: { login_id: LOGIN_ID, user_name: '코드검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⛔ 권한 없는 쪽은 «다른 사용자»여야 한다. 세션은 요청마다 DB 에서 다시 조립되므로
    // 같은 사용자의 옛 쿠키가 권한을 얼려 두지 않는다(그 성질은 아래 검사가 지킨다).
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: '코드검사용' },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-06' },
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
    await prisma.code_value.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await prisma.code_group.deleteMany({ where: { group_code: { startsWith: PREFIX } } });
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

  const key = () => randomUUID();

  async function createGroup(code = `${PREFIX}-G-${Date.now()}`): Promise<{ id: number; etag: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ groupCode: code, groupName: '검사그룹' })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/code-groups/${created.body.codeGroupId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { id: created.body.codeGroupId, etag: detail.headers.etag };
  }

  it('⛔ 권한이 없으면 쓰기가 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ groupCode: `${PREFIX}-DENY`, groupName: 'x' })
      .expect(403);
  });

  it('⛔ 그룹코드가 공백만이면 400 이다 — 계약이 「공백만 불가」로 적었다', async () => {
    const rejected = await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ groupCode: '  ', groupName: '공백만' })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'groupCode', code: 'REQUIRED' });
  });

  it('⭐ 등록하고, 상세가 계약 스키마와 ETag 를 준다', async () => {
    const { id, etag } = await createGroup(`${PREFIX}-A`);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/code-groups/${id}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/code-groups/{codeGroupId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(etag).toMatch(/^\d+$/);
    // ⛔ 값이 «하나도 없는» 갓 만든 그룹인데도 잠긴다. FK 로 세면 0 이지만, 그 0 은
    // 「값이 몇 개인가」이지 「그룹 코드 글자를 쓰는 곳이 어딘가」가 아니다.
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'NOT_COUNTABLE',
      referenceCount: null,
    });
  });

  it('⭐ 그룹 코드 글자를 쓰는 곳은 계약 안에만 151곳이다 — 셀 수 없는 이유', () => {
    // 위 검사가 「왜」 그렇게 되어야 하는지를 계약 자신에서 확인한다. 이 숫자가 0 이
    // 되는 날이 오면 그때는 그룹을 셀 수 있는지 다시 따져야 한다.
    const literals = readdirSync(CONTRACTS_DIR)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => readFileSync(join(CONTRACTS_DIR, name), 'utf8').match(/codeGroupCode=[A-Z_]+/g) ?? []);

    expect(literals.length).toBeGreaterThan(100);
    // 이 리터럴들이 가리키는 그룹 코드를 바꾸면 그 호출은 조용히 빈 목록을 받는다.
    expect(new Set(literals).size).toBeGreaterThan(30);
  });

  it('⭐ 계약이 가리키는 코드 그룹은 전부 시드에 있다 — 없으면 화면이 빈 목록을 받는다', async () => {
    // GET /mdm/code-values?codeGroupCode=X 는 그룹이 없어도 404 가 아니라 빈 목록이다(필터라서).
    // 그래서 코드 사전에 있는 그룹이 시드에 빠지면 아무 검사도 못 잡는다 — 여기서 잡는다.
    const pointed = new Set(
      readdirSync(CONTRACTS_DIR)
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) =>
          [...readFileSync(join(CONTRACTS_DIR, name), 'utf8').matchAll(/codeGroupCode=([A-Z_]+)/g)].map(
            (m) => m[1],
          ),
        ),
    );
    const seeded = new Set(
      (await prisma.code_group.findMany({ where: { is_active: true }, select: { group_code: true } })).map(
        (g) => g.group_code,
      ),
    );
    const missing = [...pointed].filter((code) => !seeded.has(code)).sort();

    // ⚠ 둘은 시드가 옛 이름(DEPENDENCY_TYPE · FREQUENCY_INTERVAL_UOM)으로 갖고 있다 — PR D-4 가 개명한다.
    expect(missing).toEqual(['INSPECTION_FREQUENCY_INTERVAL_UOM', 'ROUTING_OPERATION_DEPENDENCY_TYPE']);
  });

  it('⛔ 코드 «값»의 참조는 셀 수 없다 — 174표 어디에도 FK 가 없다', async () => {
    const { id } = await createGroup(`${PREFIX}-NC`);
    const created = await request(app.getHttpServer())
      .post('/api/mdm/code-values')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ codeGroupId: id, code: `${PREFIX}-NC1`, codeName: '값' })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/code-values/${created.body.codeValueId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/code-values/{codeValueId}');
    expect(validate(detail.body)).toBe(true);
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'NOT_COUNTABLE',
      referenceCount: null,
    });
  });

  it('⛔ 시스템 소유 그룹의 값은 SYSTEM_OWNED 다', async () => {
    const group = await prisma.code_group.findFirstOrThrow({ where: { is_system_owned: true } });
    const value = await prisma.code_value.findFirstOrThrow({
      where: { code_group_id: group.code_group_id },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/code-values/${value.code_value_id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.editability.reason).toBe('SYSTEM_OWNED');
  });

  it('⭐ 수정이 If-Match 를 쓰고 새 ETag 를 준다', async () => {
    const { id, etag } = await createGroup(`${PREFIX}-B`);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/code-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ groupCode: `${PREFIX}-B`, groupName: '고친이름' })
      .expect(200);

    expect(updated.body.groupName).toBe('고친이름');
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const { id, etag } = await createGroup(`${PREFIX}-C`);
    await request(app.getHttpServer())
      .put(`/api/mdm/code-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ groupCode: `${PREFIX}-C`, groupName: '첫번째' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/code-groups/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ groupCode: `${PREFIX}-C`, groupName: '두번째' })
      .expect(409);

    expect(stale.body.conflictCause).toBe('user');
  });

  it('⭐ 같은 멱등키로 다시 보내면 두 번 만들지 않는다', async () => {
    const idem = key();
    const body = { groupCode: `${PREFIX}-IDEM`, groupName: '멱등' };

    const first = await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idem)
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idem)
      .send(body)
      .expect(201);

    expect(second.body.codeGroupId).toBe(first.body.codeGroupId);
    expect(
      await prisma.code_group.count({ where: { group_code: `${PREFIX}-IDEM` } }),
    ).toBe(1);
  });

  it('활성·비활성 전이가 돈다', async () => {
    const { id, etag } = await createGroup(`${PREFIX}-D`);

    const off = await request(app.getHttpServer())
      .post(`/api/mdm/code-groups/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const on = await request(app.getHttpServer())
      .post(`/api/mdm/code-groups/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', off.headers.etag)
      .expect(200);
    expect(on.body.isActive).toBe(true);
  });

  it('⛔ 시스템이 쓰는 그룹은 사용 중지할 수 없다', async () => {
    const systemGroup = await prisma.code_group.findFirstOrThrow({
      where: { is_system_owned: true },
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/code-groups/${systemGroup.code_group_id}`)
      .set('Cookie', cookie)
      .expect(200);

    const response = await request(app.getHttpServer())
      .post(`/api/mdm/code-groups/${systemGroup.code_group_id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', detail.headers.etag)
      // ⛔ 400 이다 — 「업무 규칙 위반(상태 잠김)은 409 가 아니라 400」(계약).
      .expect(400);

    expect(response.body.errors[0].code).toBe('STATE_LOCKED');
  });

  it('⭐ 코드 값을 다국어 명칭과 함께 등록한다 — 이번 마이그레이션이 연 자리', async () => {
    const { id } = await createGroup(`${PREFIX}-V`);

    const created = await request(app.getHttpServer())
      .post('/api/mdm/code-values')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        codeGroupId: id,
        code: `${PREFIX}-V1`,
        codeName: '값1',
        nameKo: '한국어',
        nameVi: 'Tiếng Việt',
        displayOrder: 10,
        effectiveFrom: '2026-09-02',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      nameKo: '한국어',
      nameVi: 'Tiếng Việt',
      effectiveFrom: '2026-09-02',
    });
  });

  it('그룹 코드로 값을 거른다 — 화면은 채번 식별자를 모른다 (G-32)', async () => {
    const { id } = await createGroup(`${PREFIX}-F`);
    await request(app.getHttpServer())
      .post('/api/mdm/code-values')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ codeGroupId: id, code: `${PREFIX}-F1`, codeName: '값' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/code-values?codeGroupCode=${PREFIX}-F`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].code).toBe(`${PREFIX}-F1`);
  });

  it('⭐ 권한은 요청마다 다시 푼다 — 회수하면 옛 쿠키로도 못 한다', async () => {
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const role = await prisma.role.findUniqueOrThrow({ where: { role_code: ROLE } });

    await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id, role_id: role.role_id } });
    await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ groupCode: `${PREFIX}-REVOKED`, groupName: 'x' })
      .expect(403);

    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    await request(app.getHttpServer())
      .post('/api/mdm/code-groups')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ groupCode: `${PREFIX}-RESTORED`, groupName: 'x' })
      .expect(201);
  });

  it('⛔ 없는 그룹은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/code-groups/99999999')
      .set('Cookie', cookie)
      .expect(404);
  });
});
