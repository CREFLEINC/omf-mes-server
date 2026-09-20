/**
 * 자재 출고요청 4건 — `GET /logistics/material-issue-requests` ·
 * `/{materialIssueRequestId}` · `/shortage`(PR ②) · **`POST`**(PR ③).
 * 화면 `M-01-08`(자재 출고)이 목록·상세를, `W-02-10`(추가 자재 출고 요청)이 `shortage` 를 읽는다.
 *
 * ⭐ 픽스처는 `material_issue_request(_line)` 을 **직접 INSERT** 한다 — 요청을 만드는
 * 오퍼레이션(`POST`)은 PR ③ 몫이라 아직 없다. `:release` 회귀 하나만 API 를 탄다.
 * ⭐ 기출고 픽스처는 **출고 헤더 축**이다(R-18) — `goods_issue(POSTED · source=PICKING_ORDER)`
 * ⋈ `picking_order(source=MATERIAL_ISSUE_REQUEST)` ⋈ `material_issue_request.work_order_id`.
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`MIRE2E`)로만 한다.
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
import { ISSUE_REQUEST_REGISTERED } from '../src/logistics/material-issue-request/material-issue-request.constants';
import { parseIfMatch } from '../src/common/optimistic-lock';
import { PrismaService } from '../src/prisma/prisma.service';
import { ISSUE_REGISTERED } from '../src/production/work-order/material-issue';

const LOGIN_ID = 'e2e-mir-probe';
const PASSWORD = 'MIR-출고요청-비밀번호';
const PREFIX = 'MIRE2E';
const ROLE = 'E2E_MIR';
/** `:release` 회귀와 발행 `POST` 에만 필요하다 — 조회 3건은 계약이 403 을 선언하지 않았다. */
const PERMISSIONS = ['W-02-04', 'W-02-10'];
/** 403 을 재는 짝 — 세션은 서고 `W-02-10` 만 없다(`logistics-goods-issue.e2e-spec.ts:658` 선례). */
const NO_PERM_LOGIN_ID = 'e2e-mir-noperm';
const NO_PERM_ROLE = 'E2E_MIR_NP';
const BASE = '/api/logistics/material-issue-requests';

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

interface RequestBody {
  materialIssueRequestId: number;
  issueRequestNo: string;
  workOrderId: number;
  statusCode: string;
  requiredAt: string | null;
  requestedBy: number | null;
  reasonCode: string | null;
  remarks: string | null;
}

interface ShortageBody {
  itemId: number;
  bomComponentId: number | null;
  requiredQty: number;
  issuedQty: number;
  shortageQty: number;
}

