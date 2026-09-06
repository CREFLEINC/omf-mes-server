/**
 * 재고 예약 목록 — `GET /inventory/reservations`(I-8 PR ③).
 *
 * ⭐ 예약을 «거는» 오퍼레이션이 계약에 0건이라(I-8.md §5 · 문의 045) 이 표는 오늘 언제나
 *   비어 있다 — 픽스처로 두 행을 직접 INSERT 해 계약 스키마와 `openOnly` 를 가른다.
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`IRSVE2E`)로만 한다.
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

const LOGIN_ID = 'e2e-reservation-probe';
const PASSWORD = 'RSV-재고예약-비밀번호';
const PREFIX = 'IRSVE2E';
const BASE = '/api/inventory/reservations';

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const pointer =
    '/paths/~1inventory~1reservations/get/responses/200/content/application~1json/schema';
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface ReservationBody {
  inventoryReservationId: number;
  reservationNo: string;
  lotId: number | null;
  locationId: number | null;
  reservedQty: number;
  consumedQty: number;
}

describe('재고 예약 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = { plant: 0n, uom: 0n, item: 0n, warehouse: 0n, location: 0n, lot: 0n };
  let openId: number;
  let consumedId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('예약 목록이 계약 스키마를 만족한다(픽스처 1행)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?itemId=${Number(ids.item)}&lotId=${Number(ids.lot)}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator();
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.page).toMatchObject({ page: 1, size: 50, total: 1 });
    const [row] = response.body.items as ReservationBody[];
    expect(row).toMatchObject({
      inventoryReservationId: openId,
      reservationNo: `${PREFIX}-RS-OPEN`,
      reservedQty: 100,
      consumedQty: 30,
      lotId: Number(ids.lot),
      locationId: Number(ids.location),
    });
  });

  it('널 허용 칸은 널로 온다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?sourceDocumentId=987654&warehouseId=${Number(ids.warehouse)}`)
      .set('Cookie', cookie)
      .expect(200);

    // ⛔ 키 생략이 아니라 널이다(R-20 · 계약 `["integer","null"]`).
    const [row] = response.body.items as ReservationBody[];
    expect(row).toMatchObject({ inventoryReservationId: consumedId, lotId: null, locationId: null });
  });

  it('openOnly 는 소진된 예약을 거른다', async () => {
    const all = await request(app.getHttpServer())
      .get(`${BASE}?warehouseId=${Number(ids.warehouse)}`)
      .set('Cookie', cookie)
      .expect(200);
    // PK 역순이다(§8-1).
    expect((all.body.items as ReservationBody[]).map((row) => row.inventoryReservationId)).toEqual([
      consumedId,
      openId,
    ]);

    const open = await request(app.getHttpServer())
      .get(`${BASE}?warehouseId=${Number(ids.warehouse)}&openOnly=true`)
      .set('Cookie', cookie)
      .expect(200);

    // `reserved − released − consumed` 가 0 인 행이 빠진다 — 상태 문자열 축이 아니다.
    expect((open.body.items as ReservationBody[]).map((row) => row.inventoryReservationId)).toEqual([
      openId,
    ]);
    expect(open.body.page.total).toBe(1);
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '예약검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '예약검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '예약검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '예약검사자재',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '예약검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    ids.warehouse = warehouse.warehouse_id;
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '예약검사위치',
        location_type_code: 'BIN',
      },
    });
    ids.location = location.location_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    ids.lot = lot.lot_id;

    // 열린 예약 — 100 − 0 − 30 = 70 > 0.
    const open = await prisma.inventory_reservation.create({
      data: {
        reservation_no: `${PREFIX}-RS-OPEN`,
        reservation_type_code: 'MATERIAL',
        // 판별자 1값 — 계약 enum 이 `PRODUCTION_ORDER` 하나다.
        source_document_type_code: 'PRODUCTION_ORDER',
        source_document_id: 123456n,
        item_id: item.item_id,
        lot_id: lot.lot_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: location.location_id,
        reserved_qty: 100,
        released_qty: 0,
        consumed_qty: 30,
        uom_id: uom.uom_id,
        // ⛔ 서버가 이 값을 판정에 안 쓴다 — `src/` 에 상수를 두지 않는다(R-10 · `x-no-code-key`).
        status_code: 'OPEN',
      },
    });
    openId = Number(open.inventory_reservation_id);
    // 소진된 예약 — 40 − 10 − 30 = 0 이라 `openOnly` 에서 빠진다. LOT·위치는 널이다.
    const consumed = await prisma.inventory_reservation.create({
      data: {
        reservation_no: `${PREFIX}-RS-DONE`,
        reservation_type_code: 'MATERIAL',
        source_document_type_code: 'PRODUCTION_ORDER',
        source_document_id: 987654n,
        item_id: item.item_id,
        warehouse_id: warehouse.warehouse_id,
        reserved_qty: 40,
        released_qty: 10,
        consumed_qty: 30,
        uom_id: uom.uom_id,
        status_code: 'CONSUMED',
      },
    });
    consumedId = Number(consumed.inventory_reservation_id);
  }

  async function makeUser(): Promise<void> {
    // 계약이 403 을 선언하지 않은 조회다 — 권한 없이 세션만 있으면 된다.
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '예약검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    for (const sql of [
      `DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}%'`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
