/**
 * P/O 쓰기 넷(등록·헤더 수정·라인 치환·승인 요청) — 화면 `W-01-11`. 조회 3건은 PR ③ 이
 * 구현했고 여기서는 등록 응답·필터로만 함께 검사한다.
 *
 * cleanup 이 이 사용자의 `approval_request`(target `PURCHASE_ORDER`)도 미리 지운다 —
 * 잔존 행이 `app_user` 삭제를 막지 않도록(#191 Minor).
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

const LOGIN_ID = 'e2e-po-write-probe';
const NOPERM_ID = 'e2e-po-write-noperm';
const PASSWORD = 'PO-쓰기-검사-비밀번호';
const PREFIX = 'POWE2E';
const ROLE = 'E2E_PO_WRITE';
const PERMISSIONS = ['W-01-11'];
const ORDER_DATE = '2026-08-06';

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

const key = (): string => randomUUID();

interface OrderBody {
  purchaseOrderId: number;
  purchaseOrderNo: string;
  erpPurchaseOrderNo: string | null;
  supplierId: number;
  businessUnitId: number;
  plantId: number;
  orderDate: string;
  expectedReceiptDate: string | null;
  statusCode: string;
  approvalRequestId: number | null;
}
interface LineBody {
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  lineNo: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
  receivedQty: number;
  toleranceOverQty: number;
  toleranceUnderQty: number;
}
interface Detail {
  purchaseOrder: OrderBody;
  lines: LineBody[];
}
interface LineDraft {
  purchaseOrderLineId?: number;
  itemId: number;
  orderedQty: number;
  uomId: number;
}
interface Draft {
  supplierId: number;
  businessUnitId: number;
  plantId: number;
  orderDate: string;
  lines: LineDraft[];
}

describe('P/O 등록·헤더 수정·라인 치환·상신 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let supplierId: number;
  let businessUnitId: number;
  let plantId: number;
  let itemId: number;
  let uomId: number;
  let approverUserId: bigint;
  let approvalRouteId: bigint;
  let inboundReceiptId: bigint;
  let asnId: bigint;
  let successorLineNo = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('P/O — 등록 응답이 계약 PurchaseOrderDetailResponse 를 만족한다', async () => {
    const detail = await create();

    const validate = validator('POST /logistics/purchase-orders', 201);
    expect(validate(detail)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('P/O — 등록이 헤더와 라인을 한 트랜잭션으로 만든다(라인 실패면 헤더도 없다)', async () => {
    const before = await prisma.purchase_order.count({ where: { supplier_id: supplierId } });

    await send({
      supplierId,
      businessUnitId,
      plantId,
      orderDate: ORDER_DATE,
      lines: [
        { itemId, orderedQty: 10, uomId },
        // 없는 uom — 라인 삽입이 FK 위반으로 실패해 트랜잭션 전체가 롤백돼야 한다.
        { itemId, orderedQty: 5, uomId: 999999999 },
      ],
    }).expect(400);

    expect(await prisma.purchase_order.count({ where: { supplier_id: supplierId } })).toBe(before);
  });

  it('P/O — 라인이 빈 배열이면 400 LINE_REQUIRED 다(가드가 아니라 서비스가 막는다)', async () => {
    const rejected = await send({ ...body(), lines: [] }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('P/O — 발주번호는 서버가 짓는다(PO-YYYYMMDD-NNNN)', async () => {
    const detail = await create();
    expect(detail.purchaseOrder.purchaseOrderNo).toMatch(/^PO-20260806-\d{4,}$/);
  });

  it('P/O — 상태는 서버가 REGISTERED 로 정한다(본문이 statusCode 를 받지 않는다)', async () => {
    const draft = body();
    const created = await send({ ...draft, statusCode: 'POSTED' } as object).expect(201);
    expect((created.body as Detail).purchaseOrder.statusCode).toBe('REGISTERED');
  });

  it('P/O — 같은 Idempotency-Key 재전송도 같은 ETag 를 준다(201)', async () => {
    const draft = body();
    const idempotencyKey = key();

    const first = await send(draft, idempotencyKey).expect(201);
    const second = await send(draft, idempotencyKey).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(
      await prisma.purchase_order.count({
        where: { purchase_order_id: first.body.purchaseOrder.purchaseOrderId },
      }),
    ).toBe(1);
  });

  it('P/O — 상세가 ETag 를 헤더로만 내린다(본문에 versionNo 가 없다)', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders/${detail.purchaseOrder.purchaseOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.body.purchaseOrder).not.toHaveProperty('versionNo');
  });

  it('P/O — 목록이 supplierId·plantId·statusCode·openOnly 로 걸린다', async () => {
    const detail = await create();

    const found = await list(
      `supplierId=${supplierId}&plantId=${plantId}&statusCode=REGISTERED&openOnly=true`,
    );
    expect(found.items.map((row) => row.purchaseOrderId)).toContain(
      detail.purchaseOrder.purchaseOrderId,
    );

    const excluded = await list(`supplierId=${supplierId + 999999}`);
    expect(excluded.items.map((row) => row.purchaseOrderId)).not.toContain(
      detail.purchaseOrder.purchaseOrderId,
    );
  });

  it('P/O — 헤더 수정에 If-Match 가 없으면 400 이다', async () => {
    const detail = await create();
    await request(app.getHttpServer())
      .put(`/api/logistics/purchase-orders/${detail.purchaseOrder.purchaseOrderId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({ supplierId, orderDate: ORDER_DATE })
      .expect(400);
  });

  it('P/O — 낡은 If-Match 로 수정하면 409 다', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    const firstEtag = await etagOf(id);

    await putHeader(id, firstEtag, { supplierId, orderDate: '2026-08-07' }).expect(200);

    const rejected = await putHeader(id, firstEtag, {
      supplierId,
      orderDate: '2026-08-08',
    }).expect(409);
    expect(rejected.body.conflictCause).toBe('user');
  });

  it('P/O — 수정 본문은 사업부·공장·상태를 받지 않는다(스키마에 칸이 없다)', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    const etag = await etagOf(id);

    // 서비스가 읽지 않는 칸이라 값이 뭐든(존재하지 않는 FK 라도) 원래 값 그대로 남는다.
    const updated = await putHeader(id, etag, {
      supplierId,
      orderDate: ORDER_DATE,
      businessUnitId: businessUnitId + 999999,
      plantId: plantId + 999999,
      statusCode: 'POSTED',
    } as object).expect(200);

    expect((updated.body as OrderBody).businessUnitId).toBe(businessUnitId);
    expect((updated.body as OrderBody).plantId).toBe(plantId);
    expect((updated.body as OrderBody).statusCode).toBe('REGISTERED');
  });

  it('P/O — 등록 본문의 purchaseOrderLineId 는 무시되고 신규 라인으로 선다', async () => {
    const draft = body();
    draft.lines[0] = { ...draft.lines[0], purchaseOrderLineId: 999999999 };

    const created = await send(draft).expect(201);
    const detail = created.body as Detail;

    expect(detail.lines[0].purchaseOrderLineId).not.toBe(999999999);
    expect(detail.lines[0].lineNo).toBe(1);
  });

  it('P/O — 없는 P/O 를 수정하면 404 다(계약 미선언 · R-1)', async () => {
    await request(app.getHttpServer())
      .put('/api/logistics/purchase-orders/999999999')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '1')
      .send({ supplierId, orderDate: ORDER_DATE })
      .expect(404);
  });

  it('P/O — 권한 없는 사용자의 PUT 은 403 이다(500 이 아니다)', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    const etag = await etagOf(id);

    await request(app.getHttpServer())
      .put(`/api/logistics/purchase-orders/${id}`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ supplierId, orderDate: ORDER_DATE })
      .expect(403);
  });

  it('라인 — 배열 순서가 lineNo 1..N 이 된다(요청이 lineNo 를 보내지 않는다)', async () => {
    const id = await newOrder();

    const replaced = await putLines(id, await etagOf(id), [
      { itemId, orderedQty: 7, uomId },
      { itemId, orderedQty: 8, uomId },
      { itemId, orderedQty: 9, uomId },
    ]).expect(200);

    const items = (replaced.body as { items: LineBody[] }).items;
    expect(items.map((line) => line.lineNo)).toEqual([1, 2, 3]);
    expect(items.map((line) => line.orderedQty)).toEqual([7, 8, 9]);

    const validate = validator('PUT /logistics/purchase-orders/{purchaseOrderId}/lines', 200);
    expect(validate(replaced.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('라인 — 1↔2 를 맞바꿔도 uq_purchase_order_line 을 위반하지 않는다(한 트랜잭션)', async () => {
    const id = await newOrder();
    const seeded = await putLines(id, await etagOf(id), [
      { itemId, orderedQty: 11, uomId },
      { itemId, orderedQty: 22, uomId },
    ]).expect(200);
    const [first, second] = (seeded.body as { items: LineBody[] }).items;

    const swapped = await putLines(id, await etagOf(id), [
      { purchaseOrderLineId: second.purchaseOrderLineId, itemId, orderedQty: 22, uomId },
      { purchaseOrderLineId: first.purchaseOrderLineId, itemId, orderedQty: 11, uomId },
    ]).expect(200);

    const items = (swapped.body as { items: LineBody[] }).items;
    expect(items.map((line) => line.purchaseOrderLineId)).toEqual([
      second.purchaseOrderLineId,
      first.purchaseOrderLineId,
    ]);
    expect(items.map((line) => line.lineNo)).toEqual([1, 2]);
  });

  it('라인 — 요청에서 빠진 기존 행은 지워진다', async () => {
    const id = await newOrder();
    const seeded = await putLines(id, await etagOf(id), [
      { itemId, orderedQty: 11, uomId },
      { itemId, orderedQty: 22, uomId },
    ]).expect(200);
    const [kept, dropped] = (seeded.body as { items: LineBody[] }).items;

    const replaced = await putLines(id, await etagOf(id), [
      { purchaseOrderLineId: kept.purchaseOrderLineId, itemId, orderedQty: 11, uomId },
    ]).expect(200);

    expect((replaced.body as { items: LineBody[] }).items).toHaveLength(1);
    expect(
      await prisma.purchase_order_line.count({
        where: { purchase_order_line_id: BigInt(dropped.purchaseOrderLineId) },
      }),
    ).toBe(0);
  });

  it('라인 — 이미 입하가 붙은 라인을 지우면 400 SUCCESSOR_EXISTS 다', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    await attachReceiptLine(detail.lines[0].purchaseOrderLineId);

    const rejected = await putLines(id, await etagOf(id), [
      { itemId, orderedQty: 5, uomId },
    ]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
  });

  it('라인 — ASN 이 붙은 라인을 지우면 400 이다(FK 위반이 500 으로 새지 않는다)', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    await attachAsnLine(detail.lines[0].purchaseOrderLineId);

    const rejected = await putLines(id, await etagOf(id), [
      { itemId, orderedQty: 5, uomId },
    ]).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'SUCCESSOR_EXISTS' });
  });

  it('라인 — 치환은 부모 version_no 를 올리고 새 ETag 를 준다(계약이 선언한 헤더다)', async () => {
    const id = await newOrder();
    const before = await etagOf(id);

    const replaced = await putLines(id, before, [{ itemId, orderedQty: 5, uomId }]).expect(200);

    expect(replaced.headers.etag).toBe(String(Number(before) + 1));
    expect(await etagOf(id)).toBe(replaced.headers.etag);
  });

  it('라인 — received_qty 를 밑도는 발주 수량은 400 이다(ck_po_line_received 가 500 으로 새지 않는다)', async () => {
    const detail = await create();
    const id = detail.purchaseOrder.purchaseOrderId;
    const line = detail.lines[0];
    // 누적 입하는 I-3 이 갱신하는 서버 값이라 API 로는 못 만든다 — 직접 심는다.
    await prisma.purchase_order_line.update({
      where: { purchase_order_line_id: BigInt(line.purchaseOrderLineId) },
      data: { received_qty: 50 },
    });

    await putLines(id, await etagOf(id), [
      { purchaseOrderLineId: line.purchaseOrderLineId, itemId, orderedQty: 10, uomId },
    ]).expect(400);
  });

  it('상신 — 202 와 approvalRequestId 를 준다', async () => {
    const id = await newOrder();

    const accepted = await submit(id, await etagOf(id)).expect(202);

    expect(accepted.body.approvalRequestId).toEqual(expect.any(Number));
    const validate = validator(
      'POST /logistics/purchase-orders/{purchaseOrderId}:request-approval',
      202,
    );
    expect(validate(accepted.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('상신 — approval_request 가 PURCHASE_ORDER 유형·대상으로 서고 단계가 전개된다', async () => {
    const id = await newOrder();

    const accepted = await submit(id, await etagOf(id)).expect(202);

    const row = await prisma.approval_request.findUniqueOrThrow({
      where: { approval_request_id: BigInt(accepted.body.approvalRequestId as number) },
    });
    expect(row.approval_type_code).toBe('PURCHASE_ORDER');
    expect(row.target_type_code).toBe('PURCHASE_ORDER');
    expect(Number(row.target_id)).toBe(id);
    expect(row.status_code).toBe('PENDING');
    expect(
      await prisma.approval_step.count({ where: { approval_request_id: row.approval_request_id } }),
    ).toBe(1);
  });

  it('상신 — P/O 의 status_code 는 REGISTERED 그대로다(승인 진행은 approval_request 가 진다)', async () => {
    const id = await newOrder();

    await submit(id, await etagOf(id)).expect(202);

    const row = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(id) },
    });
    expect(row.status_code).toBe('REGISTERED');
  });

  it('상신 — purchase_order.approval_request_id 가 채워진다', async () => {
    const id = await newOrder();

    const accepted = await submit(id, await etagOf(id)).expect(202);

    const row = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(id) },
    });
    expect(Number(row.approval_request_id)).toBe(accepted.body.approvalRequestId);
  });

  it('상신 — 반려 뒤 재상신하면 approval_request_id 가 «새» 요청으로 바뀐다', async () => {
    const id = await newOrder();
    const etag = await etagOf(id);
    const first = await submit(id, etag).expect(202);
    await reject(first.body.approvalRequestId as number);

    const second = await submit(id, etag).expect(202);

    expect(second.body.approvalRequestId).not.toBe(first.body.approvalRequestId);
    const row = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(id) },
    });
    expect(Number(row.approval_request_id)).toBe(second.body.approvalRequestId);
  });

  it('상신 — 같은 Idempotency-Key 재전송도 202 다', async () => {
    const id = await newOrder();
    const etag = await etagOf(id);
    const idempotencyKey = key();

    const first = await submit(id, etag, idempotencyKey).expect(202);
    const second = await submit(id, etag, idempotencyKey).expect(202);

    expect(second.body).toEqual(first.body);
    expect(
      await prisma.approval_request.count({
        where: { target_type_code: 'PURCHASE_ORDER', target_id: BigInt(id) },
      }),
    ).toBe(1);
  });

  it('상신 — 등록 201 의 ETag 를 그대로 If-Match 로 써서 상신한다(상세 GET 을 다시 돌지 않는다)', async () => {
    const created = await send(body()).expect(201);

    await submit(
      (created.body as Detail).purchaseOrder.purchaseOrderId,
      created.headers.etag,
    ).expect(202);
  });

  it('상신 — 결재선이 없으면 400 ROUTE_NOT_FOUND 이고 요청 행이 남지 않는다', async () => {
    const id = await newOrder();
    const own = { target_type_code: 'PURCHASE_ORDER', target_id: BigInt(id) };
    const before = await prisma.approval_request.count({ where: own });
    // 이 스위트가 심은 사업부 지정본을 내린다. ⚠ 같은 유형의 «공통본»을 심는 스위트가 따로
    // 있고(`app-approval-request.e2e-spec.ts` — 넷째 인자 없이 `seedRoute`) 그 스위트가
    // `afterAll` 에서 지운다. 그것이 남으면 이 검사가 202 로 새므로 셈은 이 P/O 로 좁힌다.
    await prisma.approval_route.update({
      where: { approval_route_id: approvalRouteId },
      data: { is_active: false },
    });
    try {
      const rejected = await submit(id, await etagOf(id)).expect(400);

      expect(rejected.body.errors[0]).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
      expect(await prisma.approval_request.count({ where: own })).toBe(before);
    } finally {
      await prisma.approval_route.update({
        where: { approval_route_id: approvalRouteId },
        data: { is_active: true },
      });
    }
  });

  it('상신 — 진행 중 요청이 있으면 400 APPROVAL_IN_PROGRESS 다', async () => {
    const id = await newOrder();
    const etag = await etagOf(id);
    await submit(id, etag).expect(202);

    const rejected = await submit(id, etag).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
  });

  it('상신 — 반려된 뒤에는 다시 상신된다(새 요청 번호)', async () => {
    const id = await newOrder();
    const etag = await etagOf(id);
    const first = await submit(id, etag).expect(202);
    await reject(first.body.approvalRequestId as number);

    const second = await submit(id, etag).expect(202);

    const numbers = await prisma.approval_request.findMany({
      where: { target_type_code: 'PURCHASE_ORDER', target_id: BigInt(id) },
      select: { approval_request_id: true, approval_request_no: true },
    });
    expect(numbers).toHaveLength(2);
    expect(new Set(numbers.map((row) => row.approval_request_no)).size).toBe(2);
    expect(numbers.map((row) => Number(row.approval_request_id))).toContain(
      second.body.approvalRequestId,
    );
  });

  it('상신 — 낡은 If-Match 로 상신하면 409 다(202 에 ETag 가 없는 것과 별개다)', async () => {
    const id = await newOrder();
    const stale = await etagOf(id);
    await putHeader(id, stale, { supplierId, orderDate: '2026-08-07' }).expect(200);

    const rejected = await submit(id, stale).expect(409);

    expect(rejected.body.conflictCause).toBe('user');
  });

  it('상신 — 같은 If-Match 로 뒤이어 PUT 이 통한다(202 에 ETag 가 없어 버전을 올리지 않는다)', async () => {
    const id = await newOrder();
    const etag = await etagOf(id);

    await submit(id, etag).expect(202);

    const after = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(id) },
    });
    expect(String(after.version_no)).toBe(etag);
    await putHeader(id, etag, { supplierId, orderDate: ORDER_DATE }).expect(200);
  });

  it('⭐ 원장이 움직이지 않는다 — inventory_transaction 이 0건 그대로다', async () => {
    const before = await prisma.inventory_transaction.count();
    const id = await newOrder();

    await putLines(id, await etagOf(id), [{ itemId, orderedQty: 3, uomId }]).expect(200);
    await submit(id, await etagOf(id)).expect(202);

    expect(await prisma.inventory_transaction.count()).toBe(before);
  });

  function send(payload: object, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/purchase-orders')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
  }

  function putHeader(
    purchaseOrderId: number,
    etag: string,
    payload: object,
    idempotencyKey = key(),
  ): request.Test {
    return request(app.getHttpServer())
      .put(`/api/logistics/purchase-orders/${purchaseOrderId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etag)
      .send(payload);
  }

  function putLines(
    purchaseOrderId: number,
    etag: string,
    items: LineDraft[],
    idempotencyKey = key(),
  ): request.Test {
    return request(app.getHttpServer())
      .put(`/api/logistics/purchase-orders/${purchaseOrderId}/lines`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etag)
      .send({ items });
  }

  function submit(purchaseOrderId: number, etag: string, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post(`/api/logistics/purchase-orders/${purchaseOrderId}:request-approval`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('If-Match', etag)
      .send({ reason: '초과 입하분 정산용 발주' });
  }

  /** 반려는 결재 오퍼레이션(app-공통) 몫이라 여기서는 상태만 직접 옮긴다. */
  async function reject(approvalRequestId: number): Promise<void> {
    await prisma.approval_request.update({
      where: { approval_request_id: BigInt(approvalRequestId) },
      data: { status_code: 'REJECTED' },
    });
  }

  /**
   * 입하 라인 — 「입하가 붙은」의 판정은 «행 존재»다. P/O 라인의 `received_qty` 는 0 그대로
   * 두고(누계 갱신은 I-3 몫) 입하 라인만 심는다 — 그 표는 `received_qty > 0` CHECK 이 있다.
   */
  async function attachReceiptLine(purchaseOrderLineId: number): Promise<void> {
    successorLineNo += 1;
    await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: successorLineNo,
        purchase_order_line_id: BigInt(purchaseOrderLineId),
        item_id: BigInt(itemId),
        received_qty: 1,
        uom_id: BigInt(uomId),
        supplier_lot_label_attached: true,
        inspection_required: false,
        status_code: 'RECEIVED',
      },
    });
  }

  /** ASN 만 붙은 라인 — 이것을 안 보면 FK 위반이 500 으로 샌다(I-2.md R-6). */
  async function attachAsnLine(purchaseOrderLineId: number): Promise<void> {
    successorLineNo += 1;
    await prisma.asn_line.create({
      data: {
        asn_id: asnId,
        line_no: successorLineNo,
        purchase_order_line_id: BigInt(purchaseOrderLineId),
        item_id: BigInt(itemId),
        expected_qty: 1,
        uom_id: BigInt(uomId),
      },
    });
  }

  async function newOrder(): Promise<number> {
    return (await create()).purchaseOrder.purchaseOrderId;
  }

  async function etagOf(purchaseOrderId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders/${purchaseOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function create(): Promise<Detail> {
    const draft = body();
    const created = await send(draft).expect(201);
    return created.body as Detail;
  }

  async function list(query: string): Promise<{ items: OrderBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as { items: OrderBody[] };
  }

  function body(): Draft {
    return {
      supplierId,
      businessUnitId,
      plantId,
      orderDate: ORDER_DATE,
      lines: [{ itemId, orderedQty: 100, uomId }],
    };
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: 'PO검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: 'PO검사사업부',
      },
    });
    businessUnitId = Number(unit.business_unit_id);
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: 'PO검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: 'PO검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
      },
    });
    itemId = Number(item.item_id);

    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP`, partner_name: 'PO검사공급사' },
    });
    supplierId = Number(supplier.partner_id);

    // 후속 문서 헤더 둘 — 라인 삭제 가드가 보는 두 표(`inbound_receipt_line`·`asn_line`).
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`,
        supplier_id: supplier.partner_id,
        plant_id: plant.plant_id,
        receipt_datetime: new Date(),
        status_code: 'RECEIVED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
    const asn = await prisma.asn.create({
      data: {
        asn_no: `${PREFIX}-ASN`,
        supplier_id: supplier.partner_id,
        plant_id: plant.plant_id,
        expected_arrival_date: new Date(`${ORDER_DATE}T00:00:00.000Z`),
        status_code: 'EXPECTED',
      },
    });
    asnId = asn.asn_id;

    // 사업부 지정본이라 이 스위트의 상신만 이 결재선을 고른다(공통본을 이긴다).
    approvalRouteId = await seedRoute(prisma, 'PURCHASE_ORDER', [approverUserId], unit.business_unit_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'PO쓰기검사', status_code: 'EMPLOYED' },
    });
    approverUserId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'PO쓰기검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /**
   * ⚠ 순환 FK — `purchase_order → inbound_receipt_line → purchase_order_line →
   * purchase_order`(I-2.md R-12 ①). 이 스위트는 `sourceInboundReceiptLineId` 를 채운
   * P/O 를 만들지 않으므로 후속 라인을 «먼저» 지울 수 있다(그 칸을 채우면 이 순서가 막힌다).
   */
  async function cleanup(): Promise<void> {
    const ownPlants = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.asn_line
       WHERE asn_id IN (SELECT asn_id FROM logistics.asn WHERE plant_id IN ${ownPlants})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.asn WHERE plant_id IN ${ownPlants}`);
    // 결재선은 이 사업부 지정본이라 사업부와 함께 지운다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM app.approval_route_step
       WHERE approval_route_id IN (
         SELECT approval_route_id FROM app.approval_route
          WHERE business_unit_id IN (
            SELECT business_unit_id FROM mdm.business_unit
             WHERE business_unit_code LIKE '${PREFIX}%')
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM app.approval_route
       WHERE business_unit_id IN (
         SELECT business_unit_id FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
      // #191 Minor — PR ⑤ 가 이 파일에 상신 e2e 를 더한다. 잔존 approval_request 가
      // app_user 삭제를 막지 않도록 먼저 지운다(단계 두 개 — approval_step 이 자식이다).
      await prisma.$executeRawUnsafe(`
        DELETE FROM app.approval_step
         WHERE approval_request_id IN (
           SELECT approval_request_id FROM app.approval_request
            WHERE target_type_code = 'PURCHASE_ORDER' AND requested_by = ${target.app_user_id}
         )`);
      await prisma.$executeRawUnsafe(`
        DELETE FROM app.approval_request
         WHERE target_type_code = 'PURCHASE_ORDER' AND requested_by = ${target.app_user_id}`);
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
