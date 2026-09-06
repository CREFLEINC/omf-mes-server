/**
 * 입하 등록 — 화면 `M-01-01`. 「입하·라인·자재 LOT 이 한 트랜잭션으로 만들어진다」(계약).
 *
 * ⚠ 픽스처는 전부 «직접 INSERT» 다 — ASN·P/O 라인·입하 라인을 만드는 등록 경로를 이
 * 스위트가 쓰지 않기 위해서다(P/O 는 동시성 검사 하나에서만 API 로 만든다).
 * ⚠ 정리 순서 — `inbound_receipt_line` 이 `trace.lot` 을 «가리키므로» LOT 보다 먼저 지운다
 * (I-3.md §6-5 · P/O e2e 에는 없던 순서).
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

const LOGIN_ID = 'e2e-ir-probe';
const NOPERM_ID = 'e2e-ir-noperm';
const PASSWORD = '입하-등록-검사-비밀번호';
const PREFIX = 'IRE2E';
const ROLE = 'E2E_IR';
/** `W-01-11` 은 동시성 검사 하나가 P/O 라인 치환을 함께 걸기 위해서다. */
const PERMISSIONS = ['M-01-01', 'W-01-11'];
const BUSINESS_DATE = '2026-08-06';
const RECEIPT_AT = '2026-08-06T09:12:00+09:00';

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

interface ReceiptBody {
  inboundReceiptId: number;
  inboundReceiptNo: string;
  statusCode: string;
  receivedBy: number | null;
}
interface LineBody {
  inboundReceiptLineId: number;
  lineNo: number;
  purchaseOrderLineId: number | null;
  receivedQty: number;
  inspectionRequired: boolean;
  statusCode: string;
  lotId: number | null;
}
interface Detail {
  inboundReceipt: ReceiptBody;
  lines: LineBody[];
}
interface LineDraft {
  inboundReceiptLineId?: number;
  purchaseOrderLineId?: number | null;
  itemId: number;
  receivedQty: number;
  uomId: number;
  supplierLotNo?: string | null;
  supplierLotMissing: boolean;
  substituteLotReasonCode?: string | null;
  manufacturedDate?: string | null;
  expiryDate?: string | null;
}

