/**
 * 생산창고 입고 조회 2건 — `GET /logistics/shopfloor-receipts` · `/{shopfloorReceiptId}`.
 * 소유 화면 `P-02-03`(I-9.md R-12). PR ②(`POST`)가 이 파일에 케이스 13건을 더한다.
 *
 * ⭐ 마스터 사슬은 `logistics-material-issue-request.e2e-spec.ts:520~549` 를 복제한다 —
 * `production_order → production_plan(bom·routing) → work_order.production_plan_id`.
 * 피킹 e2e 의 사슬(`logistics-picking.e2e-spec.ts:517~613`)은 `production_plan` 이 없어
 * `plantId` 를 못 풀므로 여기선 못 쓴다(I-9.md R-14 ⓐ).
 *
 * ⭐ 출고는 `insertGoodsIssue()` 가 **직접 INSERT** 한다(`status_code='POSTED'` ·
 * `source_document_type_code='PICKING_ORDER'` · 도착지 두 칸 널) — `goods_issue_line`
 * 의 `inventory_transaction_line_id` 가 nullable 이라 전기 없이도 `POSTED` 전표를 세울 수
 * 있다(I-9.md §7-1). 수령 전표도 `insertShopfloorReceipt()` 가 직접 INSERT 한다
 * (`status_code='REGISTERED'` 리터럴 — 이 전표는 원장을 안 지나 `POSTED` 로 못 옮긴다).
 *
 * ⚠ 다른 스위트와 같은 DB 를 쓰므로 정리는 접두어(`SRE2E`)로만 한다. ⛔ TRUNCATE 금지 —
 * 이 스위트는 원장 행을 한 건도 안 만들어 필요가 없고, 쓰면 동시 실행 스위트의 원장만
 * 망가뜨린다(I-8.md §11-3 · I-9.md §7-2).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { parseIfMatch } from '../src/common/optimistic-lock';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-sre-probe';
const PASSWORD = 'SRE-생산창고입고-비밀번호';
const PREFIX = 'SRE2E';
const ROLE = 'E2E_SRE';
/** 조회 2건은 계약이 403 을 미선언 — 그래도 세션은 필요하다(전역 인증 가드). */
const PERMISSIONS = ['P-02-03'];
const BASE = '/api/logistics/shopfloor-receipts';

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

interface LineBody {
  shopfloorReceiptLineId: number;
  itemId: number;
  lotId: number;
  itemCode: string;
  itemName: string;
  lotNo: string;
  issuedQty: number;
  receivedQty: number;
  varianceQty: number;
}

interface ReceiptBody {
  shopfloorReceiptId: number;
  goodsIssueId: number;
  workOrderId: number;
  statusCode: string;
  lines: LineBody[];
}

