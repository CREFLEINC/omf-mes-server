/**
 * 출고 지시 실행(PICK-ISSUE-01) — 피킹 출고가 «원천 전표»에 남기는 자국 셋.
 *   P-14 전량 출고면 피킹 지시를 닫는다(부분 출고면 열어 둔다)
 *   P-15 도착지를 비워 보내면 서버가 출고요청의 도착 위치로 채워 원장에 `to` 를 싣는다
 *   P-16 기출고(`material_issue_request_line.issued_qty`)를 올리고 전 라인이 다 나가면 요청을 닫는다
 * 배정 규칙 자체는 `production-work-order-picking.e2e-spec.ts` 가 본다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'PIE2E';
const LOGIN_ID = 'e2e-pick-issue-probe';
const PASSWORD = 'PI-출고-비밀번호';
const ROLE = 'E2E_PICK_ISSUE';
const BUSINESS_DATE = '2026-09-15';
const OCCURRED_AT = '2026-09-15T02:00:00.000Z';

describe('피킹 출고가 원천 전표를 닫고 기출고를 올린다 (PICK-ISSUE-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 전량 출고 — 지시가 닫히고, 도착지가 채워지고, 기출고가 오른다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    const before = { source: await onHand(ids.materialLocation), wip: await onHand(ids.wipLocation) };

    const created = await issue(order, lines).expect(201);
    expect(created.body.goodsIssue.statusCode).toBe('POSTED');

    // P-15 — 화면은 도착지를 비워 보냈고 서버가 출고요청의 도착 위치로 채운다.
    expect(created.body.goodsIssue).toMatchObject({
      destinationTypeCode: 'LOCATION',
      destinationId: Number(ids.wipLocation),
    });
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      from_location_id: ids.materialLocation,
      to_location_id: ids.wipLocation,
      to_warehouse_id: ids.wipWarehouse,
    });
    // 원장 한 «행»에 from·to 가 같이 실린다 — 행이 늘지 않고 재고가 자리를 옮긴다.
    expect(await onHand(ids.materialLocation)).toBe(before.source - 100);
    expect(await onHand(ids.wipLocation)).toBe(before.wip + 100);

    // P-14 — 전 라인이 계획 수량만큼 나갔으므로 지시가 닫힌다.
    expect((await pickingOrder(order)).status_code).toBe('POSTED');
    // P-16 — 기출고가 오르고 요청도 닫힌다.
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
      orderBy: { line_no: 'asc' },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([100]);
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('POSTED');
  });

  it('⭐ 부분 출고 — 지시가 열려 있어 나머지를 집으러 돌아올 수 있다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100, 40);

    await issue(order, lines, 40).expect(201);

    // 목록이 `statusCode=REGISTERED` 로 거르므로, 닫으면 남은 60 을 집을 길이 사라진다.
    expect((await pickingOrder(order)).status_code).toBe('REGISTERED');
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([40]);
    // 요청도 아직 안 닫힌다 — 40 < 100.
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
  });

  it('기출고 누계가 요청 수량을 넘으면 400 이다 — CHECK 위반 500 이 아니다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    const before = await onHand(ids.materialLocation);
    // 요청 수량을 낮춰 「이미 대부분 나간」 상태를 만든다 — 계획 수량 100 이 남아 있다.
    await prisma.material_issue_request_line.updateMany({
      where: { material_issue_request_id: requestId },
      data: { requested_qty: 100, issued_qty: 90 },
    });

    const rejected = await issue(order, lines).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ code: 'RANGE' });
    // 400 이면 전기 자체가 없던 일이 된다 — 재고도 지시도 그대로다.
    expect(await onHand(ids.materialLocation)).toBe(before);
    expect((await pickingOrder(order)).status_code).toBe('REGISTERED');
  });

  it('출발 == 도착이면 도착지를 채우지 않는다 — 같은 자리 왕복 원장을 만들지 않는다', async () => {
    const { order, lines } = await releaseAndPick(100, 100, ids.materialLocation);
    const before = await onHand(ids.materialLocation);

    const created = await issue(order, lines).expect(201);

    expect(created.body.goodsIssue.destinationTypeCode).toBeNull();
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger[0].to_location_id).toBeNull();
    expect(await onHand(ids.materialLocation)).toBe(before - 100);
  });

  it('⛔ 원천이 피킹 지시가 아니면 도착지를 채우지 않고 원천 전표도 안 건드린다', async () => {
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR${++seq}`, receipt_type_code: 'MATERIAL', plant_id: ids.plant,
        warehouse_id: ids.materialWarehouse, receipt_datetime: new Date(OCCURRED_AT), status_code: 'POSTED',
      },
    });
    const created = await request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'SUPPLIER_RETURN',
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: Number(receipt.goods_receipt_id),
        sourceWarehouseId: Number(ids.materialWarehouse),
        issuedAt: OCCURRED_AT,
        postImmediately: true,
        businessDate: BUSINESS_DATE,
        occurredAt: OCCURRED_AT,
        lines: [
          {
            itemId: Number(ids.item), lotId: Number(ids.lot), issueQty: 10,
            uomId: Number(ids.uom), sourceLocationId: Number(ids.materialLocation),
          },
        ],
      })
      .expect(201);

    expect(created.body.goodsIssue.destinationTypeCode).toBeNull();
    const ledger = await ledgerLines(created.body.goodsIssue.goodsIssueId);
    expect(ledger[0].to_location_id).toBeNull();
  });

  it('피킹 라인이 요청 라인을 안 가리키면 기출고를 올리지 않는다 — 짝을 지어내지 않는다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    await prisma.picking_line.updateMany({
      where: { picking_order_id: order },
      data: { material_issue_request_line_id: null },
    });

    await issue(order, lines).expect(201);

    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(requestLines.map((line) => line.issued_qty.toNumber())).toEqual([0]);
    // 요청은 안 닫히지만 지시는 닫힌다 — 두 판정의 축이 다르다(기출고 ↔ 계획 수량).
    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
    expect((await pickingOrder(order)).status_code).toBe('POSTED');
  });

  it('요청 라인이 0건이면 요청을 닫지 않는다 — 「다 나갔다」가 공허한 참이 된다', async () => {
    const { order, lines, requestId } = await releaseAndPick(100);
    await prisma.picking_line.updateMany({
      where: { picking_order_id: order },
      data: { material_issue_request_line_id: null },
    });
    await prisma.material_issue_request_line.deleteMany({
      where: { material_issue_request_id: requestId },
    });

    await issue(order, lines).expect(201);

    expect((await prisma.material_issue_request.findUniqueOrThrow({
      where: { material_issue_request_id: requestId },
    })).status_code).toBe('REGISTERED');
  });

  it('기출고 칸과 `shortage` 의 기출고가 같은 값을 낸다 — 두 벌이던 것이 한 벌이 된다(046)', async () => {
    const { order, lines, requestId, workOrderId } = await releaseAndPick(100);

    await issue(order, lines).expect(201);

    const shortage = await request(app.getHttpServer())
      .get(`/api/logistics/material-issue-requests/shortage?workOrderId=${String(workOrderId)}`)
      .set('Cookie', cookie)
      .expect(200);
    const line = shortage.body.items.find((row: { itemId: number }) => row.itemId === Number(ids.item));
    const requestLines = await prisma.material_issue_request_line.findMany({
      where: { material_issue_request_id: requestId },
    });
    expect(line.issuedQty).toBe(requestLines[0].issued_qty.toNumber());
  });

  /** 배포로 요청·지시를 만들고 라인을 계획 수량만큼(또는 `pickQty` 만큼) 집는다. */
  async function releaseAndPick(
    orderQty: number,
    pickQty?: number,
    destinationLocationId?: bigint,
  ): Promise<{ order: bigint; lines: bigint[]; requestId: bigint; workOrderId: bigint }> {
    const workOrderId = await workOrder(destinationLocationId ?? ids.wipLocation);
    await request(app.getHttpServer())
      .post(`/api/production/work-orders/${String(workOrderId)}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: orderQty })
      .expect(200);

    const requestRow = await prisma.material_issue_request.findFirstOrThrow({
      where: { work_order_id: workOrderId },
    });
    const orderRow = await prisma.picking_order.findFirstOrThrow({
      where: {
        source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
        source_document_id: requestRow.material_issue_request_id,
      },
      include: { picking_line: true },
    });
    // `:pick` 이 하는 일을 픽스처로 흉내 낸다 — 라인의 집은 양과 «잔액의 picked» 는 한 짝이다.
    // 잔액을 안 옮기면 출고의 피킹 소진이 0행을 만나 400 이 된다(`issue-posting.ts` R-4).
    for (const line of orderRow.picking_line) {
      const picked = pickQty ?? line.planned_qty.toNumber();
      await prisma.picking_line.update({
        where: { picking_line_id: line.picking_line_id },
        data: { picked_qty: picked },
      });
      await prisma.inventory_balance.updateMany({
        where: { lot_id: line.lot_id, location_id: line.location_id },
        data: { picked_qty: { increment: picked } },
      });
    }
    return {
      order: orderRow.picking_order_id,
      lines: orderRow.picking_line.map((line) => line.picking_line_id),
      requestId: requestRow.material_issue_request_id,
      workOrderId,
    };
  }

  /** 모바일 `M-01-08` 과 같은 본문 — **도착지를 비워** 보낸다. */
  function issue(orderId: bigint, pickingLineIds: bigint[], qty = 100): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        issueTypeCode: 'PRODUCTION',
        sourceDocumentTypeCode: 'PICKING_ORDER',
        sourceDocumentId: Number(orderId),
        sourceWarehouseId: Number(ids.materialWarehouse),
        issuedAt: OCCURRED_AT,
        postImmediately: true,
        businessDate: BUSINESS_DATE,
        occurredAt: OCCURRED_AT,
        lines: pickingLineIds.map((pickingLineId) => ({
          pickingLineId: Number(pickingLineId),
          itemId: Number(ids.item),
          lotId: Number(ids.lot),
          issueQty: qty,
          uomId: Number(ids.uom),
          sourceLocationId: Number(ids.materialLocation),
        })),
      });
  }

  async function ledgerLines(goodsIssueId: number): Promise<
    { from_location_id: bigint | null; to_location_id: bigint | null; to_warehouse_id: bigint | null }[]
  > {
    const transaction = await prisma.inventory_transaction.findFirstOrThrow({
      where: { source_document_type_code: 'GOODS_ISSUE', source_document_id: BigInt(goodsIssueId) },
    });
    return prisma.inventory_transaction_line.findMany({
      where: {
        inventory_transaction_id: transaction.inventory_transaction_id,
        business_date: transaction.business_date,
      },
      orderBy: { line_no: 'asc' },
      select: { from_location_id: true, to_location_id: true, to_warehouse_id: true },
    });
  }

  async function onHand(locationId: bigint): Promise<number> {
    const rows = await prisma.inventory_balance.findMany({ where: { location_id: locationId } });
    return rows.reduce((sum, row) => sum + row.on_hand_qty.toNumber(), 0);
  }

  function pickingOrder(orderId: bigint) {
    return prisma.picking_order.findUniqueOrThrow({ where: { picking_order_id: orderId } });
  }

  async function workOrder(destinationLocationId: bigint): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO${++seq}`,
        production_plan_id: ids.plan,
        routing_operation_id: ids.operation,
        item_id: ids.itemFg,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'PLANNED',
        responsible_worker_id: ids.worker,
        default_wip_location_id: destinationLocationId,
        default_fg_location_id: destinationLocationId,
        default_scrap_location_id: destinationLocationId,
      },
    });
    return row.work_order_id;
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '출고검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '출고검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '출고검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.itemFg = (await prisma.item.create({
      data: { item_code: `${PREFIX}-FG`, item_name: 'FG', item_type_code: 'FINISHED', base_uom_id: ids.uom },
    })).item_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: 'A', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom },
    })).item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    ids.operation = (await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
    })).routing_operation_id;
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: ids.itemFg, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
      },
    });
    await prisma.bom_component.create({
      data: {
        bom_id: bom.bom_id, component_item_id: ids.item, required_qty: 1,
        routing_operation_id: ids.operation, uom_id: ids.uom, sequence_no: 1,
      },
    });

    const warehouse = async (code: string, type: string) => {
      const wh = await prisma.warehouse.create({
        data: {
          plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-${code}`,
          warehouse_name: code, warehouse_type_code: type, management_level_code: 'WAREHOUSE',
        },
      });
      const location = await prisma.location.create({
        data: { warehouse_id: wh.warehouse_id, location_code: `${PREFIX}-${code}-01`, location_name: code, location_type_code: 'DEFAULT' },
      });
      return { warehouseId: wh.warehouse_id, locationId: location.location_id };
    };
    const material = await warehouse('M1', 'MATERIAL');
    const wip = await warehouse('WIP', 'GENERAL');
    ids.materialWarehouse = material.warehouseId;
    ids.materialLocation = material.locationId;
    ids.wipWarehouse = wip.warehouseId;
    ids.wipLocation = wip.locationId;

    ids.worker = (await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK`, worker_name: '출고검사작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    })).worker_id;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: plant.plant_id,
        initial_qty: 5000, uom_id: ids.uom, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
      },
    });
    ids.lot = lot.lot_id;
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        warehouse_id: material.warehouseId, location_id: material.locationId, item_id: ids.item, lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
        on_hand_qty: 5000, uom_id: ids.uom,
      },
    });

    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        item_id: ids.itemFg, order_qty: 100, uom_id: ids.uom, status_code: 'RECEIVED',
      },
    });
    ids.plan = (await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        planned_qty: 100, uom_id: ids.uom, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED',
      },
    })).production_plan_id;

    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '출고검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '출고검사용' } });
    await prisma.role_permission.createMany({
      data: ['W-02-04', 'W-02-10', 'M-01-08', 'W-01-05'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const login = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    cookie = login.headers['set-cookie'] as unknown as string[];
  }

  async function cleanup(): Promise<void> {
    const plantScope = { plant: { plant_code: { startsWith: PREFIX } } };
    const workOrderScope = { work_order: { work_order_no: { startsWith: PREFIX } } };
    const warehouseScope = { warehouse: { warehouse_code: { startsWith: PREFIX } } };
    // ⛔ 원장은 트리거가 UPDATE·DELETE 를 막아 TRUNCATE 뿐이다. `goods_issue_line
    //    .inventory_transaction_line_id` FK 때문에 CASCADE 가 출고·입고 라인까지 함께 비운다
    //    (`logistics-goods-issue.e2e-spec.ts` 선례).
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.goods_issue_line.deleteMany({ where: { item: { item_code: { startsWith: PREFIX } } } });
    await prisma.goods_issue.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: { goods_receipt_no: { startsWith: PREFIX } } } });
    await prisma.goods_receipt.deleteMany({ where: { goods_receipt_no: { startsWith: PREFIX } } });
    await prisma.picking_line.deleteMany({ where: { picking_order: warehouseScope } });
    await prisma.picking_order.deleteMany({ where: warehouseScope });
    await prisma.material_issue_request_line.deleteMany({ where: { material_issue_request: workOrderScope } });
    await prisma.material_issue_request.deleteMany({ where: workOrderScope });
    await prisma.inventory_balance.deleteMany({ where: plantScope });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: warehouseScope });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
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
