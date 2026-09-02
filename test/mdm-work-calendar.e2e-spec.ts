/**
 * 작업 캘린더.
 *
 * 저장 단위가 앞의 자식 컬렉션들과 «다르다» — 날짜는 「보낸 것만 덮어쓴다」이고 통째
 * 교체가 아니다. 적용은 대상 하나에 하나뿐이고, 해석은 설비 → 그룹 → 공장으로 올라간다.
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

const LOGIN_ID = 'e2e-mdmcal-probe';
const NOPERM_ID = 'e2e-mdmcal-noperm';
const PASSWORD = '작업달력-검사-비밀번호';
const PREFIX = 'MDMCAL';
const ROLE = 'E2E_MDMCAL';

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

describe('작업 캘린더 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plantId: number;
  let parentGroupId: number;
  let groupId: number;
  let equipmentId: number;
  let calendarId: number;
  let otherCalendarId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '달력검사', status_code: 'ACTIVE' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '달력검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-05-09' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    plantId = Number((await prisma.plant.findFirstOrThrow()).plant_id);
    parentGroupId = await createGroup(`${PREFIX}-PARENT`, null);
    groupId = await createGroup(`${PREFIX}-CHILD`, parentGroupId);
    equipmentId = await createEquipment(`${PREFIX}-EQ`, groupId);
    calendarId = (await create(`${PREFIX}-A`)).id;
    otherCalendarId = (await create(`${PREFIX}-B`)).id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── 캘린더 ──────────────────────────────────────────────────────────────

  it('목록·상세가 계약 스키마를 만족한다', async () => {
    const list = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);
    const listValidate = validator('GET /mdm/work-calendars');
    expect(listValidate(list.body)).toBe(true);
    expect(listValidate.errors ?? []).toEqual([]);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars/${calendarId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailValidate = validator('GET /mdm/work-calendars/{workCalendarId}');
    expect(detailValidate(detail.body)).toBe(true);
    expect(detailValidate.errors ?? []).toEqual([]);
    expect(detail.headers.etag).toMatch(/^\d+$/);
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/mdm/work-calendars')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send({ calendarCode: `${PREFIX}-X`, calendarName: 'X' })
      .expect(403);
  });

  // ── 날짜 ────────────────────────────────────────────────────────────────

  it('⭐ 보낸 날짜만 덮어쓴다 — 안 보낸 날은 그대로다', async () => {
    const applied = await putDays(calendarId, [
      { calendarDate: '2026-01-01', dayTypeCode: 'HOLIDAY', reasonCode: 'PUBLIC_HOLIDAY' },
      { calendarDate: '2026-01-02', dayTypeCode: 'WORKING' },
    ]);
    expect(applied.body.appliedCount).toBe(2);

    // 하루만 다시 보낸다 — 다른 날이 사라지면 안 된다.
    await putDays(calendarId, [{ calendarDate: '2026-01-02', dayTypeCode: 'HOLIDAY' }]);

    const days = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars/${calendarId}/days?from=2026-01-01&to=2026-01-31`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/work-calendars/{workCalendarId}/days');
    expect(validate(days.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(days.body.items).toHaveLength(2);
    expect(days.body.items[0]).toMatchObject({
      calendarDate: '2026-01-01',
      dayTypeCode: 'HOLIDAY',
      reasonCode: 'PUBLIC_HOLIDAY',
    });
    // 덮어쓴 날은 바뀌었다.
    expect(days.body.items[1].dayTypeCode).toBe('HOLIDAY');
  });

  it('⛔ 기간을 안 주면 400 이다 — 한 해가 365행이다 (L-3)', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars/${calendarId}/days`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'from',
      'to',
    ]);
  });

  it('⛔ 부분 가동은 시각이 필요하고, 그 밖의 날은 시각을 두지 않는다', async () => {
    const missing = await request(app.getHttpServer())
      .put(`/api/mdm/work-calendars/${calendarId}/days`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ days: [{ calendarDate: '2026-02-01', dayTypeCode: 'PARTIAL' }] })
      .expect(400);
    // 「휴무로 처리하면 조업시간이 통째로 빠져 가동률이 틀린다」(계약).
    expect(missing.body.errors[0]).toMatchObject({
      field: 'days[0].startTime',
      code: 'REQUIRED',
    });

    const extra = await request(app.getHttpServer())
      .put(`/api/mdm/work-calendars/${calendarId}/days`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        days: [{ calendarDate: '2026-02-02', dayTypeCode: 'WORKING', startTime: '09:00:00' }],
      })
      .expect(400);
    expect(extra.body.errors[0]).toMatchObject({ field: 'days[0].startTime', code: 'PAIR' });
  });

  it('⭐ 부분 가동을 시각과 함께 저장하면 왕복한다', async () => {
    await putDays(calendarId, [
      {
        calendarDate: '2026-03-01',
        dayTypeCode: 'PARTIAL',
        startTime: '09:00:00',
        endTime: '13:00:00',
      },
    ]);

    const days = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars/${calendarId}/days?from=2026-03-01&to=2026-03-01`)
      .set('Cookie', cookie)
      .expect(200);
    expect(days.body.items[0]).toMatchObject({
      dayTypeCode: 'PARTIAL',
      startTime: '09:00:00',
      endTime: '13:00:00',
    });
  });

  it('⛔ 같은 날짜를 두 줄 보내면 몇 번째인지 짚고, 없는 사유 코드는 400 이다', async () => {
    const duplicated = await request(app.getHttpServer())
      .put(`/api/mdm/work-calendars/${calendarId}/days`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        days: [
          { calendarDate: '2026-04-01', dayTypeCode: 'WORKING' },
          { calendarDate: '2026-04-01', dayTypeCode: 'HOLIDAY' },
        ],
      })
      .expect(400);
    expect(duplicated.body.errors[0]).toMatchObject({
      field: 'days[1].calendarDate',
      code: 'UNIQUE_VIOLATION',
    });

    const badReason = await request(app.getHttpServer())
      .put(`/api/mdm/work-calendars/${calendarId}/days`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        days: [{ calendarDate: '2026-04-02', dayTypeCode: 'HOLIDAY', reasonCode: '없는사유' }],
      })
      .expect(400);
    expect(badReason.body.errors[0]).toMatchObject({
      field: 'days[0].reasonCode',
      code: 'INVALID',
    });
  });

  // ── 적용과 해석 (B-17) ──────────────────────────────────────────────────

  it('⭐ 대상 하나에 지정은 하나다 — 바꾸면 옛 지정이 함께 풀린다', async () => {
    await applyCalendar(PLANT_TYPE, plantId, calendarId);
    const changed = await applyCalendar(PLANT_TYPE, plantId, otherCalendarId);
    expect(changed.body.workCalendarId).toBe(otherCalendarId);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendar-applications?targetTypeCode=${PLANT_TYPE}`)
      .set('Cookie', cookie)
      .expect(200);
    const mine = list.body.items.filter(
      (a: { targetId: number }) => a.targetId === plantId,
    );
    // 「공장 기본을 바꾸면 옛 지정 해제와 새 지정을 서버가 한 트랜잭션으로 처리한다」(계약).
    expect(mine).toHaveLength(1);
  });

  it('⭐ 비워 보내면 204 로 해제된다', async () => {
    await applyCalendar(PLANT_TYPE, plantId, calendarId);
    await request(app.getHttpServer())
      .put('/api/mdm/work-calendar-applications')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ targetTypeCode: PLANT_TYPE, targetId: plantId, workCalendarId: null })
      .expect(204);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendar-applications?targetTypeCode=${PLANT_TYPE}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      list.body.items.filter((a: { targetId: number }) => a.targetId === plantId),
    ).toHaveLength(0);
  });

  it('⭐ 해석이 그룹에서 멈추고, 훑은 층을 모두 담는다', async () => {
    await applyCalendar(PLANT_TYPE, plantId, calendarId);
    await applyCalendar(GROUP_TYPE, groupId, otherCalendarId);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendar-applications/effective?equipmentId=${equipmentId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/work-calendar-applications/effective');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.resolvedFromLevelCode).toBe(GROUP_TYPE);
    expect(response.body.workCalendarId).toBe(otherCalendarId);
    // 「이 층에 지정이 있으면 여기서 멈춘다」 — 공장까지 안 간다.
    expect(response.body.steps).toHaveLength(1);
    expect(response.body.steps[0]).toMatchObject({ levelCode: GROUP_TYPE, hasApplication: true });
  });

  it('⭐ 그룹에 없으면 상위 그룹을 지나 공장까지 간다', async () => {
    await clearApplications();
    await applyCalendar(PLANT_TYPE, plantId, calendarId);

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendar-applications/effective?equipmentId=${equipmentId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.resolvedFromLevelCode).toBe(PLANT_TYPE);
    expect(response.body.workCalendarId).toBe(calendarId);
    // 소속 그룹 → 상위 그룹 → 공장 셋을 훑었다.
    expect(response.body.steps.map((s: { levelCode: string }) => s.levelCode)).toEqual([
      GROUP_TYPE,
      GROUP_TYPE,
      PLANT_TYPE,
    ]);
  });

  it('⛔ 어느 층에도 없으면 null 이다 — 화면이 그 사실을 밝힌다', async () => {
    await clearApplications();

    const response = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendar-applications/effective?equipmentId=${equipmentId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.workCalendarId).toBeNull();
    expect(response.body.resolvedFromLevelCode).toBeNull();
    expect(response.body.steps.every((s: { hasApplication: boolean }) => !s.hasApplication)).toBe(
      true,
    );
  });

  it('⛔ 없는 대상에는 지정할 수 없다', async () => {
    const rejected = await request(app.getHttpServer())
      .put('/api/mdm/work-calendar-applications')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ targetTypeCode: PLANT_TYPE, targetId: 999999999, workCalendarId: calendarId })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'targetId', code: 'INVALID' });
  });

  it('⭐ 적용이 붙으면 상세의 applicationCount 가 오르고 코드가 잠긴다', async () => {
    await clearApplications();
    await applyCalendar(PLANT_TYPE, plantId, calendarId);

    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/work-calendars/${calendarId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.applicationCount).toBe(1);
    expect(detail.body.editability).toMatchObject({ codeEditable: false, reason: 'REFERENCED' });
  });

  it('⛔ 없는 캘린더·설비는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/work-calendars/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/mdm/work-calendar-applications/effective?equipmentId=999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  const PLANT_TYPE = 'PLANT';
  const GROUP_TYPE = 'EQUIPMENT_GROUP';

  async function putDays(
    id: number,
    days: unknown[],
  ): Promise<{ body: { appliedCount: number } }> {
    const response = await request(app.getHttpServer())
      .put(`/api/mdm/work-calendars/${id}/days`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ days })
      .expect(200);
    return { body: response.body };
  }

  async function applyCalendar(
    targetTypeCode: string,
    targetId: number,
    workCalendarId: number,
  ): Promise<{ body: { workCalendarId: number } }> {
    const response = await request(app.getHttpServer())
      .put('/api/mdm/work-calendar-applications')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ targetTypeCode, targetId, workCalendarId })
      .expect(200);
    return { body: response.body };
  }

  async function clearApplications(): Promise<void> {
    await prisma.work_calendar_application.deleteMany({
      where: { work_calendar: { calendar_code: { startsWith: PREFIX } } },
    });
  }

  async function create(calendarCode: string): Promise<{ id: number }> {
    const created = await request(app.getHttpServer())
      .post('/api/mdm/work-calendars')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ calendarCode, calendarName: calendarCode })
      .expect(201);
    return { id: created.body.workCalendarId };
  }

  async function createGroup(code: string, parent: number | null): Promise<number> {
    const created = await prisma.production_line.create({
      data: {
        plant_id: plantId,
        line_code: code,
        line_name: code,
        line_type_code: 'LINE',
        ...(parent === null ? {} : { parent_line_id: parent }),
      },
    });
    return Number(created.production_line_id);
  }

  async function createEquipment(code: string, inGroup: number): Promise<number> {
    const created = await prisma.equipment.create({
      data: {
        plant_id: plantId,
        equipment_code: code,
        equipment_name: code,
        equipment_type_code: 'INJECTION_MOLDING',
        status_code: 'IN_SERVICE',
        production_line_id: inGroup,
      },
    });
    return Number(created.equipment_id);
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
    await prisma.work_calendar_application.deleteMany({
      where: { work_calendar: { calendar_code: { startsWith: PREFIX } } },
    });
    await prisma.work_calendar_day.deleteMany({
      where: { work_calendar: { calendar_code: { startsWith: PREFIX } } },
    });
    await prisma.work_calendar.deleteMany({ where: { calendar_code: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({
      where: { line_code: { startsWith: PREFIX }, NOT: { parent_line_id: null } },
    });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
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
