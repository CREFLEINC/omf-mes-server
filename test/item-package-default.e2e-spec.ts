/**
 * 피처 014 S1 — 품목 패키징 기본값(W-06-05 lot 그룹 · omf-all-around#349 · T004).
 * 패키징 단위·LOT 당 패키징 수량은 함께 있거나 함께 비고, 자재 LOT 기본크기를 나머지 없이 나눠야 한다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E14PK';
const NOT_DIVISIBLE = '패키징 수량이 부적합 합니다. 자재 LOT 기본크기를 정확히 나눌 수 있는 값을 입력해주세요.';

describe('피처 014 S1 — 품목 패키징 기본값 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let itemId: bigint;
  let ea: bigint;
  let roll: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    roll = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'BOX' } })).uom_id;
    itemId = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '패키징기본값자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ea, lot_controlled: true },
    })).item_id;
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-U`, user_name: '패키징 기본값', status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_R`, role_name: '패키징 기본값' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-06-05' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const body = (extra: Record<string, unknown>): Record<string, unknown> => ({
    lotControlled: true, serialControlTypeCode: 'NONE', inspectionRequired: false, fifoPolicyCode: 'FIFO',
    negativeStockAllowed: false, isActive: true, defaultLotStorageUomId: Number(ea), defaultProductionLotSize: 100, ...extra,
  });

  async function put(extra: Record<string, unknown>, status: number): Promise<request.Response> {
    const current = await request(app.getHttpServer()).get(`/api/mdm/items/${String(itemId)}`).set('Cookie', cookie).expect(200);
    return request(app.getHttpServer()).put(`/api/mdm/items/${String(itemId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID()).set('If-Match', current.headers.etag as string)
      .send(body(extra)).expect(status);
  }

  const messages = (response: request.Response): string[] =>
    (response.body.errors as { message: string }[]).map((error) => error.message);

  it('US5-1 패키징 단위·LOT 당 패키징 수량을 저장·조회하고, 둘 다 비우면 지운다', async () => {
    const saved = await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 10 }, 200);
    expect(saved.body).toMatchObject({ defaultPackageUomId: Number(roll), defaultPackageCount: 10, defaultProductionLotSize: 100 });
    const read = await request(app.getHttpServer()).get(`/api/mdm/items/${String(itemId)}`).set('Cookie', cookie).expect(200);
    expect(read.body.item).toMatchObject({ defaultPackageUomId: Number(roll), defaultPackageCount: 10 });
    expect(await prisma.item.findUniqueOrThrow({ where: { item_id: itemId } })).toMatchObject({
      default_package_uom_id: roll, default_package_count: 10,
    });

    // 칸을 안 보내면 그대로 둔다(다른 확장 속성 저장이 지우지 않는다).
    const untouched = await put({}, 200);
    expect(untouched.body).toMatchObject({ defaultPackageUomId: Number(roll), defaultPackageCount: 10 });

    const cleared = await put({ defaultPackageUomId: null, defaultPackageCount: null }, 200);
    expect(cleared.body).toMatchObject({ defaultPackageUomId: null, defaultPackageCount: null });
  });

  it('US5-2 Q15 하나만 넣으면 400 이고 저장하지 않는다', async () => {
    const before = await prisma.item.findUniqueOrThrow({ where: { item_id: itemId } });
    const onlyUom = await put({ defaultPackageUomId: Number(roll), defaultPackageCount: null }, 400);
    expect(onlyUom.body.errors[0]).toMatchObject({ code: 'PAIR' });
    await put({ defaultPackageUomId: null, defaultPackageCount: 5 }, 400);
    const after = await prisma.item.findUniqueOrThrow({ where: { item_id: itemId } });
    expect(after.version_no).toBe(before.version_no);
  });

  it('US5-3 Q15 기본크기 100 에 패키징 수량 30 → 400 「패키징 수량이 부적합 합니다…」, 0·소수도 400', async () => {
    const rejected = await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 30 }, 400);
    expect(messages(rejected)).toEqual([NOT_DIVISIBLE]);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'defaultPackageCount', code: 'INVALID' });
    await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 0 }, 400);
    await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 2.5 }, 400);
    // 이미 저장된 패키징 수량이 새 기본크기를 나누지 못해도 막는다.
    await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 4 }, 200);
    const resized = await put({ defaultProductionLotSize: 90 }, 400);
    expect(messages(resized)).toEqual([NOT_DIVISIBLE]);
    // 「나머지 없이 나눈다」는 기본크기 mod 패키징 수량 = 0 이다(data-model §3) — 2.5 를 5 로는 나누지 못한다.
    await put({ defaultProductionLotSize: 2.5, defaultPackageCount: 5 }, 400);
    await put({ defaultProductionLotSize: 20, defaultPackageCount: 5 }, 200);
  });

  it('US5-3 기본크기가 비어 있으면 나눔 검사를 건너뛴다', async () => {
    const saved = await put({ defaultProductionLotSize: null, defaultPackageUomId: Number(roll), defaultPackageCount: 7 }, 200);
    expect(saved.body).toMatchObject({ defaultProductionLotSize: null, defaultPackageCount: 7 });
  });

  it('없는 단위는 400 이고, If-Match 낡은 버전은 지금처럼 409 다', async () => {
    await put({ defaultPackageUomId: 999999999, defaultPackageCount: 10 }, 400);
    await request(app.getHttpServer()).put(`/api/mdm/items/${String(itemId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID()).set('If-Match', 'W/"1"')
      .send(body({ defaultPackageUomId: Number(roll), defaultPackageCount: 10 })).expect(409);
  });

  async function cleanup(): Promise<void> {
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'))`,
      `DELETE FROM quality.inspection_plan WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
