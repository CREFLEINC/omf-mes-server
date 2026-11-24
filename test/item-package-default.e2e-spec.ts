/**
 * 피처 014 S1 — 품목 패키징 기본값(W-06-05 lot 그룹 · omf-all-around#349 · T004).
 * 패키징 단위·LOT 당 패키징 수량은 함께 있거나 함께 비고, 자재 LOT 기본크기 ÷ 패키징 수량(봉지당 양)이 소수 1자리까지 떨어져야 한다
 * (사용자 결정 2026-11-24 · T047).
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

  async function put(extra: Record<string, unknown>, status: number, target: bigint = itemId): Promise<request.Response> {
    const current = await request(app.getHttpServer()).get(`/api/mdm/items/${String(target)}`).set('Cookie', cookie).expect(200);
    return request(app.getHttpServer()).put(`/api/mdm/items/${String(target)}`).set('Cookie', cookie)
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
    // 이미 저장된 패키징 수량이 새 기본크기를 나누지 못해도 막는다(9 ÷ 4 = 2.25 — 소수 2자리).
    await put({ defaultPackageUomId: Number(roll), defaultPackageCount: 4 }, 200);
    const resized = await put({ defaultProductionLotSize: 9 }, 400);
    expect(messages(resized)).toEqual([NOT_DIVISIBLE]);
    await put({ defaultProductionLotSize: 20, defaultPackageCount: 5 }, 200);
  });

  it('US5-3 Q15 T047 봉지당 양은 소수 1자리까지 — 2.5÷5=0.5·10÷4=2.5 는 200, 2.5÷2=1.25·100÷30 은 400', async () => {
    const accepted = await put({ defaultProductionLotSize: 2.5, defaultPackageUomId: Number(roll), defaultPackageCount: 5 }, 200);
    expect(accepted.body).toMatchObject({ defaultProductionLotSize: 2.5, defaultPackageCount: 5 });
    await put({ defaultProductionLotSize: 10, defaultPackageCount: 4 }, 200);
    const twoPlaces = await put({ defaultProductionLotSize: 2.5, defaultPackageCount: 2 }, 400);
    expect(messages(twoPlaces)).toEqual([NOT_DIVISIBLE]);
    expect(twoPlaces.body.errors[0]).toMatchObject({ field: 'defaultPackageCount', code: 'INVALID' });
    const repeating = await put({ defaultProductionLotSize: 100, defaultPackageCount: 30 }, 400);
    expect(messages(repeating)).toEqual([NOT_DIVISIBLE]);
    expect(await prisma.item.findUniqueOrThrow({ where: { item_id: itemId } })).toMatchObject({ default_package_count: 4 });
  });

  it('US5-3 기본크기가 비어 있으면 나눔 검사를 건너뛴다', async () => {
    const saved = await put({ defaultProductionLotSize: null, defaultPackageUomId: Number(roll), defaultPackageCount: 7 }, 200);
    expect(saved.body).toMatchObject({ defaultProductionLotSize: null, defaultPackageCount: 7 });
  });

  it('US5-3 Q15 없는 단위는 400 이고, If-Match 낡은 버전은 지금처럼 409 다', async () => {
    await put({ defaultPackageUomId: 999999999, defaultPackageCount: 10 }, 400);
    await request(app.getHttpServer()).put(`/api/mdm/items/${String(itemId)}`).set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID()).set('If-Match', 'W/"1"')
      .send(body({ defaultPackageUomId: Number(roll), defaultPackageCount: 10 })).expect(409);
  });

  it('FR-018 T049 보관 단위 ≠ 기본 단위 — 기본 단위로 바꾼 크기 ÷ 패키징 수가 6자리에서 떨어지지 않으면 400, 환산이 없으면 건너뛴다', async () => {
    // 보관 BOX 3 ÷ 3 = 1 은 소수 1자리 규칙을 통과하지만, 1 EA = 0.75 BOX 이면 3 BOX = 4 EA 이고 4 ÷ 3 은 떨어지지 않는다.
    const itemB = (await prisma.item.create({
      data: { item_code: `${PREFIX}-B`, item_name: '패키징기본값자재B', item_type_code: 'RAW_MATERIAL', base_uom_id: ea, lot_controlled: true },
    })).item_id;
    const boxLot = { defaultLotStorageUomId: Number(roll), defaultProductionLotSize: 3, defaultPackageUomId: Number(roll) };
    await put({ ...boxLot, defaultPackageCount: 3 }, 200, itemB); // 환산 없음(NO_CONVERSION) — 추가 검사 없음
    await prisma.item_uom_conversion.create({
      data: { item_id: itemB, from_uom_id: ea, to_uom_id: roll, conversion_rate: 0.75, effective_from: new Date('2026-01-01T00:00:00.000Z') },
    });
    const rejected = await put({ ...boxLot, defaultPackageCount: 3 }, 400, itemB);
    expect(messages(rejected)).toEqual([NOT_DIVISIBLE]);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'defaultPackageCount', code: 'INVALID' });
    // 패키징 수량만 다시 보내지 않아도(기본크기만 저장) 저장된 3 으로 다시 본다.
    await put({ defaultLotStorageUomId: Number(roll), defaultProductionLotSize: 3 }, 400, itemB);
    const accepted = await put({ ...boxLot, defaultPackageCount: 2 }, 200, itemB); // 4 EA ÷ 2 = 2
    expect(accepted.body).toMatchObject({ defaultProductionLotSize: 3, defaultPackageCount: 2 });
  });

  async function cleanup(): Promise<void> {
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM quality.inspection_plan_version WHERE inspection_plan_id IN (SELECT inspection_plan_id FROM quality.inspection_plan WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'))`,
      `DELETE FROM quality.inspection_plan WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.item_uom_conversion WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
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
