/**
 * 배포·출고요청 발행이 만드는 자재 피킹 지시(P-12 · 문의 045 해소). 배정 규칙의 경계 전수는
 * `src/core/picking/allocation.spec.ts` 가 보고, 여기서는 실제 표·트랜잭션·단말 조회가 이어지는지 본다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'PKE2E';
const LOGIN_ID = 'e2e-picking-probe';
const PASSWORD = 'PK-피킹-비밀번호';
const ROLE = 'E2E_PICKING';

describe('배포 → 자재 출고요청 → 피킹 지시 (P-12 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let mobileToken: string;
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

  it('배포 — 창고별 헤더에 FIFO·FEFO 로 나눠 담고, 보류 LOT·자재창고 밖 재고는 안 쓴다', async () => {
    const workOrderId = await workOrder(ids.operation1);
    await release(workOrderId).expect(200);

    const [issue] = await prisma.material_issue_request.findMany({ where: { work_order_id: workOrderId } });
    const orders = await prisma.picking_order.findMany({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: issue.material_issue_request_id },
      include: { picking_line: { orderBy: { line_no: 'asc' } } },
      orderBy: { warehouse_id: 'asc' },
    });
    expect(orders.map((order) => order.warehouse_id)).toEqual([ids.materialWh1, ids.materialWh2]);
    for (const order of orders) {
      expect(order.picking_order_no).toMatch(/^PK-\d{8}-\d{4}$/);
      expect(order).toMatchObject({ picking_type_code: 'MATERIAL', status_code: 'REGISTERED', assigned_worker_id: ids.worker });
    }
    const lines = (index: number) =>
      orders[index].picking_line.map((line) => [line.line_no, line.lot_id, line.planned_qty.toNumber(), line.inventory_reservation_id]);
    // A 소요 200: 보류 LOT(가장 오래됨)은 건너뛰고 생성 시각이 이른 LOT 부터 150 + 50.
    expect(lines(0)).toEqual([[1, ids.lotAEarly, 150, null], [2, ids.lotALate, 50, null]]);
    // B(FEFO) 소요 100: 기한이 가까운 LOT 60 → 먼 LOT 40.
    expect(lines(1)).toEqual([[1, ids.lotBSoon, 60, null], [2, ids.lotBLate, 40, null]]);
    // C 는 일반창고에만 재고가 있어 결품이다 — 어느 헤더에도 라인이 없다.
    expect(orders.flatMap((order) => order.picking_line).some((line) => line.item_id === ids.itemC)).toBe(false);
    // ⓑ 예약을 걸지 않는다 — 잔량 칸이 그대로다.
    const touched = await prisma.inventory_balance.count({
      where: { plant_id: ids.plant, OR: [{ reserved_qty: { gt: 0 } }, { picked_qty: { gt: 0 } }] },
    });
    expect(touched).toBe(0);

    const listed = await request(app.getHttpServer())
      .get('/api/logistics/picking-orders')
      .query({ assignedWorkerId: Number(ids.worker), statusCode: 'REGISTERED' })
      .set('Authorization', `Bearer ${mobileToken}`)
      .expect(200);
    expect(listed.body.items.map((item: { pickingOrderId: number }) => BigInt(item.pickingOrderId)))
      .toEqual(expect.arrayContaining(orders.map((order) => order.picking_order_id)));
    await request(app.getHttpServer())
      .get(`/api/logistics/material-issue-requests/${issue.material_issue_request_id}`)
      .set('Authorization', `Bearer ${mobileToken}`)
      .expect(200);
  });

  it('배포 — 모든 라인이 결품이면 출고요청만 서고 피킹 헤더는 없다', async () => {
    const workOrderId = await workOrder(ids.operation2);
    await release(workOrderId).expect(200);

    const issues = await prisma.material_issue_request.findMany({ where: { work_order_id: workOrderId } });
    expect(issues).toHaveLength(1);
    expect(await prisma.picking_order.count({ where: { source_document_id: issues[0].material_issue_request_id } })).toBe(0);
  });

  it('수동 발행 — 같은 규칙으로 피킹 지시를 만들고 W/O 책임 작업자에게 배정한다', async () => {
    const workOrderId = await workOrder(ids.operation1);
    const response = await request(app.getHttpServer())
      .post('/api/logistics/material-issue-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        workOrderId: Number(workOrderId),
        destinationLocationId: Number(ids.wipLocation),
        lines: [{ itemId: Number(ids.itemA), requestedQty: 10, uomId: Number(ids.uom) }],
        businessDate: '2026-09-15',
        occurredAt: '2026-09-15T03:00:00.000Z',
      })
      .expect(201);

    const orders = await prisma.picking_order.findMany({
      where: { source_document_id: BigInt(response.body.materialIssueRequest.materialIssueRequestId) },
      include: { picking_line: true },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ warehouse_id: ids.materialWh1, assigned_worker_id: ids.worker });
    expect(orders[0].picking_line.map((line) => [line.lot_id, line.planned_qty.toNumber()])).toEqual([[ids.lotAEarly, 10]]);
  });

  function release(workOrderId: bigint) {
    return request(app.getHttpServer())
      .post(`/api/production/work-orders/${workOrderId}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: 100 });
  }

  async function workOrder(routingOperationId: bigint): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO${++seq}`,
        production_plan_id: ids.plan,
        routing_operation_id: routingOperationId,
        item_id: ids.itemFg,
        order_qty: 100,
        uom_id: ids.uom,
        status_code: 'PLANNED',
        production_line_id: ids.line,
        responsible_worker_id: ids.worker,
        default_wip_location_id: ids.wipLocation,
        default_fg_location_id: ids.wipLocation,
        default_scrap_location_id: ids.wipLocation,
      },
    });
    return row.work_order_id;
  }

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '피킹검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '피킹검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '피킹검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.plant = plant.plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    const item = (code: string, type: string, fifo = 'FIFO') =>
      prisma.item.create({
        data: { item_code: `${PREFIX}-${code}`, item_name: code, item_type_code: type, base_uom_id: ids.uom, fifo_policy_code: fifo },
      });
    ids.itemFg = (await item('FG', 'FINISHED')).item_id;
    ids.itemA = (await item('A', 'RAW_MATERIAL')).item_id;
    ids.itemB = (await item('B', 'RAW_MATERIAL', 'FEFO')).item_id;
    ids.itemC = (await item('C', 'RAW_MATERIAL')).item_id;

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    for (const [key, seqNo] of [['operation1', 10], ['operation2', 20]] as const) {
      ids[key] = (await prisma.routing_operation.create({
        data: { routing_id: routing.routing_id, operation_seq: seqNo, process_id: process.process_id, operation_name: key },
      })).routing_operation_id;
    }
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: ids.itemFg, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.uom,
      },
    });
    await prisma.bom_component.createMany({
      data: [
        [ids.itemA, 2, ids.operation1], [ids.itemB, 1, ids.operation1], [ids.itemC, 1, ids.operation1], [ids.itemC, 1, ids.operation2],
      ].map(([itemId, qty, operation], index) => ({
        bom_id: bom.bom_id, component_item_id: itemId as bigint, required_qty: qty as number,
        routing_operation_id: operation as bigint, uom_id: ids.uom, sequence_no: index + 1,
      })),
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
    const wip = await warehouse('WIP', 'GENERAL');
    const wh1 = await warehouse('M1', 'MATERIAL');
    const wh2 = await warehouse('M2', 'MATERIAL');
    const general = await warehouse('G1', 'GENERAL');
    ids.wipLocation = wip.locationId;
    ids.materialWh1 = wh1.warehouseId;
    ids.materialWh2 = wh2.warehouseId;

    const stock = async (at: { warehouseId: bigint; locationId: bigint }, itemId: bigint, no: string, qty: number, created: string, expiry?: string) => {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-${no}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: plant.plant_id, initial_qty: qty,
          uom_id: ids.uom, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
          created_at: new Date(created), ...(expiry === undefined ? {} : { expiry_date: new Date(expiry) }),
        },
      });
      await prisma.inventory_balance.create({
        data: {
          legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
          warehouse_id: at.warehouseId, location_id: at.locationId, item_id: itemId, lot_id: lot.lot_id,
          quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
          on_hand_qty: qty, uom_id: ids.uom,
        },
      });
      return lot.lot_id;
    };
    ids.worker = (await prisma.worker.create({
      data: { worker_no: `${PREFIX}-WK`, worker_name: '피킹검사작업자', business_unit_id: unit.business_unit_id, plant_id: plant.plant_id, status_code: 'EMPLOYED' },
    })).worker_id;
    const held = await stock(wh1, ids.itemA, 'A-HELD', 1000, '2026-08-01T00:00:00Z');
    await prisma.lot_hold.create({
      data: { lot_id: held, reason_code: 'OTHER', status_code: 'HELD', held_at: new Date(), held_worker_id: ids.worker },
    });
    ids.lotALate = await stock(wh1, ids.itemA, 'A-LATE', 100, '2026-09-05T00:00:00Z');
    ids.lotAEarly = await stock(wh1, ids.itemA, 'A-EARLY', 150, '2026-09-01T00:00:00Z');
    ids.lotBLate = await stock(wh2, ids.itemB, 'B-LATE', 80, '2026-09-01T00:00:00Z', '2026-12-31');
    ids.lotBSoon = await stock(wh2, ids.itemB, 'B-SOON', 60, '2026-09-03T00:00:00Z', '2026-10-01');
    await stock(general, ids.itemC, 'C-GENERAL', 500, '2026-09-01T00:00:00Z');

    ids.line = (await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '피킹검사라인' },
    })).production_line_id;
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        item_id: ids.itemFg, order_qty: 100, uom_id: ids.uom, status_code: 'RECEIVED',
      },
    });
    ids.plan = (await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date('2026-09-15T00:00:00.000Z'),
        planned_qty: 100, uom_id: ids.uom, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED',
      },
    })).production_plan_id;

    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-MOB`, plant_id: plant.plant_id, terminal_type_code: 'MOBILE', status_code: 'RUNNING' },
    });
    mobileToken = app.get(JwtService).sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(plant.plant_id),
    });

    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '피킹검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '피킹검사용' } });
    await prisma.role_permission.createMany({
      data: ['W-02-04', 'W-02-10'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
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
    await prisma.picking_line.deleteMany({ where: { picking_order: warehouseScope } });
    await prisma.picking_order.deleteMany({ where: warehouseScope });
    await prisma.material_issue_request_line.deleteMany({ where: { material_issue_request: workOrderScope } });
    await prisma.material_issue_request.deleteMany({ where: workOrderScope });
    await prisma.inventory_balance.deleteMany({ where: plantScope });
    await prisma.lot_hold.deleteMany({ where: { lot: plantScope } });
    await prisma.lot_lifecycle_history.deleteMany({ where: { lot: plantScope } });
    await prisma.lot.deleteMany({ where: plantScope });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.terminal.deleteMany({ where: { terminal_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
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
