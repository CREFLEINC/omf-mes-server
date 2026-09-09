/**
 * 출하작업지시 **편성** — `POST /logistics/shipment-requests` 201(I-22 PR ⑤).
 * 화면 `W-04-01` 의 「편성」과 「단독 생성」이 한 경로다.
 *
 * ⭐ 이 파일이 **유일한 그물**인 자리가 셋이다 —
 *   ⑴ `allocatedQty > 0`(계약도 물리도 안 막는 순수 서버 규칙 · W-8)
 *   ⑵ 채번 기간 축이 `requestedShipDate`(서버 「오늘」이 아니다 · W-25)
 *   ⑶ 403 «선언» 자리의 권한 등재(미등재면 403 이 아니라 500 이다 · W-27).
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SRWE2E`)로만 한다.
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

const LOGIN_ID = 'e2e-shipment-request-write-probe';
const NOPERM_ID = 'e2e-shipment-request-write-noperm';
const PASSWORD = 'SR-편성-비밀번호';
const PREFIX = 'SRWE2E';
const ROLE = `${PREFIX}-ROLE`;
/** 편성 POST 는 403 을 «선언»했고 `DERIVED_PERMISSIONS:180` 이 이 화면 하나를 요구한다. */
const PERMISSIONS = ['W-04-01'];
const BASE = '/api/logistics/shipment-requests';
/** 다른 스위트의 목록 창(2026-08-13~14) 밖이라 서로를 안 흔든다. */
const SHIP_DATE = '2026-09-21';
/** ⭐ W-25 전용 — 이 스위트만 쓰는 날짜 둘. `afterAll` 이 채번 카운터를 지워 늘 0001 로 선다. */
const NUM_DATE_A = '2031-03-01';
const NUM_DATE_B = '2031-03-02';
const NUM_KEYS = ['20310301', '20310302'];

interface PickBody {
  lotId: number;
  pickedQty: number;
}
interface LineBody {
  shipmentRequestLineId: number;
  lineNo: number;
  salesOrderLineId: number | null;
  itemId: number;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  shippedQty: number;
  uomId: number;
  customerLotRequirement: string | null;
  shippingInspectionRequired: boolean;
  minimumRemainingShelfLifeDays: number | null;
  picks: PickBody[];
}
interface RequestBody {
  shipmentRequestId: number;
  shipmentRequestNo: string;
  salesOrderId: number | null;
  customerId: number;
  shipToPartnerId: number;
  requestedShipDate: string;
  statusCode: string;
  timeSlotCode: string | null;
  shippingInspectionStatusCode: string;
  shipmentProgressCode: string;
  lines?: LineBody[];
  versionNo?: number;
}