describe('자재 출고요청 조회 3건 + 발행 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  const ids = {
    plant: 0n,
    businessUnit: 0n,
    uom: 0n,
    item: 0n,
    componentItemA: 0n,
    componentItemB: 0n,
    routingOperation: 0n,
    bom: 0n,
    bomComponentB: 0n,
    warehouse: 0n,
    location: 0n,
    productionPlan: 0n,
    productionLine: 0n,
    workOrder: 0n,
    postWorkOrder: 0n,
    lot: 0n,
  };
  /** 두 요청 — 첫째는 필터 대상, 둘째는 라인 둘을 가진 상세 대상이다. */
  let firstRequestId: number;
  let detailRequestId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 workOrderId·statusCode·요청번호로 걸러진다', async () => {
    const all = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrder)}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/material-issue-requests');
    expect(validate(all.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(all.body.page).toMatchObject({ page: 1, size: 50 });
    // PK 역순이다(§8-1) — 나중에 만든 상세 대상이 앞선다.
    expect(all.body.items.map((row: RequestBody) => row.materialIssueRequestId)).toEqual([
      detailRequestId,
      firstRequestId,
    ]);

    const byStatus = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrder)}&statusCode=POSTED`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byStatus.body.items.map((row: RequestBody) => row.materialIssueRequestId)).toEqual([
      firstRequestId,
    ]);

    const byNo = await request(app.getHttpServer())
      .get(`${BASE}?q=${PREFIX}-MIR-2`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byNo.body.items.map((row: RequestBody) => row.materialIssueRequestId)).toEqual([
      detailRequestId,
    ]);

    const other = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrder) + 987654}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(other.body.items).toEqual([]);
  });

  it('요청 상세가 라인을 line_no 순으로 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${detailRequestId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /logistics/material-issue-requests/{materialIssueRequestId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // 널 허용 칸은 «키 생략»이 아니라 널이다(R-20).
    expect(response.body.materialIssueRequest).toMatchObject({
      statusCode: ISSUE_REQUEST_REGISTERED,
      requiredAt: null,
      requestedBy: null,
      reasonCode: null,
      remarks: null,
    });
    expect(response.body.lines.map((line: { lineNo: number }) => line.lineNo)).toEqual([1, 2]);
    expect(response.body.lines[0]).toMatchObject({
      itemId: Number(ids.componentItemA),
      requestedQty: 200,
      // ⛔ 물리 칸 값이라 오늘 언제나 0 이다(문의 046) — `shortage` 의 기출고와 다른 수다.
      issuedQty: 0,
    });
    expect(response.body.lines[1].bomComponentId).toBeNull();
  });

  it('없는 요청은 404 다', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/${detailRequestId + 987654}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('shortage 가 W/O 의 BOM 소요를 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/shortage?workOrderId=${Number(ids.workOrder)}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /logistics/material-issue-requests/shortage');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    const items = response.body.items as ShortageBody[];
    // 공정 미지정 라인(3×100)은 안 담긴다 — 담겼다면 A 가 600 이다.
    // A 는 이 공정에 두 줄(2 + 1)이라 합쳐 300 이고 `bomComponentId` 는 널이다(R-20).
    expect(items.map((item) => item.itemId)).toEqual([
      Number(ids.componentItemA),
      Number(ids.componentItemB),
    ]);
    expect(items[0]).toMatchObject({ bomComponentId: null, requiredQty: 300 });
    // 스크랩률 5% 를 곱했다면 52.5 다(문의 037).
    expect(items[1]).toMatchObject({ bomComponentId: Number(ids.bomComponentB), requiredQty: 50 });
  });

  it('shortage 의 기출고는 전기된 출고만 센다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/shortage?workOrderId=${Number(ids.workOrder)}`)
      .set('Cookie', cookie)
      .expect(200);

    const items = response.body.items as ShortageBody[];
    // POSTED 20 만 센다 — CANCELLED 999 를 셌다면 부족이 0 이다.
    expect(items[0]).toMatchObject({ requiredQty: 300, issuedQty: 20, shortageQty: 280 });
    // 출고가 닿지 않은 품목은 0 이다.
    expect(items[1]).toMatchObject({ issuedQty: 0, shortageQty: 50 });
  });

  it('shortage 는 workOrderId 가 없으면 400 REQUIRED 다', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`${BASE}/shortage`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'workOrderId', code: 'REQUIRED' });

    // 없는 W/O 는 **400** 이다 — 계약이 이 경로에 404 를 선언하지 않았다(§7-4).
    const missing = await request(app.getHttpServer())
      .get(`${BASE}/shortage?workOrderId=${Number(ids.workOrder) + 987654}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(missing.body.errors[0]).toMatchObject({ field: 'workOrderId', code: 'INVALID' });
  });

  it('⭐ :release 가 만든 요청의 statusCode 가 REGISTERED 다', async () => {
    // 두 도메인이 같은 값을 «복사»로 갖는다(도메인 간 import 금지 · §4-3 · R-11).
    expect(ISSUE_REGISTERED).toBe(ISSUE_REQUEST_REGISTERED);

    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOR`,
        production_plan_id: ids.productionPlan,
        routing_operation_id: ids.routingOperation,
        item_id: ids.item,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'PLANNED',
        // 배포 전제 — 라인이 비면 `:release` 가 400 이다(omf-all-around#36).
        production_line_id: ids.productionLine,
        default_wip_location_id: ids.location,
        default_fg_location_id: ids.location,
        default_scrap_location_id: ids.location,
      },
    });
    await request(app.getHttpServer())
      .post(`/api/production/work-orders/${Number(workOrder.work_order_id)}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: 100 })
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(workOrder.work_order_id)}&statusCode=REGISTERED`)
      .set('Cookie', cookie)
      .expect(200);
    // 'REQUESTED' 로 서면 이 필터가 자동 발행 건을 못 찾는다 — 그것이 정정의 이유다(§4-3).
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].statusCode).toBe(ISSUE_REQUEST_REGISTERED);
  });

  it('요청을 발행하면 201 과 상세가 온다', async () => {
    const validate = validator('POST /logistics/material-issue-requests', 201);

    const response = await post(createBody()).expect(201);

    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.materialIssueRequest).toMatchObject({
      workOrderId: Number(ids.postWorkOrder),
      destinationLocationId: Number(ids.location),
      statusCode: ISSUE_REQUEST_REGISTERED,
      reasonCode: 'URGENT_WO_RESPONSE',
      remarks: '라인 정지로 추가 소요',
    });
    // 주체는 세션 계정이다 — 자동 발행과 같은 축이다(R-12).
    expect(response.body.materialIssueRequest.requestedBy).toBeGreaterThan(0);
    // 채번은 DB 에 등재된 `MIR-{YYYYMMDD}-{SEQ4}` 규칙이다(§4-1).
    expect(response.body.materialIssueRequest.issueRequestNo).toMatch(/^MIR-20260907-/);
    // 라인 번호는 서버가 본문 순서대로 1..M 으로 매긴다.
    expect(response.body.lines.map((line: { lineNo: number }) => line.lineNo)).toEqual([1, 2]);
    expect(response.body.lines[1]).toMatchObject({
      itemId: Number(ids.componentItemB),
      requestedQty: 7,
      bomComponentId: Number(ids.bomComponentB),
      issuedQty: 0,
    });
  });

  it('같은 Idempotency-Key 재전송이 요청을 두 벌 만들지 않는다', async () => {
    const key = randomUUID();
    const body = createBody();
    const before = await prisma.material_issue_request.count({
      where: { work_order_id: ids.postWorkOrder },
    });

    const first = await post(body, key).expect(201);
    const again = await post(body, key).expect(201);

    expect(again.body.materialIssueRequest.materialIssueRequestId).toBe(
      first.body.materialIssueRequest.materialIssueRequestId,
    );
    const after = await prisma.material_issue_request.count({
      where: { work_order_id: ids.postWorkOrder },
    });
    expect(after - before).toBe(1);
  });

  it('⛔ 요청 발행이 inventory_reservation 을 만들지 않는다', async () => {
    // 예약을 «거는» 자리를 계약이 정하지 않았다 — 지어내지 않는다(§5 · 문의 045).
    await post(createBody()).expect(201);

    expect(
      await prisma.inventory_reservation.count({ where: { warehouse_id: ids.warehouse } }),
    ).toBe(0);
    // 피킹 지시도 마찬가지다 — 만드는 오퍼레이션이 계약에 0건이다.
    expect(
      await prisma.picking_order.count({ where: { warehouse_id: ids.warehouse } }),
    ).toBe(1);
  });

  it('⛔ 응답에 ETag 가 없다', async () => {
    // 계약 201 에 `headers` 가 없다 — `runVersioned` 를 쓰지 않는다(§4-7 · R-1 표).
    // ⚠ Express 가 본문 해시로 붙이는 약한 ETag(`W/"…"`)는 «잠금 토큰이 아니다» —
    //    `setEtag` 가 내리는 것은 `version_no` 숫자다(`optimistic-lock.ts:20`).
    const response = await post(createBody()).expect(201);

    expect(parseIfMatch(String(response.headers.etag ?? ''))).toBeNull();
    // If-Match 는 「선택」이라 받되 무시한다 — 400 도 내지 않는다(I-7 §4-6).
    const withStale = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '99')
      .send(createBody())
      .expect(201);
    expect(parseIfMatch(String(withStale.headers.etag ?? ''))).toBeNull();
  });

  it('무권한 사용자는 403', async () => {
    // 미등록이면 `PermissionGuard` 가 던져 500 이다 — 403 이 `derived-permissions.ts:175` 의 증거다.
    const response = await request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send(createBody());

    expect(response.status).toBe(403);
  });

  /** 계약 `MaterialIssueRequestCreate` — required 5 + 선택 3 전건. */
  function createBody(): Record<string, unknown> {
    return {
      workOrderId: Number(ids.postWorkOrder),
      destinationLocationId: Number(ids.location),
      requiredAt: '2026-09-08T01:00:00.000Z',
      reasonCode: 'URGENT_WO_RESPONSE',
      remarks: '라인 정지로 추가 소요',
      lines: [
        { itemId: Number(ids.componentItemA), requestedQty: 12, uomId: Number(ids.uom) },
        {
          itemId: Number(ids.componentItemB),
          requestedQty: 7,
          uomId: Number(ids.uom),
          bomComponentId: Number(ids.bomComponentB),
        },
      ],
      businessDate: '2026-09-07',
      occurredAt: '2026-09-07T03:00:00.000Z',
    };
  }

  function post(body: Record<string, unknown>, key = randomUUID()) {
    return request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body);
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '출고요청검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '출고요청검사사업부',
      },
    });
    ids.businessUnit = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '출고요청검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;
    // omf-all-around#36 — 배포는 같은 공장의 생산라인을 요구한다.
    ids.productionLine = (
      await prisma.production_line.create({
        data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '출고요청검사라인' },
      })
    ).production_line_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '출고요청검사완제품',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;
    for (const [suffix, name] of [
      ['A', '원자재갑'],
      ['B', '원자재을'],
    ]) {
      const created = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-CI${suffix}`,
          item_name: name,
          item_type_code: 'RAW_MATERIAL',
          base_uom_id: uom.uom_id,
        },
      });
      if (suffix === 'A') ids.componentItemA = created.item_id;
      else ids.componentItemB = created.item_id;
    }

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MOLDING' },
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
        operation_name: '사출',
      },
    });
    ids.routingOperation = operation.routing_operation_id;

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
    ids.bom = bom.bom_id;
    // 구성 4행 — 이 공정의 A 둘(합쳐진다) · B 하나 · 공정 미지정 A 하나(안 담긴다).
    const componentB = await prisma.bom_component.create({
      data: {
        bom_id: bom.bom_id,
        component_item_id: ids.componentItemB,
        routing_operation_id: operation.routing_operation_id,
        required_qty: 0.5,
        // 스크랩률이 있어도 소요에 곱하지 않는다(문의 037 · R-18).
        scrap_rate: 0.05,
        uom_id: uom.uom_id,
        sequence_no: 2,
      },
    });
    ids.bomComponentB = componentB.bom_component_id;
    await prisma.bom_component.createMany({
      data: [
        { bom_id: bom.bom_id, component_item_id: ids.componentItemA, routing_operation_id: operation.routing_operation_id, required_qty: 2, uom_id: uom.uom_id, sequence_no: 1 },
        { bom_id: bom.bom_id, component_item_id: ids.componentItemA, routing_operation_id: operation.routing_operation_id, required_qty: 1, uom_id: uom.uom_id, sequence_no: 3 },
        { bom_id: bom.bom_id, component_item_id: ids.componentItemA, routing_operation_id: null, required_qty: 3, uom_id: uom.uom_id, sequence_no: 4 },
      ],
    });

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '출고요청검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    ids.warehouse = warehouse.warehouse_id;
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '출고요청검사위치',
        location_type_code: 'BIN',
      },
    });
    ids.location = location.location_id;

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
        plan_date: new Date('2026-09-06T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    ids.productionPlan = plan.production_plan_id;
    const workOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'RELEASED',
        default_wip_location_id: location.location_id,
      },
    });
    ids.workOrder = workOrder.work_order_id;
    // 발행 `POST` 전용 W/O — 조회 목록의 PK 역순 단언을 흔들지 않으려고 축을 가른다.
    const postWorkOrder = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOP`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'RELEASED',
        default_wip_location_id: location.location_id,
      },
    });
    ids.postWorkOrder = postWorkOrder.work_order_id;

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: ids.componentItemA,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    ids.lot = lot.lot_id;

    firstRequestId = await insertRequest(1, 'POSTED', [{ item: ids.componentItemA, qty: 10 }]);
    detailRequestId = await insertRequest(2, ISSUE_REQUEST_REGISTERED, [
      { item: ids.componentItemA, qty: 200, bomComponentId: null },
      { item: ids.componentItemB, qty: 50, bomComponentId: null },
    ]);
    await insertIssued(firstRequestId);
  }

  /** `material_issue_request` 1행 + 라인 N행. `POST` 는 PR ③ 몫이라 직접 INSERT 한다. */
  async function insertRequest(
    seq: number,
    statusCode: string,
    lines: { item: bigint; qty: number; bomComponentId?: bigint | null }[],
  ): Promise<number> {
    const header = await prisma.material_issue_request.create({
      data: {
        issue_request_no: `${PREFIX}-MIR-${seq}`,
        work_order_id: ids.workOrder,
        destination_location_id: ids.location,
        status_code: statusCode,
      },
    });
    await prisma.material_issue_request_line.createMany({
      data: lines.map((line, index) => ({
        material_issue_request_id: header.material_issue_request_id,
        line_no: index + 1,
        item_id: line.item,
        requested_qty: line.qty,
        uom_id: ids.uom,
        bom_component_id: line.bomComponentId ?? null,
      })),
    });
    return Number(header.material_issue_request_id);
  }

  /**
   * 기출고 픽스처 — **헤더 축**(R-18). 전기된 출고 1건(20)과 취소된 출고 1건(999)을 심어
   * `status_code='POSTED'` 만 세는지 가른다.
   */
  async function insertIssued(materialIssueRequestId: number): Promise<void> {
    const order = await prisma.picking_order.create({
      data: {
        picking_order_no: `${PREFIX}-PICK`,
        picking_type_code: 'MATERIAL',
        source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
        source_document_id: BigInt(materialIssueRequestId),
        warehouse_id: ids.warehouse,
        // ⛔ 서버가 이 값을 판정에 쓰지 않는다 — `src/` 에 상수를 두지 않는다(R-10).
        status_code: 'REGISTERED',
      },
    });
    for (const [seq, [statusCode, qty]] of [
      ['POSTED', 20],
      ['CANCELLED', 999],
    ].entries()) {
      const issue = await prisma.goods_issue.create({
        data: {
          goods_issue_no: `${PREFIX}-GI-${seq}`,
          issue_type_code: 'PRODUCTION',
          source_document_type_code: 'PICKING_ORDER',
          source_document_id: order.picking_order_id,
          source_warehouse_id: ids.warehouse,
          issued_at: new Date('2026-05-04T02:00:00.000Z'),
          status_code: statusCode as string,
        },
      });
      await prisma.goods_issue_line.create({
        data: {
          goods_issue_id: issue.goods_issue_id,
          line_no: 1,
          item_id: ids.componentItemA,
          // `goods_issue_line.lot_id` 는 NOT NULL 이라 LOT 이 필수다(R-24 ⓔ).
          lot_id: ids.lot,
          issue_qty: qty as number,
          uom_id: ids.uom,
          source_location_id: ids.location,
        },
      });
    }
  }

  async function makeUser(): Promise<void> {
    cookie = await login(LOGIN_ID, ROLE, PERMISSIONS);
    noPermCookie = await login(NO_PERM_LOGIN_ID, NO_PERM_ROLE, ['W-02-04']);
  }

  async function login(loginId: string, roleCode: string, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '출고요청검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({
      data: { role_code: roleCode, role_name: '출고요청검사용' },
    });
    await prisma.role_permission.createMany({
      data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** §11-1 정리 순서 — 출고 → 피킹 → 요청 → LOT → W/O → 계획 → BOM → 마스터. */
  async function cleanup(): Promise<void> {
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    const orders = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM logistics.goods_issue_line WHERE item_id IN (${items})`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.picking_order WHERE picking_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.material_issue_request_line
        WHERE material_issue_request_id IN (SELECT material_issue_request_id
               FROM logistics.material_issue_request WHERE work_order_id IN (${orders}))`,
      `DELETE FROM logistics.material_issue_request WHERE work_order_id IN (${orders})`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      // `:release` 가 뽑는 MES LOT 번호는 접두어를 안 따른다 — 원천으로 지운다.
      `DELETE FROM trace.lot WHERE source_type_code = 'WORK_ORDER' AND source_id IN (${orders})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.production_plan WHERE plan_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.production_order WHERE production_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.bom_component
        WHERE bom_id IN (SELECT bom_id FROM planning.bom WHERE bom_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.bom WHERE bom_code LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation
        WHERE routing_id IN (SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%')`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.production_line WHERE line_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of [LOGIN_ID, NO_PERM_LOGIN_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    await prisma.role_permission.deleteMany({
      where: { role: { role_code: { in: [ROLE, NO_PERM_ROLE] } } },
    });
    await prisma.role.deleteMany({ where: { role_code: { in: [ROLE, NO_PERM_ROLE] } } });
  }
});
