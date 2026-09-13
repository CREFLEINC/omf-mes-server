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
const NOPERM_ID = 'e2e-pk-noperm';
const PASSWORD = '피킹-조회-비밀번호';
const PREFIX = 'PKE2E';
const ROLE = 'E2E_PK';
/** `:pick` 은 `manual-permissions.ts` 가 `M-01-08` 로 갖는다 · 잔액을 세우는 입고는 `W-01-10`. */
const PERMISSIONS = ['M-01-08', 'W-01-10'];
const DAY = '2026-05-04';
const AT = '2026-05-04T02:00:00.000Z';
/** ⚠ 읽고 «버린다» — 피킹의 행위자를 담을 칸이 없다(I-8.md §6-7 · 알려둘 것 ⓑ). */
const WORKER_NO = 'PK-0001';

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
  let noPermCookie: string[];
  let actorUserId: bigint;

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
        held_by: actorUserId,
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

  it(':pick 이 picked_qty 를 대체한다', async () => {
    const lotId = await makeLot('2027-03-31');
    await stock(lotId);
    const seeded = await insertPickingOrder([{ lotId }]);

    const first = await pick(seeded, 0, { pickedQty: 4 }).expect(200);
    const schema = validator(
      'POST /logistics/picking-orders/{pickingOrderId}/lines/{pickingLineId}:pick',
    );
    expect(schema(first.body)).toBe(true);
    expect(schema.errors ?? []).toEqual([]);
    expect(first.body).toMatchObject({ pickedQty: 4, statusCode: 'REGISTERED', held: false });
    // ⛔ «버전» 토큰을 안 내린다 — 계약이 이 200 에 응답 헤더를 선언하지 않았다(§9-2 · `setEtag` ✕).
    //    express 가 붙이는 `W/"…"` 는 본문 해시라 If-Match 토큰이 아니다.
    expect(Number.isNaN(Number(first.headers.etag))).toBe(true);

    // 누계가 아니라 «대체»다 — 현장이 수량을 잘못 눌렀을 때의 유일한 정정 경로다(§6-4).
    const second = await pick(seeded, 0, { pickedQty: 6 }).expect(200);
    expect(second.body.pickedQty).toBe(6);
    const line = await prisma.picking_line.findUniqueOrThrow({
      where: { picking_line_id: seeded.pickingLineIds[0] },
    });
    expect(line.picked_qty.toNumber()).toBe(6);
    expect(line.version_no).toBe(3);
  });

  it(':pick 이 balance 의 picked 를 올리고 available 을 내린다', async () => {
    const lotId = await makeLot('2027-04-30');
    await stock(lotId);
    const seeded = await insertPickingOrder([{ lotId }]);

    await pick(seeded, 0, { pickedQty: 4 }).expect(200);

    // ⭐ 코어의 중첩 `Prisma.sql`(`dimensionWhere`)이 실제 PG 에서 도는 첫 실증이다 —
    //    뷰 응답이 아니라 잔액 행을 되읽어 단언한다(리뷰 245 인계).
    const after = await balanceOf(lotId);
    expect(after.picked_qty.toNumber()).toBe(4);
    expect(Number(after.available_qty)).toBe(96);
    expect(after.on_hand_qty.toNumber()).toBe(100);

    // Δ<0 도 같은 길이다 — 줄이면 가용이 돌아온다.
    await pick(seeded, 0, { pickedQty: 1 }).expect(200);
    const reduced = await balanceOf(lotId);
    expect(reduced.picked_qty.toNumber()).toBe(1);
    expect(Number(reduced.available_qty)).toBe(99);
  });

  it('예약을 문 라인은 reserved 에서 picked 로 옮긴다', async () => {
    const lotId = await makeLot('2027-05-31');
    await stock(lotId);
    // 잔액에 예약분을 «선반영»한다 — 예약을 거는 오퍼레이션이 서버에 0건이다(문의 045).
    await prisma.$executeRawUnsafe(`
      UPDATE inventory.inventory_balance SET reserved_qty = 5
       WHERE lot_id = ${lotId} AND location_id = ${locationId}`);
    // ⚠ 코어의 예약 UPDATE 가 `inventory_reservation_id AND item_id` 짝을 본다 — 라인과 같은 품목이어야 한다.
    const reservation = await prisma.inventory_reservation.create({
      data: {
        reservation_no: `${PREFIX}-RSV-${(seq += 1)}`,
        reservation_type_code: 'PICKING',
        source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
        source_document_id: materialIssueRequestId,
        item_id: itemId,
        lot_id: lotId,
        warehouse_id: warehouseId,
        location_id: locationId,
        reserved_qty: 5,
        uom_id: uomId,
        // 서버가 이 칸을 «움직이는» 오퍼레이션이 0건이다(계약 `x-no-code-key` · R-10) — 리터럴이다.
        status_code: 'RESERVED',
      },
    });
    const seeded = await insertPickingOrder([
      { lotId, inventoryReservationId: Number(reservation.inventory_reservation_id) },
    ]);

    await pick(seeded, 0, { pickedQty: 3 }).expect(200);

    // `reserved + picked` 합이 안 변해 트리거의 문장별 불변식이 지켜진다.
    const after = await balanceOf(lotId);
    expect(after.reserved_qty.toNumber()).toBe(2);
    expect(after.picked_qty.toNumber()).toBe(3);
    expect(Number(after.available_qty)).toBe(95);
    const moved = await prisma.inventory_reservation.findUniqueOrThrow({
      where: { inventory_reservation_id: reservation.inventory_reservation_id },
    });
    expect(moved.consumed_qty.toNumber()).toBe(3);
  });

  it('If-Match 가 낡으면 409', async () => {
    const lotId = await makeLot('2027-06-30');
    await stock(lotId);
    const seeded = await insertPickingOrder([{ lotId }]);

    const stale = await pick(seeded, 0, { pickedQty: 2 }, { version: '99' }).expect(409);
    expect(stale.body).toMatchObject({ conflictCause: 'user' });
    // 업무 검사보다 «먼저» 본다 — 계획을 넘는 수량이어도 409 다(§6-1 ②).
    await pick(seeded, 0, { pickedQty: 999 }, { version: '99' }).expect(409);
    expect((await balanceOf(lotId)).picked_qty.toNumber()).toBe(0);

    // 맞는 토큰이면 지난다.
    await pick(seeded, 0, { pickedQty: 2 }, { version: '1' }).expect(200);
  });

  it('보류 LOT 은 400', async () => {
    const lotId = await makeLot('2027-08-31');
    await stock(lotId);
    await prisma.lot_hold.create({
      data: {
        lot_id: lotId,
        reason_code: 'INCOMING_INSPECTION_WAIT',
        status_code: 'HELD',
        held_by: actorUserId,
        held_at: new Date(AT),
      },
    });
    const seeded = await insertPickingOrder([{ lotId }]);

    const blocked = await pick(seeded, 0, { pickedQty: 2 }).expect(400);
    expect(blocked.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED', field: 'lotId' });
    expect((await balanceOf(lotId)).picked_qty.toNumber()).toBe(0);
  });

  it('무권한 사용자는 403', async () => {
    const lotId = await makeLot('2027-09-30');
    const seeded = await insertPickingOrder([{ lotId }]);

    await request(app.getHttpServer())
      .post(
        `/api/logistics/picking-orders/${seeded.pickingOrderId}/lines/${seeded.pickingLineIds[0]}:pick`,
      )
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', WORKER_NO)
      .send({ pickedQty: 2, businessDate: DAY, occurredAt: AT })
      .expect(403);
  });

  it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
    const lotId = await makeLot('2027-10-31');
    const seeded = await insertPickingOrder([{ lotId }]);

    const missing = await pick(seeded, 0, { pickedQty: 2 }, { workerNo: null }).expect(400);
    expect(missing.body.errors[0]).toMatchObject({ code: 'REQUIRED', field: 'X-Worker-No' });
  });

  /**
   * ⭐ **M2 마디** — 「출고요청 → 피킹 → 출고」가 한 줄로 이어진다.
   * ⚠ 앞머리의 `:release`(요청 자동 발행)는 픽스처가 무거워 «요청 행 직접 INSERT» 로
   *   갈음했다(`makeMasters` 의 `material_issue_request` · 브리프 허용 · PR 본문에 적었다).
   *   `:release` → 요청 자동 발행은 `production-work-order.e2e-spec.ts` 가 이미 지킨다.
   */
  it('M2 마디 — 피킹한 뒤 출고를 전기하면 picked 가 0 이고 on_hand 가 준다', async () => {
    const lotId = await makeLot('2027-11-30');
    await stock(lotId);
    const seeded = await insertPickingOrder([{ lotId }]);

    await pick(seeded, 0, { pickedQty: 10 }).expect(200);
    const picked = await balanceOf(lotId);
    expect(picked.picked_qty.toNumber()).toBe(10);
    // 피킹분은 가용에서 빠져 있다 — 그대로 출고하면 손검사가 400 을 낸다(§3-5).
    expect(Number(picked.available_qty)).toBe(90);

    const issued = await request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'PRODUCTION',
        sourceDocumentTypeCode: 'PICKING_ORDER',
        sourceDocumentId: seeded.pickingOrderId,
        sourceWarehouseId: warehouseId,
        issuedAt: AT,
        businessDate: DAY,
        occurredAt: AT,
        postImmediately: true,
        lines: [
          {
            pickingLineId: seeded.pickingLineIds[0],
            itemId,
            lotId,
            issueQty: 10,
            uomId,
            sourceLocationId: locationId,
          },
        ],
      })
      .expect(201);
    expect(issued.body.goodsIssue.statusCode).toBe('POSTED');

    const after = await balanceOf(lotId);
    // 소진이 손검사 «앞»에서 돌아 정상 출고가 400 이 되지 않았다(R-6).
    expect(after.picked_qty.toNumber()).toBe(0);
    expect(after.on_hand_qty.toNumber()).toBe(90);
    expect(Number(after.available_qty)).toBe(90);
  });

  /** `:pick` 한 벌 — 겹치는 헤더 셋은 여기 두고 갈래마다 덮어쓴다. */
  function pick(
    seeded: { pickingOrderId: number; pickingLineIds: number[] },
    index: number,
    body: Record<string, unknown>,
    options: { version?: string; workerNo?: string | null } = {},
  ): request.Test {
    const call = request(app.getHttpServer())
      .post(
        `/api/logistics/picking-orders/${seeded.pickingOrderId}/lines/${seeded.pickingLineIds[index]}:pick`,
      )
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID());
    if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
    if (options.version !== undefined) call.set('If-Match', options.version);
    return call.send({ businessDate: DAY, occurredAt: AT, ...body });
  }

  /**
   * ⭐ 잔액을 **입고 API 로** 세운다 — 직접 INSERT 는 트리거가 지키는 11칸 차원을 우리가
   * 맞춰야 하고, 그것이 `:pick` 이 잠그고 되읽는 행이다(출고 e2e §6-5 와 같은 규약).
   */
  async function stock(lot: number, qty = 100): Promise<void> {
    await request(app.getHttpServer())
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
            lotId: lot,
            receiptQty: qty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode: 'AVAILABLE',
            destinationLocationId: locationId,
          },
        ],
      })
      .expect(201);
  }

  function balanceOf(lot: number) {
    return prisma.inventory_balance.findFirstOrThrow({
      where: { item_id: itemId, lot_id: lot, location_id: locationId },
    });
  }

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

  /**
   * 조회 2건은 계약이 403 을 선언하지 않아 세션만 있으면 되지만, `:pick` 은 선언한다 —
   * 역할을 하나 두고 권한 없는 사용자를 따로 세워 403 을 실측한다.
   */
  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '피킹조회검사', status_code: 'EMPLOYED' },
    });
    actorUserId = user.app_user_id;
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '피킹검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login(LOGIN_ID);

    const noPerm = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '피킹무권한', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: noPerm.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
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

  /**
   * §11-1 정리 순서 — `goods_issue_line → goods_issue → picking_line → picking_order →
   * inventory_reservation → material_issue_request_line → material_issue_request →
   * inventory_balance/원장 → lot → …`.
   * 원장(`inventory_transaction*`)만은 TRUNCATE 한다 — 아래 주석(트리거가 DELETE 를 막는다).
   */
  async function cleanup(): Promise<void> {
    const lots = `SELECT lot_id FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const warehouses = `SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`;
    // ⛔ 원장 라인은 트리거가 DELETE 를 막는다(「역트랜잭션을 사용하세요」) — 기존 출고 e2e 와
    //    같은 규약으로 TRUNCATE 한다(§11-1). CASCADE 가 `goods_issue_line` 까지 함께 비운다.
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue_line WHERE item_id IN (${items})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue WHERE source_warehouse_id IN (${warehouses})`);
    // 잔액을 세우는 입고 API 호출이 라인마다 적치 지시를 만든다 — 입고 라인보다 먼저 지운다(FK).
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.putaway_task WHERE item_id IN (${items})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt_line WHERE item_id IN (${items})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.picking_line
       WHERE picking_order_id IN (SELECT picking_order_id FROM logistics.picking_order
              WHERE picking_order_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.picking_order WHERE picking_order_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_reservation WHERE reservation_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.material_issue_request_line
       WHERE material_issue_request_id IN (SELECT material_issue_request_id
              FROM logistics.material_issue_request WHERE issue_request_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.material_issue_request WHERE issue_request_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance WHERE item_id IN (${items})`);
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
    // ⛔ `app.numbering_counter` 는 지우지 않는다(I-2 R-10 ⓔ) — 입고 픽스처가 GR·PT 를 뽑는다.
  }
});
