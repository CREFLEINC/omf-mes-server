/**
 * 고객사 출하지시서 조회 2건 — `GET /logistics/sales-orders`(목록) ·
 * `GET /logistics/sales-orders/{salesOrderId}`(단건). 화면 `W-04-01`(I-22 PR ②).
 *
 * ⭐ 이 리소스는 «수신본»이라 등록 오퍼레이션이 계약에 0건이고 `seed.ts` 도 `logistics.sales_order`
 *   에 한 행도 안 넣는다 — 픽스처를 Prisma 로 직접 INSERT 한다.
 * ⭐ 축마다 값을 둘 이상 세웠다(README §6-3 ⑵) — 라인 수 1·2·3 · `erp_sales_order_no` 있음/없음 ·
 *   `requested_delivery_date` 있음/없음 · `version_no` 1/7 · 상태 둘 · 고객 둘 · 날짜 다섯.
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SOE2E`)로만 한다.
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

const LOGIN_ID = 'e2e-sales-order-probe';
const PASSWORD = 'SO-출하지시서-비밀번호';
const PREFIX = 'SOE2E';
const BASE = '/api/logistics/sales-orders';
/** 이 스위트가 세운 다섯 건만 본다 — 다른 스위트가 남긴 행에 흔들리지 않는다. */
const MINE = `q=${PREFIX}-SO`;

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface LineBody {
  salesOrderLineId: number;
  lineNo: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
  requestedDeliveryDate?: string;
  shippedQty: number;
}
interface OrderBody {
  salesOrderId: number;
  salesOrderNo: string;
  erpSalesOrderNo?: string;
  customerId: number;
  shipToPartnerId: number;
  orderDate: string;
  statusCode: string;
  lines?: LineBody[];
  versionNo?: number;
}
interface ListBody {
  items: OrderBody[];
  page: { page: number; size: number; total: number };
}

