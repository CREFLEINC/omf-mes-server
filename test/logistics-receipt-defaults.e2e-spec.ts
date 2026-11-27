/**
 * 입고 기본값(장부 P-150) — 관리웹 입고 처리가 입고 칸을 미리 채우던 자리(사용자 결정 2026-10-29).
 * 피처 009(omf-all-around#294)부터 구매 입하 LOT 은 PDA 적치로 입고하므로 칸을 비우고 USE_PDA_PUTAWAY 를 낸다.
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
import { PrismaService } from '../src/prisma/prisma.service';

/** 발주 라인의 ERP 창고 칸이 7자다 — 창고 코드가 그 안에 들어가게 짧게. */
const PREFIX = 'RDF';
const PATH = '/api/logistics/goods-receipts:defaults';
const DAY = '2026-10-29';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface Defaults {
  lotId: number;
  plantId: number | null;
  inboundReceiptLineId: number | null;
  itemId: number | null;
  uomId: number | null;
  receiptTypeCode: string;
  receiptQty: number | null;
  warehouseId: number | null;
  destinationLocationId: number | null;
  qualityStatusCode: string | null;
  inventoryStatusCode: string | null;
  issues: { code: string }[];
}

describe('입고 기본값 (e2e · 장부 P-150)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cookies: Record<string, string> = {};
  const ids: Record<string, bigint> = {};
  let lineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    for (const [name, permission] of [['receiver', 'W-01-10'], ['none', undefined]] as const) {
      const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${name}`, user_name: PREFIX, status_code: 'EMPLOYED' } });
      if (permission !== undefined) {
        const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${name}`, role_name: PREFIX } });
        await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
        await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      }
      cookies[name] = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
    }
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const validate = validator('GET /logistics/goods-receipts:defaults');
  /** 200 마다 계약 응답 스키마로 본다 — 칸이 비는 갈래마다 null 이 계약에 맞는지. */
  const defaultsOf = async (...lotIds: bigint[]): Promise<Defaults[]> => {
    const response = await request(app.getHttpServer()).get(PATH).query({ lotIds: lotIds.join(',') }).set('Cookie', cookies.receiver).expect(200);
    expect(validate(response.body) ? [] : validate.errors).toEqual([]);
    return response.body.items as Defaults[];
  };
  const codes = (row: Defaults): string[] => row.issues.map((item) => item.code);

  // 피처 009(omf-all-around#294 · R-2) — 구매 입하 자재는 PDA 적치로 입고한다. 기본값은 창고·위치·상태·수량을 고르지 않고
  // 칸을 비운 채 USE_PDA_PUTAWAY 를 낸다(옛 관리웹 W-01-10 이 입고 처리 창을 열어도 채울 것이 없다).
  it('Q21 R-2 구매 입하 LOT 은 합격·불합격·검사 대기 모두 USE_PDA_PUTAWAY — 칸은 LOT·품목·단위만 · 없는 LOT 은 NOT_FOUND · 같은 id 는 한 번', async () => {
    const good = await lotOn([ids.lineWh], 'NORMAL', 30);
    const bad = await lotOn([ids.lineWh], 'DEFECTIVE', 5);
    const pending = await lotOn([ids.lineWh], 'INSPECTION_PENDING', 3);

    const [g, b, p, missing, ...rest] = await defaultsOf(good, bad, pending, 999999999n, good);

    expect(rest).toEqual([]);
    for (const [row, lot] of [[g, good], [b, bad], [p, pending]] as const) {
      expect(row).toMatchObject({
        lotId: Number(lot), itemId: Number(ids.item), uomId: Number(ids.uom), plantId: null, warehouseId: null, destinationLocationId: null,
        receiptQty: null, qualityStatusCode: null, inventoryStatusCode: null,
      });
      expect(codes(row)).toEqual(['USE_PDA_PUTAWAY']);
    }
    expect(missing).toMatchObject({ lotId: 999999999, itemId: null });
    expect(codes(missing)).toEqual(['NOT_FOUND']);
  });

  it('⛔ lotIds 가 없거나 틀리거나 100개를 넘으면 400 — 틀린 원소를 무시하지 않는다 · 권한이 없으면 403 · 로그인이 없으면 401', async () => {
    const get = (query: Record<string, string>, cookie = cookies.receiver) =>
      request(app.getHttpServer()).get(PATH).query(query).set('Cookie', cookie);
    const invalid: [Record<string, string>, string, string][] = [
      [{}, 'lotIds', 'REQUIRED'],
      [{ lotIds: '1,x' }, 'lotIds[1]', 'INVALID'],
      [{ lotIds: '1,' }, 'lotIds[1]', 'INVALID'],
      [{ lotIds: '0' }, 'lotIds[0]', 'RANGE'],
      [{ lotIds: Array.from({ length: 101 }, (_, i) => i + 1).join(',') }, 'lotIds', 'RANGE'],
    ];
    for (const [query, field, code] of invalid) {
      const response = await get(query).expect(400);
      expect(response.body.errors).toEqual([expect.objectContaining({ field, code })]);
    }
    await get({ lotIds: '1' }, cookies.none).expect(403);
    await request(app.getHttpServer()).get(PATH).query({ lotIds: '1' }).expect(401);
  });

  /** 입하 라인 하나에 발주 라인들을 배정하고 그 라인의 LOT 을 만든다 — 상태는 IQC 를 거친 뒤의 값이다. */
  async function lotOn(orderLines: bigint[], status: string, qty: number): Promise<bigint> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: ids.receipt, line_no: lineNo, item_id: ids.item, purchase_order_line_id: orderLines[0],
        received_qty: qty, uom_id: ids.uom, supplier_lot_label_attached: false, inspection_required: true, status_code: 'REGISTERED',
      },
    });
    for (const [index, orderLine] of orderLines.entries()) {
      await prisma.inbound_receipt_po_allocation.create({
        data: {
          inbound_receipt_line_id: line.inbound_receipt_line_id, purchase_order_line_id: orderLine,
          allocated_qty: index === 0 ? qty - (orderLines.length - 1) : 1,
        },
      });
    }
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-L${lineNo}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty,
        uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: line.inbound_receipt_line_id, status_code: status,
      },
    });
    await prisma.inbound_receipt_line.update({ where: { inbound_receipt_line_id: line.inbound_receipt_line_id }, data: { lot_id: lot.lot_id } });
    return lot.lot_id;
  }

  async function warehouse(code: string, plant: bigint, isDefect = false): Promise<bigint> {
    return (await prisma.warehouse.create({
      data: {
        plant_id: plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-${code}`, warehouse_name: `${PREFIX} ${code}`,
        warehouse_type_code: 'GENERAL', management_level_code: 'WAREHOUSE', is_defect: isDefect,
      },
    })).warehouse_id;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '입고기본값법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '입고기본값사업부' },
    })).business_unit_id;
    for (const [key, code] of [['plant', 'P'], ['otherPlant', 'P2']] as const) {
      ids[key] = (await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${code}`, plant_name: `입고기본값${code}`, timezone_code: 'Asia/Ho_Chi_Minh' },
      })).plant_id;
    }
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '입고기본값품목', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
    })).item_id;
    ids.wh = await warehouse('WH', ids.plant);
    ids.other = await warehouse('WH2', ids.otherPlant);
    ids.ng = await warehouse('NG', ids.plant, true);
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-SUP`, partner_name: '입고기본값공급사' } })).partner_id;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO`, supplier_id: ids.supplier, business_unit_id: ids.unit, plant_id: ids.plant,
        order_date: new Date(`${DAY}T00:00:00.000Z`), status_code: 'CONFIRMED',
      },
    });
    for (const [index, [key, sl]] of ([
      ['lineWh', `${PREFIX}-WH`], ['lineOther', `${PREFIX}-WH2`], ['lineNone', null], ['lineMissing', `${PREFIX}-ZZ`],
    ] as const).entries()) {
      ids[key] = (await prisma.purchase_order_line.create({
        data: {
          purchase_order_id: order.purchase_order_id, line_no: index + 1, item_id: ids.item, ordered_qty: 1000, uom_id: ids.uom,
          erp_storage_location_code: sl,
        },
      })).purchase_order_line_id;
    }
    ids.receipt = (await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`, supplier_id: ids.supplier, plant_id: ids.plant,
        receipt_datetime: new Date(`${DAY}T01:00:00.000Z`), status_code: 'REGISTERED',
      },
    })).inbound_receipt_id;
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 입고 허브 스위트와 같다. */
  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    await prisma.$executeRawUnsafe(`TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`);
    for (const sql of [
      `DELETE FROM logistics.putaway_task WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${lots})`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM logistics.inbound_receipt_po_allocation WHERE inbound_receipt_line_id IN (SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'))`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN (SELECT purchase_order_id FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.purchase_order WHERE purchase_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const roles = { role_code: { startsWith: `${PREFIX}-` } };
    await prisma.idempotency_record.deleteMany({ where: { app_user: { login_id: { startsWith: `${PREFIX}-` } } } });
    await prisma.user_role.deleteMany({ where: { role: roles } });
    await prisma.role_permission.deleteMany({ where: { role: roles } });
    await prisma.role.deleteMany({ where: roles });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
