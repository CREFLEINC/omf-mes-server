/**
 * 자재 반출 조회 — 목록 `GET /production/material-returns` · 단건 `GET …/{id}`(I-10 PR ①).
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
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '자재반출검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(§7-2 · `LIKE '${PREFIX}%'` 또는 id 서브쿼리 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const returnScope = { material_return: { material_return_no: { startsWith: PREFIX } } };
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    await prisma.material_return_line.deleteMany({ where: returnScope });
    await prisma.material_return.deleteMany({ where: { material_return_no: { startsWith: PREFIX } } });
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
