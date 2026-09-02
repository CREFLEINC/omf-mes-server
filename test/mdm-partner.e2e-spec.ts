/**
 * 거래처와 판정유형 통제.
 *
 * 둘 다 「본체는 못 고치고 붙는 것만 고친다」는 형태다 — 거래처는 ERP 수신본이라 역할만,
 * 판정유형은 코드 값이 낳고 통제 속성만 얹힌다.
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

const LOGIN_ID = 'e2e-mdmpartner-probe';
const NOPERM_ID = 'e2e-mdmpartner-noperm';
const PASSWORD = '거래처-검사-비밀번호';
const PREFIX = 'MDMPARTNER';
const ROLE = 'E2E_MDMPARTNER';

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

describe('거래처·판정유형 통제 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let partnerId: number;
  let otherPartnerId: number;
  let judgmentValueId: number;
  let roleId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '거래처검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '거래처검사용' } });
    roleId = Number(role.role_id);
    for (const permission of ['W-06-06', 'W-06-04']) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: permission },
      });
    }
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 거래처는 ERP 수신본이라 등록 경로가 없다 — 검사 대상을 DB 로 세운다.
    partnerId = await createPartner(`${PREFIX}-P1`);
    otherPartnerId = await createPartner(`${PREFIX}-P2`);

    // 판정유형은 코드 값이 낳는다. 시드에 값이 없어 검사용으로 하나 세운다.
    const group = await prisma.code_group.findFirstOrThrow({
      where: { group_code: 'JUDGMENT_TYPE' },
    });
    const value = await prisma.code_value.create({
      data: {
        code_group_id: group.code_group_id,
        code: `${PREFIX}-HOLD`,
        code_name: '검사용 판정',
      },
    });
    judgmentValueId = Number(value.code_value_id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 거래처 ──────────────────────────────────────────────────────────────

  it('목록·상세가 계약 스키마를 만족한다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/partners?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /mdm/partners');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/partners/${partnerId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /mdm/partners/{partnerId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.body.partnerCode).toBe(`${PREFIX}-P1`);
  });

  it('⭐ 역할을 통째로 교체한다 — 목록에 없는 역할은 해제된다', async () => {
    const saved = await putRoles(partnerId, ['SUPPLIER', 'DISPOSAL']);
    const validate = validator('GET /mdm/partners/{partnerId}/roles');
    expect(validate(saved.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(saved.body.map((r: { roleTypeCode: string }) => r.roleTypeCode)).toEqual([
      'DISPOSAL',
      'SUPPLIER',
    ]);

    const shrunk = await putRoles(partnerId, ['SUPPLIER']);
    expect(shrunk.body).toEqual([{ roleTypeCode: 'SUPPLIER' }]);
  });

  it('⭐ 빈 배열이면 역할을 모두 해제한다', async () => {
    await putRoles(otherPartnerId, ['CUSTOMER']);
    const cleared = await putRoles(otherPartnerId, []);
    expect(cleared.body).toEqual([]);
  });

  it('⭐ 역할은 집합이라 중복을 접어 받는다', async () => {
    const saved = await putRoles(partnerId, ['SUPPLIER', 'SUPPLIER', 'CUSTOMER']);
    expect(saved.body).toHaveLength(2);
  });

  it('⛔ 어휘 밖 역할은 400 이다 — 계약이 enum 을 못박았다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/partners/${partnerId}/roles`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await roleEtag(partnerId))
      .send({ roleTypeCodes: ['없는역할'] })
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'INVALID' });
  });

  it('⭐ roleTypeCode 로 「공급사만」 고른다', async () => {
    await putRoles(partnerId, ['SUPPLIER']);
    await putRoles(otherPartnerId, ['CUSTOMER']);

    const suppliers = await request(app.getHttpServer())
      .get(`/api/mdm/partners?q=${PREFIX}&roleTypeCode=SUPPLIER`)
      .set('Cookie', cookie)
      .expect(200);

    const ids = suppliers.body.items.map((p: { partnerId: number }) => p.partnerId);
    expect(ids).toContain(partnerId);
    expect(ids).not.toContain(otherPartnerId);
  });

  it('⛔ 권한이 없으면 역할 저장이 403 이고, 낡은 If-Match 는 409 다', async () => {
    const stale = await roleEtag(partnerId);
    await request(app.getHttpServer())
      .put(`/api/mdm/partners/${partnerId}/roles`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', stale)
      .send({ roleTypeCodes: [] })
      .expect(403);

    await putRoles(partnerId, ['SUPPLIER']);
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/partners/${partnerId}/roles`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', stale)
      .send({ roleTypeCodes: [] })
      .expect(409);
    expect(rejected.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⛔ 없는 거래처는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/partners/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/mdm/partners/999999999/roles')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 판정유형 통제 ───────────────────────────────────────────────────────

  it('⭐ 통제 행이 없는 판정유형도 목록에 「전부 거짓」으로 나온다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/judgment-type-controls')
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/judgment-type-controls');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const mine = response.body.items.find(
      (c: { codeValueId: number }) => c.codeValueId === judgmentValueId,
    );
    // 판정유형은 code_value 가 낳는다 — 통제 행이 없어도 목록에서 빠지면 화면이 편집을
    // 시작할 자리를 잃는다.
    expect(mine).toMatchObject({
      blocksIssue: false,
      blocksShipment: false,
      blocksPicking: false,
      requiresApproval: false,
      versionNo: 1,
    });
  });

  it('⭐ 편집하면 통제 행이 생기고 버전이 오른다', async () => {
    const saved = await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${judgmentValueId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        blocksIssue: true,
        blocksShipment: true,
        blocksPicking: false,
        requiresApproval: true,
        approverRoleId: roleId,
        lotStatusCode: 'DEFECTIVE',
      })
      .expect(200);

    expect(saved.body.blocksIssue).toBe(true);
    expect(saved.body.approverRoleId).toBe(roleId);
    expect(saved.body.lotStatusCode).toBe('DEFECTIVE');

    const again = await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${judgmentValueId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', String(saved.body.versionNo))
      .send({
        blocksIssue: false,
        blocksShipment: false,
        blocksPicking: false,
        requiresApproval: false,
      })
      .expect(200);
    expect(again.body.versionNo).toBe(saved.body.versionNo + 1);
    expect(again.body.blocksIssue).toBe(false);
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${judgmentValueId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        blocksIssue: true,
        blocksShipment: false,
        blocksPicking: false,
        requiresApproval: false,
      })
      .expect(409);
    expect(rejected.body.errors[0].code).toBe('STALE_VERSION');
  });

  it('⛔ 마스터에 없는 Lot 상태·역할은 400 이다', async () => {
    const current = await currentControl();
    const badStatus = await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${judgmentValueId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', String(current.versionNo))
      .send({ ...flags(), lotStatusCode: '없는상태' })
      .expect(400);
    expect(badStatus.body.errors[0]).toMatchObject({ field: 'lotStatusCode', code: 'INVALID' });

    const badRole = await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${judgmentValueId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', String(current.versionNo))
      .send({ ...flags(), approverRoleId: 999999999 })
      .expect(400);
    expect(badRole.body.errors[0]).toMatchObject({ field: 'approverRoleId', code: 'INVALID' });
  });

  it('⛔ 판정유형이 아닌 코드 값에는 통제를 붙일 수 없다', async () => {
    const outsider = await prisma.code_value.findFirstOrThrow({
      where: { code_group: { group_code: 'LOT_STATUS' } },
    });

    await request(app.getHttpServer())
      .put(`/api/mdm/judgment-type-controls/${outsider.code_value_id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send(flags())
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function flags(): object {
    return {
      blocksIssue: false,
      blocksShipment: false,
      blocksPicking: false,
      requiresApproval: false,
    };
  }

  async function currentControl(): Promise<{ versionNo: number }> {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/judgment-type-controls')
      .set('Cookie', cookie)
      .expect(200);
    return response.body.items.find(
      (c: { codeValueId: number }) => c.codeValueId === judgmentValueId,
    );
  }

  async function roleEtag(id: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/partners/${id}/roles`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function putRoles(
    id: number,
    roleTypeCodes: string[],
  ): Promise<{ body: { roleTypeCode: string }[] }> {
    const response = await request(app.getHttpServer())
      .put(`/api/mdm/partners/${id}/roles`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', await roleEtag(id))
      .send({ roleTypeCodes })
      .expect(200);
    return { body: response.body };
  }

  async function createPartner(partnerCode: string): Promise<number> {
    const created = await prisma.partner.create({
      data: { partner_code: partnerCode, partner_name: partnerCode },
    });
    return Number(created.partner_id);
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
    const partners = await prisma.partner.findMany({
      where: { partner_code: { startsWith: PREFIX } },
      select: { partner_id: true },
    });
    await prisma.partner_role.deleteMany({
      where: { partner_id: { in: partners.map((p) => p.partner_id) } },
    });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    const values = await prisma.code_value.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { code_value_id: true },
    });
    await prisma.judgment_type_control.deleteMany({
      where: { code_value_id: { in: values.map((v) => v.code_value_id) } },
    });
    await prisma.code_value.deleteMany({ where: { code: { startsWith: PREFIX } } });
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
      await prisma.judgment_type_control.deleteMany({ where: { approver_role_id: role.role_id } });
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
