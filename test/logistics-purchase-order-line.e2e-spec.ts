/**
 * 입하 예정 — P/O 라인 목록 `GET /logistics/purchase-order-lines`(화면 `W-01-09` · 장부 P-77 · #741).
 *
 * ASN 이 들어오는 길이 없어 입하 예정을 아직 다 들어오지 않은 P/O 라인으로 본다. 조회 전용이라
 * 픽스처는 `prisma.purchase_order(_line).create` 로 직접 세운다(ASN e2e 선례). 다른 스위트의
 * 행이 섞이지 않게 모든 조회를 이 스위트의 공급사로 좁힌다.
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

const LOGIN_ID = 'e2e-po-line-probe';
const PASSWORD = 'PO-라인-입하예정-검사-비밀번호';
const PREFIX = 'POLE2E';

/** 지난 납기(지연) · 먼 납기 둘 — 「오늘」이 언제든 지연 판정이 흔들리지 않게 고른다. */
const PAST = '2026-01-10';
const FAR_A = '2099-12-30';
const FAR_B = '2099-12-31';

interface Row {
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  plantId: number;
  orderDate: string;
  expectedReceiptDate: string | null;
  statusCode: string;
  purchaseOrderLineId: number;
  lineNo: number;
  itemId: number;
  uomId: number;
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  toleranceOverQty: number;
  toleranceUnderQty: number;
  erpStorageLocationCode: string | null;
  cancelledAt: string | null;
  receiptStatusCode: string;
}
interface Page {
  items: Row[];
  page: { page: number; size: number; total: number };
}

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const pointer = '/paths/~1logistics~1purchase-order-lines/get/responses/200/content/application~1json/schema';
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('입하 예정 — P/O 라인 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let supplierId: bigint;
  let plantId: bigint;
  let businessUnitId: bigint;
  let itemId: bigint;
  let otherItemId: bigint;
  let uomId: bigint;
  /** 라인 id — `<P/O 글자><라인번호>`. */
  const line: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeOrders();
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('기본(openOnly)은 다 들어오지 않았고 취소되지 않은 라인만 — 납기 순, 없는 납기는 뒤', async () => {
    const body = await list('');

    expect(body.items.map((row) => row.purchaseOrderLineId)).toEqual([line.A1, line.A4, line.B1, line.D1]);
    expect(body.page).toEqual({ page: 1, size: 50, total: 4 });
  });

  it('응답이 계약 사본 InboundScheduleLine 목록을 만족하고, 헤더 칸을 한 줄에 싣는다', async () => {
    const body = await list('');

    const validate = validator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(body.items[0]).toEqual({
      purchaseOrderId: expect.any(Number),
      purchaseOrderNo: `${PREFIX}-A`,
      erpPurchaseOrderNo: `${PREFIX}ERPA`,
      supplierId: Number(supplierId),
      plantId: Number(plantId),
      orderDate: '2026-01-02',
      expectedReceiptDate: PAST,
      statusCode: 'REGISTERED',
      purchaseOrderLineId: line.A1,
      lineNo: 1,
      itemId: Number(itemId),
      uomId: Number(uomId),
      orderedQty: 100,
      receivedQty: 40,
      remainingQty: 60,
      toleranceOverQty: 5,
      toleranceUnderQty: 3,
      erpStorageLocationCode: 'W100',
      cancelledAt: null,
      receiptStatusCode: 'PARTIAL',
    });
  });

  it('⛔ 부족 허용치 안이어도 다 들어온 것이 아니다 — 9.5/10(부족 허용 1)은 PARTIAL·남은 0.5', async () => {
    const row = (await list('')).items.find((item) => item.purchaseOrderLineId === line.A4);
    expect(row).toMatchObject({ receiptStatusCode: 'PARTIAL', remainingQty: 0.5, toleranceUnderQty: 1 });
  });

  it('openOnly=false 면 다 들어온·취소된 라인과 취소된 P/O 도 낸다 — 초과 입하의 남은 수량은 0', async () => {
    const body = await list('openOnly=false');

    expect(body.items.map((row) => row.purchaseOrderLineId)).toEqual([
      line.A1,
      line.A2,
      line.A3,
      line.A4,
      line.A5,
      line.C1,
      line.B1,
      line.D1,
    ]);
    const byId = new Map(body.items.map((row) => [row.purchaseOrderLineId, row]));
    expect(byId.get(line.A2)).toMatchObject({ receiptStatusCode: 'COMPLETED', remainingQty: 0 });
    expect(byId.get(line.A5)).toMatchObject({ receiptStatusCode: 'COMPLETED', remainingQty: 0, receivedQty: 12 });
    expect(byId.get(line.A3)).toMatchObject({ receiptStatusCode: 'NOT_STARTED', remainingQty: 30 });
    expect(byId.get(line.A3)?.cancelledAt).toEqual(expect.any(String));
    expect(byId.get(line.C1)).toMatchObject({ statusCode: 'CANCELLED', receiptStatusCode: 'NOT_STARTED' });
  });

  it('overdueOnly 는 공장 현지 오늘보다 납기가 앞선 미완 라인만 — openOnly=false 여도', async () => {
    expect((await list('overdueOnly=true')).items.map((row) => row.purchaseOrderLineId)).toEqual([
      line.A1,
      line.A4,
    ]);
    expect(
      (await list('overdueOnly=true&openOnly=false')).items.map((row) => row.purchaseOrderLineId),
    ).toEqual([line.A1, line.A4]);
  });

  it('납기 범위는 양끝 포함이고, 납기가 없는 P/O 는 빠진다', async () => {
    const body = await list(`openOnly=false&expectedReceiptDateFrom=${FAR_A}&expectedReceiptDateTo=${FAR_B}`);
    expect(body.items.map((row) => row.purchaseOrderLineId)).toEqual([line.C1, line.B1]);

    const only = await list(`expectedReceiptDateFrom=${FAR_B}`);
    expect(only.items.map((row) => row.purchaseOrderLineId)).toEqual([line.B1]);
  });

  it('q 는 발주번호와 ERP 발주번호를 함께 본다', async () => {
    expect((await list(`q=${PREFIX.toLowerCase()}erpb`)).items.map((row) => row.purchaseOrderLineId)).toEqual([
      line.B1,
    ]);
    expect((await list(`q=${PREFIX}-D`)).items.map((row) => row.purchaseOrderLineId)).toEqual([line.D1]);
  });

  it('itemId·plantId 로 좁힌다', async () => {
    expect((await list(`itemId=${otherItemId}`)).items.map((row) => row.purchaseOrderLineId)).toEqual([line.B1]);
    expect((await list(`plantId=${plantId}`)).page.total).toBe(4);
    expect((await list('plantId=999999999')).items).toEqual([]);
  });

  it('쪽은 라인 기준이다 — size=2 의 둘째 쪽', async () => {
    const body = await list('page=2&size=2');
    expect(body.items.map((row) => row.purchaseOrderLineId)).toEqual([line.B1, line.D1]);
    expect(body.page).toEqual({ page: 2, size: 2, total: 4 });
  });

  it.each(['2026-02-30', '2026/10/01', '20261001'])(
    '⛔ 날짜 형식이 아니면 400 INVALID — %s',
    async (value) => {
      const response = await request(app.getHttpServer())
        .get(`/api/logistics/purchase-order-lines?expectedReceiptDateFrom=${encodeURIComponent(value)}`)
        .set('Cookie', cookie)
        .expect(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({ scope: 'field', field: 'expectedReceiptDateFrom', code: 'INVALID' }),
      ]);
    },
  );

  it('⛔ 로그인 없이는 401 이다', async () => {
    await request(app.getHttpServer()).get('/api/logistics/purchase-order-lines').expect(401);
  });

  async function list(query: string): Promise<Page> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-order-lines?supplierId=${supplierId}${query ? `&${query}` : ''}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as Page;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '입하예정검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '입하예정검사사업부',
      },
    });
    businessUnitId = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '입하예정검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = plant.plant_id;

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    for (const [code, assign] of [
      [`${PREFIX}-IT1`, (id: bigint) => (itemId = id)],
      [`${PREFIX}-IT2`, (id: bigint) => (otherItemId = id)],
    ] as const) {
      const item = await prisma.item.create({
        data: { item_code: code, item_name: code, item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id },
      });
      assign(item.item_id);
    }

    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP`, partner_name: '입하예정검사공급사' },
    });
    supplierId = supplier.partner_id;
  }

  /**
   * A(지난 납기 · 다섯 라인: 진행 중 · 다 들어옴 · ERP 취소 · 부족 허용치 안 · 초과 입하) ·
   * B(먼 납기 · 다른 품목) · C(먼 납기 · 헤더 취소) · D(납기 없음).
   */
  async function makeOrders(): Promise<void> {
    const order = async (
      letter: string,
      expected: string | null,
      statusCode = 'REGISTERED',
    ): Promise<bigint> => {
      const row = await prisma.purchase_order.create({
        data: {
          purchase_order_no: `${PREFIX}-${letter}`,
          erp_purchase_order_no: `${PREFIX}ERP${letter}`,
          supplier_id: supplierId,
          business_unit_id: businessUnitId,
          plant_id: plantId,
          order_date: new Date('2026-01-02T00:00:00.000Z'),
          expected_receipt_date: expected === null ? null : new Date(`${expected}T00:00:00.000Z`),
          status_code: statusCode,
        },
      });
      return row.purchase_order_id;
    };
    const add = async (
      key: string,
      purchaseOrderId: bigint,
      lineNo: number,
      values: {
        ordered: number;
        received: number;
        over?: number;
        under?: number;
        item?: bigint;
        cancelled?: boolean;
        storage?: string;
      },
    ): Promise<void> => {
      const row = await prisma.purchase_order_line.create({
        data: {
          purchase_order_id: purchaseOrderId,
          line_no: lineNo,
          item_id: values.item ?? itemId,
          ordered_qty: values.ordered,
          uom_id: uomId,
          received_qty: values.received,
          tolerance_over_qty: values.over ?? 0,
          tolerance_under_qty: values.under ?? 0,
          erp_storage_location_code: values.storage ?? null,
          cancelled_at: values.cancelled ? new Date('2026-01-05T00:00:00.000Z') : null,
        },
      });
      line[key] = Number(row.purchase_order_line_id);
    };

    const a = await order('A', PAST);
    await add('A1', a, 1, { ordered: 100, received: 40, over: 5, under: 3, storage: 'W100' });
    await add('A2', a, 2, { ordered: 50, received: 50 });
    await add('A3', a, 3, { ordered: 30, received: 0, cancelled: true });
    await add('A4', a, 4, { ordered: 10, received: 9.5, under: 1 });
    await add('A5', a, 5, { ordered: 10, received: 12, over: 5 });

    await add('B1', await order('B', FAR_B), 1, { ordered: 20, received: 0, item: otherItemId });
    await add('C1', await order('C', FAR_A, 'CANCELLED'), 1, { ordered: 10, received: 0 });
    await add('D1', await order('D', null), 1, { ordered: 5, received: 0 });
  }

  async function login(): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '입하예정검사', status_code: 'EMPLOYED' },
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
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const ownPlants = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
