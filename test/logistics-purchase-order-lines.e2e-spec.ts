/**
 * 입하 예정 — 구매발주 라인 목록 `GET /logistics/purchase-order-lines`(장부 P-78 · #741).
 * 계약 사본에 없는 경로라 인증·질의 검증을 컨트롤러가 직접 한다 — 401·400 도 여기서 본다.
 * 발주 목록 `openOnly` 가 ERP 취소 라인만 남은 발주를 빼는 것(같은 기준)도 함께 본다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-POLINES';
const PATH = '/api/logistics/purchase-order-lines';
const PAST = '2000-01-10';
const SOON = '2099-01-01';
const LATER = '2099-12-01';

interface Item {
  purchaseOrderNo: string;
  lineNo: number;
  remainingQty: number;
  receiptStatusCode: string;
  expectedReceiptDate: string | null;
  erpPurchaseOrderNo: string | null;
}
interface Page {
  items: Item[];
  page: { page: number; size: number; total: number };
}

describe('입하 예정 — 구매발주 라인 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const list = async (query: Record<string, string>): Promise<Page> =>
    (
      await request(app.getHttpServer())
        .get(PATH)
        .query({ plantId: ids.plant.toString(), ...query })
        .set('Cookie', cookie)
        .expect(200)
    ).body as Page;
  const keys = (page: Page): string[] => page.items.map((i) => `${i.purchaseOrderNo.slice(PREFIX.length + 1)}#${i.lineNo}`);

  it('⛔ 로그인이 없으면 401 이다 — 가드 밖 경로라 컨트롤러가 직접 막는다', async () => {
    const response = await request(app.getHttpServer()).get(PATH).expect(401);
    expect(response.body.errors[0]).toMatchObject({ scope: 'screen', code: 'PERMISSION_DENIED' });
  });

  it('⛔ 틀린 질의는 칸마다 400 INVALID 다', async () => {
    const response = await request(app.getHttpServer())
      .get(PATH)
      .query({ plantId: 'abc', expectedReceiptDateTo: '2026-02-30', openOnly: 'yes' })
      .set('Cookie', cookie)
      .expect(400);
    expect(response.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual([
      'plantId:INVALID',
      'expectedReceiptDateTo:INVALID',
      'openOnly:INVALID',
    ]);
  });

  it('⭐ 기본은 남은 라인만 — 다 받은·ERP 취소·취소 헤더 라인을 빼고 납기 순(없으면 뒤)이다', async () => {
    const page = await list({});
    expect(keys(page)).toEqual(['A#1', 'A#2', 'D#1', 'B#1']);
    expect(page.page.total).toBe(4);
    expect(page.items.map((i) => [i.receiptStatusCode, i.remainingQty])).toEqual([
      ['NOT_STARTED', 100],
      ['PARTIAL', 30],
      ['NOT_STARTED', 8],
      ['NOT_STARTED', 5],
    ]);
    expect(page.items[3].expectedReceiptDate).toBeNull();
  });

  it('openOnly=false 면 끝난 라인도 판정과 함께 싣는다 — 취소 라인의 남은 수량은 0', async () => {
    const page = await list({ openOnly: 'false' });
    expect(keys(page)).toEqual(['A#1', 'A#2', 'A#3', 'A#4', 'C#1', 'D#1', 'B#1', 'E#1']);
    expect(page.items.map((i) => `${i.receiptStatusCode}:${i.remainingQty}`)).toEqual([
      'NOT_STARTED:100',
      'PARTIAL:30',
      'COMPLETED:0',
      'CANCELLED:0',
      'CANCELLED:0',
      'NOT_STARTED:8',
      'NOT_STARTED:5',
      'CANCELLED:0',
    ]);
  });

  it('⭐ 납기 지남은 공장 현지 오늘보다 앞인 남은 라인만이다', async () => {
    expect(keys(await list({ overdueOnly: 'true' }))).toEqual(['A#1', 'A#2']);
  });

  it('납기 범위 · 품목 · 공급사 · ERP 발주번호 검색으로 거른다', async () => {
    expect(keys(await list({ expectedReceiptDateFrom: '2099-06-01' }))).toEqual(['D#1']);
    expect(keys(await list({ expectedReceiptDateTo: SOON }))).toEqual(['A#1', 'A#2']);
    expect(keys(await list({ itemId: ids.item2.toString() }))).toEqual(['A#2']);
    expect(keys(await list({ supplierId: ids.supplier2.toString() }))).toEqual(['D#1']);
    const byErp = await list({ q: `${PREFIX}-erp-a` });
    expect(keys(byErp)).toEqual(['A#1', 'A#2']);
    expect(byErp.items[0].erpPurchaseOrderNo).toBe(`${PREFIX}-ERP-A`);
  });

  it('쪽을 나눠도 순서가 이어진다', async () => {
    const second = await list({ page: '2', size: '1' });
    expect(keys(second)).toEqual(['A#2']);
    expect(second.page.total).toBe(4);
  });

  it('⭐ 발주 목록 openOnly 도 ERP 취소 라인만 남은 발주를 뺀다 — 같은 기준', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/logistics/purchase-orders')
      .query({ plantId: ids.plant.toString(), openOnly: 'true' })
      .set('Cookie', cookie)
      .expect(200);
    const numbers = (response.body.items as { purchaseOrderNo: string }[]).map((o) => o.purchaseOrderNo.slice(PREFIX.length + 1));
    expect(numbers.sort()).toEqual(['A', 'B', 'D']);
  });

  async function fixtures(): Promise<void> {
    ids.user = (
      await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } })
    ).app_user_id;
    const legal = await prisma.legal_entity.create({
      data: { legal_entity_code: PREFIX, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.legal = legal.legal_entity_id;
    ids.unit = (
      await prisma.business_unit.create({
        data: { legal_entity_id: ids.legal, business_unit_code: PREFIX, business_unit_name: PREFIX },
      })
    ).business_unit_id;
    ids.plant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: ids.legal,
          business_unit_id: ids.unit,
          plant_code: PREFIX,
          plant_name: PREFIX,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    for (const n of ['1', '2']) {
      ids[`item${n}`] = (
        await prisma.item.create({
          data: { item_code: `${PREFIX}-IT${n}`, item_name: PREFIX, item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id },
        })
      ).item_id;
      ids[`supplier${n}`] = (
        await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP${n}`, partner_name: PREFIX } })
      ).partner_id;
    }

    // A: 납기 지남 — 미입하 · 일부 · 다 받음 · ERP 취소
    await order('A', PAST, 'REGISTERED', ids.supplier1, `${PREFIX}-ERP-A`, [
      { qty: '100' },
      { qty: '50', received: '20', item: ids.item2 },
      { qty: '10', received: '10' },
      { qty: '30', cancelled: true },
    ]);
    await order('B', null, 'REGISTERED', ids.supplier1, null, [{ qty: '5' }]);
    // C: 헤더 취소 — 라인은 취소 표시가 없어도 끝난 것이다.
    await order('C', SOON, 'CANCELLED', ids.supplier1, null, [{ qty: '7' }]);
    await order('D', LATER, 'REGISTERED', ids.supplier2, null, [{ qty: '8' }]);
    // E: 남은 라인이 ERP 취소 하나뿐 — 발주 목록 openOnly 에서도 빠져야 한다.
    await order('E', null, 'REGISTERED', ids.supplier1, null, [{ qty: '9', cancelled: true }]);
  }

  async function order(
    name: string,
    expected: string | null,
    status: string,
    supplier: bigint,
    erpNo: string | null,
    lines: { qty: string; received?: string; cancelled?: boolean; item?: bigint }[],
  ): Promise<void> {
    await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-${name}`,
        erp_purchase_order_no: erpNo,
        supplier_id: supplier,
        business_unit_id: ids.unit,
        plant_id: ids.plant,
        order_date: new Date('2026-10-01T00:00:00.000Z'),
        expected_receipt_date: expected === null ? null : new Date(`${expected}T00:00:00.000Z`),
        status_code: status,
        purchase_order_line: {
          create: lines.map((line, index) => ({
            line_no: index + 1,
            item_id: line.item ?? ids.item1,
            uom_id: ids.uom,
            ordered_qty: new Prisma.Decimal(line.qty),
            received_qty: new Prisma.Decimal(line.received ?? '0'),
            cancelled_at: line.cancelled ? new Date('2026-10-10T00:00:00.000Z') : null,
          })),
        },
      },
    });
  }

  async function cleanup(): Promise<void> {
    const orders = { purchase_order_no: { startsWith: `${PREFIX}-` } };
    await prisma.purchase_order_line.deleteMany({ where: { purchase_order: orders } });
    await prisma.purchase_order.deleteMany({ where: orders });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: `${PREFIX}-` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-` } } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: PREFIX } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: PREFIX } });
    await prisma.app_user.deleteMany({ where: { login_id: `${PREFIX}-USER` } });
  }
});
