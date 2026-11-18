/**
 * W/O 배포의 자재 단위 환산 — BOM 단위(GR·EA)와 재고 단위(품목 기본 단위 KG)가 다른 자재. 환산 규칙의 경계는
 * `src/core/bom/stock-uom.spec.ts`·`src/production/work-order/release-materials.spec.ts` 가 보고, 여기서는 배포 전 조회 →
 * 확인 → 출고요청·피킹 → 품목 환산 저장·감사 기록 → 부족 조회·추가 출고 요청이 실제 표에서 같은 수량으로 이어지는지 본다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { localDate } from '../src/planning/production-plan/plan-window';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'UOME2E';
const LOGIN_ID = 'e2e-release-uom-probe';
const PASSWORD = 'UOM-환산-비밀번호';
const ROLE = 'E2E_RELEASE_UOM';
const TIMEZONE = 'Asia/Ho_Chi_Minh';

interface Requirement {
  bomComponentId: number;
  itemId: number;
  bomQty: number;
  bomUomCode: string;
  stockUomCode: string;
  stockUomScale: number;
  stockQty: number | null;
  conversionSource: string | null;
  conversionRate: number | null;
  confirmationRequired: boolean;
}

describe('W/O 배포 — 자재 출고요청 단위 환산·확인 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId: bigint;
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

  it('품목 환산 자재 — 「367 GR → 0.367 KG」를 보이고, 확인 전에는 400, 확인 뒤 0.367 KG 출고요청과 피킹 라인이 선다', async () => {
    const workOrderId = await workOrder(ids.operationResin);

    const rows = await requirements(workOrderId);
    expect(rows.map((row) => [row.itemId, row.bomQty, row.bomUomCode, row.stockQty, row.stockUomCode, row.stockUomScale, row.conversionSource, row.conversionRate, row.confirmationRequired])).toEqual([
      [Number(ids.resin), 367, 'GR', 0.367, 'KG', 3, 'ITEM', 1000, true],
      [Number(ids.bolt), 20, 'EA', 20, 'EA', 0, null, null, false],
    ]);

    const refused = await release(workOrderId, {}).expect(400);
    expect(refused.body.errors).toEqual([
      expect.objectContaining({ field: `materialUomConfirmations[bomComponentId=${rows[0].bomComponentId}].confirmed`, code: 'MATERIAL_UOM_CONFIRMATION_REQUIRED' }),
    ]);
    expect((await prisma.work_order.findUniqueOrThrow({ where: { work_order_id: workOrderId } })).status_code).toBe('PLANNED');

    await release(workOrderId, { materialUomConfirmations: [{ bomComponentId: rows[0].bomComponentId, confirmed: true }] }).expect(200);
    const [issue] = await prisma.material_issue_request.findMany({
      where: { work_order_id: workOrderId },
      include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
    });
    expect(issue.material_issue_request_line.map((line) => [line.item_id, line.uom_id, line.requested_qty.toNumber()])).toEqual([
      [ids.resin, ids.kg, 0.367],
      [ids.bolt, ids.ea, 20],
    ]);
    const picking = await prisma.picking_line.findMany({
      where: { picking_order: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: issue.material_issue_request_id } },
    });
    expect(picking.filter((line) => line.item_id === ids.resin).map((line) => [line.lot_id, line.uom_id, line.planned_qty.toNumber()])).toEqual([
      [ids.resinLot, ids.kg, 0.367],
    ]);
  });

  it('환산 없는 자재 — 비율 없이는 400, 비율을 넣으면 배포되고 품목 환산·감사 기록이 남아 다음 배포에는 품목 환산으로 보인다', async () => {
    const first = await workOrder(ids.operationNoRule);
    const [row] = await requirements(first);
    expect(row).toMatchObject({ bomQty: 15, bomUomCode: 'EA', stockUomCode: 'KG', stockQty: null, conversionSource: 'NONE', conversionRate: null, confirmationRequired: true });

    const at = `materialUomConfirmations[bomComponentId=${row.bomComponentId}]`;
    const noRate = await release(first, { materialUomConfirmations: [{ bomComponentId: row.bomComponentId, confirmed: true }] }).expect(400);
    expect(noRate.body.errors).toEqual([expect.objectContaining({ field: `${at}.conversionRate`, code: 'MATERIAL_UOM_CONFIRMATION_REQUIRED' })]);
    expect(await prisma.item_uom_conversion.count({ where: { item_id: ids.resinNoRule } })).toBe(0);

    const key = randomUUID();
    await release(first, { materialUomConfirmations: [{ bomComponentId: row.bomComponentId, confirmed: true, conversionRate: 40 }] }, key).expect(200);
    const [line] = await prisma.material_issue_request_line.findMany({ where: { material_issue_request: { work_order_id: first } } });
    // 1 KG = 40 EA — 15 EA 는 0.375 KG.
    expect([line.uom_id, line.requested_qty.toNumber()]).toEqual([ids.kg, 0.375]);
    const today = localDate(new Date(), TIMEZONE);
    const saved = await prisma.item_uom_conversion.findMany({ where: { item_id: ids.resinNoRule } });
    expect(saved.map((conversion) => [conversion.from_uom_id, conversion.to_uom_id, conversion.conversion_rate.toNumber(), conversion.effective_from.toISOString().slice(0, 10), conversion.created_by])).toEqual([
      [ids.kg, ids.ea, 40, today, userId],
    ]);
    const audits = await prisma.audit_event.findMany({ where: { target_type_code: 'ITEM', target_id: ids.resinNoRule } });
    expect(audits).toEqual([
      expect.objectContaining({
        event_type_code: 'CREATE',
        performed_by: userId,
        correlation_id: key,
        after_value: {
          eventCode: 'ITEM_UOM_CONVERSION_ENTERED_AT_RELEASE',
          detail: expect.objectContaining({ conversionRate: 40, workOrderId: Number(first), replacedSource: 'NONE', bomComponentIds: [row.bomComponentId] }),
        },
      }),
    ]);

    const next = await workOrder(ids.operationNoRule);
    const [again] = await requirements(next);
    expect(again).toMatchObject({ stockQty: 0.375, conversionSource: 'ITEM', conversionRate: 40 });
    // 이미 품목 환산이 있는 자재에 다른 비율은 덮어쓰지 않는다.
    const conflict = await release(next, { materialUomConfirmations: [{ bomComponentId: again.bomComponentId, confirmed: true, conversionRate: 50 }] }).expect(400);
    expect(conflict.body.errors).toEqual([expect.objectContaining({ field: `${at}.conversionRate`, code: 'INVALID' })]);
    expect(await prisma.item_uom_conversion.count({ where: { item_id: ids.resinNoRule } })).toBe(1);
  });

  it('같은 품목에 같은 비율을 넣은 동시 배포 둘은 둘 다 되고 환산은 한 행이다 — 품목 버전이 올라 열어 둔 기준정보 화면의 저장은 409', async () => {
    const openedVersion = (await prisma.item.findUniqueOrThrow({ where: { item_id: ids.resinConcurrent } })).version_no;
    const [first, second] = [await workOrder(ids.operationConcurrent), await workOrder(ids.operationConcurrent)];
    const [row] = await requirements(first);
    const confirm = { materialUomConfirmations: [{ bomComponentId: row.bomComponentId, confirmed: true, conversionRate: 40 }] };

    const responses = await Promise.all([release(first, confirm), release(second, confirm)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await prisma.item_uom_conversion.count({ where: { item_id: ids.resinConcurrent } })).toBe(1);
    expect(await prisma.audit_event.count({ where: { target_type_code: 'ITEM', target_id: ids.resinConcurrent } })).toBe(1);

    await request(app.getHttpServer())
      .put(`/api/mdm/items/${ids.resinConcurrent}/uom-conversions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', String(openedVersion))
      .send({ conversions: [] })
      .expect(409);
    expect(await prisma.item_uom_conversion.count({ where: { item_id: ids.resinConcurrent } })).toBe(1);
  });

  it('질량 공통 환산(KG·GR)은 다른 비율로 바꿀 수 없다 — 같은 비율은 통과', async () => {
    const workOrderId = await workOrder(ids.operationCommon);
    const [row] = await requirements(workOrderId);
    expect(row).toMatchObject({ conversionSource: 'COMMON', conversionRate: 1000, stockQty: 0.367 });
    const at = `materialUomConfirmations[bomComponentId=${row.bomComponentId}].conversionRate`;
    const refused = await release(workOrderId, { materialUomConfirmations: [{ bomComponentId: row.bomComponentId, confirmed: true, conversionRate: 900 }] }).expect(400);
    expect(refused.body.errors).toEqual([expect.objectContaining({ field: at, code: 'INVALID' })]);
    await release(workOrderId, { materialUomConfirmations: [{ bomComponentId: row.bomComponentId, confirmed: true, conversionRate: 1000 }] }).expect(200);
    expect(await prisma.item_uom_conversion.count({ where: { item_id: ids.resinCommon } })).toBe(0);
  });

  it('라인 없이 배포하는 자동 W/O 는 배포가 단위 확인을 건너뛰므로 조회도 확인 필요로 내지 않는다', async () => {
    const workOrderId = await workOrder(ids.operationResin);
    await prisma.production_plan.update({ where: { production_plan_id: ids.plan }, data: { created_automatically: true } });
    await prisma.work_order.update({ where: { work_order_id: workOrderId }, data: { production_line_id: null } });
    try {
      expect((await requirements(workOrderId)).map((row) => [row.conversionSource, row.confirmationRequired])).toEqual([['ITEM', false], [null, false]]);
    } finally {
      await prisma.production_plan.update({ where: { production_plan_id: ids.plan }, data: { created_automatically: false } });
    }
  });

  it('단위가 같은 자재뿐인 W/O 는 지금 본문({ lotSize }) 그대로 배포된다', async () => {
    const workOrderId = await workOrder(ids.operationBolt);
    expect((await requirements(workOrderId)).map((row) => row.confirmationRequired)).toEqual([false]);
    await release(workOrderId, {}).expect(200);
  });

  it('출고요청 부족 조회(「BOM 소요량 불러오기」)가 배포 전 조회와 같은 재고 단위 수량을 내고, 추가 출고 요청은 GR 줄을 KG 로 담는다', async () => {
    const workOrderId = await workOrder(ids.operationResin);
    const [preview] = await requirements(workOrderId);
    const shortage = await request(app.getHttpServer())
      .get('/api/logistics/material-issue-requests/shortage')
      .query({ workOrderId: Number(workOrderId) })
      .set('Cookie', cookie)
      .expect(200);
    const resinRow = shortage.body.items.find((item: { itemId: number }) => item.itemId === Number(ids.resin));
    expect(resinRow).toMatchObject({ uomId: Number(ids.kg), requiredQty: preview.stockQty, conversionSource: 'ITEM' });

    const created = await request(app.getHttpServer())
      .post('/api/logistics/material-issue-requests')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        workOrderId: Number(workOrderId),
        destinationLocationId: Number(ids.wipLocation),
        lines: [{ itemId: Number(ids.resin), requestedQty: 367, uomId: Number(ids.gr) }],
        businessDate: '2026-11-18',
        occurredAt: '2026-11-18T03:00:00.000Z',
      })
      .expect(201);
    expect(created.body.lines.map((line: { uomId: number; requestedQty: number }) => [line.uomId, line.requestedQty])).toEqual([[Number(ids.kg), 0.367]]);
  });

  function requirements(workOrderId: bigint): Promise<Requirement[]> {
    return request(app.getHttpServer())
      .get(`/api/production/work-orders/${workOrderId}/material-requirements`)
      .set('Cookie', cookie)
      .expect(200)
      .then((response) => response.body.items as Requirement[]);
  }

  function release(workOrderId: bigint, extra: Record<string, unknown>, key = randomUUID()) {
    return request(app.getHttpServer())
      .post(`/api/production/work-orders/${workOrderId}:release`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .set('If-Match', '1')
      .send({ lotSize: 10, ...extra });
  }

  async function workOrder(routingOperationId: bigint): Promise<bigint> {
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO${++seq}`,
        production_plan_id: ids.plan,
        routing_operation_id: routingOperationId,
        item_id: ids.itemFg,
        order_qty: 10,
        uom_id: ids.ea,
        status_code: 'PLANNED',
        production_line_id: ids.line,
        default_wip_location_id: ids.wipLocation,
        default_fg_location_id: ids.wipLocation,
        default_scrap_location_id: ids.wipLocation,
      },
    });
    return row.work_order_id;
  }

  async function makeFixtures(): Promise<void> {
    const uom = async (code: string) => (await prisma.uom.findUniqueOrThrow({ where: { uom_code: code } })).uom_id;
    ids.kg = await uom('KG');
    ids.gr = await uom('GR');
    ids.ea = await uom('EA');
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '환산검사법인', country_code: 'VN', timezone_code: TIMEZONE },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '환산검사사업부' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '환산검사공장', timezone_code: TIMEZONE },
    });
    const item = async (code: string, type: string, baseUomId: bigint) =>
      (await prisma.item.create({ data: { item_code: `${PREFIX}-${code}`, item_name: code, item_type_code: type, base_uom_id: baseUomId } })).item_id;
    ids.itemFg = await item('FG', 'FINISHED', ids.ea);
    ids.resin = await item('RESIN', 'RAW_MATERIAL', ids.kg);
    ids.resinNoRule = await item('RESIN-NR', 'RAW_MATERIAL', ids.kg);
    ids.bolt = await item('BOLT', 'RAW_MATERIAL', ids.ea);
    ids.resinConcurrent = await item('RESIN-CC', 'RAW_MATERIAL', ids.kg);
    ids.resinCommon = await item('RESIN-CM', 'RAW_MATERIAL', ids.kg);
    await prisma.item_uom_conversion.create({
      data: { item_id: ids.resin, from_uom_id: ids.kg, to_uom_id: ids.gr, conversion_rate: 1000, effective_from: new Date('2026-01-01T00:00:00.000Z') },
    });

    const process = await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MACHINING' } });
    const routing = await prisma.routing.create({
      data: { item_id: ids.itemFg, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    for (const [key, seqNo] of [['operationResin', 10], ['operationNoRule', 20], ['operationBolt', 30], ['operationConcurrent', 40], ['operationCommon', 50]] as const) {
      ids[key] = (await prisma.routing_operation.create({
        data: { routing_id: routing.routing_id, operation_seq: seqNo, process_id: process.process_id, operation_name: key },
      })).routing_operation_id;
    }
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: ids.itemFg, bom_code: `${PREFIX}-BOM`, bom_version: 1, status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: ids.ea,
      },
    });
    const components: [bigint, string, bigint, bigint][] = [
      [ids.resin, '36.7', ids.gr, ids.operationResin],
      [ids.bolt, '2', ids.ea, ids.operationResin],
      [ids.resinNoRule, '1.5', ids.ea, ids.operationNoRule],
      [ids.bolt, '1', ids.ea, ids.operationBolt],
      [ids.resinConcurrent, '1.5', ids.ea, ids.operationConcurrent],
      [ids.resinCommon, '36.7', ids.gr, ids.operationCommon],
    ];
    await prisma.bom_component.createMany({
      data: components.map(([itemId, qty, uomId, operation], index) => ({
        bom_id: bom.bom_id, component_item_id: itemId, required_qty: qty, routing_operation_id: operation, uom_id: uomId, sequence_no: index + 1,
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
    ids.wipLocation = (await warehouse('WIP', 'GENERAL')).locationId;
    const material = await warehouse('M1', 'MATERIAL');
    const stock = async (itemId: bigint, no: string, qty: number, uomId: bigint) => {
      const lot = await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-${no}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: plant.plant_id, initial_qty: qty,
          uom_id: uomId, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
        },
      });
      await prisma.inventory_balance.create({
        data: {
          legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
          warehouse_id: material.warehouseId, location_id: material.locationId, item_id: itemId, lot_id: lot.lot_id,
          quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
          on_hand_qty: qty, uom_id: uomId,
        },
      });
      return lot.lot_id;
    };
    ids.resinLot = await stock(ids.resin, 'RESIN', 25, ids.kg);
    await stock(ids.resinNoRule, 'RESIN-NR', 25, ids.kg);
    await stock(ids.bolt, 'BOLT', 1000, ids.ea);

    ids.line = (await prisma.production_line.create({
      data: { plant_id: plant.plant_id, line_code: `${PREFIX}-LN`, line_name: '환산검사라인' },
    })).production_line_id;
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`, business_unit_id: unit.business_unit_id, plant_id: plant.plant_id,
        item_id: ids.itemFg, order_qty: 10, uom_id: ids.ea, status_code: 'RECEIVED',
      },
    });
    ids.plan = (await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id, plan_no: `${PREFIX}-PP`, plan_date: new Date('2026-11-18T00:00:00.000Z'),
        planned_qty: 10, uom_id: ids.ea, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED',
      },
    })).production_plan_id;

    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '환산검사', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '환산검사용' } });
    await prisma.role_permission.createMany({
      data: ['W-02-04', 'W-02-10', 'W-06-05'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
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
    const itemScope = { item: { item_code: { startsWith: PREFIX } } };
    const items = await prisma.item.findMany({ where: { item_code: { startsWith: PREFIX } }, select: { item_id: true } });
    await prisma.audit_event.deleteMany({ where: { target_type_code: 'ITEM', target_id: { in: items.map((row) => row.item_id) } } });
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
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: warehouseScope });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item_uom_conversion.deleteMany({ where: itemScope });
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
