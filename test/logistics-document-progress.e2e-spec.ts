/**
 * 물류 문서 진행현황 — 목록 `GET /logistics/document-progress`(I-5 PR ③a) + 상세
 * `GET …/{documentTypeCode}/{documentId}`(PR ③b) + 취소 요청 `POST …:request-cancel`(PR ④).
 * `:cancel` 실행은 뒤 PR(⑤) 몫이라 여기서 다루지 않는다.
 *
 * ⛔ 계약이 두 GET 에 403 을 선언하지 않아(`declaresForbidden` 이 거짓) 조회는 로그인 세션만
 *   있으면 된다(I-5.md §1-1 실측). 쓰기 `:request-cancel` 은 403 을 선언하므로 `W-01-13` 을 심는다.
 * ⚠ 취소 결재선(`approval_route`)은 시드에 0행이라 이 스위트가 `seedRoute()` 로 3유형을 직접
 *   심는다 — 안 심으면 상신이 400 `ROUTE_NOT_FOUND` 로 끝난다(I-5.md §6-2).
 * ⭐ 픽스처는 대부분 **직접 INSERT** 한다 — 이 스위트의 목은 조회·매핑이지 등록·전기 흐름이 아니고,
 *   후속 판정(`CancelEligibilityService`)은 `source_document_type_code`+`source_document_id` 다형
 *   축을 직접 보므로 REGISTERED 상태 그대로도 후속으로 잡힌다(전기가 필요 없다).
 * ⚠ 상세의 `POSTED` 줄 픽스처는 `inventory_transaction` 을 **직접 INSERT** 한다 — 원장은
 *   트리거가 UPDATE·DELETE 를 막아(`block_ledger_header_mutation`) cleanup 이 DELETE 대신
 *   `TRUNCATE … CASCADE` 를 쓴다(입고 스위트 선례 · I-5.md §10-1). `CANCELLED` 줄은 여기서
 *   안 다룬다 — `document_cancellation` 은 PR⑤ 전이라 오늘 0행이다(단위로만 덮는다).
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
import { seedRoute } from './approval-request.fixture';

const LOGIN_ID = 'e2e-dp-probe';
const PASSWORD = 'DP-진행현황-비밀번호';
const PREFIX = 'DPE2E';
const ROLE = `${PREFIX}-ROLE`;
const AT = '2026-05-04T02:00:00.000Z';
/** 계약 경로 `documentTypeCode` enum 3값 — 승인 유형은 `${유형}_CANCEL` 이다(§6-2). */
const CANCELABLE = ['INBOUND_RECEIPT', 'GOODS_RECEIPT', 'GOODS_ISSUE'] as const;
const CANCEL_APPROVAL_TYPES = CANCELABLE.map((type) => `${type}_CANCEL`);

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

  it('GET /{type}/{id} — 없는 id 면 404', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/document-progress/GOODS_RECEIPT/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('GET /{type}/{id} — steps 와 successors 를 한 번에 낸다(등록·전기 두 줄 · 후속 1건)', async () => {
    const receipt = await insertGoodsReceipt({ statusCode: 'POSTED' });
    const tx = await insertPostedLedger(receipt.goodsReceiptId);
    await insertGoodsIssue({ sourceDocumentId: receipt.goodsReceiptId });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/document-progress/GOODS_RECEIPT/${receipt.goodsReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/document-progress/{documentTypeCode}/{documentId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const steps = response.body.steps as Array<{
      stepCode: string;
      actorName?: string;
      inventoryTransactionNo?: string;
      businessDate?: string;
    }>;
    expect(steps.map((s) => s.stepCode)).toEqual(['REGISTERED', 'POSTED']);
    // REGISTERED 는 created_by 를 안 채운 픽스처라 actorName 이 없다.
    expect(steps[0]).not.toHaveProperty('actorName');
    // POSTED 는 자동이라 actorName 이 «언제나» 없고, 원장 번호·영업일을 대신 싣는다(§5-4).
    expect(steps[1]).not.toHaveProperty('actorName');
    expect(steps[1]).toMatchObject({ inventoryTransactionNo: tx.transactionNo, businessDate: '2026-05-04' });

    expect(response.body.progress).toMatchObject({ documentTypeCode: 'GOODS_RECEIPT', documentId: receipt.goodsReceiptId });
    expect(response.body.successors).toHaveLength(1);
    expect(response.body.successors[0]).toMatchObject({ successorTypeCode: 'GOODS_ISSUE' });
  });

  it(':request-cancel — 202 와 approvalRequestId 를 낸다 · 문서가 CANCEL_REQUESTED 다', async () => {
    const receipt = await insertGoodsReceipt();

    const response = await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1).expect(202);
    const validate = validator(
      'POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel',
      202,
    );
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    const row = await prisma.goods_receipt.findUniqueOrThrow({
      where: { goods_receipt_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(row.status_code).toBe('CANCEL_REQUESTED');
    expect(row.version_no).toBe(2);
    const approval = await prisma.approval_request.findUniqueOrThrow({
      where: { approval_request_id: BigInt(response.body.approvalRequestId) },
    });
    expect(approval).toMatchObject({
      approval_type_code: 'GOODS_RECEIPT_CANCEL',
      target_type_code: 'GOODS_RECEIPT',
      target_id: BigInt(receipt.goodsReceiptId),
      status_code: 'PENDING',
    });
  });

  it(':request-cancel — If-Match 가 없으면 400 · 낡은 토큰이면 409', async () => {
    const receipt = await insertGoodsReceipt();

    const missing = await request(app.getHttpServer())
      .post(`/api/logistics/document-progress/GOODS_RECEIPT/${receipt.goodsReceiptId}:request-cancel`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: '토큰 없이 보냄' });
    expect(missing.status).toBe(400);

    // 낡은 토큰은 재로드하면 풀리는 저장 충돌이다 — 400 계열과 갈린다(공유계약 G-1).
    const stale = await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 99);
    expect(stale.status).toBe(409);
  });

  it(':request-cancel — 대상 문서 상세 GET 의 ETag 가 그대로 통과한다(토큰 출처 대조)', async () => {
    const receipt = await insertGoodsReceipt();

    // ⭐ 토큰의 출처는 «이 경로»가 아니라 대상 문서 리소스의 상세 GET 이다(계약 · §7-2).
    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/goods-receipts/${receipt.goodsReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);
    const etag = detail.headers.etag as string;
    expect(etag).toBe('1');

    await request(app.getHttpServer())
      .post(`/api/logistics/document-progress/GOODS_RECEIPT/${receipt.goodsReceiptId}:request-cancel`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', etag)
      .send({ reason: 'ETag 를 그대로 실어 보냄' })
      .expect(202);
  });

  it(':request-cancel — 같은 Idempotency-Key 재전송이 요청을 둘 만들지 않는다', async () => {
    const receipt = await insertGoodsReceipt();
    const key = randomUUID();

    const first = await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1, key).expect(202);
    const again = await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1, key).expect(202);

    expect(again.body.approvalRequestId).toBe(first.body.approvalRequestId);
    const requests = await prisma.approval_request.findMany({
      where: { target_type_code: 'GOODS_RECEIPT', target_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(requests).toHaveLength(1);
  });

  it(':request-cancel — 없는 문서면 404', async () => {
    const response = await requestCancel('GOODS_RECEIPT', 999999999, 1);

    expect(response.status).toBe(404);
  });

  it(':request-cancel — 두 번째 요청은 400 CANCEL_IN_PROGRESS 다', async () => {
    const receipt = await insertGoodsReceipt();
    await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1).expect(202);

    // 상태가 옮겨졌으니 토큰도 새것을 쓴다 — 409(저장 충돌)가 아니라 400 이어야 한다(R-9).
    const again = await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2);

    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'CANCEL_IN_PROGRESS' });
  });

  it(':request-cancel — 입하·입고·출고 3유형이 같은 경로로 선다', async () => {
    const targets = [
      { type: 'INBOUND_RECEIPT' as const, id: (await insertInboundReceipt()).inboundReceiptId },
      { type: 'GOODS_RECEIPT' as const, id: (await insertGoodsReceipt()).goodsReceiptId },
      { type: 'GOODS_ISSUE' as const, id: (await insertGoodsIssue()).goodsIssueId },
    ];

    for (const target of targets) {
      const response = await requestCancel(target.type, target.id, 1).expect(202);
      const approval = await prisma.approval_request.findUniqueOrThrow({
        where: { approval_request_id: BigInt(response.body.approvalRequestId) },
      });
      expect(approval.approval_type_code).toBe(`${target.type}_CANCEL`);
      expect(approval.target_type_code).toBe(target.type);
    }

    // ⛔ 대상 표의 approval_request_id 를 안 덮는다 — I-4 의 업무 품의 흔적이 정본이고 다형 축이
    //    승인의 정본이다(§2-5 · plan.md §5 #12). 그 칸을 가진 둘(입하·출고)로 확인한다.
    const issue = await prisma.goods_issue.findUniqueOrThrow({
      where: { goods_issue_id: BigInt(targets[2].id) },
    });
    expect(issue.approval_request_id).toBeNull();
    const inbound = await prisma.inbound_receipt.findUniqueOrThrow({
      where: { inbound_receipt_id: BigInt(targets[0].id) },
    });
    expect(inbound.approval_request_id).toBeNull();
    expect(inbound.status_code).toBe('CANCEL_REQUESTED');
  });

  /** 취소 요청 한 벌 — 토큰은 대상 문서의 `version_no` 다(§7-2). */
  function requestCancel(
    typeCode: string,
    documentId: number,
    version: number,
    key = randomUUID(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/document-progress/${typeCode}/${documentId}:request-cancel`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', String(version))
      .send({ reason: '초과 입하분 오등록 — 취소 요청' });
  }

  /** 라인 없는 입하 — LOT 축이 비어 후속 0이다(라인의 `lot_id` 가 nullable · §4-2). */
  async function insertInboundReceipt(): Promise<{ inboundReceiptId: number }> {
    inboundSeq += 1;
    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP-${inboundSeq}`, partner_name: '진행현황검사공급사' },
    });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR-${inboundSeq}`,
        supplier_id: supplier.partner_id,
        plant_id: plantId,
        receipt_datetime: new Date(AT),
        status_code: 'REGISTERED',
      },
    });
    return { inboundReceiptId: Number(receipt.inbound_receipt_id) };
  }

  let inboundSeq = 0;
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

  /**
   * `POSTED` 단계 픽스처 — 실 전기 흐름(`InventoryPostingService`) 대신 원장 헤더를 직접
   * 세운다. 이 스위트의 목은 상세 조회·매핑이지 posting 이 아니다(같은 근거로 목록도 직접 INSERT).
   * ⚠ `occurred_at` 은 «지금»을 쓴다 — 대상 문서 `created_at` 이 `clock_timestamp()` 기본값(실제
   *   현재 시각)이라, 고정된 과거 `AT` 를 쓰면 REGISTERED 보다 POSTED 가 앞서는 뒤집힌 순서가 된다.
   */
  async function insertPostedLedger(sourceDocumentId: number): Promise<{ transactionNo: string }> {
    receiptSeq += 1;
    const transactionNo = `${PREFIX}-TX-${receiptSeq}`;
    await prisma.inventory_transaction.create({
      data: {
        business_date: new Date('2026-05-04'),
        transaction_no: transactionNo,
        transaction_type_code: 'GOODS_RECEIPT',
        plant_id: plantId,
        occurred_at: new Date(),
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: BigInt(sourceDocumentId),
        status_code: 'POSTED',
        idempotency_key: `${PREFIX}-IDEMP-${transactionNo}`,
      },
    });
    return { transactionNo };
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
    // 쓰기 `:request-cancel` 만 403 을 선언한다 — 도출표(`derived-permissions.ts:168`)가 W-01-13 이다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '진행현황검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-01-13' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    // 결재선은 `approval_route` 시드가 0행이라 3유형을 직접 심는다 — 단계 1(자기 결재).
    for (const approvalTypeCode of CANCEL_APPROVAL_TYPES) {
      await seedRoute(prisma, approvalTypeCode, [user.app_user_id]);
    }
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
    // 원장 header 는 트리거가 UPDATE·DELETE 를 막는다 — TRUNCATE 뿐이다(입고 스위트 선례).
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    // 승인은 문서보다 «먼저» 지운다 — 단계 → 요청 → 결재선 순(FK 방향).
    const cancelTypes = { approval_type_code: { in: CANCEL_APPROVAL_TYPES } };
    await prisma.approval_step.deleteMany({ where: { approval_request: cancelTypes } });
    await prisma.approval_request.deleteMany({ where: cancelTypes });
    await prisma.approval_route_step.deleteMany({ where: { approval_route: cancelTypes } });
    await prisma.approval_route.deleteMany({ where: cancelTypes });
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`);
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
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
