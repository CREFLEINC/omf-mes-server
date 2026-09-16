/**
 * 출하 단위 — `GET/POST /logistics/shipping-units` · `GET …/{shippingUnitId}`(SHIP-UNIT-01 ③a).
 * 화면 `P-04-05`(출하 단위 구성).
 *
 * ⛔ **계약 사본에 우리가 먼저 적은 경로다**(장부 P-24) — 설계 정본에는 아직 없다. 그래서
 * 응답 스키마 대조도 그 사본을 읽는다. 사본이 당겨져 규격이 사라지면
 * `contract-shipping-unit.spec.ts` 가 먼저 빨개진다.
 * ⭐ 세션과 **POP 단말** 둘 다 부른다 — 단말 갈래는 그 단말의 공장으로 좁혀지는지까지 본다.
 * ⚠ 출하·출하작업지시는 생성 경로가 계약에 없어 Prisma 직접 INSERT 다(배분 e2e 와 같은 관례).
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

const LOGIN_ID = 'e2e-shipping-unit-probe';
const PASSWORD = 'SU-출하단위-비밀번호';
const PREFIX = 'SUE2E';
const ROLE = `${PREFIX}-ROLE`;
const PERMISSIONS = ['P-04-05'];
const BASE = '/api/logistics/shipping-units';
const WORKER_NO = `${PREFIX}-W1`;
const SESSION_COOKIE = 'omf_session';

function validator(pointer: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8'),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface UnitBody {
  shippingUnitId: number;
  shippingUnitNo: string;
  statusCode: string;
  shipmentId: number;
  shipmentNo: string;
  customer: { partnerId: number; partnerCode: string; partnerName: string };
  shipTo: { partnerId: number; partnerCode: string; partnerName: string };
  boxCount: number;
  versionNo: number;
  boxes: unknown[];
  itemTotals: unknown[];
}

describe('출하 단위 — 생성·목록·상세 (SHIP-UNIT-01 ③a e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let popToken: string;
  let foreignToken: string;
  let seq = 0;

  const ids = {
    plant: 0n,
    foreignPlant: 0n,
    warehouse: 0n,
    foreignWarehouse: 0n,
    customer: 0n,
    shipTo: 0n,
    item: 0n,
    lot: 0n,
    uom: 0n,
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

  // ── 생성 ────────────────────────────────────────────────────────────────

  it('U-1 ⭐ 201 · SU-{YYYYMMDD}-{SEQ4} 채번 · ETag · 계약 스키마를 만족한다', async () => {
    const shipment = await makeShipment();

    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: shipment.shipmentId, shippingUnitTypeCode: 'PALLET' })
      .expect(201);

    const body = response.body as UnitBody;
    expect(body.shippingUnitNo).toMatch(/^SU-\d{8}-\d{4}$/);
    expect(body.statusCode).toBe('OPEN');
    expect(body.boxCount).toBe(0);
    expect(body.versionNo).toBe(1);
    // 마감(`:close`)이 이 값을 If-Match 로 되받는다 — 상세를 다시 읽지 않아도 되게 201 에 싣는다.
    expect(response.headers.etag).toBe('1');

    const validate = validator('/components/schemas/ShippingUnitDetail');
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  /**
   * ⭐ 고객·납품처는 출하 전표에 «없다» — 출하작업지시를 거쳐 거래처로 조인해야 나온다.
   * 단말은 `shipment-requests` 를 읽지 못하므로(MOBILE 전용) 서버가 풀어 주지 않으면
   * POP 이 납품 라벨의 머리 두 줄을 그릴 수 없다.
   */
  it('U-2 ⭐ 고객·납품처를 출하작업지시에서 풀어 내려준다', async () => {
    const shipment = await makeShipment();

    const body = (await create(shipment.shipmentId)) as UnitBody;

    expect(body.customer).toEqual({
      partnerId: Number(ids.customer),
      partnerCode: `${PREFIX}-CUST`,
      partnerName: '출하단위검사고객',
    });
    expect(body.shipTo).toEqual({
      partnerId: Number(ids.shipTo),
      partnerCode: `${PREFIX}-SHIPTO`,
      partnerName: '출하단위검사납품처',
    });
  });

  it('U-3 없는 출하는 404 · 없는 유형은 400 INVALID 다', async () => {
    const shipment = await makeShipment();

    await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: Number(shipment.shipmentId) + 9_000_000, shippingUnitTypeCode: 'PALLET' })
      .expect(404);

    const invalid = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: shipment.shipmentId, shippingUnitTypeCode: 'NOT-A-TYPE' })
      .expect(400);
    expect(invalid.body.errors[0]).toMatchObject({
      field: 'shippingUnitTypeCode',
      code: 'INVALID',
    });
  });

  /** ⛔ 취소된 출하에는 열지 않는다. 확정 여부는 묻지 않는다 — 확정과 무관한 작업이다. */
  it('U-4 ⭐ 취소된 출하는 400 STATE_LOCKED · 확정된 출하는 열린다', async () => {
    const cancelled = await makeShipment('CANCELLED');
    const confirmed = await makeShipment('CONFIRMED');

    const blocked = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: cancelled.shipmentId, shippingUnitTypeCode: 'PALLET' })
      .expect(400);
    expect(blocked.body.errors[0]).toMatchObject({ field: 'shipmentId', code: 'STATE_LOCKED' });

    await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: confirmed.shipmentId, shippingUnitTypeCode: 'BUNDLE' })
      .expect(201);
  });

  it('U-5 같은 Idempotency-Key 재전송은 단위를 둘 만들지 않는다', async () => {
    const shipment = await makeShipment();
    const key = randomUUID();
    const send = () =>
      request(app.getHttpServer())
        .post(BASE)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .send({ shipmentId: shipment.shipmentId, shippingUnitTypeCode: 'PALLET' });

    const first = await send().expect(201);
    const second = await send();

    expect(second.body.shippingUnitId).toBe(first.body.shippingUnitId);
    await expect(
      prisma.shipping_unit.count({ where: { shipment_id: BigInt(shipment.shipmentId) } }),
    ).resolves.toBe(1);
  });

  // ── 목록·상세 ────────────────────────────────────────────────────────────

  it('U-6 목록이 출하·상태·번호로 걸리고 page 메타를 싣는다', async () => {
    const shipment = await makeShipment();
    const open = (await create(shipment.shipmentId)) as UnitBody;
    await prisma.shipping_unit.update({
      where: { shipping_unit_id: BigInt(open.shippingUnitId) },
      data: { status_code: 'CLOSED' },
    });
    const other = (await create(shipment.shipmentId)) as UnitBody;

    const byShipment = await list({ shipmentId: shipment.shipmentId, size: 50 });
    expect(byShipment.items.map((row) => row.shippingUnitId).sort()).toEqual(
      [open.shippingUnitId, other.shippingUnitId].sort(),
    );
    expect(byShipment.page).toMatchObject({ page: 1, size: 50 });

    const closed = await list({ shipmentId: shipment.shipmentId, statusCode: 'CLOSED' });
    expect(closed.items.map((row) => row.shippingUnitId)).toEqual([open.shippingUnitId]);

    const byNo = await list({ q: other.shippingUnitNo });
    expect(byNo.items.map((row) => row.shippingUnitId)).toContain(other.shippingUnitId);
  });

  it('U-7 상세가 ETag 를 내리고 빈 단위의 상자·합계가 빈 배열이다', async () => {
    const shipment = await makeShipment();
    const created = (await create(shipment.shipmentId)) as UnitBody;

    const response = await request(app.getHttpServer())
      .get(`${BASE}/${created.shippingUnitId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.headers.etag).toBe('1');
    expect(response.body.boxes).toEqual([]);
    // ⛔ 빈 배열이지 키 누락이 아니다 — 화면이 「상자 0」과 「모르는 상태」를 갈라야 한다.
    expect(response.body.itemTotals).toEqual([]);
  });

  it('U-8 없는 단위 상세는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/9007199254740`)
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 단말 ────────────────────────────────────────────────────────────────

  /**
   * ⛔ 단말은 자기 «창고»를 모른다 — 공장만 안다. 그래서 서버가 단말의 공장으로 좁히지
   * 않으면 남의 공장 출하 단위가 POP 목록에 샌다.
   */
  it('U-9 ⭐ POP 단말은 자기 공장만 본다 — 목록·상세·생성 셋 다', async () => {
    const mine = await makeShipment();
    const foreign = await makeShipment('REGISTERED', true);
    const mineUnit = (await create(mine.shipmentId)) as UnitBody;
    const foreignUnit = (await create(foreign.shipmentId)) as UnitBody;

    const listed = await request(app.getHttpServer())
      .get(`${BASE}?size=100`)
      .set('Authorization', `Bearer ${popToken}`)
      .expect(200);
    const seen = listed.body.items.map((row: UnitBody) => row.shippingUnitId);
    expect(seen).toContain(mineUnit.shippingUnitId);
    expect(seen).not.toContain(foreignUnit.shippingUnitId);

    // 남의 공장 단위는 상세도 못 본다 — 「있는데 막혔다」가 아니라 「없다」로 답한다.
    await request(app.getHttpServer())
      .get(`${BASE}/${foreignUnit.shippingUnitId}`)
      .set('Authorization', `Bearer ${popToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`${BASE}/${mineUnit.shippingUnitId}`)
      .set('Authorization', `Bearer ${popToken}`)
      .set('X-Worker-No', WORKER_NO)
      .expect(200);

    // 남의 공장 출하에는 단위를 열 수 없다.
    await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', `Bearer ${popToken}`)
      .set('X-Worker-No', WORKER_NO)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: foreign.shipmentId, shippingUnitTypeCode: 'PALLET' })
      .expect(401);
  });

  it('U-10 그 공장 단말은 자기 출하에 단위를 연다 — created_by 는 비고 작업자로 남는다', async () => {
    const shipment = await makeShipment();

    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', `Bearer ${popToken}`)
      .set('X-Worker-No', WORKER_NO)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId: shipment.shipmentId, shippingUnitTypeCode: 'PALLET' })
      .expect(201);

    const row = await prisma.shipping_unit.findUniqueOrThrow({
      where: { shipping_unit_id: BigInt(response.body.shippingUnitId) },
      select: { created_by: true, status_code: true },
    });
    // ⛔ 단말 호출은 세션 계정이 없다 — `created_by` 는 null 이고 흔적은 감사에 남는다.
    expect(row.created_by).toBeNull();
    expect(row.status_code).toBe('OPEN');
  });

  it('U-11 ⛔ 모바일 단말은 이 화면을 갖지 않는다 — 401 이다', async () => {
    await request(app.getHttpServer())
      .get(BASE)
      .set('Authorization', `Bearer ${foreignToken}`)
      .expect(401);
  });

  // ── 상자 넣기·빼기·마감 (③b) ────────────────────────────────────────────

  it('U-12 ⭐ 포장 라벨 번호로 상자를 넣는다 — seq·합계·버전이 함께 오른다', async () => {
    const shipment = await makeShipment();
    const unit = (await create(shipment.shipmentId)) as UnitBody;
    const first = await makePackedBox(shipment, 100);
    const second = await makePackedBox(shipment, 40);

    const one = await addBox(unit.shippingUnitId, first.handlingUnitNo);
    expect(one.body.boxCount).toBe(1);
    // ⭐ 상자가 드나들면 버전이 오른다 — 안 오르면 낡은 ETag 로 마감이 통과한다.
    expect(one.body.versionNo).toBe(2);
    expect(one.headers.etag).toBe('2');

    const two = await addBox(unit.shippingUnitId, second.handlingUnitNo);
    expect(two.body.boxes.map((box: { seq: number }) => box.seq)).toEqual([1, 2]);
    expect(two.body.versionNo).toBe(3);
    // 같은 품목·단위라 한 줄로 합쳐진다.
    expect(two.body.itemTotals).toEqual([
      expect.objectContaining({ itemId: Number(ids.item), qty: 140, uomId: Number(ids.uom) }),
    ]);
  });

  /** ⭐ 스캐너가 한 번에 두 번 읽는 일이 흔하다 — 그걸 오류로 만들면 작업자가 멈춘다. */
  it('U-13 ⭐ 같은 상자를 다시 스캔하면 200 이고 버전도 안 오른다(멱등)', async () => {
    const shipment = await makeShipment();
    const unit = (await create(shipment.shipmentId)) as UnitBody;
    const box = await makePackedBox(shipment, 10);

    const first = await addBox(unit.shippingUnitId, box.handlingUnitNo);
    const again = await addBox(unit.shippingUnitId, box.handlingUnitNo);

    expect(again.body.boxCount).toBe(1);
    expect(again.body.versionNo).toBe(first.body.versionNo);
  });

  it('U-14 ⭐ 넣기 거절 다섯 갈래가 code·field 로 갈린다', async () => {
    const shipment = await makeShipment();
    const unit = (await create(shipment.shipmentId)) as UnitBody;

    // ① 없는 상자 → 404
    await request(app.getHttpServer())
      .post(`${BASE}/${unit.shippingUnitId}:add-box`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ handlingUnitNo: `${PREFIX}-NOPE` })
      .expect(404);

    // ② 포장 확정되지 않은 상자 → STATE_LOCKED / handlingUnitNo
    const open = await makePackedBox(shipment, 5, { status: 'OPEN' });
    expect((await addBox(unit.shippingUnitId, open.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'handlingUnitNo', code: 'STATE_LOCKED' });

    // ③ 포장 실적(배분)이 없는 상자 → INVALID
    const bare = await makePackedBox(shipment, 5, { allocate: false });
    expect((await addBox(unit.shippingUnitId, bare.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'handlingUnitNo', code: 'INVALID' });

    // ④ 다른 출하의 상자 → PAIR
    const otherShipment = await makeShipment();
    const foreign = await makePackedBox(otherShipment, 5);
    expect((await addBox(unit.shippingUnitId, foreign.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'handlingUnitNo', code: 'PAIR' });

    // ⑤ 이미 다른 단위에 구성된 상자 → UNIQUE_VIOLATION
    const taken = await makePackedBox(shipment, 5);
    const otherUnit = (await create(shipment.shipmentId)) as UnitBody;
    await addBox(otherUnit.shippingUnitId, taken.handlingUnitNo);
    expect((await addBox(unit.shippingUnitId, taken.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'handlingUnitNo', code: 'UNIQUE_VIOLATION' });
  });

  it('U-15 상자를 빼면 200 + 상세이고 seq 는 재부여되지 않는다', async () => {
    const shipment = await makeShipment();
    const unit = (await create(shipment.shipmentId)) as UnitBody;
    const first = await makePackedBox(shipment, 10);
    const second = await makePackedBox(shipment, 20);
    await addBox(unit.shippingUnitId, first.handlingUnitNo);
    await addBox(unit.shippingUnitId, second.handlingUnitNo);

    const removed = await request(app.getHttpServer())
      .delete(`${BASE}/${unit.shippingUnitId}/boxes/${first.handlingUnitId}`)
      .set('Cookie', cookie)
      .expect(200);

    // ⛔ 204 가 아니라 상세다 — 화면이 목록·합계를 그 자리에서 다시 그린다.
    expect(removed.body.boxCount).toBe(1);
    // 남은 상자의 seq 는 2 그대로다 — 재부여하면 화면에 찍힌 번호가 흔들린다.
    expect(removed.body.boxes.map((box: { seq: number }) => box.seq)).toEqual([2]);
    expect(removed.body.versionNo).toBe(4);

    // 그 단위에 없는 상자를 빼면 404
    await request(app.getHttpServer())
      .delete(`${BASE}/${unit.shippingUnitId}/boxes/${first.handlingUnitId}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('U-16 ⭐ 마감은 If-Match 를 요구하고 편도다 — 상자 0 은 400 INVALID', async () => {
    const shipment = await makeShipment();
    const empty = (await create(shipment.shipmentId)) as UnitBody;

    // 상자가 없으면 마감할 수 없다.
    const blocked = await close(empty.shippingUnitId, empty.versionNo, 400);
    expect(blocked.body.errors[0]).toMatchObject({ field: 'boxes', code: 'INVALID' });

    const box = await makePackedBox(shipment, 30);
    const added = await addBox(empty.shippingUnitId, box.handlingUnitNo);

    // ⛔ 낡은 버전으로는 못 닫는다 — 상자를 넣으며 버전이 올랐다.
    const stale = await close(empty.shippingUnitId, empty.versionNo, 409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });

    const closed = await close(empty.shippingUnitId, added.body.versionNo, 200);
    expect(closed.body.statusCode).toBe('CLOSED');
    expect(closed.body.closedAt).toEqual(expect.any(String));

    // 마감된 뒤에는 넣기·빼기·재마감이 전부 막힌다(편도다).
    const more = await makePackedBox(shipment, 5);
    expect((await addBox(empty.shippingUnitId, more.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'shippingUnitId', code: 'STATE_LOCKED' });
    await request(app.getHttpServer())
      .delete(`${BASE}/${empty.shippingUnitId}/boxes/${box.handlingUnitId}`)
      .set('Cookie', cookie)
      .expect(400);
    await close(empty.shippingUnitId, closed.body.versionNo, 400);
  });

  it('U-17 ⛔ 출하가 취소되면 넣기도 마감도 막힌다', async () => {
    const shipment = await makeShipment();
    const unit = (await create(shipment.shipmentId)) as UnitBody;
    const box = await makePackedBox(shipment, 10);
    const added = await addBox(unit.shippingUnitId, box.handlingUnitNo);

    await prisma.shipment.update({
      where: { shipment_id: BigInt(shipment.shipmentId) },
      data: { status_code: 'CANCELLED' },
    });

    const more = await makePackedBox(shipment, 5);
    expect((await addBox(unit.shippingUnitId, more.handlingUnitNo, 400)).body.errors[0])
      .toMatchObject({ field: 'shipmentId', code: 'STATE_LOCKED' });
    expect((await close(unit.shippingUnitId, added.body.versionNo, 400)).body.errors[0])
      .toMatchObject({ field: 'shipmentId', code: 'STATE_LOCKED' });
  });

  // ── 헬퍼 ────────────────────────────────────────────────────────────────

  function addBox(
    shippingUnitId: number,
    handlingUnitNo: string,
    expected = 200,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`${BASE}/${shippingUnitId}:add-box`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ handlingUnitNo })
      .expect(expected);
  }

  function close(shippingUnitId: number, version: number, expected = 200): request.Test {
    return request(app.getHttpServer())
      .post(`${BASE}/${shippingUnitId}:close`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(version))
      .expect(expected);
  }

  /** 포장이 끝난 상자 하나 — 배분까지 붙여야 「그 출하의 상자」가 된다. */
  async function makePackedBox(
    shipment: { shipmentId: number; requestLineId: bigint },
    qty: number,
    options: { status?: string; allocate?: boolean } = {},
  ): Promise<{ handlingUnitId: number; handlingUnitNo: string }> {
    seq += 1;
    const box = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-HU-${seq}`,
        handling_unit_type_code: 'BOX',
        warehouse_id: ids.warehouse,
        status_code: options.status ?? 'PACKED',
      },
    });
    if (options.allocate !== false) {
      // ⛔ `line_no` 는 출하 안에서 유일하다(`uq_shipment_line`) — 그 출하의 마지막 뒤에 붙인다.
      const last = await prisma.shipment_line.findFirst({
        where: { shipment_id: BigInt(shipment.shipmentId) },
        orderBy: { line_no: 'desc' },
        select: { line_no: true },
      });
      const line = await prisma.shipment_line.create({
        data: {
          shipment_id: BigInt(shipment.shipmentId),
          shipment_request_line_id: shipment.requestLineId,
          line_no: (last?.line_no ?? 0) + 1,
          item_id: ids.item,
          shipped_qty: qty,
          uom_id: ids.uom,
        },
      });
      await prisma.shipment_lot_allocation.create({
        data: {
          shipment_line_id: line.shipment_line_id,
          lot_id: ids.lot,
          handling_unit_id: box.handling_unit_id,
          allocated_qty: qty,
          uom_id: ids.uom,
        },
      });
      await prisma.handling_unit_content.create({
        data: {
          handling_unit_id: box.handling_unit_id,
          item_id: ids.item,
          lot_id: ids.lot,
          qty,
          uom_id: ids.uom,
        },
      });
    }
    return {
      handlingUnitId: Number(box.handling_unit_id),
      handlingUnitNo: box.handling_unit_no,
    };
  }


  async function create(shipmentId: number): Promise<unknown> {
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ shipmentId, shippingUnitTypeCode: 'PALLET' })
      .expect(201);
    return response.body;
  }

  async function list(
    query: Record<string, string | number>,
  ): Promise<{ items: UnitBody[]; page: { page: number; size: number; total: number } }> {
    const response = await request(app.getHttpServer())
      .get(BASE)
      .query(query)
      .set('Cookie', cookie)
      .expect(200);
    return response.body;
  }

  async function makeShipment(
    statusCode = 'REGISTERED',
    foreign = false,
  ): Promise<{ shipmentId: number; requestLineId: bigint }> {
    seq += 1;
    const header = await prisma.shipment_request.create({
      data: {
        shipment_request_no: `${PREFIX}-SR-${seq}`,
        customer_id: ids.customer,
        ship_to_partner_id: ids.shipTo,
        requested_ship_date: new Date('2026-09-17T00:00:00.000Z'),
        status_code: 'REGISTERED',
      },
    });
    // ⛔ `shipment_line.shipment_request_line_id` 가 필수다 — 출하 라인은 지시 라인에서 나온다.
    const requestLine = await prisma.shipment_request_line.create({
      data: {
        shipment_request_id: header.shipment_request_id,
        line_no: 1,
        item_id: ids.item,
        requested_qty: 1000,
        allocated_qty: 1000,
        uom_id: ids.uom,
        shipping_inspection_required: false,
      },
    });
    const shipment = await prisma.shipment.create({
      data: {
        shipment_no: `${PREFIX}-SH-${seq}`,
        shipment_request_id: header.shipment_request_id,
        warehouse_id: foreign ? ids.foreignWarehouse : ids.warehouse,
        status_code: statusCode,
      },
    });
    return {
      shipmentId: Number(shipment.shipment_id),
      requestLineId: requestLine.shipment_request_line_id,
    };
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '출하단위검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '출하단위검사사업부',
      },
    });
    for (const [key, code, warehouseKey] of [
      ['plant', 'P1', 'warehouse'],
      ['foreignPlant', 'P2', 'foreignWarehouse'],
    ] as const) {
      const plant = await prisma.plant.create({
        data: {
          legal_entity_id: entity.legal_entity_id,
          plant_code: `${PREFIX}-${code}`,
          plant_name: `출하단위검사공장${code}`,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      });
      ids[key] = plant.plant_id;
      const warehouse = await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id,
          business_unit_id: unit.business_unit_id,
          warehouse_code: `${PREFIX}-WH-${code}`,
          warehouse_name: `출하단위검사창고${code}`,
          warehouse_type_code: 'FINISHED',
          management_level_code: 'WAREHOUSE',
        },
      });
      ids[warehouseKey] = warehouse.warehouse_id;
    }

    // ⭐ 유형 값은 `prisma/seed.ts` 가 넣는다(고객 관리형 그룹). e2e DB 에 표준 시드가
    //   적용돼 있지 않을 수 있어 여기서 보장한다 — 없으면 생성이 전부 400 이다.
    await prisma.code_group.upsert({
      where: { group_code: 'SHIPPING_UNIT_TYPE' },
      update: {},
      create: { group_code: 'SHIPPING_UNIT_TYPE', group_name: '출하단위 유형' },
    });
    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: 'SHIPPING_UNIT_TYPE' },
    });
    for (const [code, name, order] of [
      ['PALLET', '팔레트', 10],
      ['BUNDLE', '번들', 20],
    ] as const) {
      const found = await prisma.code_value.findFirst({
        where: { code_group_id: group.code_group_id, code },
      });
      if (found === null) {
        await prisma.code_value.create({
          data: { code_group_id: group.code_group_id, code, code_name: name, display_order: order },
        });
      }
    }

    const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '출하단위검사품목',
        item_type_code: 'FINISHED',
        base_uom_id: uom.uom_id,
      },
    });
    ids.item = item.item_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: item.item_id,
        lot_type_code: 'PRODUCT',
        plant_id: ids.plant,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'GOODS_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    ids.lot = lot.lot_id;

    const customer = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-CUST`, partner_name: '출하단위검사고객' },
    });
    ids.customer = customer.partner_id;
    const shipTo = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SHIPTO`, partner_name: '출하단위검사납품처' },
    });
    ids.shipTo = shipTo.partner_id;

    const jwt = app.get(JwtService);
    for (const [key, plantId, type] of [
      ['popToken', ids.plant, 'POP'],
      ['foreignToken', ids.plant, 'MOBILE'],
    ] as const) {
      const terminal = await prisma.terminal.create({
        data: {
          terminal_code: `${PREFIX}-${type}`,
          plant_id: plantId,
          terminal_type_code: type,
          status_code: 'RUNNING',
        },
      });
      const token = jwt.sign({
        sub: Number(terminal.terminal_id),
        typ: 'terminal',
        tv: terminal.token_version,
        terminalCode: terminal.terminal_code,
        plantId: Number(plantId),
      });
      if (key === 'popToken') popToken = token;
      else foreignToken = token;
    }

    await prisma.worker.create({
      data: {
        worker_no: WORKER_NO,
        worker_name: '출하단위검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: ids.plant,
        status_code: 'EMPLOYED',
      },
    });
  }

  async function makeUser(): Promise<void> {
    const role = await prisma.role.create({
      data: { role_code: ROLE, role_name: '출하단위검사역할' },
    });
    for (const code of PERMISSIONS) {
      await prisma.role_permission.create({
        data: { role_id: role.role_id, permission_code: code },
      });
    }
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출하단위검사계정', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const jwt = app.get(JwtService);
    cookie = [`${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: 'session' })}`];
  }

  async function cleanup(): Promise<void> {
    // ⛔ 링크 → 단위 → 출하 → 지시 순이다(FK).
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipping_unit_handling_unit
       WHERE shipping_unit_id IN (SELECT shipping_unit_id FROM logistics.shipping_unit
              WHERE shipping_unit_no LIKE 'SU-%' AND shipment_id IN (
                SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipping_unit
       WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_lot_allocation
       WHERE handling_unit_id IN (SELECT handling_unit_id FROM inventory.handling_unit
              WHERE handling_unit_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_content
       WHERE handling_unit_id IN (SELECT handling_unit_id FROM inventory.handling_unit
              WHERE handling_unit_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_line
       WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.shipment_request_line
       WHERE shipment_request_id IN (SELECT shipment_request_id FROM logistics.shipment_request
              WHERE shipment_request_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    );

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