describe('고객사 출하지시서 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = { c1: 0, c2: 0, ship1: 0, ship2: 0, item1: 0, item2: 0, uom1: 0, uom2: 0 };
  /** `SO1` 편성됨 · `SO2` 미편성 · `SO3` 널 작업지시가 «안» 가리킴 · `SO2L`·`SO3L` 라인 2·3 */
  const so = { SO1: 0, SO2: 0, SO3: 0, SO2L: 0, SO3L: 0 };

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

  // ── S-1 ~ S-3 · 응답 모양 ────────────────────────────────────────────────
  it('S-1 목록이 계약 SalesOrder 스키마를 만족한다', async () => {
    const body = await list(MINE);

    const validate = validator('GET /logistics/sales-orders');
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(body.page.total).toBe(5);
    // ⭐ ajv 는 «타입»만 본다 — required 6칸이 제 출처에서 오는지는 값으로만 잡힌다(§6-3 ⑴).
    expect(row(body, so.SO1)).toMatchObject({
      salesOrderNo: `${PREFIX}-SO1`,
      customerId: ids.c1,
      shipToPartnerId: ids.ship1,
      orderDate: '2026-08-06',
      statusCode: 'RECEIVED',
    });
    expect(row(body, so.SO2)).toMatchObject({
      shipToPartnerId: ids.ship1,
      orderDate: '2026-08-07',
      statusCode: 'CONFIRMED',
    });
  });

  it('S-2 erpSalesOrderNo 가 없는 행은 키를 «생략»한다(있는 행은 싣는다)', async () => {
    const body = await list(MINE);

    expect(row(body, so.SO2)).not.toHaveProperty('erpSalesOrderNo');
    expect(row(body, so.SO1).erpSalesOrderNo).toBe(`ERP-${PREFIX}-1`);
  });

  it('S-3 목록이 lines 를 싣고 라인 수가 2·3 으로 갈린다', async () => {
    const body = await list(MINE);

    expect(row(body, so.SO2L).lines).toHaveLength(2);
    expect(row(body, so.SO3L).lines).toHaveLength(3);
    expect(row(body, so.SO1).lines).toHaveLength(1);
  });

  // ── S-4 ~ S-7 · 고객·기간 필터 ──────────────────────────────────────────
  it('S-4 customerId 로 거르면 다른 고객(C2)의 지시서가 빠진다', async () => {
    const body = await list(`${MINE}&customerId=${ids.c1}`);

    expect(idsOf(body)).toEqual([so.SO3, so.SO2, so.SO1]);
  });

  it('S-5 orderDateFrom 은 «같은 날»을 포함한다', async () => {
    const body = await list(`${MINE}&orderDateFrom=2026-08-10`);

    expect(idsOf(body)).toEqual([so.SO3L]);
  });

  it('S-6 orderDateTo 는 «같은 날»을 포함한다', async () => {
    const body = await list(`${MINE}&orderDateTo=2026-08-06`);

    expect(idsOf(body)).toEqual([so.SO1]);
  });

  it('S-7 From·To 를 함께 주면 바깥 행이 빠진다', async () => {
    const body = await list(`${MINE}&orderDateFrom=2026-08-07&orderDateTo=2026-08-09`);

    expect(idsOf(body)).toEqual([so.SO2L, so.SO3, so.SO2]);
  });

  // ── S-8 ~ S-10 · unassignedOnly ────────────────────────────────────────
  it('S-8 unassignedOnly=true 가 편성된 SO1 을 빼고 미편성 SO2 를 낸다', async () => {
    const body = await list(`${MINE}&unassignedOnly=true`);

    expect(idsOf(body)).not.toContain(so.SO1);
    expect(idsOf(body)).toContain(so.SO2);
  });

  it('S-9 sales_order_id 가 NULL 인 작업지시가 있어도 목록이 비지 않는다(NOT IN 함정)', async () => {
    // ⭐ `NOT IN` 으로 쓰면 SQL 3값 논리로 «통째로» 빈다 — 그 변이를 여기서 죽인다.
    expect(
      await prisma.shipment_request.count({
        where: { shipment_request_no: { startsWith: PREFIX }, sales_order_id: null },
      }),
    ).toBe(1);

    const body = await list(`${MINE}&unassignedOnly=true`);

    expect(idsOf(body)).toEqual([so.SO3L, so.SO2L, so.SO3, so.SO2]);
  });

  it('S-10 unassignedOnly=false 는 필터를 «안 건다» — 편성된 것도 낸다', async () => {
    const body = await list(`${MINE}&unassignedOnly=false`);

    expect(idsOf(body)).toEqual([so.SO3L, so.SO2L, so.SO3, so.SO2, so.SO1]);
  });

  // ── S-11 ~ S-13 · q · statusCode ───────────────────────────────────────
  it('S-11 q 가 sales_order_no 부분일치다(완전일치가 아니다)', async () => {
    const body = await list(`q=${PREFIX}-SO3`);

    expect(idsOf(body)).toEqual([so.SO3L, so.SO3]);
    // ⭐ 계획서에 없던 두 «추가» 동작을 잠근다(README §6-2 마지막 문단) — 접두사만 대면
    //   `startsWith` 로 좁혀도 통과하고, 저장값 그대로 대면 `mode:'insensitive'` 제거도
    //   통과한다. 중간 일치와 소문자를 각각 대야 둘이 죽는다.
    expect(idsOf(await list('q=E2E-SO3'))).toEqual([so.SO3L, so.SO3]);
    expect(idsOf(await list(`q=${PREFIX.toLowerCase()}-so3`))).toEqual([so.SO3L, so.SO3]);
  });

  it('S-12 q 는 erp_sales_order_no 를 «안» 본다', async () => {
    const body = await list(`q=ERP-${PREFIX}-1`);

    expect(body.items).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  it('S-13 statusCode 로 거른다', async () => {
    const body = await list(`${MINE}&statusCode=CONFIRMED`);

    expect(idsOf(body)).toEqual([so.SO2]);
  });

  // ── S-14 ~ S-15 · 정렬·페이징 ───────────────────────────────────────────
  it('S-14 정렬이 sales_order_id 내림차순이다', async () => {
    const body = await list(MINE);

    expect(idsOf(body)).toEqual([so.SO3L, so.SO2L, so.SO3, so.SO2, so.SO1]);
  });

  it('S-15 page=2&size=1 이 1쪽과 겹치지 않는다', async () => {
    const first = await list(`${MINE}&page=1&size=1`);
    const second = await list(`${MINE}&page=2&size=1`);

    expect(idsOf(first)).toEqual([so.SO3L]);
    expect(idsOf(second)).toEqual([so.SO2L]);
    expect(second.page).toEqual({ page: 2, size: 1, total: 5 });
  });

  // ── S-16 ~ S-20 · 단건 ─────────────────────────────────────────────────
  it('S-16 단건이 계약 스키마를 만족하고 lines 를 함께 낸다', async () => {
    const body = await detail(so.SO3L);

    const validate = validator('GET /logistics/sales-orders/{salesOrderId}');
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(body.lines).toHaveLength(3);
    expect((body.lines as LineBody[]).map((line) => line.lineNo)).toEqual([1, 2, 3]);
  });

  it('S-17 SalesOrderLine 의 required 6칸이 «제 출처»에서 온다', async () => {
    const body = await detail(so.SO3L);
    const lines = body.lines as LineBody[];

    // ⭐ 여섯 칸이 서로 다른 값이라 뒤바꿈(예: orderedQty ↔ shippedQty)이 «값»에서 잡힌다.
    //   ajv 는 타입만 보므로 이 단언이 없으면 그 변이가 초록이다(README §6-3 ⑴).
    expect(lines[0]).toMatchObject({
      lineNo: 1,
      itemId: ids.item1,
      orderedQty: 120,
      uomId: ids.uom1,
      shippedQty: 30,
    });
    expect(lines[1]).toMatchObject({
      lineNo: 2,
      itemId: ids.item2,
      orderedQty: 240,
      uomId: ids.uom2,
      shippedQty: 60,
    });
    expect(lines[2]).toMatchObject({ lineNo: 3, orderedQty: 360, shippedQty: 90 });
    // ⛔ `Set(...).size` 로는 안 잠긴다 — 「서로 다르다」만 보므로 `line_no`(1·2·3)나
    //   `ordered_qty`(120·240·360)에서 가져와도 통과한다. 저장된 PK 와 통째로 맞춘다.
    const stored = await prisma.sales_order_line.findMany({
      where: { sales_order_id: BigInt(so.SO3L) },
      orderBy: { line_no: 'asc' },
      select: { sales_order_line_id: true },
    });
    expect(lines.map((line) => line.salesOrderLineId)).toEqual(
      stored.map((row) => Number(row.sales_order_line_id)),
    );
  });

  it('S-18 requestedDeliveryDate 가 없는 라인은 키를 «생략»한다(있는 라인은 싣는다)', async () => {
    const lines = (await detail(so.SO3L)).lines as LineBody[];

    expect(lines[0].requestedDeliveryDate).toBe('2026-08-20');
    expect(lines[1]).not.toHaveProperty('requestedDeliveryDate');
    expect(lines[2].requestedDeliveryDate).toBe('2026-08-22');
  });

  it('S-19 없는 salesOrderId 는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/${so.SO3L + 9_999_999}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('S-20 versionNo 가 저장값 그대로다(상수가 아니다)', async () => {
    expect((await detail(so.SO2)).versionNo).toBe(7);
    expect((await detail(so.SO1)).versionNo).toBe(1);
  });

  // ── 헬퍼 ────────────────────────────────────────────────────────────────
  async function list(query: string): Promise<ListBody> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as ListBody;
  }

  async function detail(salesOrderId: number): Promise<OrderBody> {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${salesOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as OrderBody;
  }

  function idsOf(body: ListBody): number[] {
    return body.items.map((item) => item.salesOrderId);
  }

  function row(body: ListBody, salesOrderId: number): OrderBody {
    const found = body.items.find((item) => item.salesOrderId === salesOrderId);
    if (!found) throw new Error(`목록에 ${salesOrderId} 가 없다`);
    return found;
  }

  async function makeFixtures(): Promise<void> {
    const [uom1, uom2] = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    ids.uom1 = Number(uom1.uom_id);
    ids.uom2 = Number(uom2.uom_id);

    for (const [key, suffix] of [
      ['item1', 'IT1'],
      ['item2', 'IT2'],
    ] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `출하지시서검사품목${suffix}`,
          item_type_code: 'FINISHED',
          base_uom_id: uom1.uom_id,
        },
      });
      ids[key] = Number(item.item_id);
    }

    // ⭐ 배송처를 고객과 «다른» 파트너로 세운다 — 둘이 같으면 두 칸을 뒤바꿔도 안 잡힌다.
    for (const [key, suffix] of [
      ['c1', 'C1'],
      ['c2', 'C2'],
      ['ship1', 'SH1'],
      ['ship2', 'SH2'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `출하지시서검사파트너${suffix}` },
      });
      ids[key] = Number(partner.partner_id);
    }

    // 라인 하나짜리 셋 — 고객 C1 · 날짜 08-06/07/08 · 상태 둘 · `version_no` 1/7.
    so.SO1 = await order('SO1', ids.c1, ids.ship1, '2026-08-06', 'RECEIVED', `ERP-${PREFIX}-1`, 1, 1);
    so.SO2 = await order('SO2', ids.c1, ids.ship1, '2026-08-07', 'CONFIRMED', null, 7, 1);
    so.SO3 = await order('SO3', ids.c1, ids.ship2, '2026-08-08', 'RECEIVED', null, 1, 1);
    // 라인 2·3 짜리 — 고객 C2. 라인 수 축에 값이 셋이라 `lines` 투영이 공허하지 않다.
    so.SO2L = await order('SO2L', ids.c2, ids.ship2, '2026-08-09', 'RECEIVED', `ERP-${PREFIX}-2`, 1, 2);
    so.SO3L = await order('SO3L', ids.c2, ids.ship1, '2026-08-10', 'RECEIVED', `ERP-${PREFIX}-3`, 1, 3);

    // SO1 을 «편성된» 것으로 만든다(A13 링크).
    await shipmentRequest('SR-ASSIGNED', so.SO1);
    // ⭐ `sales_order_id` 가 NULL 인 작업지시 — `NOT IN` 이면 목록이 통째로 빈다(S-9).
    await shipmentRequest('SR-NULL', null);
  }

  async function order(
    key: string,
    customerId: number,
    shipToPartnerId: number,
    orderDate: string,
    statusCode: string,
    erpNo: string | null,
    versionNo: number,
    lineCount: number,
  ): Promise<number> {
    const created = await prisma.sales_order.create({
      data: {
        sales_order_no: `${PREFIX}-${key}`,
        erp_sales_order_no: erpNo,
        customer_id: BigInt(customerId),
        ship_to_partner_id: BigInt(shipToPartnerId),
        order_date: new Date(`${orderDate}T00:00:00.000Z`),
        status_code: statusCode,
        version_no: versionNo,
        sales_order_line: {
          create: Array.from({ length: lineCount }, (_, index) => ({
            line_no: index + 1,
            // 라인마다 품목·단위·수량이 갈린다 — 투영 뒤바꿈을 값으로 잡는다(S-17).
            item_id: BigInt(index % 2 === 0 ? ids.item1 : ids.item2),
            uom_id: BigInt(index % 2 === 0 ? ids.uom1 : ids.uom2),
            ordered_qty: 120 * (index + 1),
            shipped_qty: 30 * (index + 1),
            // 둘째 라인만 납기가 없다 — 키 생략 축에 값이 둘이 된다(S-18).
            requested_delivery_date:
              index === 1 ? null : new Date(`2026-08-${20 + index}T00:00:00.000Z`),
          })),
        },
      },
    });
    return Number(created.sales_order_id);
  }

  async function shipmentRequest(key: string, salesOrderId: number | null): Promise<void> {
    await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-${key}`,
        customer_id: BigInt(ids.c1),
        ship_to_partner_id: BigInt(ids.c1),
        requested_ship_date: new Date('2026-08-15T00:00:00.000Z'),
        status_code: 'REGISTERED',
        sales_order_id: salesOrderId === null ? null : BigInt(salesOrderId),
      },
    });
  }

  async function makeUser(): Promise<void> {
    // 계약이 403 을 선언하지 않은 조회 둘이다 — 권한 없이 세션만 있으면 된다.
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하지시서검사', status_code: 'EMPLOYED' },
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
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.sales_order_line WHERE sales_order_id IN (
         SELECT sales_order_id FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
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
