/**
 * 자재 반출 — 조회 2건(PR ①) + 등록 `POST /production/material-returns`(PR ③).
 *
 * ⭐ 조회가 보는 반출은 **직접 INSERT** 한다 — 이 PR 에 `POST` 가 없다(PR ③ 몫).
 * ⭐ 라인 전건 `return_quality_status_code: null` 이다 — M-2(NOT NULL 완화)가 실제로 먹었는지를
 *    픽스처가 증명한다. 계약 `MaterialReturnLine` 에 그 칸이 없어 서버가 값을 만들지 않는다.
 * ⭐ 목록도 상세도 `lines` 를 싣는다 — 같은 `MaterialReturn` 스키마라 비우면 자리마다 모양이
 *    갈린다(I-10 §5-3).
 * ⛔ 계약이 조회 둘에 403 도 ETag 도 선언하지 않았다 — 권한 없는 계정을 세우지 않는다.
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — 원장 행을 한 건도 만들지 않는다(I-10 §7-2).
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

const LOGIN_ID = 'e2e-mr-probe';
const PASSWORD = 'MR-자재반출-비밀번호';
const PREFIX = 'MRE2E';
const RETURNS = '/api/production/material-returns';
const REQUESTED_1 = '2026-09-07T01:00:00.000Z';
const REQUESTED_2 = '2026-09-07T03:00:00.000Z';
const WORKER_NO = `${PREFIX}-WK`;
/** 계약 `statusCode` 는 `x-no-code-key` 다 — 서버가 대조하지 않는 자유 문자다(문의 053). */
const STATUS_REQUESTED = 'REQUESTED';
const STATUS_RECEIVED = 'RECEIVED';

