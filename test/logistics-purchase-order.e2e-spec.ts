/**
 * P/O 등록·헤더 수정 — 화면 `W-01-11`. 조회 3건은 PR ③ 이 구현했고 여기서는 등록 응답·
 * 필터로만 함께 검사한다. 라인 치환·승인 요청은 PR ⑤(§8) 가 같은 파일에 더한다.
 *
 * cleanup 이 이 사용자의 `approval_request`(target `PURCHASE_ORDER`)도 미리 지운다 —
 * PR ⑤ 가 상신 e2e 를 더할 때 잔존 행이 `app_user` 삭제를 막지 않도록(#191 Minor).
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

describe('P/O 등록·헤더 수정 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let supplierId: number;
  let businessUnitId: number;
  let plantId: number;
  let itemId: number;
  let uomId: number;

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
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'PO쓰기검사', status_code: 'EMPLOYED' },
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
   * P/O 를 만들지 않으므로 지금은 걸리지 않지만, 순서는 「라인 → 헤더」로 둔다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order
          WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')
       )`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
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
