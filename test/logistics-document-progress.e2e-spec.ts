/**
 * 물류 문서 진행현황 목록 — `GET /logistics/document-progress`(I-5 PR ③a). 상세 GET·취소 2건은
 * 뒤 PR(③b·④·⑤) 몫이라 여기서 다루지 않는다.
 *
 * ⛔ 계약이 이 GET 에 403 을 선언하지 않아(`declaresForbidden` 이 거짓) 권한 등록이 필요 없다
 *   — 로그인 세션만 있으면 된다(I-5.md §1-1 실측).
 * ⭐ 픽스처는 대부분 **직접 INSERT** 한다 — 이 스위트의 목은 조회·매핑이지 등록·전기 흐름이 아니고,
 *   후속 판정(`CancelEligibilityService`)은 `source_document_type_code`+`source_document_id` 다형
 *   축을 직접 보므로 REGISTERED 상태 그대로도 후속으로 잡힌다(전기가 필요 없다).
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

const LOGIN_ID = 'e2e-dp-probe';
const PASSWORD = 'DP-진행현황-비밀번호';
const PREFIX = 'DPE2E';
const AT = '2026-05-04T02:00:00.000Z';

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

interface ProgressItem {
  documentTypeCode: string;
  documentId: number;
  documentNo: string;
  documentDate: string;
  statusCode: string;
  plannedQty: number;
  processedQty: number;
  remainingQty: number;
  successorCount: number;
  cancellable: boolean;
  cancelBlockedReasonCode?: string;
}

describe('물류 문서 진행현황 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let warehouseId: number;
  let locationId: number;
  let itemId: number;
  let uomId: number;

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

  it('GET /logistics/document-progress — documentTypeCode 없이 부르면 400', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/logistics/document-progress')
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
  });

  it('GET — enum 밖 유형이면 400', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/logistics/document-progress?documentTypeCode=NOT_A_TYPE')
      .set('Cookie', cookie);

    expect(response.status).toBe(400);
  });

  it('GET ?documentTypeCode=GOODS_RECEIPT — 한 형태로 맞춘 목록을 낸다(문서번호·일자·수량 3칸)', async () => {
    const receipt = await insertGoodsReceipt({ receiptQty: 120 });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${receipt.goodsReceiptNo}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/document-progress');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const items = response.body.items as ProgressItem[];
    expect(items).toHaveLength(1);
    // 라인의 expected_qty 를 안 실었다(API 로 만든 입고는 언제나 NULL · R-7 ⓐ) — planned = processed.
    expect(items[0]).toMatchObject({
      documentTypeCode: 'GOODS_RECEIPT',
      documentId: receipt.goodsReceiptId,
      documentNo: receipt.goodsReceiptNo,
      documentDate: '2026-05-04',
      plannedQty: 120,
      processedQty: 120,
      remainingQty: 0,
    });
  });

  it('GET — 후속이 있는 입고는 successorCount 가 0 이 아니고 cancellable 이 거짓이다', async () => {
    const receipt = await insertGoodsReceipt();
    await insertGoodsIssue({ sourceDocumentId: receipt.goodsReceiptId });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${receipt.goodsReceiptNo}`)
      .set('Cookie', cookie)
      .expect(200);

    const items = response.body.items as ProgressItem[];
    expect(items[0].successorCount).toBeGreaterThan(0);
    expect(items[0].cancellable).toBe(false);
  });

  it('GET — 취소 경로가 없는 유형은 cancelBlockedReasonCode 가 TYPE_NOT_CANCELABLE 이다', async () => {
    const picking = await insertPickingOrder();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=PICKING_ORDER&q=${picking.pickingOrderNo}`)
      .set('Cookie', cookie)
      .expect(200);

    const items = response.body.items as ProgressItem[];
    expect(items[0]).toMatchObject({ cancellable: false, cancelBlockedReasonCode: 'TYPE_NOT_CANCELABLE' });
  });

  it('GET ?cancellableOnly=true — 막힌 건이 빠진다', async () => {
    const blocked = await insertGoodsReceipt();
    await insertGoodsIssue({ sourceDocumentId: blocked.goodsReceiptId });
    const open = await insertGoodsReceipt();
    const q = PREFIX; // 이 스위트가 만든 GOODS_RECEIPT 전건을 한 페이지에 담는다.

    const all = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${q}&size=200`)
      .set('Cookie', cookie)
      .expect(200);
    const filtered = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${q}&size=200&cancellableOnly=true`)
      .set('Cookie', cookie)
      .expect(200);

    const allIds = (all.body.items as ProgressItem[]).map((row) => row.documentId);
    const filteredIds = (filtered.body.items as ProgressItem[]).map((row) => row.documentId);
    expect(allIds).toContain(blocked.goodsReceiptId);
    expect(allIds).toContain(open.goodsReceiptId);
    expect(filteredIds).not.toContain(blocked.goodsReceiptId);
    expect(filteredIds).toContain(open.goodsReceiptId);
    // totalElements 는 거르기 «전» 수다(I-5.md §5-3) — cancellableOnly 가 걸러도 총량은 안 준다.
    expect(filtered.body.page.total).toBe(all.body.page.total);
  });

  it('GET ?q= · ?statusCode= · ?documentDateFrom= 필터가 각각 선다', async () => {
    const early = await insertGoodsReceipt({ statusCode: 'REGISTERED', receiptDatetime: '2026-05-01T02:00:00.000Z' });
    const late = await insertGoodsReceipt({ statusCode: 'POSTED', receiptDatetime: '2026-05-10T02:00:00.000Z' });
    const q = PREFIX;

    const byNo = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${early.goodsReceiptNo}`)
      .set('Cookie', cookie)
      .expect(200);
    expect((byNo.body.items as ProgressItem[]).map((r) => r.documentId)).toEqual([early.goodsReceiptId]);

    const byStatus = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${q}&statusCode=REGISTERED&size=200`)
      .set('Cookie', cookie)
      .expect(200);
    const statusIds = (byStatus.body.items as ProgressItem[]).map((r) => r.documentId);
    expect(statusIds).toContain(early.goodsReceiptId);
    expect(statusIds).not.toContain(late.goodsReceiptId);

    const byDateFrom = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=GOODS_RECEIPT&q=${q}&documentDateFrom=2026-05-05&size=200`)
      .set('Cookie', cookie)
      .expect(200);
    const fromIds = (byDateFrom.body.items as ProgressItem[]).map((r) => r.documentId);
    expect(fromIds).toContain(late.goodsReceiptId);
    expect(fromIds).not.toContain(early.goodsReceiptId);
  });

  it('GET ?documentTypeCode=SUBCONTRACT_ISSUE — 문서번호를 짝 출고에서 판다', async () => {
    const pair = await insertSubcontractIssue();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress?documentTypeCode=SUBCONTRACT_ISSUE&q=${pair.goodsIssueNo}`)
      .set('Cookie', cookie)
      .expect(200);

    const items = response.body.items as ProgressItem[];
    expect(items).toHaveLength(1);
    expect(items[0].documentNo).toBe(pair.goodsIssueNo);
  });

  let receiptSeq = 0;
  let lotSeq = 0;
  let issueSeq = 0;
  let pickingSeq = 0;

  async function makeLot(): Promise<number> {
    lotSeq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${lotSeq}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 1000,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return Number(lot.lot_id);
  }

  /** 라인 하나짜리 입고. `expected_qty` 를 안 채운다 — API 로 만든 입고와 같은 모양(R-7 ⓐ). */
  async function insertGoodsReceipt(
    overrides: { statusCode?: string; receiptDatetime?: string; receiptQty?: number } = {},
  ): Promise<{ goodsReceiptId: number; goodsReceiptNo: string }> {
    receiptSeq += 1;
    const lot = await makeLot();
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR-${receiptSeq}`,
        receipt_type_code: 'MATERIAL',
        plant_id: plantId,
        warehouse_id: warehouseId,
        receipt_datetime: new Date(overrides.receiptDatetime ?? AT),
        status_code: overrides.statusCode ?? 'REGISTERED',
      },
    });
    await prisma.goods_receipt_line.create({
      data: {
        goods_receipt_id: receipt.goods_receipt_id,
        line_no: 1,
        item_id: itemId,
        lot_id: lot,
        receipt_qty: overrides.receiptQty ?? 100,
        uom_id: uomId,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        destination_location_id: locationId,
      },
    });
    return { goodsReceiptId: Number(receipt.goods_receipt_id), goodsReceiptNo: receipt.goods_receipt_no };
  }

  /** 다형 축(`source_document_type_code`+`source_document_id`)으로 후속을 잇는다 — 전기가 필요 없다. */
  async function insertGoodsIssue(
    overrides: { sourceDocumentId?: number } = {},
  ): Promise<{ goodsIssueId: number; goodsIssueNo: string }> {
    issueSeq += 1;
    const lot = await makeLot();
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI-${issueSeq}`,
        issue_type_code: 'OTHER',
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: overrides.sourceDocumentId ?? 0,
        source_warehouse_id: warehouseId,
        issued_at: new Date(AT),
        status_code: 'REGISTERED',
      },
    });
    await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id,
        line_no: 1,
        item_id: itemId,
        lot_id: lot,
        issue_qty: 10,
        uom_id: uomId,
        source_location_id: locationId,
      },
    });
    return { goodsIssueId: Number(issue.goods_issue_id), goodsIssueNo: issue.goods_issue_no };
  }

  async function insertPickingOrder(): Promise<{ pickingOrderId: number; pickingOrderNo: string }> {
    pickingSeq += 1;
    const order = await prisma.picking_order.create({
      data: {
        picking_order_no: `${PREFIX}-PK-${pickingSeq}`,
        picking_type_code: 'STANDARD',
        source_document_type_code: 'GOODS_ISSUE',
        source_document_id: 1,
        warehouse_id: warehouseId,
        status_code: 'REGISTERED',
      },
    });
    return { pickingOrderId: Number(order.picking_order_id), pickingOrderNo: order.picking_order_no };
  }

  /** 외주출고 — 문서번호·라인·수량 칸이 없다. 짝 출고(`goods_issue`)에 매달린다(I-5.md §5-2). */
  async function insertSubcontractIssue(): Promise<{ subcontractIssueId: number; goodsIssueNo: string }> {
    const partner = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-PN`, partner_name: '외주검사업체' },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PS`, process_name: '외주검사공정', process_type_code: 'OUTSOURCE' },
    });
    const order = await prisma.subcontract_order.create({
      data: {
        subcontract_order_no: `${PREFIX}-SO-1`,
        partner_id: partner.partner_id,
        process_id: process.process_id,
        item_id: itemId,
        order_qty: 10,
        uom_id: uomId,
        status_code: 'OPEN',
      },
    });
    const issue = await insertGoodsIssue();
    const subcontractIssue = await prisma.subcontract_issue.create({
      data: {
        subcontract_order_id: order.subcontract_order_id,
        goods_issue_id: BigInt(issue.goodsIssueId),
        issued_at: new Date(AT),
      },
    });
    return { subcontractIssueId: Number(subcontractIssue.subcontract_issue_id), goodsIssueNo: issue.goodsIssueNo };
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '진행현황검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '진행현황검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '진행현황검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '진행현황검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '진행현황검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);

    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '진행현황검사위치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(location.location_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '진행현황검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.subcontract_issue
        WHERE subcontract_order_id IN (SELECT subcontract_order_id FROM logistics.subcontract_order WHERE subcontract_order_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.subcontract_order WHERE subcontract_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_issue_line
        WHERE goods_issue_id IN (SELECT goods_issue_id FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_receipt_line
        WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.picking_order WHERE picking_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`);

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
