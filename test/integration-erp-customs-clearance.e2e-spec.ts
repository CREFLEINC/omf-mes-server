/**
 * 외자 발주 통관번호 받아오기 `POST /integration/erp-sync/purchase-orders/{purchaseOrderId}/customs-clearances:fetch`(장부 P-143).
 * ERP 함수는 가짜로 바꾼다(`CUSTOMS_LOOKUP`) — 실제 함수는 erp-mock `docker/erp-stub.sql` 이 흉내 낸다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { CUSTOMS_LOOKUP, CustomsClearance, CustomsLookup } from '../src/integration/erp/customs-clearance';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-ERPCC';
const IMPORT_NO = `${PREFIX}-PO`;
const path = (purchaseOrderId: bigint | number): string =>
  `/api/integration/erp-sync/purchase-orders/${purchaseOrderId}/customs-clearances:fetch`;

/** ERP 함수 대역 — 발주번호·라인마다 돌려줄 행. */
const ERP: Record<string, CustomsClearance[]> = {
  [`${IMPORT_NO}|1`]: [{ no: 'CC2606-0001', seq: 1 }],
  [`${IMPORT_NO}|2`]: [
    { no: 'CC2606-0001', seq: 5 },
    { no: 'CC2606-0002', seq: 1 },
  ],
};
const lookup: CustomsLookup = { find: (poNo, poSeq) => Promise.resolve(ERP[`${poNo}|${poSeq}`] ?? []) };

/** 계약의 200 응답 스키마 — 문서째 등록해야 그 안의 `$ref` 가 풀린다. */
function responseValidator(file: string, operation: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32']) ajv.addFormat(format, true);
  ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '../contracts', file), 'utf8')) as object, 'contract');
  const [method, path] = operation.split(' ');
  return ajv.compile({
    $ref: `contract#/paths/${path.replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`,
  });
}
const expectContract = (file: string, operation: string, body: unknown): void => {
  const validate = responseValidator(file, operation);
  expect(validate(body)).toBe(true);
  expect(validate.errors ?? []).toEqual([]);
};

