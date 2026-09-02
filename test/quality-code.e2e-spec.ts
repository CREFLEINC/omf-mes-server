/**
 * 불량코드·원인코드 2계층 마스터.
 *
 * ⭐ **DB 가 계층을 아무것도 막지 않는다** — 계약이 그것을 적었다(`ck_*_parent` 없음, #64).
 * 자기 자신·3계층·하위 있는 대분류에 상위 붙이기 셋을 서버가 막는지가 이 파일의 본체다.
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
import { CAUSE_CODE_REFERRERS } from '../src/quality/code/cause-code.service';
import { DEFECT_CODE_REFERRERS } from '../src/quality/code/defect-code.service';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-qcode-probe';
const NOPERM_ID = 'e2e-qcode-noperm';
const PASSWORD = '품질코드-검사-비밀번호';
const PREFIX = 'E2E_QCODE';
const ROLE = 'E2E_QCODE_ROLE';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const status = method === 'POST' && !path.includes(':') ? '201' : '200';
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('불량·원인코드 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let processId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '품질코드검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '품질코드검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-03' },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    cookie = await login();

    processId = Number(
      (
        await prisma.process.create({
          data: {
            process_code: `${PREFIX}-PR`,
            process_name: '검사공정',
            process_type_code: 'ASSEMBLY',
          },
        })
      ).process_id,
    );
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 참조 목록이 DB 의 FK 와 정확히 같다 — 두 표 모두', async () => {
    for (const [table, referrers] of [
      ['defect_code', DEFECT_CODE_REFERRERS],
      ['cause_code', CAUSE_CODE_REFERRERS],
    ] as const) {
      const rows = await prisma.$queryRawUnsafe<{ table: string; column: string }[]>(
        `
        SELECT n.nspname || '.' || r.relname AS "table",
               (SELECT a.attname FROM unnest(c.conkey) k
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS "column"
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.confrelid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        JOIN pg_class r ON r.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE c.contype = 'f' AND tn.nspname = 'quality' AND t.relname = $1
      `,
        table,
      );
      const actual = rows.map((row) => `${row.table}.${row.column}`).sort();
      expect(referrers.map(([t, c]) => `${t}.${c}`).sort()).toEqual(actual);
    }
  });

  // ── 불량코드 ────────────────────────────────────────────────────────────

  it('목록·상세가 계약 스키마를 만족하고 상세가 ETag 를 준다', async () => {
    const major = await createDefect('D1');

    const list = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/defect-codes');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes/${major}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /quality/defect-codes/{defectCodeId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toBe('1');
    expect(detail.body.editability).toEqual({
      codeEditable: true,
      reason: 'EDITABLE',
      referenceCount: 0,
    });
  });

  it('⭐ 상세를 붙이면 대분류의 코드가 잠기고 parentDefectCodeId 로 걸러진다', async () => {
    const major = await createDefect('D2');
    const detail = await createDefect('D2A', major);

    const parent = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes/${major}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(parent.body.editability).toMatchObject({ reason: 'REFERENCED', referenceCount: 1 });

    const children = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes?parentDefectCodeId=${major}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(children.body.items.map((d: { defectCodeId: number }) => d.defectCodeId)).toEqual([
      detail,
    ]);
  });

  it('⭐⭐ 3계층을 서버가 막는다 — DB 에는 CHECK 자체가 없다', async () => {
    const major = await createDefect('D3');
    const detail = await createDefect('D3A', major);

    // 상세를 상위로 지정 → 3계층.
    const third = await request(app.getHttpServer())
      .post('/api/quality/defect-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        defectCode: `${PREFIX}-D3B`,
        defectName: '3계층 시도',
        parentDefectCodeId: detail,
      })
      .expect(400);
    expect(third.body.errors[0]).toMatchObject({
      field: 'parentDefectCodeId',
      code: 'INVALID',
    });
    expect(third.body.errors[0].message).toContain('2계층');
  });

  it('⭐ 자기 자신을 상위로 지정할 수 없다', async () => {
    const major = await createDefect('D4');

    const rejected = await request(app.getHttpServer())
      .put(`/api/quality/defect-codes/${major}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        defectCode: `${PREFIX}-D4`,
        defectName: '자기참조',
        parentDefectCodeId: major,
      })
      .expect(400);
    expect(rejected.body.errors[0].message).toContain('자기 자신');
  });

  it('⭐⭐ 하위가 있는 대분류에 상위를 붙일 수 없다 — 하위가 3계층이 된다', async () => {
    const major = await createDefect('D5');
    await createDefect('D5A', major);
    const other = await createDefect('D6');

    const rejected = await request(app.getHttpServer())
      .put(`/api/quality/defect-codes/${major}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        defectCode: `${PREFIX}-D5`,
        defectName: '하위 있는 대분류',
        parentDefectCodeId: other,
      })
      .expect(400);
    expect(rejected.body.errors[0].message).toContain('하위 코드가 있는');
  });

  it('⛔ 어휘 밖 처분구분·없는 공정·중복 코드는 400 이다', async () => {
    const badDisposition = await request(app.getHttpServer())
      .post('/api/quality/defect-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        defectCode: `${PREFIX}-DBAD`,
        defectName: '어휘 밖',
        dispositionTypeCode: '없는구분',
      })
      .expect(400);
    // 계약이 enum 을 못박아 계약 검증 가드가 거른다.
    expect(badDisposition.body.errors[0].code).toBe('INVALID');

    const noProcess = await request(app.getHttpServer())
      .post('/api/quality/defect-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ defectCode: `${PREFIX}-DNP`, defectName: '없는공정', processId: 999999999 })
      .expect(400);
    expect(noProcess.body.errors[0]).toMatchObject({ field: 'processId', code: 'INVALID' });

    await createDefect('DUP');
    const duplicated = await request(app.getHttpServer())
      .post('/api/quality/defect-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ defectCode: `${PREFIX}-DUP`, defectName: '중복' })
      .expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'defectCode',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['defectCode'],
    });
  });

  it('⭐ 처분구분과 다국어 명칭이 오간다', async () => {
    const id = await createDefect('D7');

    const saved = await request(app.getHttpServer())
      .put(`/api/quality/defect-codes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({
        defectCode: `${PREFIX}-D7`,
        defectName: 'Scratch',
        nameKo: '긁힘',
        nameVi: 'Tray xuoc',
        dispositionTypeCode: 'SCRAP',
        processId,
      })
      .expect(200);

    expect(saved.body).toMatchObject({
      nameKo: '긁힘',
      nameVi: 'Tray xuoc',
      dispositionTypeCode: 'SCRAP',
      processId,
    });
  });

  it('사용 중지·다시 사용이 목록 기본값을 가른다', async () => {
    const id = await createDefect('D8');

    await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${id}:deactivate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .expect(200);

    const defaults = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes?q=${PREFIX}-D8`)
      .set('Cookie', cookie)
      .expect(200);
    expect(defaults.body.items).toHaveLength(0);

    const included = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes?q=${PREFIX}-D8&includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);
    expect(included.body.items[0].isActive).toBe(false);

    await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${id}:activate`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '2')
      .expect(200);
  });

  // ── 불량코드-공정 매핑 ──────────────────────────────────────────────────

  it('⭐ 상세 코드에 공정을 매핑하고 해제한다 — 셀 토글', async () => {
    const major = await createDefect('M1');
    const detail = await createDefect('M1A', major);

    const added = await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ processId })
      .expect(201);
    const createValidate = validator('POST /quality/defect-codes/{defectCodeId}/processes');
    expect(createValidate(added.body)).toBe(true);
    expect(createValidate.errors ?? []).toEqual([]);
    // 화면 왕복을 없애려고 공정명을 함께 낸다(계약).
    expect(added.body.processName).toBe('검사공정');

    const list = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/defect-codes/{defectCodeId}/processes');
    expect(listValidate(list.body)).toBe(true);
    expect(list.body.items).toHaveLength(1);

    await request(app.getHttpServer())
      .delete(`/api/quality/defect-codes/${detail}/processes/${processId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(204);

    const cleared = await request(app.getHttpServer())
      .get(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .expect(200);
    expect(cleared.body.items).toEqual([]);
  });

  it('⛔ 대분류에는 매핑할 수 없다 — 전사 고정 축이다', async () => {
    const major = await createDefect('M2');

    const rejected = await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${major}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ processId })
      .expect(400);
    expect(rejected.body.errors[0].message).toContain('대분류');
  });

  it('⛔ 같은 공정을 두 번 매핑하면 409 이고 봉투는 ErrorResponse 다', async () => {
    const major = await createDefect('M3');
    const detail = await createDefect('M3A', major);
    await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ processId })
      .expect(201);

    const again = await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ processId })
      .expect(409);
    // ⛔ 이 자리만 다르다 — 계약이 409 를 `ErrorResponse` 로 선언한 둘 중 하나다.
    // 저장 충돌이 아니라 「같은 항목이 이미 있다」라 `conflictCause` 가 없다.
    expect(again.body.errors[0]).toMatchObject({
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['defectCodeId', 'processId'],
    });
    expect(again.body).not.toHaveProperty('conflictCause');
  });

  it('⛔ 없는 공정·없는 매핑은 400·404 다', async () => {
    const major = await createDefect('M4');
    const detail = await createDefect('M4A', major);

    const noProcess = await request(app.getHttpServer())
      .post(`/api/quality/defect-codes/${detail}/processes`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ processId: 999999999 })
      .expect(400);
    expect(noProcess.body.errors[0]).toMatchObject({ field: 'processId', code: 'INVALID' });

    await request(app.getHttpServer())
      .delete(`/api/quality/defect-codes/${detail}/processes/${processId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .expect(404);

    await request(app.getHttpServer())
      .get('/api/quality/defect-codes/999999999/processes')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 원인코드 ────────────────────────────────────────────────────────────

  it('⭐ 원인코드가 같은 규칙으로 선다 — 계층 셋을 똑같이 막는다', async () => {
    const major = await createCause('C1');
    const detail = await createCause('C1A', major);

    const list = await request(app.getHttpServer())
      .get(`/api/quality/cause-codes?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /quality/cause-codes');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const one = await request(app.getHttpServer())
      .get(`/api/quality/cause-codes/${major}`)
      .set('Cookie', cookie)
      .expect(200);
    const oneValidate = validator('GET /quality/cause-codes/{causeCodeId}');
    expect(oneValidate(one.body)).toBe(true);
    expect(one.body.editability).toMatchObject({ reason: 'REFERENCED', referenceCount: 1 });

    // 3계층
    const third = await request(app.getHttpServer())
      .post('/api/quality/cause-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ causeCode: `${PREFIX}-C1B`, causeName: '3계층', parentCauseCodeId: detail })
      .expect(400);
    expect(third.body.errors[0].message).toContain('2계층');

    // 자기 자신
    const self = await request(app.getHttpServer())
      .put(`/api/quality/cause-codes/${major}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ causeCode: `${PREFIX}-C1`, causeName: '자기참조', parentCauseCodeId: major })
      .expect(400);
    expect(self.body.errors[0].message).toContain('자기 자신');
  });

  it('⛔ 낡은 If-Match 는 409 이고 봉투는 ConflictResponse 다', async () => {
    const id = await createCause('C2');
    await request(app.getHttpServer())
      .put(`/api/quality/cause-codes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ causeCode: `${PREFIX}-C2`, causeName: '한 번' })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/quality/cause-codes/${id}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ causeCode: `${PREFIX}-C2`, causeName: '두 번' })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 권한이 없으면 쓰기가 403 이고, 없는 코드는 404 다', async () => {
    for (const resource of ['defect-codes', 'cause-codes'] as const) {
      await request(app.getHttpServer())
        .post(`/api/quality/${resource}`)
        .set('Cookie', noPermCookie)
        .set('Idempotency-Key', key())
        .send(
          resource === 'defect-codes'
            ? { defectCode: `${PREFIX}-X`, defectName: '막힘' }
            : { causeCode: `${PREFIX}-X`, causeName: '막힘' },
        )
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/quality/${resource}/999999999`)
        .set('Cookie', cookie)
        .expect(404);
    }
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function createDefect(suffix: string, parentDefectCodeId?: number): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/defect-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        defectCode: `${PREFIX}-${suffix}`,
        defectName: suffix,
        ...(parentDefectCodeId === undefined ? {} : { parentDefectCodeId }),
      })
      .expect(201);
    const validate = validator('POST /quality/defect-codes');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.defectCodeId;
  }

  async function createCause(suffix: string, parentCauseCodeId?: number): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/quality/cause-codes')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        causeCode: `${PREFIX}-${suffix}`,
        causeName: suffix,
        ...(parentCauseCodeId === undefined ? {} : { parentCauseCodeId }),
      })
      .expect(201);
    const validate = validator('POST /quality/cause-codes');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body.causeCodeId;
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
    const mapped = await prisma.defect_code.findMany({
      where: { defect_code: { startsWith: PREFIX } },
      select: { defect_code_id: true },
    });
    await prisma.defect_code_process.deleteMany({
      where: { defect_code_id: { in: mapped.map((row) => row.defect_code_id) } },
    });
    // 상세가 대분류를 가리키므로 자식부터 지운다.
    await prisma.defect_code.deleteMany({
      where: { defect_code: { startsWith: PREFIX }, parent_defect_code_id: { not: null } },
    });
    await prisma.defect_code.deleteMany({ where: { defect_code: { startsWith: PREFIX } } });
    await prisma.cause_code.deleteMany({
      where: { cause_code: { startsWith: PREFIX }, parent_cause_code_id: { not: null } },
    });
    await prisma.cause_code.deleteMany({ where: { cause_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });

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
