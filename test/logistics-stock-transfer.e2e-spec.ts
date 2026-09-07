/**
 * 재고 이동 조회 3건(I-13 PR ①). 등록·도착·라인 치환·판별자 축은 PR ②③④ 몫이다.
 *
 * ⚠ 픽스처는 prisma 로 직접 심는다 — `POST /logistics/stock-transfers` 가 아직 없다
 * (PR ② 몫). 반출·도착도 없어 원장을 만들지 않는다 ⇒ 이 스위트는 `inventory_transaction`
 * 을 안 건드리고 `TRUNCATE` 도 필요 없다(`stock_transfer`·`stock_transfer_line` 을
 * 접두어로 직접 지운다).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-st-probe';
const PASSWORD = 'ST-검사-비밀번호';
const PREFIX = 'STE2E';
const ROLE = 'E2E_ST';
const PERMISSIONS = ['M-01-10'];

interface StockTransferBody {
  stockTransferId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  transferTypeCode: string;
  statusCode: string;
  requestedAt: string;
  shippedAt: string | null;
  receivedAt: string | null;
}
interface DetailBody {
  stockTransfer: StockTransferBody;
  lines: { stockTransferLineId: number; itemId: number; lotId: number }[];
}

describe('재고 이동 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let businessUnitId: number;
  let warehouse1Id: number;
  let warehouse2Id: number;
  let warehouse3Id: number;
  let location1Id: number;
  let location2Id: number;
  let uomId: number;
  let itemId: number;
  let lotId: number;

  let srA: number;
  let srB: number;
  let srC: number;
  let srD: number;
  let srE: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    await makeStockTransfers();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 fromWarehouseId·toWarehouseId 로 걸러진다', async () => {
    const byFrom = await list(`fromWarehouseId=${warehouse1Id}`);
    expect(byFrom.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srD].sort(),
    );

    const byTo = await list(`toWarehouseId=${warehouse2Id}`);
    expect(byTo.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srD, srE].sort(),
    );
  });

  it('목록이 transferTypeCode·statusCode 로 걸러진다', async () => {
    const byType = await list('transferTypeCode=DEFECT_RETURN');
    expect(byType.items.map((row) => row.stockTransferId)).toEqual([srB]);

    const byStatus = await list('statusCode=REGISTERED');
    expect(byStatus.items.map((row) => row.stockTransferId).sort()).toEqual(
      [srA, srC, srE].sort(),
    );
  });

  it('⭐ inTransitOnly=true 는 반출됐고 도착 안 한 건만 낸다', async () => {
    // srB·srD 는 도착까지 끝났고(도착 완료), srA·srE 는 반출 전이다 — 도착 완료 건이
    // 안 나오는 것으로 「반출됐으나 도착 안 함」 축을 증명한다.
    const { items } = await list('inTransitOnly=true');
    expect(items.map((row) => row.stockTransferId)).toEqual([srC]);
  });

  it('requestedAtFrom·requestedAtTo 가 UTC 하루 경계로 자른다', async () => {
    const { items } = await list('requestedAtFrom=2026-05-11&requestedAtTo=2026-05-12');
    expect(items.map((row) => row.stockTransferId).sort()).toEqual([srB, srC].sort());
  });

  it('statusCode=POSTED × inTransitOnly=true 는 빈 목록이고 400 이 아니다', async () => {
    const { items } = await list('statusCode=POSTED&inTransitOnly=true');
    expect(items).toEqual([]);
  });

  it('목록이 requested_at desc · PK desc 로 온다', async () => {
    const { items } = await list(`toWarehouseId=${warehouse2Id}`);
    expect(items.map((row) => row.stockTransferId)).toEqual([srE, srD, srC, srA]);
  });

  it('상세가 ETag 로 version_no 를 내리고 lines 를 함께 싣는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers/${srA}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toBe('1');
    const body = response.body as DetailBody;
    expect(body.stockTransfer.stockTransferId).toBe(srA);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].itemId).toBe(itemId);
    expect(body.lines[0].lotId).toBe(lotId);
  });

  it('없는 전표의 상세·라인 목록은 둘 다 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/stock-transfers/999999999')
      .set('Cookie', cookie)
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/logistics/stock-transfers/999999999/lines')
      .set('Cookie', cookie)
      .expect(404);
  });

  async function list(query: string): Promise<{ items: StockTransferBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/stock-transfers?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as { items: StockTransferBody[] };
  }

  async function makeStockTransfers(): Promise<void> {
    srA = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-10T09:00:00.000Z',
      withLine: true,
    });
    srB = await makeTransfer({
      fromWarehouseId: warehouse2Id,
      toWarehouseId: warehouse1Id,
      transferTypeCode: 'DEFECT_RETURN',
      statusCode: 'POSTED',
      requestedAt: '2026-05-11T09:00:00.000Z',
      shippedAt: '2026-05-11T10:00:00.000Z',
      receivedAt: '2026-05-11T11:00:00.000Z',
    });
    srC = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-12T09:00:00.000Z',
      shippedAt: '2026-05-12T10:00:00.000Z',
    });
    srD = await makeTransfer({
      fromWarehouseId: warehouse1Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'POSTED',
      requestedAt: '2026-05-13T09:00:00.000Z',
      shippedAt: '2026-05-13T10:00:00.000Z',
      receivedAt: '2026-05-13T11:00:00.000Z',
    });
    srE = await makeTransfer({
      fromWarehouseId: warehouse3Id,
      toWarehouseId: warehouse2Id,
      transferTypeCode: 'NORMAL',
      statusCode: 'REGISTERED',
      requestedAt: '2026-05-14T09:00:00.000Z',
    });
  }

  async function makeTransfer(spec: {
    fromWarehouseId: number;
    toWarehouseId: number;
    transferTypeCode: string;
    statusCode: string;
    requestedAt: string;
    shippedAt?: string;
    receivedAt?: string;
    withLine?: boolean;
  }): Promise<number> {
    const row = await prisma.stock_transfer.create({
      data: {
        stock_transfer_no: `${PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        transfer_type_code: spec.transferTypeCode,
        from_business_unit_id: businessUnitId,
        to_business_unit_id: businessUnitId,
        from_warehouse_id: spec.fromWarehouseId,
        to_warehouse_id: spec.toWarehouseId,
        requested_at: new Date(spec.requestedAt),
        shipped_at: spec.shippedAt ? new Date(spec.shippedAt) : null,
        received_at: spec.receivedAt ? new Date(spec.receivedAt) : null,
        status_code: spec.statusCode,
      },
    });
    if (spec.withLine) {
      await prisma.stock_transfer_line.create({
        data: {
          stock_transfer_id: row.stock_transfer_id,
          line_no: 1,
          item_id: itemId,
          lot_id: lotId,
          requested_qty: 10,
          uom_id: uomId,
          from_location_id: location1Id,
          to_location_id: location2Id,
        },
      });
    }
    return Number(row.stock_transfer_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '이동검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '이동검사사업부',
      },
    });
    businessUnitId = Number(unit.business_unit_id);
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '이동검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    const warehouse1 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH1`,
        warehouse_name: '이동검사출발창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse1Id = Number(warehouse1.warehouse_id);
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '이동검사도착창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse2Id = Number(warehouse2.warehouse_id);
    const warehouse3 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH3`,
        warehouse_name: '이동검사다른창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse3Id = Number(warehouse3.warehouse_id);

    const location1 = await prisma.location.create({
      data: {
        warehouse_id: warehouse1.warehouse_id,
        location_code: `${PREFIX}-LOC1`,
        location_name: '이동검사출발위치',
        location_type_code: 'BIN',
      },
    });
    location1Id = Number(location1.location_id);
    const location2 = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '이동검사도착위치',
        location_type_code: 'BIN',
      },
    });
    location2Id = Number(location2.location_id);

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '이동검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-1`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lotId = Number(lot.lot_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '이동검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '이동검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    cookie = await login(LOGIN_ID);
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

  /** ⛔ 이 스위트는 원장을 안 만든다 — TRUNCATE 가 필요 없다(픽스처를 prisma 로 직접 심는다). */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.stock_transfer_line
       WHERE stock_transfer_id IN (
             SELECT stock_transfer_id FROM logistics.stock_transfer
              WHERE stock_transfer_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.stock_transfer WHERE stock_transfer_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    await prisma.role_permission.deleteMany({ where: { role: { role_code: ROLE } } });
    await prisma.role.deleteMany({ where: { role_code: ROLE } });
  }
});