describe('외자 발주 통관번호 받아오기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<string, string> = {};
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CUSTOMS_LOOKUP)
      .useValue(lookup)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    for (const [name, permission] of [
      ['operator', 'W-06-10'],
      ['none', undefined],
    ] as const) {
      const user = await prisma.app_user.create({
        data: { login_id: `${PREFIX}-${name}`, user_name: PREFIX, status_code: 'EMPLOYED' },
      });
      if (permission !== undefined) {
        const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${name}`, role_name: PREFIX } });
        await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
        await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      }
      cookies[name] = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
    }
    await seed();
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  async function seed(): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow();
    const businessUnitId = plant.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    const uom = await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } });
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '통관 검사 자재', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id },
    });
    const supplier = await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: '통관 검사 공급사' } });
    for (const [key, erpNo, type] of [
      ['import', IMPORT_NO, 'PO'],
      ['domestic', `${PREFIX}-DO`, 'DO'],
    ] as const) {
      ids[key] = (
        await prisma.purchase_order.create({
          data: {
            purchase_order_no: `${PREFIX}-${key}`,
            erp_purchase_order_no: erpNo,
            erp_order_type_code: type,
            supplier_id: supplier.partner_id,
            business_unit_id: businessUnitId,
            plant_id: plant.plant_id,
            order_date: new Date('2026-10-01T00:00:00.000Z'),
            status_code: 'CONFIRMED',
          },
        })
      ).purchase_order_id;
      for (const lineNo of [1, 2, 3]) {
        ids[`${key}Line${lineNo}`] = (
          await prisma.purchase_order_line.create({
            data: {
              purchase_order_id: ids[key],
              line_no: lineNo,
              item_id: item.item_id,
              ordered_qty: 100,
              uom_id: uom.uom_id,
              // 3번 라인은 앞서 받아 둔 값이 있다 — ERP 가 이제 빈 결과를 줘도(전량 입고) 지우지 않는다.
              ...(lineNo === 3 ? { erp_customs_clearance_no: 'CC2605-0009', erp_customs_clearance_seq: 2 } : {}),
            },
          })
        ).purchase_order_line_id;
      }
    }
  }

  it('⛔ 로그인이 없으면 401 · W-06-10 이 없으면 403 이다', async () => {
    await request(app.getHttpServer()).post(path(ids.import)).expect(401);
    await request(app.getHttpServer()).post(path(ids.import)).set('Cookie', cookies.none).expect(403);
  });

  it('⭐ 외자 발주 — 하나면 적고, 여럿이면 적지 않고 후보를 주고, 없으면 적어 둔 값을 그대로 둔다', async () => {
    const response = await request(app.getHttpServer()).post(path(ids.import)).set('Cookie', cookies.operator).expect(200);

    expect(response.body).toEqual({
      purchaseOrderId: Number(ids.import),
      lines: [
        {
          purchaseOrderLineId: Number(ids.importLine1),
          lineNo: 1,
          result: 'SAVED',
          customsClearanceNo: 'CC2606-0001',
          customsClearanceSeq: 1,
          candidates: [],
        },
        {
          purchaseOrderLineId: Number(ids.importLine2),
          lineNo: 2,
          result: 'MULTIPLE',
          customsClearanceNo: null,
          customsClearanceSeq: null,
          candidates: [
            { customsClearanceNo: 'CC2606-0001', customsClearanceSeq: 5 },
            { customsClearanceNo: 'CC2606-0002', customsClearanceSeq: 1 },
          ],
        },
        {
          purchaseOrderLineId: Number(ids.importLine3),
          lineNo: 3,
          result: 'NOT_FOUND',
          customsClearanceNo: 'CC2605-0009',
          customsClearanceSeq: 2,
          candidates: [],
        },
      ],
    });
    expectContract('mdm-기준정보.json', 'POST /integration/erp-sync/purchase-orders/{purchaseOrderId}/customs-clearances:fetch', response.body);
    const saved = await prisma.purchase_order_line.findMany({
      where: { purchase_order_id: ids.import },
      orderBy: { line_no: 'asc' },
      select: { erp_customs_clearance_no: true, erp_customs_clearance_seq: true, erp_customs_clearance_fetched_at: true },
    });
    expect(saved.map((row) => [row.erp_customs_clearance_no, row.erp_customs_clearance_seq])).toEqual([
      ['CC2606-0001', 1],
      [null, null],
      ['CC2605-0009', 2],
    ]);
    expect(saved[0].erp_customs_clearance_fetched_at).not.toBeNull();
    // 라인 목록 행도 적힌 값을 그대로 싣는다.
    const listed = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-order-lines?purchaseOrderId=${ids.import}&openOnly=false`)
      .set('Cookie', cookies.operator)
      .expect(200);
    expectContract('logistics-01자재창고.json', 'GET /logistics/purchase-order-lines', listed.body);
    const customsOf = (row: Record<string, unknown>) => [row.erpCustomsClearanceNo, row.erpCustomsClearanceSeq, row.erpCustomsClearanceFetchedAt];
    expect((listed.body as { items: Record<string, unknown>[] }).items.map(customsOf)).toEqual(
      saved.map((row) => [row.erp_customs_clearance_no, row.erp_customs_clearance_seq, row.erp_customs_clearance_fetched_at?.toISOString() ?? null]),
    );
  });

  it('⛔ 외자가 아닌 발주는 400 STATE_LOCKED 이고 없는 발주는 404 다', async () => {
    const domestic = await request(app.getHttpServer()).post(path(ids.domestic)).set('Cookie', cookies.operator).expect(400);
    expect(domestic.body.errors).toEqual([
      { scope: 'screen', code: 'STATE_LOCKED', message: '외자 발주(발주유형 PO)만 통관번호를 받아 옵니다.' },
    ]);
    await request(app.getHttpServer()).post(path(999_999_999)).set('Cookie', cookies.operator).expect(404);
  });

  async function cleanup(): Promise<void> {
    const orders = { purchase_order_no: { startsWith: `${PREFIX}-` } };
    await prisma.purchase_order_line.deleteMany({ where: { purchase_order: orders } });
    await prisma.purchase_order.deleteMany({ where: orders });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: `${PREFIX}-` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-` } } });
    const roles = { role_code: { startsWith: `${PREFIX}-` } };
    await prisma.user_role.deleteMany({ where: { role: roles } });
    await prisma.role_permission.deleteMany({ where: { role: roles } });
    await prisma.role.deleteMany({ where: roles });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
