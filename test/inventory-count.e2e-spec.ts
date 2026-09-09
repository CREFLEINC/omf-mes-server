/**
 * I-15 재고 실사. 조회 3건과 생성 스냅샷을 같은 격리 스위트에서 검증한다.
 * ⛔ I-14 조정 라인이 실사 라인을 FK로 가리키므로 CASCADE TRUNCATE를 쓰지 않는다.
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

const LOGIN_ID = 'e2e-inventory-count';
const NOPERM_ID = 'e2e-inventory-count-no-permission';
const PASSWORD = '실사-조회-비밀번호';
const PREFIX = 'ICE2E';
const ROLE = 'E2E_INVENTORY_COUNT';
const AT = new Date('2026-09-09T01:02:03.000Z');

function validator(operation: string, status = '200'): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('재고 실사 조회·생성 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let userId: bigint;
  let warehouseId: number;
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let plantId: bigint;
  let uomId: bigint;
  let location1Id: number;
  let location2Id: number;
  let itemId: number;
  let blindId: number;
  let completedId: number;
  let plannedId: number;
  let createdId: number;
  let negativeItemId: bigint;
  let negativeLotId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeUser();
    await makeCounts();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록은 계획일·PK 역순이고 필터 5축과 페이지를 적용한다', async () => {
    const all = await list('');
    expect(all.items.map((row) => row.inventoryCountId)).toEqual([
      blindId,
      completedId,
      plannedId,
    ]);
    expect(all.page).toMatchObject({ page: 1, size: 50, total: 3 });

    expect((await list(`warehouseId=${warehouseId}`)).items).toHaveLength(3);
    expect((await list('plannedDateFrom=2026-09-09&plannedDateTo=2026-09-09')).items)
      .toEqual([expect.objectContaining({ inventoryCountId: completedId })]);
    expect((await list('countTypeCode=CYCLE')).items.map((row) => row.inventoryCountId))
      .toEqual([blindId, completedId]);
    expect((await list('statusCode=PLANNED')).items.map((row) => row.inventoryCountId))
      .toEqual([plannedId]);
    expect((await list('inProgressOnly=true')).items.map((row) => row.inventoryCountId))
      .toEqual([blindId]);
    expect((await list('page=2&size=2')).items.map((row) => row.inventoryCountId))
      .toEqual([plannedId]);
  });

  it('상세은 ETag와 전체 요약을 내리고 차단 사유 우선순위를 지킨다', async () => {
    const blind = await request(app.getHttpServer())
      .get(`/api/inventory/counts/${blindId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(blind.headers.etag).toBe('1');
    expect(blind.body.summary).toEqual({
      plannedCount: 2,
      countedCount: 1,
      uncountedCount: 1,
      varianceCount: 1,
      closable: false,
      closeBlockedReasonCode: 'COUNT_REMAINING',
    });
    const validate = validator('GET /inventory/counts/{inventoryCountId}');
    expect(validate(blind.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const completed = await request(app.getHttpServer())
      .get(`/api/inventory/counts/${completedId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(completed.body.summary.closeBlockedReasonCode).toBe('ALREADY_CLOSED');
  });

  it('라인은 안정 정렬·필터·표시 조인을 적용하고 블라인드 장부를 가린다', async () => {
    const all = await lines(blindId, '');
    expect(all.items.map((row) => row.lineNo)).toEqual([1, 2]);
    expect(all.items[0]).toMatchObject({
      locationId: location1Id,
      itemId,
      counted: false,
      countedQty: 0,
      varianceQty: 0,
      itemCode: `${PREFIX}-ITEM`,
      itemName: '실사 품목',
      lotNo: `${PREFIX}-LOT`,
      locationCode: `${PREFIX}-L1`,
    });
    expect(all.items[0]).not.toHaveProperty('systemQty');
    expect(all.items[1]).toMatchObject({ counted: true, countedQty: 8, varianceQty: -2 });
    expect(all.items[1]).not.toHaveProperty('systemQty');

    expect((await lines(blindId, 'uncountedOnly=true')).items.map((row) => row.lineNo)).toEqual([1]);
    expect((await lines(blindId, 'varianceOnly=true')).items.map((row) => row.lineNo)).toEqual([2]);
    expect((await lines(blindId, 'uncountedOnly=true&varianceOnly=true')).items).toEqual([]);
    expect((await lines(blindId, `locationId=${location2Id}&itemId=${itemId}`)).items.map((row) => row.lineNo))
      .toEqual([2]);
    expect((await lines(blindId, 'page=2&size=1')).items.map((row) => row.lineNo)).toEqual([2]);
  });

  it('비블라인드 라인 응답은 계약 스키마를 만족하고 systemQty를 내린다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/counts/${completedId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.items[0].systemQty).toBe(5);
    const validate = validator('GET /inventory/counts/{inventoryCountId}/lines');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('없는 상세·라인은 404이고 조회는 화면 권한을 따로 요구하지 않는다', async () => {
    await request(app.getHttpServer())
      .get('/api/inventory/counts/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/inventory/counts/999999999/lines')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer()).get('/api/inventory/counts').set('Cookie', cookie).expect(200);
  });

  it('생성은 현재 잔액을 네 축으로 합쳐 0은 빼고 원장을 쓰지 않는다', async () => {
    const transactionCount = await prisma.inventory_transaction.count();
    const key = randomUUID();
    const body = {
      countTypeCode: 'CYCLE',
      warehouseId,
      plannedDate: '2026-09-10',
      blindCount: false,
    };
    const first = await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    createdId = first.body.inventoryCount.inventoryCountId;
    expect(first.headers.etag).toBe('1');
    expect(first.body).toMatchObject({
      inventoryCount: {
        inventoryCountNo: expect.stringMatching(/^IC-20260910-/),
        countTypeCode: 'CYCLE',
        warehouseId,
        plannedDate: '2026-09-10',
        blindCount: false,
        statusCode: 'IN_PROGRESS',
      },
      summary: {
        plannedCount: 1,
        countedCount: 0,
        uncountedCount: 1,
        varianceCount: 0,
        closable: false,
        closeBlockedReasonCode: 'COUNT_REMAINING',
      },
    });
    const validate = validator('POST /inventory/counts', '201');
    expect(validate(first.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const replay = await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.etag).toBe('1');
    expect(
      await prisma.inventory_count.count({ where: { created_by: userId } }),
    ).toBe(1);

    const createdLines = await request(app.getHttpServer())
      .get(`/api/inventory/counts/${createdId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    expect(createdLines.body.items).toHaveLength(1);
    expect(createdLines.body.items.map((line: { systemQty: number }) => line.systemQty)).toEqual([
      10,
    ]);
    expect(await prisma.inventory_transaction.count()).toBe(transactionCount);
  });

  it('음수 장부는 0으로 자르거나 누락하지 않고 질의 276 회신 전까지 생성 전체를 막는다', async () => {
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_id: businessUnitId,
        plant_id: plantId,
        warehouse_id: warehouseId,
        location_id: location2Id,
        item_id: negativeItemId,
        lot_id: negativeLotId,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: -3,
        uom_id: uomId,
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ countTypeCode: 'CYCLE', warehouseId, plannedDate: '2026-09-10' })
      .expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: 'warehouseId', code: 'INVALID' }),
    ]);
    expect(await prisma.inventory_count.count({ where: { created_by: userId } })).toBe(1);
  });

  it('생성은 권한·코드·창고 계약을 각각 거부한다', async () => {
    await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ countTypeCode: 'CYCLE', warehouseId, plannedDate: '2026-09-10' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ countTypeCode: 'NOT_A_TYPE', warehouseId, plannedDate: '2026-09-10' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/inventory/counts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ countTypeCode: 'CYCLE', warehouseId: 999999999, plannedDate: '2026-09-10' })
      .expect(400);
  });

  async function list(query: string): Promise<{
    items: { inventoryCountId: number }[];
    page: { page: number; size: number; total: number };
  }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/counts?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/counts');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function lines(id: number, query: string): Promise<{
    items: Record<string, unknown>[];
    page: { page: number; size: number; total: number };
  }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/counts/${id}/lines?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '실사 조회자', status_code: 'EMPLOYED' },
    });
    userId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: userId, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: '재고 실사 E2E' },
    });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-01-04' },
    });
    await prisma.user_role.create({ data: { app_user_id: userId, role_id: role.role_id } });
    const noPerm = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '실사 권한 없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: noPerm.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function makeCounts(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '실사 법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    legalEntityId = entity.legal_entity_id;
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '실사 사업부',
      },
    });
    businessUnitId = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '실사 공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = plant.plant_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '실사 창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const location1 = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-L1`,
        location_name: '실사 위치 1',
        location_type_code: 'BIN',
      },
    });
    const location2 = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-L2`,
        location_name: '실사 위치 2',
        location_type_code: 'BIN',
      },
    });
    location1Id = Number(location1.location_id);
    location2Id = Number(location2.location_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-ITEM`,
        item_name: '실사 품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
        negative_stock_allowed: false,
      },
    });
    itemId = Number(item.item_id);
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'AVAILABLE',
      },
    });
    const negativeItem = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-NEG-ITEM`,
        item_name: '음수 재고 허용 품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
        negative_stock_allowed: true,
      },
    });
    negativeItemId = negativeItem.item_id;
    const negativeLot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-NEG-LOT`,
        item_id: negativeItem.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 2,
        status_code: 'AVAILABLE',
      },
    });
    negativeLotId = negativeLot.lot_id;
    await prisma.inventory_balance.createMany({
      data: [
        {
          legal_entity_id: entity.legal_entity_id,
          business_unit_id: unit.business_unit_id,
          plant_id: plant.plant_id,
          warehouse_id: warehouse.warehouse_id,
          location_id: location1.location_id,
          item_id: item.item_id,
          lot_id: lot.lot_id,
          quality_status_code: 'NORMAL',
          inventory_status_code: 'AVAILABLE',
          ownership_type_code: 'OWNED',
          on_hand_qty: 6,
          uom_id: uom.uom_id,
        },
        {
          legal_entity_id: entity.legal_entity_id,
          business_unit_id: unit.business_unit_id,
          plant_id: plant.plant_id,
          warehouse_id: warehouse.warehouse_id,
          location_id: location1.location_id,
          item_id: item.item_id,
          lot_id: lot.lot_id,
          quality_status_code: 'NORMAL',
          inventory_status_code: 'BLOCKED',
          ownership_type_code: 'OWNED',
          on_hand_qty: 4,
          uom_id: uom.uom_id,
        },
        {
          legal_entity_id: entity.legal_entity_id,
          business_unit_id: unit.business_unit_id,
          plant_id: plant.plant_id,
          warehouse_id: warehouse.warehouse_id,
          location_id: location2.location_id,
          item_id: item.item_id,
          lot_id: lot.lot_id,
          quality_status_code: 'NORMAL',
          inventory_status_code: 'AVAILABLE',
          ownership_type_code: 'OWNED',
          on_hand_qty: 0,
          uom_id: uom.uom_id,
        },
      ],
    });

    const blind = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-003`,
        count_type_code: 'CYCLE',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-09-10T00:00:00.000Z'),
        blind_count: true,
        status_code: 'IN_PROGRESS',
      },
    });
    blindId = Number(blind.inventory_count_id);
    const lines = await Promise.all([
      prisma.inventory_count_line.create({
        data: {
          inventory_count_id: blind.inventory_count_id,
          line_no: 1,
          location_id: location1.location_id,
          item_id: item.item_id,
          lot_id: lot.lot_id,
          system_qty: 100,
          counted_qty: 0,
          uom_id: uom.uom_id,
          counted_at: AT,
          counted: false,
        },
      }),
      prisma.inventory_count_line.create({
        data: {
          inventory_count_id: blind.inventory_count_id,
          line_no: 2,
          location_id: location2.location_id,
          item_id: item.item_id,
          lot_id: lot.lot_id,
          system_qty: 10,
          counted_qty: 8,
          uom_id: uom.uom_id,
          variance_reason_code: 'COUNT_ERROR',
          counted_by: userId,
          counted_at: AT,
          counted: true,
        },
      }),
    ]);
    const adjustment = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `${PREFIX}-IA`,
        inventory_count_id: blind.inventory_count_id,
        reason_code: 'COUNT_VARIANCE',
        status_code: 'POSTED',
      },
    });
    await prisma.inventory_adjustment_line.create({
      data: {
        inventory_adjustment_id: adjustment.inventory_adjustment_id,
        inventory_count_line_id: lines[1].inventory_count_line_id,
        line_no: 1,
        location_id: location2.location_id,
        item_id: item.item_id,
        lot_id: lot.lot_id,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        adjustment_qty: -2,
        uom_id: uom.uom_id,
        reason_code: 'COUNT_VARIANCE',
      },
    });

    const completed = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-002`,
        count_type_code: 'CYCLE',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-09-09T00:00:00.000Z'),
        status_code: 'COMPLETED',
      },
    });
    completedId = Number(completed.inventory_count_id);
    await prisma.inventory_count_line.create({
      data: {
        inventory_count_id: completed.inventory_count_id,
        line_no: 1,
        location_id: location1.location_id,
        item_id: item.item_id,
        lot_id: lot.lot_id,
        system_qty: 5,
        counted_qty: 5,
        uom_id: uom.uom_id,
        counted_by: userId,
        counted_at: AT,
        counted: true,
      },
    });

    const planned = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-001`,
        count_type_code: 'ADHOC',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-09-08T00:00:00.000Z'),
        status_code: 'PLANNED',
      },
    });
    plannedId = Number(planned.inventory_count_id);
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment_line WHERE inventory_adjustment_id IN
       (SELECT inventory_adjustment_id FROM inventory.inventory_adjustment
         WHERE inventory_adjustment_no LIKE '${PREFIX}%')`,
    );
    await prisma.inventory_adjustment.deleteMany({
      where: { inventory_adjustment_no: { startsWith: PREFIX } },
    });
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count_line WHERE inventory_count_id IN
       (SELECT inventory_count_id FROM inventory.inventory_count
         WHERE inventory_count_no LIKE '${PREFIX}%'
            OR created_by IN (SELECT app_user_id FROM app.app_user
                               WHERE login_id IN ('${LOGIN_ID}', '${NOPERM_ID}')))`,
    );
    await prisma.inventory_count.deleteMany({
      where: {
        OR: [
          { inventory_count_no: { startsWith: PREFIX } },
          { created_by: { in: (await prisma.app_user.findMany({
            where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
            select: { app_user_id: true },
          })).map((user) => user.app_user_id) } },
        ],
      },
    });
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_balance
        WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
    );
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: { startsWith: PREFIX } },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: { startsWith: PREFIX } },
    });
    const users = await prisma.app_user.findMany({
      where: { login_id: { in: [LOGIN_ID, NOPERM_ID] } },
      select: { app_user_id: true },
    });
    for (const user of users) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role !== null) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