function validator(file: string, operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, `../contracts/${file}`), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('자재 반출 조회 2건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let workOrderId: number;
  /** 라인 둘(`line_no` 2 를 «먼저» 심어 정렬이 저장 순서가 아님을 본다). */
  let returnOneId: number;
  let returnTwoId: number;
  let otherReturnId: number;
  let lotAId: number;
  let lotBId: number;
  /** PR ③ 이 본문에 싣는 축 — 픽스처 그대로여야 원장 무변화 단언이 좁게 선다. */
  let componentItemId: number;
  let uomId: number;
  let locationId: number;
  let warehouseId: number;
  /** ⭐ 두 번째 공장의 창고 — 「같은 공장」 거부(R-11)를 e2e 가 본다. */
  let otherWarehouseId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    // 자가 치유 — 앞 회차가 죽어 남긴 행을 먼저 지운다.
    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 workOrderId·statusCode 로 걸러진다', async () => {
    const byOrder = await request(app.getHttpServer())
      .get(`${RETURNS}?workOrderId=${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(byOrder.body.page).toMatchObject({ page: 1, size: 50, total: 2 });
    // 정렬 고정 `requested_at DESC` · 동률은 PK DESC — 늦게 요청한 것이 앞이다.
    expect(byOrder.body.items.map((item: { materialReturnId: number }) => item.materialReturnId)).toEqual([
      returnTwoId,
      returnOneId,
    ]);
    expect(byOrder.body.items.map((item: { materialReturnId: number }) => item.materialReturnId)).not.toContain(
      otherReturnId,
    );
    expect(validator('production-02생산실행.json', 'GET /production/material-returns')(byOrder.body)).toBe(true);

    // `x-no-code-key` — 문자 그대로 건다. 대조를 걸면 값이 늘 때 목록이 400 이 된다.
    const byStatus = await request(app.getHttpServer())
      .get(`${RETURNS}?workOrderId=${workOrderId}&statusCode=${STATUS_RECEIVED}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byStatus.body.items.map((item: { materialReturnId: number }) => item.materialReturnId)).toEqual([
      returnTwoId,
    ]);
  });

  it('목록이 requestedFrom·requestedTo 반개구간으로 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RETURNS}?workOrderId=${workOrderId}&requestedFrom=${REQUESTED_1}&requestedTo=${REQUESTED_2}`)
      .set('Cookie', cookie)
      .expect(200);

    // From 이상 · To 미만(공유계약 L-3) — 끝 경계 정각의 R2 가 빠진다.
    expect(response.body.items.map((item: { materialReturnId: number }) => item.materialReturnId)).toEqual([
      returnOneId,
    ]);
  });

  it('⭐ 목록 항목이 lines 를 함께 싣는다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RETURNS}?workOrderId=${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    const [second, first] = response.body.items;
    expect(first.lines).toHaveLength(2);
    expect(second.lines).toHaveLength(1);
    // 라인은 계약에 «있는» 5칸뿐이다 — `lineNo`·`returnQualityStatusCode`·`packageOpened`·
    // `qualityCheckRequired`·`inventoryTransactionLineId` 는 응답 스키마에 자리가 없다.
    expect(Object.keys(first.lines[0]).sort()).toEqual([
      'itemId',
      'lotId',
      'materialReturnLineId',
      'returnQty',
      'uomId',
    ]);
    // 채우는 오퍼레이션이 0건이라 `received_at` 은 NULL 이고 뷰가 키를 생략한다(문의 051).
    expect(first).not.toHaveProperty('receivedAt');
  });

  it('상세가 라인을 line_no 오름차순으로 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RETURNS}/${returnOneId}`)
      .set('Cookie', cookie)
      .expect(200);

    // `line_no` 2 를 «먼저» 심었다 — 저장 순서가 아니라 `line_no` 로 정렬한다.
    expect(response.body.lines.map((line: { lotId: number }) => line.lotId)).toEqual([lotAId, lotBId]);
    expect(response.body).toMatchObject({
      materialReturnId: returnOneId,
      workOrderId,
      statusCode: STATUS_REQUESTED,
      requestedAt: REQUESTED_1,
    });
    expect(
      validator('production-02생산실행.json', 'GET /production/material-returns/{materialReturnId}')(response.body),
    ).toBe(true);
  });

  it('없는 반출은 404', async () => {
    await request(app.getHttpServer()).get(`${RETURNS}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('⛔ 조회 응답에 ETag 가 없다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${RETURNS}/${returnOneId}`)
      .set('Cookie', cookie)
      .expect(200);

    // 계약이 I-10 6건 어디에도 ETag 를 선언하지 않았다 — `setEtag` 를 부르지 않는다.
    // ⚠ Express 가 붙이는 «약한» 내용 해시는 남는다 — 우리가 싣는 숫자 토큰이 아니다.
    expect(response.headers.etag).toMatch(/^W\/"/);
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
  });

  /**
   * `POST /production/material-returns` — I-10 PR ③. 계약이 이 하나에만 403 을 선언하므로
   * 조회 전용 `cookie` 대신 이 describe 전용 세션 둘을 쓴다(① 의 `makeUser()` 를 고치지 않는다).
   * ⛔ 실제 채번 번호(`MR-{YYYYMMDD}-{SEQ4}`)는 `MRE2E` 접두어가 아니다 — 정리는 W/O 축으로 되짚는다.
   */
  describe('POST /production/material-returns', () => {
    const POST_LOGIN_ID = 'e2e-mre-post';
    const POST_ROLE = 'E2E_MRE_POST';
    const NO_PERM_LOGIN_ID = 'e2e-mre-post-np';
    const NO_PERM_ROLE = 'E2E_MRE_POST_NP';

    let postCookie: string[];
    let noPermCookie: string[];
    let successResponse: request.Response;
    let sentBefore: number;
    let sentAfter: number;
    let ledgerBefore: { onHand: string; version: number };
    let ledgerAfter: { onHand: string; version: number };
    let txLineCountBefore: number;
    let txLineCountAfter: number;

    interface PostOptions {
      key?: string;
      cookie?: string[];
      workerNo?: string | null;
    }

    function post(payload: object, options: PostOptions = {}) {
      const call = request(app.getHttpServer())
        .post(RETURNS)
        .set('Cookie', options.cookie ?? postCookie)
        .set('Idempotency-Key', options.key ?? randomUUID());
      if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
      return call.send(payload);
    }

    function returnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        workOrderId,
        sourceLocationId: locationId,
        destinationWarehouseId: warehouseId,
        lines: [{ itemId: componentItemId, lotId: lotAId, returnQty: 5, uomId }],
        ...overrides,
      };
    }

    beforeAll(async () => {
      postCookie = await login(POST_LOGIN_ID, POST_ROLE, ['P-02-03']);
      noPermCookie = await login(NO_PERM_LOGIN_ID, NO_PERM_ROLE, []);

      // 원장 단언은 픽스처 item_id/lot_id 축으로 좁힌다 — 다른 스위트의 행을 세지 않는다.
      const balanceBefore = await prisma.inventory_balance.findFirstOrThrow({
        where: { item_id: componentItemId, lot_id: lotAId },
      });
      ledgerBefore = { onHand: balanceBefore.on_hand_qty.toString(), version: balanceBefore.version_no };
      txLineCountBefore = await prisma.inventory_transaction_line.count({ where: { lot_id: lotAId } });

      sentBefore = Date.now();
      successResponse = await post(
        returnBody({
          lines: [
            { itemId: componentItemId, lotId: lotBId, returnQty: 7, uomId },
            { itemId: componentItemId, lotId: lotAId, returnQty: 5, uomId },
          ],
        }),
      );
      sentAfter = Date.now();

      const balanceAfter = await prisma.inventory_balance.findFirstOrThrow({
        where: { item_id: componentItemId, lot_id: lotAId },
      });
      ledgerAfter = { onHand: balanceAfter.on_hand_qty.toString(), version: balanceAfter.version_no };
      txLineCountAfter = await prisma.inventory_transaction_line.count({ where: { lot_id: lotAId } });
    });

    afterAll(async () => {
      for (const loginId of [POST_LOGIN_ID, NO_PERM_LOGIN_ID]) {
        const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
        if (!target) continue;
        await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
        await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
      }
      for (const roleCode of [POST_ROLE, NO_PERM_ROLE]) {
        await prisma.role_permission.deleteMany({ where: { role: { role_code: roleCode } } });
        await prisma.role.deleteMany({ where: { role_code: roleCode } });
      }
    });

    it('라인 둘을 실으면 201 이고 line_no 가 1·2 로 매겨진다', async () => {
      expect(successResponse.status).toBe(201);
      const validate = validator('production-02생산실행.json', 'POST /production/material-returns', 201);
      expect(validate(successResponse.body)).toBe(true);
      expect(validate.errors ?? []).toEqual([]);
      expect(successResponse.body).toMatchObject({ workOrderId, statusCode: STATUS_REQUESTED });

      // 계약 응답에 `lineNo` 칸이 없다 — 서버가 본문 순서로 매긴 값은 DB 에서 본다.
      const lines = await prisma.material_return_line.findMany({
        where: { material_return_id: BigInt(successResponse.body.materialReturnId as number) },
        orderBy: { line_no: 'asc' },
      });
      expect(lines.map((line) => [line.line_no, Number(line.lot_id)])).toEqual([
        [1, lotBId],
        [2, lotAId],
      ]);
    });

    it('⛔ 반출이 inventory_transaction 을 만들지 않고 inventory_balance 가 그대로다', () => {
      // 설계 미정 — 문의 051
      expect(ledgerAfter).toEqual(ledgerBefore);
      expect(txLineCountAfter).toBe(txLineCountBefore);
      expect(txLineCountAfter).toBe(0);
    });

    it('⛔ material_return_line.inventory_transaction_line_id 가 NULL 이다', async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n
          FROM production.material_return_line
         WHERE material_return_id = ${BigInt(successResponse.body.materialReturnId as number)}
           AND inventory_transaction_line_id IS NOT NULL`;
      expect(Number(rows[0].n)).toBe(0);
    });

    it('⛔ received_at 이 NULL 이고 requested_at 이 서버 시각으로 찬다', async () => {
      const rows = await prisma.$queryRaw<{ received_at: Date | null; requested_at: Date }[]>`
        SELECT received_at, requested_at
          FROM production.material_return
         WHERE material_return_id = ${BigInt(successResponse.body.materialReturnId as number)}`;
      expect(rows[0].received_at).toBeNull();
      // 담을 칸은 있는데 받을 칸이 없다 — 요청에 날짜가 0개다(문의 051).
      expect(rows[0].requested_at.getTime()).toBeGreaterThanOrEqual(sentBefore);
      expect(rows[0].requested_at.getTime()).toBeLessThanOrEqual(sentAfter);
      expect(successResponse.body).not.toHaveProperty('receivedAt');
    });

    it('lines 가 비면 400 RANGE(계약 가드 minItems)', async () => {
      // ⭐ 서비스가 아니라 계약 가드가 막는다 — `LINE_REQUIRED` 를 만들지 않았다(§4-3 ⓑ).
      const response = await post(returnBody({ lines: [] })).expect(400);
      expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'lines', code: 'RANGE' }));
    });

    it('같은 (itemId, lotId) 가 두 줄이면 400 INVALID', async () => {
      const response = await post(
        returnBody({
          lines: [
            { itemId: componentItemId, lotId: lotAId, returnQty: 5, uomId },
            { itemId: componentItemId, lotId: lotAId, returnQty: 1, uomId },
          ],
        }),
      ).expect(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: 'lines[1].lotId', code: 'INVALID' }),
      );
    });

    it('source_location 의 창고와 destination_warehouse 가 다른 공장이면 400 INVALID', async () => {
      // 계약이 시키지 않은 이 슬라이스의 유일한 거부다 — 거부는 완화가 싸다(R-11).
      const response = await post(returnBody({ destinationWarehouseId: otherWarehouseId })).expect(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: 'destinationWarehouseId', code: 'INVALID' }),
      );
    });

    it('같은 Idempotency-Key 재전송이 반출을 두 벌 만들지 않는다', async () => {
      // ⭐ `material_return` 에 `idempotency_key` 칸이 없다 — 멱등은 `runIdempotent` 하나뿐이다.
      const key = randomUUID();
      const first = await post(returnBody(), { key }).expect(201);
      const again = await post(returnBody(), { key }).expect(201);
      expect(again.body.materialReturnId).toBe(first.body.materialReturnId);
      expect(again.body.materialReturnNo).toBe(first.body.materialReturnNo);
    });

    it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
      // 저장할 칸이 없어 읽고 버린다 — 부재만 거부한다(§4-8).
      const response = await post(returnBody(), { workerNo: null }).expect(400);
      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: 'X-Worker-No', code: 'REQUIRED' }),
      );
    });

    it('무권한 사용자는 403', async () => {
      // ⭐ `manual-permissions.ts` 등록이 살아 있음을 증명한다 — 미등록이면 가드가 던져 500 이다.
      await post(returnBody(), { cookie: noPermCookie }).expect(403);
    });

    it('⭐ 발행된 번호가 MR-{YYYYMMDD}-{SEQ4} 다', () => {
      expect(successResponse.body.materialReturnNo).toMatch(/^MR-\d{8}-\d{4}$/);
      // 기간 축은 서버 시각의 UTC 날짜다 — 계약에 `businessDate` 도 `occurredAt` 도 없다(§4-6).
      expect(successResponse.body.materialReturnNo).toContain(
        `MR-${new Date(sentBefore).toISOString().slice(0, 10).replace(/-/g, '')}-`,
      );
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '자재반출검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '자재반출검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '자재반출검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '자재반출검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const component = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-CI`,
        item_name: '자재반출검사원자재',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '자재반출검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '자재반출검사위치',
        location_type_code: 'BIN',
      },
    });
    componentItemId = Number(component.item_id);
    uomId = Number(uom.uom_id);
    locationId = Number(location.location_id);
    warehouseId = Number(warehouse.warehouse_id);
    // 다른 공장의 창고 — 계약이 시키지 않은 유일한 거부(R-11)를 증명할 상대다.
    const otherPlant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '자재반출검사타공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    otherWarehouseId = Number(
      (
        await prisma.warehouse.create({
          data: {
            plant_id: otherPlant.plant_id,
            business_unit_id: unit.business_unit_id,
            warehouse_code: `${PREFIX}-WH2`,
            warehouse_name: '자재반출검사타공장창고',
            warehouse_type_code: 'RAW',
            management_level_code: 'LOCATION',
          },
        })
      ).warehouse_id,
    );
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });
    // ⭐ PR ③ 의 `X-Worker-No` 검증이 이 위에 선다 — 조회는 읽지 않는다.
    await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '자재반출검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP`,
        plan_date: new Date('2026-09-07T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    const workOrder = async (suffix: string) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'IN_PROGRESS',
        },
      });
    const main = await workOrder('WO');
    workOrderId = Number(main.work_order_id);
    const other = await workOrder('WO2');

    const lot = async (suffix: string, sourceId: number) =>
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: component.item_id,
          lot_type_code: 'MATERIAL',
          plant_id: plant.plant_id,
          initial_qty: 1000,
          uom_id: uom.uom_id,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: sourceId,
          status_code: 'NORMAL',
        },
      });
    const lotA = await lot('A', 1);
    lotAId = Number(lotA.lot_id);
    const lotB = await lot('B', 2);
    lotBId = Number(lotB.lot_id);

    // ⭐ 원장 무변화 단언의 대조 대상 — 이 한 행의 `on_hand_qty`·`version_no` 가 그대로여야 한다.
    //    ⛔ `post()` 가 아니라 픽스처가 직접 심는다(반출은 원장을 지나지 않는다 · 문의 051).
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: location.location_id,
        item_id: component.item_id,
        lot_id: lotA.lot_id,
        quality_status_code: 'GOOD',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: 1000,
        uom_id: uom.uom_id,
      },
    });

    let sequence = 0;
    const materialReturn = async (
      workOrderIdValue: bigint,
      requestedAt: string,
      statusCode: string,
      lots: bigint[],
    ) => {
      sequence += 1;
      return prisma.material_return.create({
        data: {
          material_return_no: `${PREFIX}-MR-${sequence}`,
          work_order_id: workOrderIdValue,
          source_location_id: location.location_id,
          destination_warehouse_id: warehouse.warehouse_id,
          status_code: statusCode,
          requested_at: new Date(requestedAt),
          material_return_line: {
            create: lots.map((lotId, index) => ({
              // ⭐ `line_no` 를 내림차순으로 심는다 — 정렬이 저장 순서가 아님을 상세가 본다.
              line_no: lots.length - index,
              item_id: component.item_id,
              lot_id: lotId,
              return_qty: 5,
              uom_id: uom.uom_id,
              // ⭐ M-2 — 완화 전이면 이 INSERT 가 NOT NULL 위반으로 죽는다.
              return_quality_status_code: null,
            })),
          },
        },
      });
    };
    returnOneId = Number(
      (await materialReturn(main.work_order_id, REQUESTED_1, STATUS_REQUESTED, [lotB.lot_id, lotA.lot_id]))
        .material_return_id,
    );
    returnTwoId = Number(
      (await materialReturn(main.work_order_id, REQUESTED_2, STATUS_RECEIVED, [lotA.lot_id])).material_return_id,
    );
    otherReturnId = Number(
      (await materialReturn(other.work_order_id, REQUESTED_2, STATUS_REQUESTED, [lotA.lot_id])).material_return_id,
    );
  }

  async function makeUser(): Promise<void> {
    // 조회 둘은 403 미선언이라 역할을 안 붙인다 — 로그인 세션만 있으면 된다.
    cookie = await login(LOGIN_ID, null, []);
  }

  /** 역할 코드가 널이면 역할을 안 붙인다(조회 전용 세션). */
  async function login(loginId: string, roleCode: string | null, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '자재반출검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    if (roleCode !== null) {
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: '자재반출검사용' } });
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
      });
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(§7-2 · `LIKE '${PREFIX}%'` 또는 id 서브쿼리 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    // ⭐ `POST` 가 발행한 번호는 `MR-…` 라 접두어로 안 잡힌다 — W/O 축으로도 되짚는다.
    const returnWhere = {
      OR: [{ material_return_no: { startsWith: PREFIX } }, { work_order: orderScope }],
    };
    await prisma.material_return_line.deleteMany({ where: { material_return: returnWhere } });
    await prisma.material_return.deleteMany({ where: returnWhere });
    await prisma.inventory_balance.deleteMany({ where: { lot: { lot_no: { startsWith: PREFIX } } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
