/**
 * 물류 문서 진행현황 — 목록 `GET /logistics/document-progress`(I-5 PR ③a) + 상세
 * `GET …/{documentTypeCode}/{documentId}`(PR ③b) + 취소 요청 `POST …:request-cancel`(PR ④).
 * `:cancel` 실행(PR ⑤)까지 한 파일이다.
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
/**
 * ⛔ 자재 MES LOT 번호(`materialMesLotNo`)가 품목 코드를 **9자리 숫자**, 공급사 코드를
 * **6자리 숫자**로 그대로 담고, 사전부착 공급사 LOT 번호는 **숫자 34자리**여야 한다(#610).
 * 이 셋만 숫자로 두고 나머지 마스터 코드는 PREFIX 를 그대로 쓴다.
 */
const ITEM_CODE = '900000201';
const PO_SUPPLIER_BASE = 910000;
const SUPPLIER_BASE = 920000;
const supplierCodeOf = (base: number, seq: number): string => String(base + seq);
const supplierLotNoOf = (seq: number): string => `9002${String(seq).padStart(30, '0')}`;
const ROLE = `${PREFIX}-ROLE`;
const AT = '2026-05-04T02:00:00.000Z';
/** `AT` 의 영업일. ⛔ 서버가 도출하지 않는다 — 클라이언트가 보낸다(C-8). */
const DAY = '2026-05-04';
/** 계약 경로 `documentTypeCode` enum 3값 — 승인 유형은 `${유형}_CANCEL` 이다(§6-2). */
const CANCELABLE = ['INBOUND_RECEIPT', 'GOODS_RECEIPT', 'GOODS_ISSUE'] as const;
const CANCEL_APPROVAL_TYPES = CANCELABLE.map((type) => `${type}_CANCEL`);
/** 이 사유가 곧 취소 이력이 된다 — `document_cancellation.reason_detail` 로 그대로 실린다. */
const CANCEL_REASON = '초과 입하분 오등록 — 취소 요청';

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
  let businessUnitId: number;

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

  it(':cancel — M1: 요청 → 결재 승인 → 실행 → 역트랜잭션 → 잔액 원복', async () => {
    const receipt = await receiveViaApi(100);
    expect(await onHand(receipt.lotId)).toBe(100);
    await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2).expect(200);

    expect(response.body).toMatchObject({ statusCode: 'CANCELLED', reversed: true });
    // ⭐ M1 완료 조건 — 잔액이 원복된다.
    expect(await onHand(receipt.lotId)).toBe(0);
    const row = await prisma.goods_receipt.findUniqueOrThrow({
      where: { goods_receipt_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(row).toMatchObject({ status_code: 'CANCELLED', version_no: 3 });
    // 취소 흔적은 한 표가 진다 — reason_code 는 비고 사유 원문이 reason_detail 에 실린다(R-1).
    const trace = await prisma.document_cancellation.findFirstOrThrow({
      where: { document_type_code: 'GOODS_RECEIPT', document_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(trace.reason_code).toBeNull();
    expect(trace.reason_detail).toBe(CANCEL_REASON);
    expect(trace.previous_status_code).toBe('CANCEL_REQUESTED');
  });

  it(':cancel — J-8: 승인 뒤 후속이 생기면 400 SUCCESSOR_EXISTS 이고 승인은 APPROVED 그대로다', async () => {
    const receipt = await receiveViaApi(100);
    const approvalRequestId = await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);
    // ⭐ 승인을 기다리는 «사이»에 후속이 생겼다 — 자동 실행이면 이것을 못 본다(계약 J-8).
    await issueViaApi(receipt.goodsReceiptId, receipt.lotId, 10);

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
    // ⌜승인은 그대로 유효하다 — 새 요청을 다시 올리지 않는다⌝ · 문서도 CANCEL_REQUESTED 그대로다.
    const approval = await prisma.approval_request.findUniqueOrThrow({
      where: { approval_request_id: BigInt(approvalRequestId) },
    });
    expect(approval.status_code).toBe('APPROVED');
    const row = await prisma.goods_receipt.findUniqueOrThrow({
      where: { goods_receipt_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(row.status_code).toBe('CANCEL_REQUESTED');
    expect(
      await prisma.document_cancellation.count({
        where: { document_type_code: 'GOODS_RECEIPT', document_id: BigInt(receipt.goodsReceiptId) },
      }),
    ).toBe(0);
  });

  it(':cancel — 승인 전이면 400 이다', async () => {
    const receipt = await receiveViaApi(10);
    await requestCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1).expect(202);

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
  });

  it(':cancel — 상태 자물쇠가 정본 가드다(승인 요청 0건이면 400 STATE_LOCKED)', async () => {
    // `assertApproved` 는 요청이 0건이면 통과한다 — 막는 것은 document-cancel 의 from 뿐이다(R-8).
    const receipt = await receiveViaApi(10);

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });
  });

  it(':cancel — 전기 전 전표를 취소하면 reversed:false 이고 원장이 0건이다', async () => {
    const issue = await insertGoodsIssue();
    await approveCancel('GOODS_ISSUE', issue.goodsIssueId, 1);

    const response = await callCancel('GOODS_ISSUE', issue.goodsIssueId, 2).expect(200);

    expect(response.body.reversed).toBe(false);
    // ⛔ 널이 아니라 «키 생략»이다(plan.md §5 규칙 7).
    expect(response.body).not.toHaveProperty('reversalTransactionNo');
    expect(response.body).not.toHaveProperty('reversalBusinessDate');
    expect(
      await prisma.inventory_transaction.count({
        where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: BigInt(issue.goodsIssueId) },
      }),
    ).toBe(0);
  });

  it(':cancel — 되돌리면 가용 재고가 음수가 되면 400 NEGATIVE_BALANCE 다', async () => {
    const receipt = await receiveViaApi(100);
    await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);
    // ⚠ 같은 LOT 을 «실제로 빼는» 출고는 후속 판정(LOT 축)에 먼저 걸려 이 경로에 못 닿는다 —
    //   그래서 가용을 줄이는 다른 축(예약)으로 세운다. 「알려둘 것」에 올린 사실이다.
    await prisma.inventory_balance.updateMany({
      where: { item_id: BigInt(itemId), lot_id: BigInt(receipt.lotId) },
      data: { reserved_qty: 100 },
    });

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2);

    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ code: 'NEGATIVE_BALANCE' });
    // ⭐ 역처리가 막히면 상태도 안 옮긴다(어댑터가 전이 «앞»이다).
    const row = await prisma.goods_receipt.findUniqueOrThrow({
      where: { goods_receipt_id: BigInt(receipt.goodsReceiptId) },
    });
    expect(row.status_code).toBe('CANCEL_REQUESTED');
  });

  it(':cancel — 입하 취소가 P/O 라인의 received_qty 를 되돌린다', async () => {
    const inbound = await inboundAgainstOrder(10);
    const before = await prisma.purchase_order_line.findUniqueOrThrow({
      where: { purchase_order_line_id: BigInt(inbound.purchaseOrderLineId) },
    });
    expect(Number(before.received_qty)).toBe(10);
    await approveCancel('INBOUND_RECEIPT', inbound.inboundReceiptId, 1);

    const response = await callCancel('INBOUND_RECEIPT', inbound.inboundReceiptId, 2).expect(200);

    // 입하는 전기 경로가 없다 — reversed 가 언제나 거짓이다(plan-api.md S02).
    expect(response.body.reversed).toBe(false);
    const after = await prisma.purchase_order_line.findUniqueOrThrow({
      where: { purchase_order_line_id: BigInt(inbound.purchaseOrderLineId) },
    });
    expect(Number(after.received_qty)).toBe(0);
    // ⛔ 라인의 LOT 은 그대로 남는다 — 「어느 LOT 이 이 입하에서 났나」를 지우지 않는다(I-3 R-12 ⓒ).
    const lines = await prisma.inbound_receipt_line.findMany({
      where: { inbound_receipt_id: BigInt(inbound.inboundReceiptId) },
      select: { lot_id: true },
    });
    expect(lines.every((line) => line.lot_id !== null)).toBe(true);
  });

  it(':cancel — 두 번째 호출은 400 ALREADY_CANCELLED 다', async () => {
    const receipt = await receiveViaApi(10);
    await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);
    await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2).expect(200);

    // 토큰도 새것을 쓴다 — 409(저장 충돌)가 아니라 400 이어야 한다.
    const again = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 3);

    expect(again.status).toBe(400);
    expect(again.body.errors[0]).toMatchObject({ code: 'ALREADY_CANCELLED' });
  });

  it(':cancel — 200 본문이 CancelResult 4칸을 채우고 역처리 시 번호·영업일 2칸을 더 낸다', async () => {
    const receipt = await receiveViaApi(20);
    await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);

    const response = await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2).expect(200);

    const validate = validator(
      'POST /logistics/document-progress/{documentTypeCode}/{documentId}:cancel',
      200,
    );
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      documentTypeCode: 'GOODS_RECEIPT',
      documentId: receipt.goodsReceiptId,
      statusCode: 'CANCELLED',
      reversed: true,
      reversalBusinessDate: DAY,
    });
    // 역행 번호는 `{원 번호}-R` 파생이다 — 채번을 안 부른다(§3-5).
    expect(String(response.body.reversalTransactionNo)).toMatch(/-R$/);
    // ⛔ 낙관적 잠금 토큰을 안 내린다 — 계약이 200 에 ETag 를 선언하지 않았다. 헤더에 보이는
    //    것은 Express 가 본문 해시로 붙이는 약한 ETag 라 `version_no` 가 아니다.
    expect(String(response.headers.etag)).toMatch(/^W\//);
  });

  it(':cancel — 역트랜잭션의 business_date 가 원 원장의 것과 같다', async () => {
    const receipt = await receiveViaApi(30);
    await approveCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 1);

    await callCancel('GOODS_RECEIPT', receipt.goodsReceiptId, 2).expect(200);

    const rows = await prisma.inventory_transaction.findMany({
      where: { source_document_type_code: 'GOODS_RECEIPT', source_document_id: BigInt(receipt.goodsReceiptId) },
      orderBy: { inventory_transaction_id: 'asc' },
    });
    expect(rows).toHaveLength(2);
    const [original, reversal] = rows;
    // ⛔ 역행의 영업일은 «원» 트랜잭션의 것이다 — :cancel 이 businessDate 를 안 받는다(C-8 · §3-4).
    expect(reversal.business_date.toISOString().slice(0, 10)).toBe(
      original.business_date.toISOString().slice(0, 10),
    );
    expect(reversal.reversal_of_transaction_id).toBe(original.inventory_transaction_id);
    expect(reversal.transaction_no).toBe(`${original.transaction_no}-R`);
  });

  /** 취소 실행 한 벌. 본문이 없다 — 계약에 requestBody 가 0건이다. */
  function callCancel(
    typeCode: string,
    documentId: number,
    version: number,
    key = randomUUID(),
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/document-progress/${typeCode}/${documentId}:cancel`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', String(version));
  }

  /** 요청 → 결재 승인까지. 결재선은 단계 1(자기 결재)이라 같은 계정이 승인한다(§10-1). */
  async function approveCancel(
    typeCode: string,
    documentId: number,
    version: number,
  ): Promise<number> {
    const requested = await requestCancel(typeCode, documentId, version).expect(202);
    const approvalRequestId = requested.body.approvalRequestId as number;
    const detail = await request(app.getHttpServer())
      .get(`/api/app/approval-requests/${approvalRequestId}`)
      .set('Cookie', cookie)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/app/approval-requests/${approvalRequestId}:approve`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', detail.headers.etag as string)
      .send({})
      .expect(200);
    return approvalRequestId;
  }

  /** ⭐ 원장·잔액·적치를 한 번에 세운다 — 입고 API 를 «부른다». 직접 INSERT 는 차원 11칸을 손으로 맞춰야 한다. */
  async function receiveViaApi(
    receiptQty: number,
  ): Promise<{ goodsReceiptId: number; lotId: number }> {
    const lotId = await makeLot();
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId,
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId,
            lotId,
            receiptQty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: locationId,
          },
        ],
      })
      .expect(201);
    return { goodsReceiptId: response.body.goodsReceipt.goodsReceiptId as number, lotId };
  }

  /** J-8 의 「그 사이 생긴 후속」 — 같은 LOT 을 빼는 실 출고다. */
  async function issueViaApi(
    sourceGoodsReceiptId: number,
    lotId: number,
    issueQty: number,
  ): Promise<number> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'OTHER',
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: sourceGoodsReceiptId,
        sourceWarehouseId: warehouseId,
        issuedAt: AT,
        businessDate: DAY,
        occurredAt: AT,
        postImmediately: true,
        lines: [{ itemId, lotId, issueQty, uomId, sourceLocationId: locationId }],
      })
      .expect(201);
    return response.body.goodsIssue.goodsIssueId as number;
  }

  /** P/O 는 직접 INSERT(등록은 이 스위트 밖이다) · 입하 API 가 `received_qty` 를 올린다. */
  async function inboundAgainstOrder(
    receivedQty: number,
  ): Promise<{ inboundReceiptId: number; purchaseOrderLineId: number }> {
    inboundSeq += 1;
    const supplier = await prisma.partner.create({
      data: { partner_code: supplierCodeOf(PO_SUPPLIER_BASE, inboundSeq), partner_name: '발주검사공급사' },
    });
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${inboundSeq}`,
        supplier_id: supplier.partner_id,
        business_unit_id: BigInt(businessUnitId),
        plant_id: BigInt(plantId),
        order_date: new Date(`${DAY}T00:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    const line = await prisma.purchase_order_line.create({
      data: {
        purchase_order_id: order.purchase_order_id,
        line_no: 1,
        item_id: BigInt(itemId),
        ordered_qty: 100,
        uom_id: BigInt(uomId),
      },
    });
    const response = await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', 'W-0001')
      .send({
        supplierId: Number(supplier.partner_id),
        plantId,
        receiptDatetime: AT,
        businessDate: DAY,
        occurredAt: AT,
        lines: [
          {
            itemId,
            purchaseOrderLineId: Number(line.purchase_order_line_id),
            receivedQty,
            uomId,
            supplierLotNo: supplierLotNoOf(inboundSeq),
            supplierLotMissing: false,
          },
        ],
      })
      .expect(201);
    return {
      inboundReceiptId: response.body.inboundReceipt.inboundReceiptId as number,
      purchaseOrderLineId: Number(line.purchase_order_line_id),
    };
  }

  async function onHand(lotId: number): Promise<number> {
    const rows = await prisma.inventory_balance.findMany({
      where: { item_id: BigInt(itemId), lot_id: BigInt(lotId) },
      select: { on_hand_qty: true },
    });
    return rows.reduce((sum, row) => sum + Number(row.on_hand_qty), 0);
  }

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
      .send({ reason: CANCEL_REASON });
  }

  /** 라인 없는 입하 — LOT 축이 비어 후속 0이다(라인의 `lot_id` 가 nullable · §4-2). */
  async function insertInboundReceipt(): Promise<{ inboundReceiptId: number }> {
    inboundSeq += 1;
    const supplier = await prisma.partner.create({
      data: { partner_code: supplierCodeOf(SUPPLIER_BASE, inboundSeq), partner_name: '진행현황검사공급사' },
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
    businessUnitId = Number(unit.business_unit_id);
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
        item_code: ITEM_CODE,
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
    // ⭐ 취소(W-01-13) 외에 넷이 더 필요하다 — 원장·잔액을 «실 API» 로 세우고(입고 W-01-10 ·
    //    출고 W-01-06 · 입하 M-01-01) 취소 승인을 «부르기»(W-03-09) 때문이다(§10-1).
    for (const permissionCode of ['W-01-13', 'W-01-10', 'W-01-06', 'M-01-01', 'W-03-09']) {
      await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permissionCode } });
    }
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
    // ⭐ API 로 만든 전표는 번호를 채번이 짓는다(PREFIX 가 아니다) — 공장·창고·품목으로 짚는다.
    const plantScope = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    const itemScope = `(SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`;
    const warehouseScope = `(SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(
      `DELETE FROM app.document_cancellation
        WHERE cancelled_by IN (SELECT app_user_id FROM app.app_user WHERE login_id = '${LOGIN_ID}')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.inventory_balance WHERE item_id IN ${itemScope}`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.putaway_task WHERE item_id IN ${itemScope}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN
        (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${plantScope})`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.inbound_receipt WHERE plant_id IN ${plantScope}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.subcontract_issue
        WHERE subcontract_order_id IN (SELECT subcontract_order_id FROM logistics.subcontract_order WHERE subcontract_order_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.subcontract_order WHERE subcontract_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_issue_line WHERE goods_issue_id IN
        (SELECT goods_issue_id FROM logistics.goods_issue WHERE source_warehouse_id IN ${warehouseScope})`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.goods_issue WHERE source_warehouse_id IN ${warehouseScope}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN
        (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN ${plantScope})`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.goods_receipt WHERE plant_id IN ${plantScope}`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.picking_order WHERE picking_order_no LIKE '${PREFIX}%'`);
    // ⭐ 입하 라인은 LOT 을 문다(A3 FK) — 위에서 먼저 지웠다.
    const lotScope = `(SELECT lot_id FROM trace.lot WHERE item_id IN ${itemScope})`;
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_hold WHERE lot_id IN ${lotScope}`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_external_identifier WHERE lot_id IN ${lotScope}`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE item_id IN ${itemScope}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.purchase_order_line WHERE purchase_order_id IN
        (SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${plantScope})`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.purchase_order WHERE plant_id IN ${plantScope}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    // ⛔ 공급사 코드가 «숫자»라 접두로 못 짚는다. 코드 패턴으로 지우면 남의 스위트·시드가
    //    만든 6자리 코드까지 쓸어 간다 — 이 스위트만 쓰는 «이름»으로 짚는다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM mdm.partner
       WHERE partner_code LIKE '${PREFIX}%'
          OR partner_name IN ('발주검사공급사', '진행현황검사공급사')`);
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