function validator(): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const pointer =
    '/paths/~1logistics~1shipment-requests/post/responses/201/content/application~1json/schema';
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('출하작업지시 편성 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  const ids = {
    uom1: 0,
    uom2: 0,
    item1: 0,
    item2: 0,
    customer: 0,
    shipTo: 0,
    customer2: 0,
    salesOrder: 0,
    salesOrderLine1: 0,
    salesOrderLine2: 0,
    otherSalesOrder: 0,
    otherSalesOrderLine: 0,
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  // ── W-1 ~ W-5 · 응답 모양 · 두 모드 · 라인 번호 ──────────────────────────
  it('W-1 201 이고 계약 ShipmentRequest 스키마를 만족한다', async () => {
    const body = await create(payload());

    const validate = validator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('W-2 salesOrderId 를 주면 링크가 실린다', async () => {
    const body = await create(payload({ salesOrderId: ids.salesOrder }));

    expect(body.salesOrderId).toBe(ids.salesOrder);
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(body.shipmentRequestId) },
    });
    expect(Number(stored.sales_order_id)).toBe(ids.salesOrder);
  });

  it('W-3 salesOrderId 를 비우면 단독 생성이고 null 로 실린다', async () => {
    const body = await create(payload());

    // ⭐ 키 생략이 아니라 `null` 이다 — 계약이 `type:['integer','null']` 로 적었다.
    expect(body).toHaveProperty('salesOrderId', null);
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(body.shipmentRequestId) },
    });
    expect(stored.sales_order_id).toBeNull();
  });

  it('W-4 단독 생성 라인의 salesOrderLineId 가 null 이다', async () => {
    const standalone = ((await create(payload())).lines as LineBody[])[0];
    const linked = ((
      await create(
        payload({
          salesOrderId: ids.salesOrder,
          lines: [line({ salesOrderLineId: ids.salesOrderLine1 })],
        }),
      )
    ).lines as LineBody[])[0];

    // 키를 생략하면 required 는 아니지만 «축에 값이 둘» 이어야 「늘 널」 변이가 죽는다.
    expect(standalone).toHaveProperty('salesOrderLineId', null);
    expect(linked.salesOrderLineId).toBe(ids.salesOrderLine1);
  });

  it('W-5 line_no 를 서버가 1부터 배열 순서대로 부여한다', async () => {
    const body = await create(
      payload({
        lines: [
          line({ itemId: ids.item2, uomId: ids.uom2, requestedQty: 30, allocatedQty: 10 }),
          line({ itemId: ids.item1, uomId: ids.uom1, requestedQty: 40, allocatedQty: 20 }),
          line({ itemId: ids.item2, uomId: ids.uom1, requestedQty: 50, allocatedQty: 30 }),
        ],
      }),
    );
    const stored = await prisma.shipment_request_line.findMany({
      where: { shipment_request_id: BigInt(body.shipmentRequestId) },
      orderBy: { shipment_request_line_id: 'asc' },
    });

    // ⛔ `Set(...).size` 로는 안 잠긴다 — 「서로 다르다」만 보므로 역순·0 부터가 통과한다.
    //    저장값 배열과 «통째로» 맞춘다.
    expect(stored.map((row) => row.line_no)).toEqual([1, 2, 3]);
    expect((body.lines as LineBody[]).map((row) => row.lineNo)).toEqual([1, 2, 3]);
    // ⭐ `ShipmentRequestLine` 은 헤더와 «다른 스키마»다 — 칸마다 값이 갈리게 세워 출처를 못 박는다.
    expect(body.lines as LineBody[]).toMatchObject([
      { itemId: ids.item2, uomId: ids.uom2, requestedQty: 30, allocatedQty: 10, shippedQty: 0, pickedQty: 0 },
      { itemId: ids.item1, uomId: ids.uom1, requestedQty: 40, allocatedQty: 20, shippedQty: 0, pickedQty: 0 },
      { itemId: ids.item2, uomId: ids.uom1, requestedQty: 50, allocatedQty: 30, shippedQty: 0, pickedQty: 0 },
    ]);
    expect((body.lines as LineBody[]).map((row) => row.shipmentRequestLineId)).toEqual(
      stored.map((row) => Number(row.shipment_request_line_id)),
    );
    expect((body.lines as LineBody[]).map((row) => row.picks)).toEqual([[], [], []]);
  });

  // ── W-6 ~ W-10 · 수량 손검사 ─────────────────────────────────────────────
  it('W-6 ⭐ allocatedQty = requestedQty 는 통과한다(한계와 «같은» 값)', async () => {
    const body = await create(payload({ lines: [line({ requestedQty: 120, allocatedQty: 120 })] }));

    // `<` 로 조이면 「전량 배정」이라는 가장 흔한 편성이 통째로 막힌다.
    expect((body.lines as LineBody[])[0]).toMatchObject({ requestedQty: 120, allocatedQty: 120 });
    expect(body.shipmentProgressCode).toBe('PICKING');
  });

  it('W-7 allocatedQty > requestedQty 는 400 RANGE 다', async () => {
    const errors = await reject(payload({ lines: [line({ requestedQty: 100, allocatedQty: 101 })] }));

    // ⛔ 손검사를 빼면 `ck_shipment_request_qty` 가 잡아 **500** 이 된다.
    expect(errors[0]).toMatchObject({ field: 'lines[0].allocatedQty', code: 'RANGE' });
  });

  it('W-8 ⭐⭐ allocatedQty = 0 은 400 RANGE 다 — 계약도 물리도 안 막는 자리', async () => {
    const errors = await reject(payload({ lines: [line({ requestedQty: 100, allocatedQty: 0 })] }));

    // 계약에 최소값 키가 없고 `ck_shipment_request_qty` 는 `0 <= 100` 이라 통과시킨다.
    // 이 시험을 빼면 「배정 0 짜리 편성」이 조용히 저장되고 진행이 NOT_ALLOCATED 로 선다.
    expect(errors).toEqual([
      expect.objectContaining({ field: 'lines[0].allocatedQty', code: 'RANGE' }),
    ]);
    expect(
      await prisma.shipment_request_line.count({ where: { allocated_qty: 0, shipment_request: { shipment_request_no: { startsWith: `${PREFIX}-` } } } }),
    ).toBe(0);
  });

  it('W-9 requestedQty = 0 은 400 RANGE 다', async () => {
    const errors = await reject(payload({ lines: [line({ requestedQty: 0, allocatedQty: 0 })] }));

    expect(errors.map((e) => e.field)).toEqual([
      'lines[0].requestedQty',
      'lines[0].allocatedQty',
    ]);
    expect(errors.every((e) => e.code === 'RANGE')).toBe(true);
  });

  it('W-10 lines: [] 는 계약 가드가 400 으로 막는다', async () => {
    const errors = await reject(payload({ lines: [] }));

    // ⭐ 우리 코드 0줄 — `minItems: 1` 이다(I-21 R-15). 서비스에 사본을 두지 않는다.
    expect(errors[0]).toMatchObject({ field: 'lines' });
  });

  // ── W-11 ~ W-15 · 참조 · 짝 · 코드값 ────────────────────────────────────
  it('W-11 ⭐ 없는 salesOrderId 는 400 INVALID 다 — 404 가 아니다', async () => {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(payload({ salesOrderId: ids.salesOrder + 987_654 }));

    // 계약이 이 경로에 404 를 «선언하지 않았다» — 404 를 내면 계약 밖 응답이다.
    expect(response.status).toBe(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'salesOrderId', code: 'INVALID' });
  });

  it('W-12 없는 customerId · itemId · uomId 는 400 INVALID 다', async () => {
    const errors = await reject(
      payload({
        customerId: ids.customer + 987_654,
        lines: [line({ itemId: ids.item1 + 987_654, uomId: ids.uom1 + 987_654 })],
      }),
    );

    expect(errors.map((e) => `${e.field}:${e.code}`)).toEqual([
      'customerId:INVALID',
      'lines[0].itemId:INVALID',
      'lines[0].uomId:INVALID',
    ]);
  });

  it('W-13 ⭐ salesOrderLineId 가 «다른» 지시서의 라인이면 400 PAIR 다', async () => {
    const errors = await reject(
      payload({
        salesOrderId: ids.salesOrder,
        lines: [line({ salesOrderLineId: ids.otherSalesOrderLine })],
      }),
    );

    expect(errors[0]).toMatchObject({ field: 'lines[0].salesOrderLineId', code: 'PAIR' });
    // ⭐ 같은 축에 「통과하는 값」이 있어야 짝 검사가 공허하지 않다 — 제 지시서의 라인은 선다.
    const ok = await create(
      payload({ salesOrderId: ids.salesOrder, lines: [line({ salesOrderLineId: ids.salesOrderLine2 })] }),
    );
    expect((ok.lines as LineBody[])[0].salesOrderLineId).toBe(ids.salesOrderLine2);
  });

  it('W-14 목록에 없는 timeSlotCode 는 400 INVALID 다', async () => {
    const errors = await reject(payload({ timeSlotCode: 'NOON' }));

    expect(errors[0]).toMatchObject({ field: 'timeSlotCode', code: 'INVALID' });
  });

  it('W-15 timeSlotCode 는 null 이 통과하고 null 로 실린다(값이면 값으로)', async () => {
    const empty = await create(payload({ timeSlotCode: null }));
    const filled = await create(payload({ timeSlotCode: 'MORNING' }));

    expect(empty).toHaveProperty('timeSlotCode', null);
    expect(filled.timeSlotCode).toBe('MORNING');
  });

  // ── W-16 ~ W-18 · 길이 · 하한 ───────────────────────────────────────────
  it('W-16 customerLotRequirement 201자는 400 RANGE 다', async () => {
    const errors = await reject(payload({ lines: [line({ customerLotRequirement: 'ㄱ'.repeat(201) })] }));

    // ⛔ 안 막으면 `varchar(200)` 이 잡아 **500** 이다. 200자는 통과한다(한계와 같은 값).
    expect(errors[0]).toMatchObject({ field: 'lines[0].customerLotRequirement', code: 'RANGE' });
    const ok = await create(payload({ lines: [line({ customerLotRequirement: 'ㄱ'.repeat(200) })] }));
    expect((ok.lines as LineBody[])[0].customerLotRequirement).toHaveLength(200);
  });

  it('W-17 minimumRemainingShelfLifeDays = -1 은 400 RANGE 다', async () => {
    const errors = await reject(payload({ lines: [line({ minimumRemainingShelfLifeDays: -1 })] }));

    expect(errors[0]).toMatchObject({
      field: 'lines[0].minimumRemainingShelfLifeDays',
      code: 'RANGE',
    });
  });

  it('W-18 ⭐ minimumRemainingShelfLifeDays = 0 은 통과한다', async () => {
    const zero = await create(payload({ lines: [line({ minimumRemainingShelfLifeDays: 0 })] }));
    const empty = await create(payload());

    // ⛔ `> 0` 으로 조이면 「하한 없음(0일)」을 못 적는다. 0 과 null 이 «다른» 값이다.
    expect((zero.lines as LineBody[])[0]).toHaveProperty('minimumRemainingShelfLifeDays', 0);
    expect((empty.lines as LineBody[])[0]).toHaveProperty('minimumRemainingShelfLifeDays', null);
  });

  // ── W-19 ~ W-23 · 상태 · 파생 축 ────────────────────────────────────────
  it('W-19 statusCode 가 REGISTERED 다 — 저장값과 응답이 같은 상수다', async () => {
    const body = await create(payload());
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(body.shipmentRequestId) },
    });

    expect(stored.status_code).toBe('REGISTERED');
    expect(body.statusCode).toBe('REGISTERED');
  });

  it('W-20 부분 배정 본문이면 PARTIALLY_ALLOCATED 다', async () => {
    const body = await create(
      payload({
        lines: [line({ requestedQty: 100, allocatedQty: 100 }), line({ requestedQty: 100, allocatedQty: 40 })],
      }),
    );

    // 0 < ΣA(140) < ΣR(200) 이고 P = 0 이다.
    expect(body.shipmentProgressCode).toBe('PARTIALLY_ALLOCATED');
    expect((body.lines as LineBody[]).map((row) => row.pickedQty)).toEqual([0, 0]);
  });

  it('W-21 ⭐ NOT_ALLOCATED 는 «편성으로는» 만들 수 없다 — SR-F 는 Prisma 직접이다', async () => {
    // 편성 본문은 `allocatedQty > 0` 이라 ΣA 가 늘 0 보다 크다.
    expect((await reject(payload({ lines: [line({ allocatedQty: 0 })] })))[0]).toMatchObject({
      code: 'RANGE',
    });
    const viaApi = await create(payload({ lines: [line({ requestedQty: 100, allocatedQty: 1 })] }));
    expect(viaApi.shipmentProgressCode).not.toBe('NOT_ALLOCATED');

    // ⭐ 그래도 그 값 자체는 도달 가능하다 — 물리로 배정 0 행을 넣으면 나온다(R-7 ⓐ).
    const direct = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-SRF`,
        customer_id: ids.customer,
        ship_to_partner_id: ids.shipTo,
        requested_ship_date: new Date(`${SHIP_DATE}T00:00:00.000Z`),
        status_code: 'REGISTERED',
        shipment_request_line: {
          create: [{ line_no: 1, item_id: ids.item1, uom_id: ids.uom1, requested_qty: 100, allocated_qty: 0 }],
        },
      },
    });
    const detail = await request(app.getHttpServer())
      .get(`${BASE}/${Number(direct.shipment_request_id)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect((detail.body as RequestBody).shipmentProgressCode).toBe('NOT_ALLOCATED');
  });

  it('W-22 대상 라인이 있고 결과가 0 건이면 PENDING 이다', async () => {
    const body = await create(
      payload({
        lines: [line({ shippingInspectionRequired: false }), line({ shippingInspectionRequired: true })],
      }),
    );

    expect(body.shippingInspectionStatusCode).toBe('PENDING');
  });

  it('W-23 전 라인이 비대상이면 NOT_REQUIRED 다', async () => {
    const body = await create(
      payload({
        lines: [line({ shippingInspectionRequired: false }), line({ shippingInspectionRequired: false })],
      }),
    );

    // 기본값을 뒤집으면(true) 이 건이 PENDING 으로 샌다.
    expect(body.shippingInspectionStatusCode).toBe('NOT_REQUIRED');
    expect((body.lines as LineBody[]).map((row) => row.shippingInspectionRequired)).toEqual([false, false]);
  });

  // ── W-24 ~ W-26 · 채번 · 멱등 ───────────────────────────────────────────
  it('W-24 shipmentRequestNo 가 SR-{YYYYMMDD}-{SEQ4} 다', async () => {
    const body = await create(payload());

    expect(body.shipmentRequestNo).toMatch(/^SR-20260921-\d{4}$/);
  });

  it('W-25 ⭐⭐ 채번 기간 키가 requestedShipDate 다 — 날짜가 다르면 각각 0001 이다', async () => {
    const first = await create(payload({ requestedShipDate: NUM_DATE_A }));
    const second = await create(payload({ requestedShipDate: NUM_DATE_B }));

    // ⛔ 서버가 「오늘」로 다시 잡으면 둘이 같은 기간 키를 써 0001·0002 가 되고
    //    날짜 조각도 오늘 날짜가 된다(공유계약 C-8 과 같은 이유).
    expect(first.shipmentRequestNo).toBe('SR-20310301-0001');
    expect(second.shipmentRequestNo).toBe('SR-20310302-0001');
    expect(first.requestedShipDate).toBe(NUM_DATE_A);
    expect(second.requestedShipDate).toBe(NUM_DATE_B);
  });

  it('W-26 같은 Idempotency-Key 재전송은 새 전표를 안 만든다', async () => {
    const key = randomUUID();
    const body = payload();
    const before = await countOurs();

    const first = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect((second.body as RequestBody).shipmentRequestId).toBe(
      (first.body as RequestBody).shipmentRequestId,
    );
    expect(await countOurs()).toBe(before + 1);
  });

  // ── W-27 ~ W-28 · 권한 · 출처 ───────────────────────────────────────────
  it('W-27 ⭐⭐ 권한 없는 세션은 403 이다', async () => {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send(payload());

    // ⚠ `OPERATION_PERMISSIONS` 에 미등재면 가드가 «던져» 403 이 아니라 500 이 된다.
    expect(response.status).toBe(403);
    expect(response.body.errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('W-28 ⭐ 응답 ShipmentRequest 12칸이 «제 출처»에서 온다', async () => {
    const body = await create(
      payload({
        salesOrderId: ids.salesOrder,
        timeSlotCode: 'AFTERNOON',
        lines: [line({ requestedQty: 100, allocatedQty: 40, shippingInspectionRequired: true })],
      }),
    );
    const stored = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: BigInt(body.shipmentRequestId) },
      include: { shipment_request_line: true },
    });

    // ⭐ ajv 는 «타입»만 본다 — 열두 칸을 뒤바꿔도 통과한다(§6-3 ⑴). 값으로 못 박는다.
    //   고객·배송처가 «다른» 파트너이고 진행·검사가 «다른» 문자열이라 뒤바꿈이 드러난다.
    expect(body).toEqual({
      shipmentRequestId: Number(stored.shipment_request_id),
      shipmentRequestNo: stored.shipment_request_no,
      salesOrderId: ids.salesOrder,
      customerId: ids.customer,
      shipToPartnerId: ids.shipTo,
      requestedShipDate: SHIP_DATE,
      statusCode: 'REGISTERED',
      timeSlotCode: 'AFTERNOON',
      shippingInspectionStatusCode: 'PENDING',
      shipmentProgressCode: 'PARTIALLY_ALLOCATED',
      lines: body.lines,
      versionNo: 1,
    });
    expect(ids.customer).not.toBe(ids.shipTo);
    expect(ids.customer).not.toBe(ids.salesOrder);
    // `requested_ship_date` 를 `created_at` 에서 길어 오면 오늘 날짜가 나온다.
    expect(body.requestedShipDate).not.toBe(stored.created_at.toISOString().slice(0, 10));
    expect(body.versionNo).toBe(stored.version_no);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────
  interface LineInput {
    salesOrderLineId?: number | null;
    itemId?: number;
    requestedQty?: number;
    allocatedQty?: number;
    uomId?: number;
    customerLotRequirement?: string | null;
    shippingInspectionRequired?: boolean;
    minimumRemainingShelfLifeDays?: number | null;
  }

  function line(overrides: LineInput = {}): Record<string, unknown> {
    return {
      itemId: ids.item1,
      requestedQty: 100,
      allocatedQty: 60,
      uomId: ids.uom1,
      shippingInspectionRequired: false,
      ...overrides,
    };
  }

  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      customerId: ids.customer,
      shipToPartnerId: ids.shipTo,
      requestedShipDate: SHIP_DATE,
      lines: [line()],
      ...overrides,
    };
  }

  async function create(body: Record<string, unknown>): Promise<RequestBody> {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    return response.body as RequestBody;
  }

  async function reject(
    body: Record<string, unknown>,
  ): Promise<{ field?: string; code: string }[]> {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(400);
    return response.body.errors as { field?: string; code: string }[];
  }

  async function countOurs(): Promise<number> {
    return prisma.shipment_request.count({
      where: { customer_id: BigInt(ids.customer) },
    });
  }

  async function makeMasters(): Promise<void> {
    const [uom1, uom2] = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    ids.uom1 = Number(uom1.uom_id);
    ids.uom2 = Number(uom2.uom_id);
    for (const [key, suffix] of [
      ['item1', 'IT1'],
      ['item2', 'IT2'],
    ] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `출하편성검사품목${suffix}`,
          item_type_code: 'FINISHED',
          base_uom_id: BigInt(ids.uom1),
        },
      });
      ids[key] = Number(item.item_id);
    }
    // ⭐ 배송처를 고객과 «다른» 파트너로 세운다 — 같으면 두 칸을 뒤바꿔도 안 잡힌다(§6-3 ⑵).
    for (const [key, suffix] of [
      ['customer', 'C1'],
      ['shipTo', 'SH1'],
      ['customer2', 'C2'],
    ] as const) {
      const partner = await prisma.partner.create({
        data: { partner_code: `${PREFIX}-${suffix}`, partner_name: `출하편성검사파트너${suffix}` },
      });
      ids[key] = Number(partner.partner_id);
    }

    const salesOrder = await prisma.sales_order.create({
      data: {
        sales_order_no: `${PREFIX}-SO`,
        customer_id: BigInt(ids.customer),
        ship_to_partner_id: BigInt(ids.shipTo),
        order_date: new Date('2026-09-01T00:00:00.000Z'),
        status_code: 'RECEIVED',
        sales_order_line: {
          create: [
            { line_no: 1, item_id: BigInt(ids.item1), uom_id: BigInt(ids.uom1), ordered_qty: 500 },
            { line_no: 2, item_id: BigInt(ids.item2), uom_id: BigInt(ids.uom1), ordered_qty: 300 },
          ],
        },
      },
      include: { sales_order_line: { orderBy: { line_no: 'asc' } } },
    });
    ids.salesOrder = Number(salesOrder.sales_order_id);
    ids.salesOrderLine1 = Number(salesOrder.sales_order_line[0].sales_order_line_id);
    ids.salesOrderLine2 = Number(salesOrder.sales_order_line[1].sales_order_line_id);

    // ⭐ 짝 검사의 「안 걸리는 행」 — 지시서가 둘이라야 W-13 이 공허하지 않다(§6-3 ⑵).
    const other = await prisma.sales_order.create({
      data: {
        sales_order_no: `${PREFIX}-SO2`,
        customer_id: BigInt(ids.customer2),
        ship_to_partner_id: BigInt(ids.shipTo),
        order_date: new Date('2026-09-02T00:00:00.000Z'),
        status_code: 'RECEIVED',
        sales_order_line: {
          create: [{ line_no: 1, item_id: BigInt(ids.item1), uom_id: BigInt(ids.uom1), ordered_qty: 200 }],
        },
      },
      include: { sales_order_line: true },
    });
    ids.otherSalesOrder = Number(other.sales_order_id);
    ids.otherSalesOrderLine = Number(other.sales_order_line[0].sales_order_line_id);
  }

  /** 편성은 403 을 «선언»한 자리다 — 권한 있는 세션과 없는 세션을 둘 다 세운다. */
  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하편성검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '출하편성검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    const noPerm = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '출하편성무권한', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: noPerm.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async function cleanup(): Promise<void> {
    const OURS = `SELECT partner_id FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`;
    for (const sql of [
      // ⛔ 전표 «번호»로 지우지 마라 — 번호는 변이 하네스가 바꾸는 바로 그 값이라(채번 기간 축
      //    변이는 `SR-{오늘}-…` 를 만든다) 실패한 회차의 행이 남아 다음 회차의 정리를 FK 로 막는다.
      //    파트너는 어떤 변이로도 안 움직이는 축이다.
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request
          WHERE customer_id IN (${OURS}) OR ship_to_partner_id IN (${OURS}))`,
      `DELETE FROM logistics.shipment_request
        WHERE customer_id IN (${OURS}) OR ship_to_partner_id IN (${OURS})`,
      `DELETE FROM logistics.sales_order_line WHERE sales_order_id IN (
         SELECT sales_order_id FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.sales_order WHERE sales_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      // ⭐ W-25 가 「각각 0001」을 보므로 이 스위트가 쓴 기간 카운터를 지운다.
      `DELETE FROM app.numbering_counter
         WHERE period_key IN (${NUM_KEYS.map((k) => `'${k}'`).join(', ')})
           AND numbering_rule_id IN (SELECT numbering_rule_id FROM app.numbering_rule
                                      WHERE document_type_code = 'SHIPMENT_REQUEST')`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
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