describe('생산창고 입고 조회 2건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n,
    businessUnit: 0n,
    uom: 0n,
    item: 0n,
    componentItem: 0n,
    warehouse: 0n,
    location: 0n,
    process: 0n,
    routing: 0n,
    routingOperation: 0n,
    bom: 0n,
    productionOrder: 0n,
    productionPlan: 0n,
    workOrderA: 0n,
    workOrderB: 0n,
    lotA: 0n,
    lotB: 0n,
  };

  let goodsIssueAId: number;
  let goodsIssueALine1Id: number;
  let goodsIssueALine2Id: number;

  /** W/O A 의 출고를 받은 수령 전표 — 라인 둘(itemCode·itemName·lotNo 검증도 여기서). */
  let receivedId: number;
  let receivedLine1Id: number;
  let receivedLine2Id: number;
  let giSeq = 0;

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

  it('목록이 workOrderId 로 걸러진다', async () => {
    const forA = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/shopfloor-receipts');
    expect(validate(forA.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(forA.body.items.map((row: ReceiptBody) => row.shopfloorReceiptId)).toEqual([receivedId]);

    const forB = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderB)}`)
      .set('Cookie', cookie)
      .expect(200);
    // W/O B 의 출고는 수령 전표가 없다 — 빈 목록이다.
    expect(forB.body.items).toEqual([]);
  });

  it('목록이 goodsIssueId·statusCode 로 걸러진다', async () => {
    const byIssue = await request(app.getHttpServer())
      .get(`${BASE}?goodsIssueId=${goodsIssueAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byIssue.body.items.map((row: ReceiptBody) => row.shopfloorReceiptId)).toEqual([receivedId]);

    const matched = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}&statusCode=REGISTERED`)
      .set('Cookie', cookie)
      .expect(200);
    expect(matched.body.items.map((row: ReceiptBody) => row.shopfloorReceiptId)).toEqual([receivedId]);

    // 문자 그대로 대조한다 — 4값 목록 밖이어도 400 이 아니라 빈 목록이다(§4-1).
    const unmatched = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}&statusCode=POSTED`)
      .set('Cookie', cookie)
      .expect(200);
    expect(unmatched.body.items).toEqual([]);
  });

  it('⭐ 목록 항목이 lines 를 함께 싣는다(1+N 회피)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}`)
      .set('Cookie', cookie)
      .expect(200);
    const item = response.body.items[0] as ReceiptBody;
    expect(item.lines).toHaveLength(2);
    expect(item.lines.map((line) => line.shopfloorReceiptLineId)).toEqual([
      receivedLine1Id,
      receivedLine2Id,
    ]);
  });

  it('목록 라인이 itemCode·itemName·lotNo 를 채운다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}`)
      .set('Cookie', cookie)
      .expect(200);
    const [line] = (response.body.items[0] as ReceiptBody).lines;
    // 수령 라인의 품목은 «투입 원자재»다 — `item_id` 가 완제품이 아니라 `componentItem` 축이다.
    expect(line).toMatchObject({
      itemCode: `${PREFIX}-CI`,
      itemName: '생산창고입고검사원자재',
      lotNo: `${PREFIX}-LOT-A`,
    });
  });

  it('상세가 라인을 PK 오름차순으로 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${receivedId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.lines.map((line: LineBody) => line.shopfloorReceiptLineId)).toEqual([
      receivedLine1Id,
      receivedLine2Id,
    ]);
  });

  it('⭐ 상세가 lines 를 바깥과 shopfloorReceipt 안 두 곳에 같은 값으로 낸다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/${receivedId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /logistics/shopfloor-receipts/{shopfloorReceiptId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    expect(response.body.lines).toEqual(response.body.shopfloorReceipt.lines);
    expect(response.body.shopfloorReceipt).toMatchObject({
      shopfloorReceiptId: receivedId,
      goodsIssueId: goodsIssueAId,
      workOrderId: Number(ids.workOrderA),
      statusCode: 'REGISTERED',
      // 널이어도 키를 생략하지 않는다(R-20).
      receivedBy: null,
    });
    // GENERATED STORED — 차이 없는 라인은 0 이다(§4-4).
    expect(response.body.lines[0].varianceQty).toBe(0);
  });

  it('없는 수령 전표는 404', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/${receivedId + 987654}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⛔ 조회 응답에 ETag 가 없다', async () => {
    // 계약 200 에 `headers` 가 없다 — `setEtag`·`runVersioned` 를 안 부른다(§1-1).
    // ⚠ Express 가 본문 해시로 붙이는 약한 ETag(`W/"…"`)는 «잠금 토큰이 아니다» —
    //    `parseIfMatch` 가 그 모양을 못 읽는 것으로 「안 내렸다」를 잰다(MIR e2e 선례).
    const list = await request(app.getHttpServer())
      .get(`${BASE}?workOrderId=${Number(ids.workOrderA)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(parseIfMatch(String(list.headers.etag ?? ''))).toBeNull();

    const detail = await request(app.getHttpServer())
      .get(`${BASE}/${receivedId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(parseIfMatch(String(detail.headers.etag ?? ''))).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '생산창고입고검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '생산창고입고검사사업부',
      },
    });
    ids.businessUnit = unit.business_unit_id;
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '생산창고입고검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '생산창고입고검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.item = item.item_id;
    const component = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-CI`,
        item_name: '생산창고입고검사원자재',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ids.componentItem = component.item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MOLDING' },
    });
    ids.process = process.process_id;
    const routing = await prisma.routing.create({
      data: {
        item_id: item.item_id,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'ACTIVE',
      },
    });
    ids.routing = routing.routing_id;
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

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '생산창고입고검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    ids.warehouse = warehouse.warehouse_id;
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '생산창고입고검사위치',
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
    ids.productionOrder = order.production_order_id;
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

    const workOrderA = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOA`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'RELEASED',
        default_wip_location_id: location.location_id,
      },
    });
    ids.workOrderA = workOrderA.work_order_id;
    // 목록 필터 축을 가르는 둘째 W/O — 이 축의 출고는 미수령으로 남는다.
    const workOrderB = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WOB`,
        production_plan_id: plan.production_plan_id,
        routing_operation_id: operation.routing_operation_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'RELEASED',
        default_wip_location_id: location.location_id,
      },
    });
    ids.workOrderB = workOrderB.work_order_id;

    const lotA = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-A`,
        item_id: ids.componentItem,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    ids.lotA = lotA.lot_id;
    const lotB = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-B`,
        item_id: ids.componentItem,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 2,
        status_code: 'NORMAL',
      },
    });
    ids.lotB = lotB.lot_id;

    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: location.location_id,
        item_id: ids.componentItem,
        lot_id: lotA.lot_id,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: 100,
        uom_id: uom.uom_id,
      },
    });

    // 출고 A — 라인 둘, W/O A 가 받는다.
    const issueA = await insertGoodsIssue({
      warehouseId: ids.warehouse,
      locationId: ids.location,
      lines: [
        { itemId: ids.componentItem, lotId: ids.lotA, uomId: ids.uom, issueQty: 100 },
        { itemId: ids.componentItem, lotId: ids.lotB, uomId: ids.uom, issueQty: 50 },
      ],
    });
    goodsIssueAId = issueA.goodsIssueId;
    [goodsIssueALine1Id, goodsIssueALine2Id] = issueA.lineIds;

    // W/O B 는 수령 전표가 아예 없다 — `work_order_id` 필터가 헤더 칸이라 출고 없이도
    // 목록 필터 축을 가른다(§4-1 · 이 축은 `shopfloor_receipt` 헤더에만 산다).

    const receipt = await insertShopfloorReceipt({
      goodsIssueId: goodsIssueAId,
      workOrderId: ids.workOrderA,
      destinationLocationId: ids.location,
      lines: [
        {
          goodsIssueLineId: goodsIssueALine1Id,
          itemId: ids.componentItem,
          lotId: ids.lotA,
          uomId: ids.uom,
          issuedQty: 100,
          receivedQty: 100,
        },
        {
          goodsIssueLineId: goodsIssueALine2Id,
          itemId: ids.componentItem,
          lotId: ids.lotB,
          uomId: ids.uom,
          issuedQty: 50,
          receivedQty: 40,
          varianceReasonCode: 'SPILL',
        },
      ],
    });
    receivedId = receipt.shopfloorReceiptId;
    [receivedLine1Id, receivedLine2Id] = receipt.lineIds;
  }

  /**
   * `goods_issue` 헤더 1 + 라인 N — **직접 INSERT**. `source_document_type_code='PICKING_ORDER'`
   * · `source_document_id` 는 FK 없는 축이라 아무 정수 · 도착지 두 칸은 **둘 다 널**
   * (`ck_goods_issue_destination`). ② 가 이 헬퍼를 그대로 쓴다(브리프 인자 여유).
   */
  async function insertGoodsIssue(args: {
    warehouseId: bigint;
    locationId: bigint;
    lines: { itemId: bigint; lotId: bigint; uomId: bigint; issueQty: number }[];
    statusCode?: string;
  }): Promise<{ goodsIssueId: number; lineIds: number[] }> {
    giSeq += 1;
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI-${giSeq}`,
        issue_type_code: 'PRODUCTION',
        source_document_type_code: 'PICKING_ORDER',
        source_document_id: 1,
        source_warehouse_id: args.warehouseId,
        issued_at: new Date('2026-09-06T02:00:00.000Z'),
        status_code: args.statusCode ?? 'POSTED',
      },
    });
    const lineIds: number[] = [];
    for (const [index, line] of args.lines.entries()) {
      const created = await prisma.goods_issue_line.create({
        data: {
          goods_issue_id: issue.goods_issue_id,
          line_no: index + 1,
          item_id: line.itemId,
          lot_id: line.lotId,
          issue_qty: line.issueQty,
          uom_id: line.uomId,
          source_location_id: args.locationId,
        },
      });
      lineIds.push(Number(created.goods_issue_line_id));
    }
    return { goodsIssueId: Number(issue.goods_issue_id), lineIds };
  }

  /**
   * `shopfloor_receipt` 헤더 1 + 라인 N — **직접 INSERT**. `status_code='REGISTERED'`
   * 리터럴(이 전표는 원장을 안 지나 `POSTED` 로 못 옮긴다 — I-9.md §3-5). `variance_qty`
   * 는 GENERATED 라 **넣지 않는다**.
   */
  async function insertShopfloorReceipt(args: {
    goodsIssueId: number;
    workOrderId: bigint;
    destinationLocationId: bigint;
    lines: {
      goodsIssueLineId: number;
      itemId: bigint;
      lotId: bigint;
      uomId: bigint;
      issuedQty: number;
      receivedQty: number;
      varianceReasonCode?: string;
    }[];
  }): Promise<{ shopfloorReceiptId: number; lineIds: number[] }> {
    const receipt = await prisma.shopfloor_receipt.create({
      data: {
        shopfloor_receipt_no: `${PREFIX}-SR-${args.goodsIssueId}`,
        goods_issue_id: args.goodsIssueId,
        work_order_id: args.workOrderId,
        destination_location_id: args.destinationLocationId,
        received_at: new Date('2026-09-06T03:00:00.000Z'),
        status_code: 'REGISTERED',
      },
    });
    const lineIds: number[] = [];
    for (const line of args.lines) {
      const created = await prisma.shopfloor_receipt_line.create({
        data: {
          shopfloor_receipt_id: receipt.shopfloor_receipt_id,
          goods_issue_line_id: line.goodsIssueLineId,
          item_id: line.itemId,
          lot_id: line.lotId,
          issued_qty: line.issuedQty,
          received_qty: line.receivedQty,
          uom_id: line.uomId,
          variance_reason_code: line.varianceReasonCode ?? null,
        },
      });
      lineIds.push(Number(created.shopfloor_receipt_line_id));
    }
    return { shopfloorReceiptId: Number(receipt.shopfloor_receipt_id), lineIds };
  }

  async function makeUser(): Promise<void> {
    cookie = await login(LOGIN_ID, ROLE, PERMISSIONS);
  }

  async function login(loginId: string, roleCode: string, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '생산창고입고검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const role = await prisma.role.create({
      data: { role_code: roleCode, role_name: '생산창고입고검사용' },
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

  /** §7-2 정리 순서 — TRUNCATE 금지(원장 행을 안 만든다). `numbering_*` 는 지우지 않는다. */
  async function cleanup(): Promise<void> {
    const boms = `SELECT bom_id FROM planning.bom WHERE bom_code LIKE '${PREFIX}%'`;
    const routings = `SELECT routing_id FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`;
    const items = `SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM logistics.shopfloor_receipt_line
        WHERE shopfloor_receipt_id IN (
          SELECT shopfloor_receipt_id FROM logistics.shopfloor_receipt
          WHERE shopfloor_receipt_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.shopfloor_receipt WHERE shopfloor_receipt_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_issue_line
        WHERE goods_issue_id IN (
          SELECT goods_issue_id FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%')`,
      `DELETE FROM logistics.goods_issue WHERE goods_issue_no LIKE '${PREFIX}%'`,
      `DELETE FROM inventory.inventory_balance WHERE item_id IN (${items})`,
      `DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.production_plan WHERE plan_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.production_order WHERE production_order_no LIKE '${PREFIX}%'`,
      `DELETE FROM planning.routing_operation WHERE routing_id IN (${routings})`,
      `DELETE FROM planning.routing WHERE routing_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.process WHERE process_code LIKE '${PREFIX}%'`,
      `DELETE FROM planning.bom_component WHERE bom_id IN (${boms})`,
      `DELETE FROM planning.bom WHERE bom_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    for (const loginId of [LOGIN_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!target) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    await prisma.role_permission.deleteMany({ where: { role: { role_code: ROLE } } });
    await prisma.role.deleteMany({ where: { role_code: ROLE } });
  }
});
