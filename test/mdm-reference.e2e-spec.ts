/**
 * 조회 전용 기준정보 7종. 응답이 **계약 스키마를 만족하는지**를 계약 원본으로 판정한다 —
 * 손으로 기대값을 적으면 계약이 바뀐 순간 조용히 드리프트한다.
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

const LOGIN_ID = 'e2e-mdmref-probe';
const PASSWORD = '기준정보-검사-비밀번호';
const PREFIX = 'MDMREF';

/**
 * 계약 원본에서 그 경로의 200 응답 스키마를 꺼낸다.
 *
 * ⛔ 인라인 스키마를 «그대로» 컴파일하면 그 안의 `$ref: '#/components/...'` 가 문서가
 * 아니라 자기 자신을 기준으로 풀려 안 잡힌다. 문서를 통째로 등록하고 JSON 포인터로
 * 가리킨다 — `#94` 의 검증기와 같은 방식이다.
 */
function responseValidator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('기준정보 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ENDPOINTS: [string, string][] = [
    ['GET /mdm/uoms', '/api/mdm/uoms'],
    ['GET /mdm/legal-entities', '/api/mdm/legal-entities'],
    ['GET /mdm/business-units', '/api/mdm/business-units'],
    ['GET /mdm/plants', '/api/mdm/plants'],
    ['GET /mdm/production-lines', '/api/mdm/production-lines'],
    ['GET /mdm/processes', '/api/mdm/processes'],
    ['GET /mdm/shifts', '/api/mdm/shifts'],
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '기준정보검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    await prisma.production_line.create({
      data: {
        plant_id: plant.plant_id,
        line_code: `${PREFIX}-LN`,
        line_name: '검사라인',
        line_type_code: 'LINE',
      },
    });
    await prisma.process.create({
      data: {
        process_code: `${PREFIX}-PR`,
        process_name: '검사공정',
        process_type_code: 'ASSEMBLY',
      },
    });
    await prisma.shift.create({
      data: {
        plant_id: plant.plant_id,
        shift_code: `${PREFIX}-SH`,
        shift_name: '야간조',
        start_time: new Date('1970-01-01T22:00:00Z'),
        end_time: new Date('1970-01-01T06:00:00Z'),
        crosses_midnight: true,
      },
    });

    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = login.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    await prisma.shift.deleteMany({ where: { shift_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: { startsWith: PREFIX } },
    });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
  }

  it.each(ENDPOINTS)('⭐ %s 응답이 계약 스키마를 만족한다', async (operation, url) => {
    const response = await request(app.getHttpServer()).get(url).set('Cookie', cookie).expect(200);

    const validate = responseValidator(operation);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items.length).toBeGreaterThan(0);
  });

  it('계약 스키마 검증기가 실제로 거른다 — 위 검사가 헛통과가 아님을 보인다', () => {
    const validate = responseValidator('GET /mdm/uoms');

    expect(validate({ items: [{ uomId: 1 }], page: { page: 1, size: 50, total: 1 } })).toBe(false);
    expect(validate({ items: [] })).toBe(false);
  });

  it('⛔ 세션 없이는 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/mdm/uoms').expect(401);
  });

  it('q 가 코드·명칭을 찾는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/plants?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].plantCode).toBe(`${PREFIX}-P`);
  });

  it('FK 필터가 걸린다', async () => {
    const all = await request(app.getHttpServer())
      .get('/api/mdm/plants')
      .set('Cookie', cookie)
      .expect(200);
    const target = all.body.items.find((x: { plantCode: string }) => x.plantCode === `${PREFIX}-P`);

    const filtered = await request(app.getHttpServer())
      .get(`/api/mdm/business-units?legalEntityId=${target.legalEntityId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(filtered.body.items.every((x: { legalEntityId: number }) => x.legalEntityId === target.legalEntityId)).toBe(true);
  });

  it('기본은 쓰는 것만 준다 — includeInactive 로 넓힌다', async () => {
    await prisma.process.updateMany({
      where: { process_code: `${PREFIX}-PR` },
      data: { is_active: false },
    });

    const active = await request(app.getHttpServer())
      .get(`/api/mdm/processes?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const all = await request(app.getHttpServer())
      .get(`/api/mdm/processes?q=${PREFIX}&includeInactive=true`)
      .set('Cookie', cookie)
      .expect(200);

    expect(active.body.items).toHaveLength(0);
    expect(all.body.items).toHaveLength(1);

    await prisma.process.updateMany({
      where: { process_code: `${PREFIX}-PR` },
      data: { is_active: true },
    });
  });

  it('⭐ 쪽이 계약 PageMeta 대로 돈다', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/mdm/uoms?page=1&size=2')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.page).toMatchObject({ page: 1, size: 2 });
    expect(response.body.items.length).toBeLessThanOrEqual(2);
    expect(response.body.page.total).toBeGreaterThanOrEqual(response.body.items.length);
  });

  it('⭐ 야간조 시각이 HH:MM:SS 로 나온다 — 계약이 time 을 문자열로 받는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/shifts?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items[0]).toMatchObject({
      startTime: '22:00:00',
      endTime: '06:00:00',
      crossesMidnight: true,
    });
  });
});