describe('입하 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let supplierId: number;
  let businessUnitId: number;
  let plantId: number;
  let itemId: number;
  let uomId: number;
  let lotSeq = 0;
  let orderSeq = 0;

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

  it('입하 — 등록 응답이 계약 InboundReceiptDetailResponse 를 만족한다', async () => {
    const detail = await create();

    const validate = validator('POST /logistics/inbound-receipts', 201);
    expect(validate(detail)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('입하 — 등록이 헤더·라인·LOT 을 한 트랜잭션으로 만든다(라인 실패면 헤더도 LOT 도 없다)', async () => {
    const before = await prisma.inbound_receipt.count({ where: { plant_id: plantId } });
    const lotsBefore = await prisma.lot.count({ where: { plant_id: plantId } });

    await send(
      await body({
        lines: [
          await lineDraft(),
          // 없는 uom — 라인 삽입이 FK 위반으로 실패해 트랜잭션 전체가 롤백돼야 한다.
          { ...(await lineDraft()), uomId: 999999999 },
        ],
      }),
    ).expect(400);

    expect(await prisma.inbound_receipt.count({ where: { plant_id: plantId } })).toBe(before);
    expect(await prisma.lot.count({ where: { plant_id: plantId } })).toBe(lotsBefore);
  });

  it('입하 — 입하번호는 서버가 짓는다(IR-YYYYMMDD-\\d{4,})', async () => {
    const detail = await create();

    expect(detail.inboundReceipt.inboundReceiptNo).toMatch(/^IR-20260806-\d{4,}$/);
  });

  it('입하 — 상태는 서버가 REGISTERED 로 정한다(본문이 statusCode 를 받지 않는다)', async () => {
    const created = await send({ ...(await body()), statusCode: 'POSTED' } as object).expect(201);

    const detail = created.body as Detail;
    expect(detail.inboundReceipt.statusCode).toBe('REGISTERED');
    expect(detail.lines[0].statusCode).toBe('REGISTERED');
  });

  it('입하 — lines 가 빈 배열이면 400 LINE_REQUIRED 다', async () => {
    const rejected = await send(await body({ lines: [] })).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('입하 — supplierLotMissing=true 인데 substituteLotReasonCode 가 없으면 400 이다', async () => {
    const draft = await lineDraft();
    const rejected = await send(
      await body({
        lines: [{ ...draft, supplierLotNo: null, supplierLotMissing: true }],
      }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines.0.substituteLotReasonCode',
      code: 'PAIR',
    });
  });

  it('입하 — exceptionTypeCode 만 있고 exceptionReason 이 없으면 400 PAIR 다', async () => {
    const rejected = await send(
      await body({ exceptionTypeCode: 'CUSTOMER_SUPPLY', exceptionReason: undefined }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'exceptionReason', code: 'PAIR' });
  });

  it('입하 — expiryDate 가 manufacturedDate 보다 앞서면 400 이다(ck_inbound_expiry 가 500 으로 새지 않는다)', async () => {
    const draft = await lineDraft();
    const rejected = await send(
      await body({
        lines: [{ ...draft, manufacturedDate: '2026-08-06', expiryDate: '2026-08-05' }],
      }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines.0.expiryDate', code: 'INVALID' });
  });

  it('입하 — 사전부착 라인의 lotId 가 응답에 채워진다', async () => {
    const supplierLotNo = `${PREFIX}-SL-${(lotSeq += 1)}`;
    const detail = await create({ lines: [{ ...(await lineDraft()), supplierLotNo }] });

    const lotId = detail.lines[0].lotId;
    expect(lotId).not.toBeNull();
    const lot = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lotId as number) } });
    expect(lot.lot_no).toBe(supplierLotNo);
    expect(lot.lot_type_code).toBe('MATERIAL');
    expect(lot.manufactured_at).toBeNull();
    expect(await prisma.lot_hold.count({ where: { lot_id: lot.lot_id } })).toBe(1);
  });

  it('입하 — 미부착 라인의 lotId 는 널이다(키를 생략하지 않는다)', async () => {
    const draft = await lineDraft();
    const detail = await create({
      lines: [
        {
          ...draft,
          supplierLotNo: null,
          supplierLotMissing: true,
          substituteLotReasonCode: 'NO_LABEL',
        },
      ],
    });

    expect(detail.lines[0]).toHaveProperty('lotId');
    expect(detail.lines[0].lotId).toBeNull();
  });

  it('입하 — purchase_order_line.received_qty 가 라인 수량만큼 오른다', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);

    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 30 }] });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(30);
  });

  it('입하 — 발주+허용치를 넘기면 400 QTY_EXCEEDS_ORDERED 다(ck_po_line_received 가 500 으로 새지 않는다)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(10, 2);

    const rejected = await send(
      await body({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 13 }] }),
    ).expect(400);

    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines.0.receivedQty',
      code: 'QTY_EXCEEDS_ORDERED',
    });
    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(0);
  });

  it('입하 — 같은 P/O 에 두 번 등록하면 received_qty 가 누적된다(분할 납품)', async () => {
    const { purchaseOrderLineId } = await seedOrderLine(100);

    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 40 }] });
    await create({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 25 }] });

    expect(Number((await poLine(purchaseOrderLineId)).received_qty)).toBe(65);
  });

  it('⭐ 입하 등록과 P/O 라인 치환을 동시에 걸어도 500 이 없다(부모 FOR UPDATE 로 직렬화된다)', async () => {
    const order = await createOrder();
    const purchaseOrderLineId = order.lines[0].purchaseOrderLineId;
    const etag = await orderEtag(order.purchaseOrder.purchaseOrderId);

    const [receipt, replaced] = await Promise.all([
      send(await body({ lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 5 }] })),
      request(app.getHttpServer())
        .put(`/api/logistics/purchase-orders/${order.purchaseOrder.purchaseOrderId}/lines`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', etag)
        .send({ items: [{ purchaseOrderLineId, itemId, orderedQty: 100, uomId }] }),
    ]);

    expect(receipt.status).toBeLessThan(500);
    expect(replaced.status).toBeLessThan(500);
  });

  it('입하 — 승인되지 않은 P/O 에도 입하가 붙는다(계약에 승인 문장이 0건이다 — 문의 023)', async () => {
    const { purchaseOrderId, purchaseOrderLineId } = await seedOrderLine(100);
    const order = await prisma.purchase_order.findUniqueOrThrow({
      where: { purchase_order_id: BigInt(purchaseOrderId) },
    });
    expect(order.approval_request_id).toBeNull();

    const detail = await create({
      lines: [{ ...(await lineDraft()), purchaseOrderLineId, receivedQty: 1 }],
    });

    expect(detail.lines[0].purchaseOrderLineId).toBe(purchaseOrderLineId);
  });

  it('입하 — 같은 Idempotency-Key 재전송도 같은 ETag 를 준다(201)', async () => {
    const draft = await body();
    const idempotencyKey = key();

    const first = await send(draft, idempotencyKey).expect(201);
    const second = await send(draft, idempotencyKey).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(
      await prisma.inbound_receipt.count({
        where: { inbound_receipt_id: BigInt(first.body.inboundReceipt.inboundReceiptId) },
      }),
    ).toBe(1);
  });

  it('입하 — If-Match 없이 등록된다(선택이다 — 오프라인 큐는 토큰을 안 싣는다)', async () => {
    await send(await body()).expect(201);

    // 실려 와도 대조할 버전이 없다 — 서비스가 값을 무시한다(400 이 아니다).
    await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', '"1"')
      .send(await body())
      .expect(201);
  });

  it('입하 — 권한 없는 사용자의 POST 는 403 이다(500 이 아니다)', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await body())
      .expect(403);
  });

  it('⭐ 원장이 움직이지 않는다 — inventory_transaction 이 0건 그대로다', async () => {
    await create();

    expect(await prisma.inventory_transaction.count({ where: { plant_id: plantId } })).toBe(0);
  });

  it('등록 — 본문의 inboundReceiptLineId 는 무시되고 신규 행으로 선다', async () => {
    const first = await create();
    const carried = first.lines[0].inboundReceiptLineId;

    const second = await create({ lines: [{ ...(await lineDraft()), inboundReceiptLineId: carried }] });

    expect(second.lines[0].inboundReceiptLineId).not.toBe(carried);
    expect(second.lines[0].lineNo).toBe(1);
  });

  it('등록 — deliveryNoteAttachmentId 를 받아도 400 이 아니다', async () => {
    const created = await send(await body({ deliveryNoteAttachmentId: 999999999 })).expect(201);

    expect((created.body as Detail).inboundReceipt.inboundReceiptId).toBeDefined();
  });

  it('입하 — 상세가 ETag 를 헤더로만 내린다(본문에 versionNo 가 없다)', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toMatch(/^\d+$/);
    expect(response.body.inboundReceipt).not.toHaveProperty('versionNo');
  });

  it('입하 — 없는 입하 상세는 404 다(계약 선언)', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/inbound-receipts/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('입하 — 라인 목록은 ETag 를 내리지 않는다(자식 컬렉션 · B-1-1)', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}/lines`)
      .set('Cookie', cookie)
      .expect(200);

    // express 가 기본으로 약한 ETag 를 늘 붙인다 — 우리가 안 내렸다는 건 숫자 형식이 아님으로 본다(#196 리뷰 Minor).
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('입하 — 목록이 supplierId·plantId·statusCode·receiptDate 로 걸린다', async () => {
    const detail = await create();

    const found = await list(
      `supplierId=${supplierId}&plantId=${plantId}&statusCode=REGISTERED` +
        `&receiptDateFrom=${BUSINESS_DATE}&receiptDateTo=${BUSINESS_DATE}`,
    );

    expect(found.items.map((item) => item.inboundReceiptId)).toContain(
      detail.inboundReceipt.inboundReceiptId,
    );
  });

  it('입하 — P-01-01 의 조합 질의(supplierLotMissing=true&labelIssued=false)가 미부착 라인만 준다', async () => {
    const labeledAttached = await lineDraft();
    const plainAttached = await lineDraft();
    const missing = await lineDraft();
    const detail = await create({
      lines: [
        labeledAttached,
        plainAttached,
        { ...missing, supplierLotNo: null, supplierLotMissing: true, substituteLotReasonCode: 'NO_LABEL' },
      ],
    });

    // 첫 라인의 LOT 에 라벨 발행 기록을 직접 남긴다 — 발행은 P-01-01 의 몫이라 등록 API 가 모른다.
    const user = await prisma.app_user.findUniqueOrThrow({ where: { login_id: LOGIN_ID } });
    const labeledLotId = BigInt(detail.lines[0].lotId as number);
    await prisma.document_issue_log.create({
      data: {
        document_type_code: 'MATERIAL_LOT_LABEL',
        target_type_code: 'LOT',
        target_id: labeledLotId,
        lot_id: labeledLotId,
        issued_by: user.app_user_id,
      },
    });

    const response = await request(app.getHttpServer())
      .get(
        `/api/logistics/inbound-receipts/${detail.inboundReceipt.inboundReceiptId}` +
          '/lines?supplierLotMissing=true&labelIssued=false',
      )
      .set('Cookie', cookie)
      .expect(200);

    // 라벨 발행된 부착 라인(1) · 미발행 부착 라인(2)은 supplierLotMissing 에서 이미 빠지고,
    // 미부착 라인(3)만 두 필터를 모두 통과한다 — AND 가 아니면 2도 섞여 나온다.
    const items = response.body.items as LineBody[];
    expect(items.map((item) => item.lineNo)).toEqual([3]);
  });

  // ── 도우미 ────────────────────────────────────────────────────────────────

  async function list(qs: string): Promise<{ items: ReceiptBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/inbound-receipts?${qs}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.body as { items: ReceiptBody[] };
  }

  function send(draft: object, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/inbound-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Worker-No', 'W-0001')
      .send(draft);
  }

  async function create(overrides: object = {}): Promise<Detail> {
    const created = await send(await body(overrides)).expect(201);
    return created.body as Detail;
  }

  /** 기본 라인은 «무발주»다 — 그래서 예외 유형·사유가 늘 실린다(R-7 ②). P/O 귀속을
   *  보는 검사만 `purchaseOrderLineId` 를 덮어쓴다. */
  async function body(overrides: object = {}): Promise<object> {
    return {
      supplierId,
      plantId,
      receiptDatetime: RECEIPT_AT,
      businessDate: BUSINESS_DATE,
      occurredAt: RECEIPT_AT,
      exceptionTypeCode: 'CUSTOMER_SUPPLY',
      exceptionReason: '무발주 도착',
      lines: [await lineDraft()],
      ...overrides,
    };
  }

  /** `uq_lot(plant_id, lot_no)` 때문에 공급사 LOT 번호는 호출마다 새 값이다. */
  async function lineDraft(): Promise<LineDraft> {
    lotSeq += 1;
    return {
      itemId,
      receivedQty: 10,
      uomId,
      supplierLotNo: `${PREFIX}-SL-${lotSeq}`,
      supplierLotMissing: false,
    };
  }

  async function poLine(purchaseOrderLineId: number) {
    return prisma.purchase_order_line.findUniqueOrThrow({
      where: { purchase_order_line_id: BigInt(purchaseOrderLineId) },
    });
  }

  /** 귀속 대상 P/O 는 직접 INSERT 다 — 등록 API 는 이 슬라이스 밖이다. */
  async function seedOrderLine(
    orderedQty: number,
    toleranceOverQty = 0,
  ): Promise<{ purchaseOrderId: number; purchaseOrderLineId: number }> {
    orderSeq += 1;
    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO-${orderSeq}`,
        supplier_id: BigInt(supplierId),
        business_unit_id: BigInt(businessUnitId),
        plant_id: BigInt(plantId),
        order_date: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    const line = await prisma.purchase_order_line.create({
      data: {
        purchase_order_id: order.purchase_order_id,
        line_no: 1,
        item_id: BigInt(itemId),
        ordered_qty: orderedQty,
        uom_id: BigInt(uomId),
        tolerance_over_qty: toleranceOverQty,
      },
    });
    return {
      purchaseOrderId: Number(order.purchase_order_id),
      purchaseOrderLineId: Number(line.purchase_order_line_id),
    };
  }

  /** 동시성 검사 하나만 P/O 를 API 로 만든다 — 라인 치환에 담을 ETag 가 필요하다. */
  async function createOrder(): Promise<{
    purchaseOrder: { purchaseOrderId: number };
    lines: { purchaseOrderLineId: number }[];
  }> {
    const created = await request(app.getHttpServer())
      .post('/api/logistics/purchase-orders')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send({
        supplierId,
        businessUnitId,
        plantId,
        orderDate: BUSINESS_DATE,
        lines: [{ itemId, orderedQty: 100, uomId }],
      })
      .expect(201);
    return created.body as { purchaseOrder: { purchaseOrderId: number }; lines: { purchaseOrderLineId: number }[] };
  }

  async function orderEtag(purchaseOrderId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/purchase-orders/${purchaseOrderId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '입하검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '입하검사사업부',
      },
    });
    businessUnitId = Number(unit.business_unit_id);
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '입하검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    // `inspection_required` 는 이 품목에서 승계된다(계약 · I-3.md §5-2).
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '입하검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        inspection_required: true,
      },
    });
    itemId = Number(item.item_id);

    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP`, partner_name: '입하검사공급사' },
    });
    supplierId = Number(supplier.partner_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '입하등록검사', status_code: 'EMPLOYED' },
    });
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '입하등록검사용' } });
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
   * ⭐ `inbound_receipt_line` 이 `trace.lot` 을 «가리킨다» — LOT 을 먼저 지우면 FK 위반이다
   * (I-3.md §6-5 ②가 ④보다 먼저). `lot_hold`·`lot_external_identifier` 는 LOT 의 자식이다.
   */
  async function cleanup(): Promise<void> {
    const ownPlants = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    const ownLots = `(SELECT lot_id FROM trace.lot WHERE plant_id IN ${ownPlants})`;
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_variance
       WHERE inbound_receipt_line_id IN (
         SELECT inbound_receipt_line_id FROM logistics.inbound_receipt_line
          WHERE inbound_receipt_id IN (
            SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants})
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (
         SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_hold WHERE lot_id IN ${ownLots}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN ${ownLots}`,
    );
    // `app.document_issue_log` 가 `trace.lot` 을 가리킨다(labelIssued 픽스처) — lot 보다 먼저(R-10).
    await prisma.$executeRawUnsafe(`DELETE FROM app.document_issue_log WHERE lot_id IN ${ownLots}`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    );
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
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
