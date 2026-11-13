/**
 * 생산계획 근무일 판정 조회 (e2e) — `POST /planning/working-days:resolve`.
 *
 * 라인 캘린더 > 상위 라인 > 공장 캘린더(적용 층 순서, 고른 캘린더에 날짜가 없으면 내려가지 않는다) > 공장 근무일 정책 > 판정 불가.
 * ⚠ 이 시험 데이터로 «규칙»만 본다 — 실데이터 검증이 아니다.
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

const PREFIX = `E2E_WD_${randomUUID().slice(0, 8)}`;
const PATH = '/api/planning/working-days:resolve';

function resultValidator(): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: 'https://omf-mes.invalid/contract#/components/schemas/PlanningWorkingDayResolveResult' });
}

interface Day {
  date: string;
  statusCode: string;
  sourceCode: string;
  workCalendarId: number | null;
  appliedProductionLineId: number | null;
  reasonCode: string | null;
  remarks: string | null;
  startTime: string | null;
  endTime: string | null;
  weeklyWorkingDays: number | null;
}

describe('생산계획 근무일 판정 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let deniedCookie: string;
  let scopedCookie: string;
  const id: Record<string, bigint> = {};
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  const resolve = (targets: object[], session = cookie) =>
    request(app.getHttpServer()).post(PATH).set('Cookie', session).send({ targets });
  const daysOf = async (plant: bigint, line: bigint | null, from: string, to: string): Promise<Map<string, Day>> => {
    const response = await resolve([{ plantId: Number(plant), productionLineId: line === null ? null : Number(line), from, to }]).expect(200);
    return new Map((response.body.items[0].days as Day[]).map((day) => [day.date, day]));
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    const plant = async (suffix: string) => (await prisma.plant.create({
      data: { plant_code: `${PREFIX}_${suffix}`, plant_name: `${PREFIX} ${suffix}`, legal_entity_id: base.legal_entity_id, business_unit_id: base.business_unit_id, timezone_code: 'Asia/Ho_Chi_Minh' },
    })).plant_id;
    id.P = await plant('P');
    id.Q = await plant('Q');
    const line = async (code: string, plantId: bigint, parent: bigint | null = null) => (await prisma.production_line.create({
      data: { plant_id: plantId, line_code: `${PREFIX}_${code}`, line_name: code, parent_line_id: parent },
    })).production_line_id;
    id.PARENT = await line('PARENT', id.P);
    id.CHILD = await line('CHILD', id.P, id.PARENT);
    id.SIBLING = await line('SIBLING', id.P, id.PARENT);
    id.OFF = await line('OFF', id.P);
    id.Q_LINE = await line('QLINE', id.Q);

    const calendar = async (code: string, active = true) => (await prisma.work_calendar.create({
      data: { calendar_code: `${PREFIX}_${code}`, calendar_name: code, is_active: active },
    })).work_calendar_id;
    id.CAL_PLANT = await calendar('PLANT');
    id.CAL_PARENT = await calendar('PARENT');
    id.CAL_CHILD = await calendar('CHILD');
    id.CAL_OFF = await calendar('OFF', false);
    id.CAL_Q = await calendar('Q');
    const apply = (calendarId: bigint, type: string, target: bigint) => prisma.work_calendar_application.create({
      data: { work_calendar_id: calendarId, target_type_code: type, target_id: target, effective_from: new Date('2027-01-01') },
    });
    await apply(id.CAL_PLANT, 'PLANT', id.P);
    await apply(id.CAL_PARENT, 'EQUIPMENT_GROUP', id.PARENT);
    await apply(id.CAL_CHILD, 'EQUIPMENT_GROUP', id.CHILD);
    await apply(id.CAL_OFF, 'EQUIPMENT_GROUP', id.OFF);
    await apply(id.CAL_Q, 'PLANT', id.Q);

    const day = (calendarId: bigint, date: string, type: string, extra: object = {}) => prisma.work_calendar_day.create({
      data: { work_calendar_id: calendarId, calendar_date: new Date(date), day_type_code: type, ...extra },
    });
    await day(id.CAL_PLANT, '2027-03-02', 'HOLIDAY', { reason_code: 'PUBLIC_HOLIDAY', remarks: '공휴일' });
    await day(id.CAL_PLANT, '2027-03-03', 'PARTIAL', { work_start_time: new Date('1970-01-01T08:00:00Z'), work_end_time: new Date('1970-01-01T12:00:00Z') });
    await day(id.CAL_PLANT, '2027-03-06', 'WORKING', { reason_code: 'MAKEUP_WORKING_DAY' });
    await day(id.CAL_PARENT, '2027-03-04', 'HOLIDAY');
    await day(id.CAL_CHILD, '2027-03-05', 'HOLIDAY');
    await day(id.CAL_OFF, '2027-03-01', 'HOLIDAY');
    await day(id.CAL_Q, '2027-03-02', 'HOLIDAY');

    await prisma.operation_policy.create({
      data: { policy_code: 'WEEKLY_WORKING_DAYS', plant_id: id.P, value_numeric: 5, effective_from: new Date('2027-01-01'), effective_to: new Date('2027-03-07') },
    });
    await prisma.operation_policy.create({
      data: { policy_code: 'WEEKLY_WORKING_DAYS', plant_id: id.P, value_numeric: 6, effective_from: new Date('2027-03-08') },
    });

    const jwt = app.get(JwtService);
    const sign = (userId: bigint) => `${SESSION_COOKIE}=${jwt.sign({ sub: Number(userId), typ: 'session' })}`;
    cookie = sign(await makeUser('PLANNER', 'W-02-02'));
    deniedCookie = sign(await makeUser('DENIED', 'W-CO-14'));
    const scoped = await makeUser('SCOPED', 'W-02-02');
    await prisma.user_data_scope.create({ data: { app_user_id: scoped, plant_id: id.Q } });
    scopedCookie = sign(scoped);
  }, 120_000);

  afterAll(async () => {
    try {
      const calendars = [id.CAL_PLANT, id.CAL_PARENT, id.CAL_CHILD, id.CAL_OFF, id.CAL_Q].filter(Boolean);
      await prisma.work_calendar_day.deleteMany({ where: { work_calendar_id: { in: calendars } } });
      await prisma.work_calendar_application.deleteMany({ where: { work_calendar_id: { in: calendars } } });
      await prisma.work_calendar.deleteMany({ where: { work_calendar_id: { in: calendars } } });
      await prisma.operation_policy.deleteMany({ where: { plant_id: { in: [id.P, id.Q] } } });
      await prisma.production_line.deleteMany({ where: { production_line_id: { in: [id.CHILD, id.SIBLING, id.OFF, id.Q_LINE] } } });
      await prisma.production_line.deleteMany({ where: { production_line_id: id.PARENT } });
      await prisma.user_data_scope.deleteMany({ where: { app_user_id: { in: userIds } } });
      await prisma.plant.deleteMany({ where: { plant_id: { in: [id.P, id.Q] } } });
      await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
      await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
      await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
      await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    } finally {
      await app.close();
    }
  });

  async function makeUser(suffix: string, permission: string): Promise<bigint> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}_${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' } });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `근무일 판정 시험 ${suffix}` } });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return user.app_user_id;
  }

  it('공장 층 — 캘린더 날짜(평일 공휴일 HOLIDAY·부분 가동·토요일 특근 WORKING)가 정책보다 앞서고, 없는 날은 그날 유효한 정책의 요일이다', async () => {
    const response = await resolve([{ plantId: Number(id.P), from: '2027-03-01', to: '2027-03-13' }]).expect(200);
    expect(resultValidator()(response.body)).toBe(true);
    const days = new Map((response.body.items[0].days as Day[]).map((day) => [day.date, day]));
    expect(days.size).toBe(13);
    expect(days.get('2027-03-01')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY', weeklyWorkingDays: 5, workCalendarId: Number(id.CAL_PLANT) });
    expect(days.get('2027-03-02')).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'PLANT_CALENDAR', reasonCode: 'PUBLIC_HOLIDAY', remarks: '공휴일', appliedProductionLineId: null });
    expect(days.get('2027-03-03')).toMatchObject({ statusCode: 'PARTIAL', sourceCode: 'PLANT_CALENDAR', startTime: '08:00:00', endTime: '12:00:00' });
    expect(days.get('2027-03-04')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY' });
    expect(days.get('2027-03-06')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'PLANT_CALENDAR', reasonCode: 'MAKEUP_WORKING_DAY' });
    expect(days.get('2027-03-07')).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'WEEKLY_POLICY', weeklyWorkingDays: 5 });
    // 03-08 부터 주 6일 — 토요일이 가동이다.
    expect(days.get('2027-03-13')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY', weeklyWorkingDays: 6 });
  });

  it('라인 캘린더에 날짜가 없으면 상위·공장 캘린더로 내려가지 않고 정책으로 본다', async () => {
    const days = await daysOf(id.P, id.CHILD, '2027-03-01', '2027-03-07');
    expect(days.get('2027-03-05')).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'LINE_CALENDAR', workCalendarId: Number(id.CAL_CHILD), appliedProductionLineId: Number(id.CHILD) });
    expect(days.get('2027-03-02')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY', workCalendarId: Number(id.CAL_CHILD) });
    expect(days.get('2027-03-04')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY' });
  });

  it('자기 적용이 없는 라인은 상위 라인의 캘린더를 따른다', async () => {
    const days = await daysOf(id.P, id.SIBLING, '2027-03-01', '2027-03-07');
    expect(days.get('2027-03-04')).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'PARENT_LINE_CALENDAR', workCalendarId: Number(id.CAL_PARENT), appliedProductionLineId: Number(id.PARENT) });
    expect(days.get('2027-03-02')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY' });
  });

  it('사용 중지된 캘린더의 날짜는 쓰지 않는다 — 공장 캘린더로 내려가지 않고 정책으로 본다', async () => {
    const days = await daysOf(id.P, id.OFF, '2027-03-01', '2027-03-02');
    expect(days.get('2027-03-01')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY', workCalendarId: Number(id.CAL_OFF) });
    expect(days.get('2027-03-02')).toMatchObject({ statusCode: 'WORKING', sourceCode: 'WEEKLY_POLICY' });
  });

  it('정책이 없는 공장 — 캘린더 날짜는 적용하고, 나머지는 요일로 빼지 않고 판정 불가다', async () => {
    const days = await daysOf(id.Q, null, '2027-03-01', '2027-03-07');
    expect(days.get('2027-03-02')).toMatchObject({ statusCode: 'HOLIDAY', sourceCode: 'PLANT_CALENDAR' });
    for (const date of ['2027-03-01', '2027-03-06', '2027-03-07']) {
      expect(days.get(date)).toMatchObject({ statusCode: 'UNDETERMINED', sourceCode: 'NOT_CONFIGURED', weeklyWorkingDays: null });
    }
  });

  it('적용 시작일 전 날짜는 그 적용을 쓰지 않는다', async () => {
    const days = await daysOf(id.Q, id.Q_LINE, '2026-12-31', '2026-12-31');
    expect(days.get('2026-12-31')).toMatchObject({ statusCode: 'UNDETERMINED', sourceCode: 'NOT_CONFIGURED', workCalendarId: null });
  });

  it('여러 묶음을 요청 순서대로 낸다', async () => {
    const response = await resolve([
      { plantId: Number(id.Q), from: '2027-03-02', to: '2027-03-02' },
      { plantId: Number(id.P), productionLineId: Number(id.CHILD), from: '2027-03-05', to: '2027-03-06' },
    ]).expect(200);
    expect(response.body.items.map((item: { plantId: number; days: Day[] }) => [item.plantId, item.days.map((day) => day.statusCode)])).toEqual([
      [Number(id.Q), ['HOLIDAY']],
      [Number(id.P), ['HOLIDAY', 'HOLIDAY']],
    ]);
  });

  it('기간 거꾸로·92일 초과·없는 공장·다른 공장 라인은 400, 51 묶음은 400', async () => {
    const fields = async (targets: object[]) => ((await resolve(targets).expect(400)).body.errors as { field?: string; code: string }[]).map((error) => [error.field, error.code]);
    expect(await fields([{ plantId: Number(id.P), from: '2027-03-02', to: '2027-03-01' }])).toEqual([['targets[0].to', 'RANGE']]);
    expect(await fields([{ plantId: Number(id.P), from: '2027-01-01', to: '2027-04-03' }])).toEqual([['targets[0].to', 'RANGE']]);
    expect(await daysOf(id.P, null, '2027-01-01', '2027-04-02').then((days) => days.size)).toBe(92);
    expect(await fields([{ plantId: 999999999, from: '2027-03-01', to: '2027-03-01' }])).toEqual([['targets[0].plantId', 'INVALID']]);
    expect(await fields([{ plantId: Number(id.P), productionLineId: Number(id.Q_LINE), from: '2027-03-01', to: '2027-03-01' }])).toEqual([['targets[0].productionLineId', 'INVALID']]);
    const many = Array.from({ length: 51 }, () => ({ plantId: Number(id.P), from: '2027-03-01', to: '2027-03-01' }));
    await resolve(many).expect(400);
  });

  it('데이터 범위 밖 공장은 403 PERMISSION_DENIED — 없는 공장(400)이 먼저다', async () => {
    const outside = await resolve([
      { plantId: Number(id.Q), from: '2027-03-01', to: '2027-03-01' },
      { plantId: Number(id.P), from: '2027-03-01', to: '2027-03-01' },
    ], scopedCookie).expect(403);
    expect(outside.body.errors).toEqual([expect.objectContaining({ scope: 'field', field: 'targets[1].plantId', code: 'PERMISSION_DENIED' })]);
    await resolve([{ plantId: Number(id.Q), from: '2027-03-01', to: '2027-03-01' }], scopedCookie).expect(200);
    const missing = await resolve([
      { plantId: Number(id.P), from: '2027-03-01', to: '2027-03-01' },
      { plantId: 999999999, from: '2027-03-01', to: '2027-03-01' },
    ], scopedCookie).expect(400);
    expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'targets[1].plantId', code: 'INVALID' })]);
  });

  it('계획 화면 권한이 없으면 403', async () => {
    await resolve([{ plantId: Number(id.P), from: '2027-03-01', to: '2027-03-01' }], deniedCookie).expect(403);
  });
});
