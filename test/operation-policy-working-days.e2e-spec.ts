/**
 * 공장 주간 근무일 — 운영 정책 `WEEKLY_WORKING_DAYS`(피처 003 · omf-all-around#66).
 *
 * 범위는 공장만, 값은 5|6. 설정하지 않은 공장은 서버가 5 로 계산한다(이 코드만의 예외 — effective 는
 * 그대로 resolved=false). 설정 화면 `W-CO-15` 는 이 코드만 읽고 쓴다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { weeklyWorkingDays } from '../src/app/policy/working-days';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_WWD_${randomUUID().slice(0, 8)}`;
const PATH = '/api/app/operation-policies';
const CODE = 'WEEKLY_WORKING_DAYS';
const TODAY = '2026-11-03';

describe('공장 주간 근무일 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let screenCookie: string;
  let deniedCookie: string;
  let plantId: bigint;
  let itemId: bigint;
  const userIds: bigint[] = [];
  const roleIds: bigint[] = [];

  const post = (body: object, session = screenCookie) =>
    request(app.getHttpServer()).post(PATH).set('Cookie', session).set('Idempotency-Key', randomUUID()).send(body);
  const effective = () =>
    request(app.getHttpServer())
      .get(`${PATH}/effective`)
      .query({ policyCode: CODE, plantId: Number(plantId), on: TODAY })
      .set('Cookie', screenCookie);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    plantId = (
      await prisma.plant.create({
        data: {
          plant_code: PREFIX,
          plant_name: `${PREFIX} 공장`,
          legal_entity_id: base.legal_entity_id,
          business_unit_id: base.business_unit_id,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    itemId = (await prisma.item.findFirstOrThrow({ orderBy: { item_id: 'asc' } })).item_id;

    const jwt = app.get(JwtService);
    const sign = (id: bigint) => `${SESSION_COOKIE}=${jwt.sign({ sub: Number(id), typ: 'session' })}`;
    screenCookie = sign(await makeUser('SCREEN', 'W-CO-15'));
    deniedCookie = sign(await makeUser('DENIED', 'W-CO-14'));
  });

  afterAll(async () => {
    await prisma.operation_policy.deleteMany({ where: { plant_id: plantId } });
    await prisma.plant.deleteMany({ where: { plant_id: plantId } });
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await prisma.user_role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role_permission.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { role_id: { in: roleIds } } });
    await prisma.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    await app.close();
  });

  async function makeUser(suffix: string, permission: string): Promise<bigint> {
    const user = await prisma.app_user.create({
      data: { login_id: `${PREFIX}_${suffix}`, user_name: `${PREFIX} ${suffix}`, status_code: 'EMPLOYED' },
    });
    userIds.push(user.app_user_id);
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `근무일 시험 ${suffix}` } });
    roleIds.push(role.role_id);
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return user.app_user_id;
  }

  it('US7-1 설정이 없는 공장은 헬퍼가 5 로 계산하고, effective 는 기본값을 지어내지 않는다', async () => {
    expect(await weeklyWorkingDays(prisma, plantId, TODAY)).toBe(5);
    const response = await effective().expect(200);
    expect(response.body).toMatchObject({ policyCode: CODE, resolved: false, valueNumeric: null });
  });

  it('US7-3 W-CO-15 로 6 을 저장하면 다시 읽어도 6 이고, 헬퍼도 6 이다', async () => {
    const created = await post({ policyCode: CODE, plantId: Number(plantId), valueNumeric: 6, effectiveFrom: TODAY }).expect(201);
    expect(created.body).toMatchObject({ policyCode: CODE, plantId: Number(plantId), valueNumeric: 6 });

    const read = await effective().expect(200);
    expect(read.body).toMatchObject({ resolved: true, valueNumeric: 6, matchedScopeCode: 'PLANT' });
    expect(await weeklyWorkingDays(prisma, plantId, TODAY)).toBe(6);
    // 적용일 전날은 아직 5 다 — 저장은 「그날부터 적용하는 행」이다.
    expect(await weeklyWorkingDays(prisma, plantId, '2026-11-02')).toBe(5);

    // 같은 화면이 고쳐 5 로 되돌린다.
    const id = created.body.operationPolicyId as number;
    const detail = await request(app.getHttpServer()).get(`${PATH}/${id}`).set('Cookie', screenCookie).expect(200);
    await request(app.getHttpServer())
      .put(`${PATH}/${id}`)
      .set('Cookie', screenCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send({ valueNumeric: 5, effectiveFrom: TODAY })
      .expect(200);
    expect(await weeklyWorkingDays(prisma, plantId, TODAY)).toBe(5);
  });

  it('US7-3 W-CO-15 저장 방식 — 앞 행을 닫지 않고 「오늘부터」 새 행을 더해도 겹침을 거부하지 않고 시작일이 늦은 행이 이긴다', async () => {
    await post({ policyCode: CODE, plantId: Number(plantId), valueNumeric: 6, effectiveFrom: '2026-11-10' }).expect(201);
    expect(await weeklyWorkingDays(prisma, plantId, '2026-11-09')).toBe(5);
    expect(await weeklyWorkingDays(prisma, plantId, '2026-11-10')).toBe(6);
    const read = await request(app.getHttpServer())
      .get(`${PATH}/effective`)
      .query({ policyCode: CODE, plantId: Number(plantId), on: '2026-11-10' })
      .set('Cookie', screenCookie)
      .expect(200);
    expect(read.body).toMatchObject({ resolved: true, valueNumeric: 6 });

    // ⚠ 같은 공장·같은 시작일의 두 번째 POST 는 유일 인덱스(uq_operation_policy)로 400 이다 — 같은 날 다시
    //   저장하려면 그 행을 PUT 으로 고친다.
    await post({ policyCode: CODE, plantId: Number(plantId), valueNumeric: 5, effectiveFrom: '2026-11-10' }).expect(400);
    const id = read.body.operationPolicyId as number;
    const detail = await request(app.getHttpServer()).get(`${PATH}/${id}`).set('Cookie', screenCookie).expect(200);
    await request(app.getHttpServer())
      .put(`${PATH}/${id}`)
      .set('Cookie', screenCookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send({ valueNumeric: 5, effectiveFrom: '2026-11-10' })
      .expect(200);
    expect(await weeklyWorkingDays(prisma, plantId, '2026-11-10')).toBe(5);
  });

  it('US7-3 값은 5·6 만 받는다 — 그 밖은 400 RANGE', async () => {
    for (const value of [4, 7, 5.5]) {
      const response = await post({ policyCode: CODE, plantId: Number(plantId), valueNumeric: value, effectiveFrom: TODAY }).expect(400);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'valueNumeric', code: 'RANGE' })]),
      );
    }
  });

  it('US7-3 범위가 공장이 아니면 400 — 공장 없음 · 품목 범위', async () => {
    const noPlant = await post({ policyCode: CODE, valueNumeric: 6, effectiveFrom: TODAY }).expect(400);
    expect(noPlant.body.errors[0]).toMatchObject({ field: 'plantId', code: 'REQUIRED' });

    const withItem = await post({
      policyCode: CODE,
      plantId: Number(plantId),
      itemId: Number(itemId),
      valueNumeric: 6,
      effectiveFrom: TODAY,
    }).expect(400);
    expect(withItem.body.errors[0]).toMatchObject({ field: 'itemId', code: 'INVALID' });
  });

  it('US7-3 W-CO-15 는 이 코드만 읽는다 — 다른 코드 행 상세는 403, 목록은 근무일 행만', async () => {
    const other = await prisma.operation_policy.create({
      data: { policy_code: 'MINOR_STOP_THRESHOLD_MINUTES', plant_id: plantId, value_numeric: 5, effective_from: new Date(`${TODAY}T00:00:00Z`) },
    });
    await request(app.getHttpServer()).get(`${PATH}/${other.operation_policy_id}`).set('Cookie', screenCookie).expect(403);
    const listed = await request(app.getHttpServer()).get(PATH).query({ plantId: Number(plantId) }).set('Cookie', screenCookie).expect(200);
    expect(listed.body.items.length).toBeGreaterThan(0);
    expect(new Set(listed.body.items.map((item: { policyCode: string }) => item.policyCode))).toEqual(new Set([CODE]));
    const asked = await request(app.getHttpServer())
      .get(PATH)
      .query({ plantId: Number(plantId), policyCode: 'MINOR_STOP_THRESHOLD_MINUTES' })
      .set('Cookie', screenCookie)
      .expect(200);
    expect(asked.body.items).toEqual([]);
  });

  it('US7-3 W-CO-15 는 이 코드만 쓴다 — 다른 정책 코드는 403, 권한이 없으면 403', async () => {
    await post({ policyCode: 'MINOR_STOP_THRESHOLD_MINUTES', plantId: Number(plantId), valueNumeric: 5, effectiveFrom: TODAY }).expect(403);
    await post({ policyCode: CODE, plantId: Number(plantId), valueNumeric: 6, effectiveFrom: TODAY }, deniedCookie).expect(403);
  });
});
