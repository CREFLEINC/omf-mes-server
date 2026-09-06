/**
 * 피킹 지시 조회 2건 — `GET /logistics/picking-orders` · `/{pickingOrderId}`.
 * 화면 `M-01-08`(자재 출고 피킹).
 *
 * ⭐ **지시를 만드는 오퍼레이션이 계약에 0건**이라(I-8.md §5 · 문의 045) 지시·라인은
 * `insertPickingOrder()` 가 직접 INSERT 한다. ④b(`:pick`)와 통합자의 M2 마디 e2e 가 그
 * 헬퍼를 그대로 쓴다(I-8.md §11-1 · §9-4).
 * ⚠ 목록은 **자기 `warehouseId` 로 걸러** 부른다 — `logistics-document-progress.e2e-spec.ts`
 * 가 심는 `source_document_type_code='GOODS_ISSUE'` 행이 계약 enum 2값 밖이라 섞이면
 * AJV 가 떨어진다(I-8.md R-24 ⓔ).
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

const LOGIN_ID = 'e2e-pk-probe';
const PASSWORD = '피킹-조회-비밀번호';
const PREFIX = 'PKE2E';

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

interface LineSeed {
  lotId: number;
  locationId?: number;
  itemId?: number;
  plannedQty?: number;
  pickedQty?: number;
  uomId?: number;
  inventoryReservationId?: number | null;
}

interface LineBody {
  pickingLineId: number;
  lineNo: number;
  held: boolean;
  holdReasonCode: string | null;
  itemCode: string;
  lotNo: string;
  locationCode: string;
  expiryDate: string | null;
  manufacturedAt: string | null;
  pickSequenceRank: number | null;
  inventoryReservationId: number | null;
}

describe('피킹 지시 조회 2건 — 목록 · 상세 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let warehouseId: number;
  let locationId: number;
  let itemId: number;
  let uomId: number;
  let materialIssueRequestId: number;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('픽스처가 심은 지시가 목록·상세로 나온다', async () => {
    const lotId = await makeLot('2027-07-31');
    const seeded = await insertPickingOrder([{ lotId }]);

    const list = await request(app.getHttpServer())
      // ⚠ 자기 창고로 닫는다 — 다른 스위트가 남긴 enum 밖 지시가 섞이면 AJV 가 떨어진다.
      .get(`/api/logistics/picking-orders?warehouseId=${warehouseId}`)
      .set('Cookie', cookie)
      .expect(200);
    const listSchema = validator('GET /logistics/picking-orders');
    expect(listSchema(list.body)).toBe(true);
    expect(listSchema.errors ?? []).toEqual([]);
    expect(list.body.page).toMatchObject({ page: 1, size: 50 });
    expect(list.body.items.map((row: { pickingOrderId: number }) => row.pickingOrderId)).toContain(
      seeded.pickingOrderId,
    );

    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/picking-orders/${seeded.pickingOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    const detailSchema = validator('GET /logistics/picking-orders/{pickingOrderId}');
    expect(detailSchema(detail.body)).toBe(true);
    expect(detailSchema.errors ?? []).toEqual([]);
    expect(detail.body.pickingOrder).toMatchObject({
      pickingOrderId: seeded.pickingOrderId,
      sourceDocumentTypeCode: 'MATERIAL_ISSUE_REQUEST',
      sourceDocumentId: materialIssueRequestId,
      warehouseId,
      assignedWorkerId: null,
    });
    // 파생 6칸이 마스터 조인으로 채워진다 — 화면이 마스터를 다시 부르지 않는다(계약 L-2).
    expect(detail.body.lines[0]).toMatchObject({
      pickingLineId: seeded.pickingLineIds[0],
      itemCode: `${PREFIX}-IT`,
      itemName: '피킹조회검사품목',
      locationCode: `${PREFIX}-LOC`,
      expiryDate: '2027-07-31',
      held: false,
      holdReasonCode: null,
      inventoryReservationId: null,
    });
  });

  it('상세가 보류 라인을 held 로 낸다', async () => {
    const heldLot = await makeLot('2027-01-31');
    const freeLot = await makeLot('2027-02-28');
    await prisma.lot_hold.create({
      data: {
        lot_id: heldLot,
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_at: new Date('2026-05-04T02:00:00.000Z'),
      },
    });
    const seeded = await insertPickingOrder([{ lotId: heldLot }, { lotId: freeLot }]);

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/picking-orders/${seeded.pickingOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    const lines: LineBody[] = response.body.lines;
    expect(lines.map((line) => line.held)).toEqual([true, false]);
    expect(lines.map((line) => line.holdReasonCode)).toEqual(['INCOMING_INSPECTION_WAIT', null]);
  });

  it('상세 라인이 pickSequenceRank 를 FEFO 로 낸다', async () => {
    const later = await makeLot('2028-12-31');
    const sooner = await makeLot('2026-12-31');
    const seeded = await insertPickingOrder([{ lotId: later }, { lotId: sooner }]);

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/picking-orders/${seeded.pickingOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 라인은 `line_no asc` 로 오고(R-21), 순위는 유효기한 이른 쪽이 1 이다.
    const lines: LineBody[] = response.body.lines;
    expect(lines.map((line) => line.lineNo)).toEqual([1, 2]);
    expect(lines.map((line) => line.pickSequenceRank)).toEqual([2, 1]);
  });

  it('없는 지시는 404', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/picking-orders/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  /**
   * `picking_order` 1행 + `picking_line` N행. ④b(`:pick`)와 M2 체인 e2e 가 그대로 쓴다.
   * `status_code` 는 `'REGISTERED'` 리터럴이다 — **서버가 그 값을 판정에 쓰는 자리가 0건**이라
   * `src/` 에 상수를 두지 않는다(I-8.md R-10 · CLAUDE.md 「사용처 하나뿐인 추상화 금지」).
   * 라인의 `location_id` 는 지시의 창고 안이어야 한다(`goods-issue-rules.ts` 가 그렇게 본다).
   */
  async function insertPickingOrder(
    lines: LineSeed[],
    options: {
      warehouseId?: number;
      sourceDocumentId?: number;
      assignedWorkerId?: number | null;
      statusCode?: string;
    } = {},
  ): Promise<{ pickingOrderId: number; pickingOrderNo: string; pickingLineIds: number[] }> {
    seq += 1;
    const order = await prisma.picking_order.create({
      data: {
        picking_order_no: `${PREFIX}-PK-${seq}`,
        picking_type_code: 'MATERIAL',
        source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
        source_document_id: options.sourceDocumentId ?? materialIssueRequestId,
        warehouse_id: options.warehouseId ?? warehouseId,
        status_code: options.statusCode ?? 'REGISTERED',
        assigned_worker_id: options.assignedWorkerId ?? null,
      },
    });
    const pickingLineIds: number[] = [];
    for (const [index, line] of lines.entries()) {
      const created = await prisma.picking_line.create({
        data: {
          picking_order_id: order.picking_order_id,
          line_no: index + 1,
          item_id: line.itemId ?? itemId,
          lot_id: line.lotId,
          location_id: line.locationId ?? locationId,
          planned_qty: line.plannedQty ?? 10,
          picked_qty: line.pickedQty ?? 0,
          uom_id: line.uomId ?? uomId,
          inventory_reservation_id: line.inventoryReservationId ?? null,
          status_code: 'REGISTERED',
        },
      });
      pickingLineIds.push(Number(created.picking_line_id));
    }
    return {
      pickingOrderId: Number(order.picking_order_id),
      pickingOrderNo: order.picking_order_no,
      pickingLineIds,
    };
  }

  async function makeLot(expiryDate: string): Promise<number> {
    seq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${seq}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 1000,
        uom_id: uomId,
        manufactured_at: new Date('2026-05-01T00:00:00.000Z'),
        expiry_date: new Date(`${expiryDate}T00:00:00.000Z`),
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return Number(lot.lot_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '피킹조회검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '피킹조회검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '피킹조회검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    // ⭐ `shelf_life_days` 가 있어야 FEFO 다 — 없으면 `manufactured_at` 축이다(R-21).
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '피킹조회검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
        shelf_life_days: 365,
      },
    });
    itemId = Number(item.item_id);

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '피킹조회검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);

    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '피킹조회검사위치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(location.location_id);

    // 지시의 원천 문서 — 다형 참조에 FK 가 없어도 실재하는 행을 가리킨다(I-4.md R-3 규칙).
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '피킹검사공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'ACTIVE',
      },
    });
    const operation = await prisma.routing_operation.create({
      data: {
        routing_id: routing.routing_id,
        operation_seq: 10,
        process_id: process.process_id,
        operation_name: '피킹검사작업',
      },
    });
    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'RELEASED',
      },
    });
    const issueRequest = await prisma.material_issue_request.create({
      data: {
        issue_request_no: `${PREFIX}-MIR`,
        work_order_id: workOrder.work_order_id,
        destination_location_id: location.location_id,
        status_code: 'REGISTERED',
      },
    });
    materialIssueRequestId = Number(issueRequest.material_issue_request_id);
  }

  /** 조회 2건은 계약이 403 을 선언하지 않는다 — 세션만 있으면 된다(권한 표 무변경). */
  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '피킹조회검사', status_code: 'EMPLOYED' },
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

  /** §11-1 정리 순서 — 원장·출고는 이 스위트가 안 만든다(조회뿐). 접두어로만 지운다. */
  async function cleanup(): Promise<void> {
    const lots = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.picking_line
       WHERE picking_order_id IN (SELECT picking_order_id FROM logistics.picking_order
              WHERE picking_order_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.picking_order WHERE picking_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.material_issue_request_line
       WHERE material_issue_request_id IN (SELECT material_issue_request_id
              FROM logistics.material_issue_request WHERE issue_request_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.material_issue_request WHERE issue_request_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM planning.routing_operation
       WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
