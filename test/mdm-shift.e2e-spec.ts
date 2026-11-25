/**
 * 교대 관리(W-06-26 · omf-all-around#318) — 등록·상세·수정·사용 중지·재사용을 실 DB 로 본다.
 * 유일 제약(공장·코드), 자정 넘김, 같은 시각 거절, 공장 데이터 범위, 낙관적 잠금, 기존 조회와의 호환.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `SHF${randomUUID().slice(0, 6)}`;
const PATH = '/api/mdm/shifts';
const HANOI = 'Asia/Ho_Chi_Minh';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('교대 관리 W-06-26 (e2e · omf-all-around#318)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ids: Record<string, bigint> = {};
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '교대법인', country_code: 'VN', timezone_code: HANOI },
    });
    ids.entity = entity.legal_entity_id;
    for (const key of ['P1', 'P2']) {
      const plant = await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${key}`, plant_name: `교대${key}`, timezone_code: HANOI },
      });
      ids[key] = plant.plant_id;
    }
    cookies.manager = await userWith('manager', ['W-06-26']);
    cookies.scoped = await userWith('scoped', ['W-06-26'], ids.P1);
    cookies.none = await userWith('none', []);
  });

  afterAll(async () => {
    const plants = { in: [ids.P1, ids.P2] };
    await prisma.shift.deleteMany({ where: { plant_id: plants } });
    const users = { app_user: { login_id: { startsWith: PREFIX } } };
    await prisma.idempotency_record.deleteMany({ where: users });
    await prisma.user_data_scope.deleteMany({ where: users });
    await prisma.user_role.deleteMany({ where: users });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_id: plants } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_id: ids.entity } });
    await app.close();
  });

  async function userWith(key: string, permissions: string[], plantId?: bigint): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${key}`, user_name: `교대 ${key}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${key}`, role_name: key } });
    for (const permission of permissions) await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    if (plantId !== undefined) await prisma.user_data_scope.create({ data: { app_user_id: user.app_user_id, plant_id: plantId } });
    return `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  }

  const send = (method: 'post' | 'put', path: string, body?: object, headers: Record<string, string> = {}, as = cookies.manager) => {
    let call = request(app.getHttpServer())[method](path).set('Cookie', as).set('Idempotency-Key', randomUUID());
    for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
    return call.send(body);
  };
  const detail = (shiftId: number) => request(app.getHttpServer()).get(`${PATH}/${shiftId}`).set('Cookie', cookies.manager);
  const create = (overrides: object = {}, as = cookies.manager) =>
    send('post', PATH, { plantId: Number(ids.P1), shiftCode: 'N', shiftName: '야간', startTime: '20:00:00', endTime: '08:00:00', ...overrides }, {}, as);

  let night: number;

  it('등록 — 자정 넘김은 서버가 시각으로 정하고 계약 모양으로 돌려준다', async () => {
    const created = await create().expect(201);
    expect(validator('/mdm/shifts', 'post', 201)(created.body)).toBe(true);
    expect(created.body).toMatchObject({ plantId: Number(ids.P1), shiftCode: 'N', startTime: '20:00:00', endTime: '08:00:00', crossesMidnight: true, isActive: true });
    night = created.body.shiftId;
    const day = await create({ shiftCode: 'D', shiftName: '주간', startTime: '08:00:00', endTime: '20:00:00' }).expect(201);
    expect(day.body.crossesMidnight).toBe(false);
  });

  it('같은 공장 같은 코드는 400 UNIQUE_VIOLATION, 다른 공장은 된다', async () => {
    const duplicate = await create({ shiftName: '중복' }).expect(400);
    expect(duplicate.body.errors[0]).toMatchObject({ code: 'UNIQUE_VIOLATION' });
    await create({ plantId: Number(ids.P2) }).expect(201);
  });

  it('시작과 종료가 같은 시각이면 등록·수정 모두 400 이다', async () => {
    const rejected = await create({ shiftCode: 'EQ', startTime: '08:00:00', endTime: '08:00:00' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'endTime', code: 'INVALID' });
    const current = await detail(night).expect(200);
    await send('put', `${PATH}/${night}`, { shiftName: '야간', startTime: '20:00:00', endTime: '20:00:00' }, { 'If-Match': current.headers.etag }).expect(400);
  });

  it('권한이 없으면 403, 데이터 범위 밖 공장이면 403 이다', async () => {
    await create({ shiftCode: 'X1' }, cookies.none).expect(403);
    await create({ plantId: Number(ids.P2), shiftCode: 'X2' }, cookies.scoped).expect(403);
    await create({ shiftCode: 'X3' }, cookies.scoped).expect(201);
  });

  it('수정 — ETag 로 잠그고, 낡은 ETag 는 409 다', async () => {
    const current = await detail(night).expect(200);
    expect(validator('/mdm/shifts/{shiftId}', 'get', 200)(current.body)).toBe(true);
    expect(current.body.editability).toMatchObject({ codeEditable: true, referenceCount: 0 });
    const updated = await send('put', `${PATH}/${night}`, { shiftName: '야간조', startTime: '21:00:00', endTime: '07:00:00' }, { 'If-Match': current.headers.etag }).expect(200);
    expect(updated.body).toMatchObject({ shiftName: '야간조', crossesMidnight: true });
    await send('put', `${PATH}/${night}`, { shiftName: '낡음', startTime: '21:00:00', endTime: '07:00:00' }, { 'If-Match': current.headers.etag }).expect(409);
  });

  it('사용 중지하면 기본 조회에서 빠지고, 재사용하면 다시 나온다', async () => {
    const codes = async (query: object) =>
      (await request(app.getHttpServer()).get(PATH).query({ plantId: Number(ids.P1), ...query }).set('Cookie', cookies.manager).expect(200)).body.items.map(
        (shift: { shiftCode: string }) => shift.shiftCode,
      );
    let current = await detail(night).expect(200);
    const off = await send('post', `${PATH}/${night}:deactivate`, undefined, { 'If-Match': current.headers.etag }).expect(200);
    expect(off.body.isActive).toBe(false);
    expect(await codes({})).not.toContain('N');
    expect(await codes({ includeInactive: true })).toContain('N');
    /* 중지한 교대의 코드로 새로 등록할 수 없다 — 재사용이 되살리는 길이다. */
    await create({ shiftName: '새 야간' }).expect(400);

    current = await detail(night).expect(200);
    await send('post', `${PATH}/${night}:activate`, undefined, { 'If-Match': current.headers.etag }, cookies.none).expect(403);
    const on = await send('post', `${PATH}/${night}:activate`, undefined, { 'If-Match': current.headers.etag }).expect(200);
    expect(on.body.isActive).toBe(true);
    expect(await codes({})).toContain('N');
    await send('post', `${PATH}/${night}:activate`, undefined, { 'If-Match': current.headers.etag }).expect(409);
  });

  it('범위 밖 공장의 교대는 중지·재사용할 수 없다', async () => {
    const other = (await create({ plantId: Number(ids.P2), shiftCode: 'O' }).expect(201)).body.shiftId;
    const current = await detail(other).expect(200);
    await send('post', `${PATH}/${other}:deactivate`, undefined, { 'If-Match': current.headers.etag }, cookies.scoped).expect(403);
    await send('post', `${PATH}/${other}:activate`, undefined, { 'If-Match': current.headers.etag }, cookies.scoped).expect(403);
  });
});
