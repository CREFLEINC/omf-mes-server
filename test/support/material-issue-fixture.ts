/**
 * 계획 기반 출고 요청(피처 003) e2e 공용 준비. 한 법인·사업부 아래 공장 여럿, 품목 X·Y·Z·W·V, 공정(= BOM 묶음)마다
 * 다른 소요를 두고 W/O 를 만들어 배포한다. 소요는 BOM 기준 수량 1 · 지시수량 1 이라 `required_qty` 그대로다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { localDate } from '../../src/planning/production-plan/plan-window';
import { SESSION_COOKIE } from '../../src/auth/session-cookie';
import { PrismaService } from '../../src/prisma/prisma.service';

export const ITEMS = ['X', 'Y', 'Z', 'W', 'V'] as const;
export type ItemKey = (typeof ITEMS)[number];

/** 공정 키 → 소요. 같은 자재 줄 둘(XX)도 둔다. */
export const OPERATIONS: Record<string, [ItemKey, number][]> = {
  X70: [['X', 70]],
  X50: [['X', 50]],
  X20: [['X', 20]],
  XYZ: [['X', 20], ['Y', 10], ['Z', 10]],
  WVX: [['W', 20], ['V', 10], ['X', 30]],
  XX: [['X', 10], ['X', 15], ['Y', 5]],
};

const DAY_MS = 24 * 60 * 60 * 1000;

export class MaterialIssueFixture {
  readonly ids: Record<string, bigint> = {};
  readonly items = {} as Record<ItemKey, bigint>;
  readonly operations: Record<string, bigint> = {};
  cookie = '';
  private seq = 0;
  private readonly plants: Record<string, { plantId: bigint; planId: bigint; timezone: string; wip: bigint }> = {};

  constructor(
    private readonly app: INestApplication,
    private readonly prisma: PrismaService,
    readonly prefix: string,
  ) {}

  async setup(): Promise<void> {
    const p = this.prisma;
    const entity = await p.legal_entity.create({
      data: { legal_entity_code: `${this.prefix}-LE`, legal_entity_name: '출고요청시험법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    this.ids.entity = entity.legal_entity_id;
    this.ids.unit = (
      await p.business_unit.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${this.prefix}-BU`, business_unit_name: '시험사업부' },
      })
    ).business_unit_id;
    this.ids.otherUnit = (
      await p.business_unit.create({
        data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${this.prefix}-BU2`, business_unit_name: '시험사업부2' },
      })
    ).business_unit_id;
    this.ids.uom = (await p.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } })).uom_id;
    const item = (code: string, type: string) =>
      p.item.create({
        data: { item_code: `${this.prefix}-${code}`, item_name: code, item_type_code: type, base_uom_id: this.ids.uom, fifo_policy_code: 'FIFO' },
      });
    this.ids.fg = (await item('FG', 'FINISHED')).item_id;
    for (const key of ITEMS) this.items[key] = (await item(key, 'RAW_MATERIAL')).item_id;

    const process = await p.process.create({
      data: { process_code: `${this.prefix}-PR`, process_name: '조립', process_type_code: 'MACHINING' },
    });
    const routing = await p.routing.create({
      data: { item_id: this.ids.fg, routing_code: `${this.prefix}-RT`, routing_version: 1, status_code: 'CONFIRMED' },
    });
    this.ids.routing = routing.routing_id;
    const bom = await p.bom.create({
      data: {
        parent_item_id: this.ids.fg, bom_code: `${this.prefix}-BOM`, bom_version: 1, status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: this.ids.uom,
      },
    });
    this.ids.bom = bom.bom_id;
    let sequence = 0;
    for (const [index, [key, needs]] of Object.entries(OPERATIONS).entries()) {
      const operation = await p.routing_operation.create({
        data: { routing_id: routing.routing_id, operation_seq: (index + 1) * 10, process_id: process.process_id, operation_name: key },
      });
      this.operations[key] = operation.routing_operation_id;
      for (const [itemKey, qty] of needs) {
        await p.bom_component.create({
          data: {
            bom_id: bom.bom_id, component_item_id: this.items[itemKey], required_qty: qty,
            routing_operation_id: operation.routing_operation_id, uom_id: this.ids.uom, sequence_no: ++sequence,
          },
        });
      }
    }

    const user = await p.app_user.create({ data: { login_id: `${this.prefix}-U`, user_name: '출고요청시험', status_code: 'EMPLOYED' } });
    this.ids.user = user.app_user_id;
    const role = await p.role.create({ data: { role_code: `${this.prefix}-R`, role_name: '출고요청시험' } });
    await p.role_permission.createMany({
      data: ['W-02-04', 'W-02-10', 'W-06-06'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await p.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    this.cookie = `${SESSION_COOKIE}=${this.app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  }

  /** 공장 하나 — 계획(ERP W/O 1건)과 생산 현장 창고·위치를 함께 만든다. */
  async plant(key: string, timezone = 'Asia/Ho_Chi_Minh'): Promise<bigint> {
    const p = this.prisma;
    const plant = await p.plant.create({
      data: { legal_entity_id: this.ids.entity, business_unit_id: this.ids.unit, plant_code: `${this.prefix}-${key}`, plant_name: key, timezone_code: timezone },
    });
    const wip = await this.warehouse(plant.plant_id, `${key}-WIP`);
    const plan = await this.plan(plant.plant_id, key, this.ids.unit);
    this.plants[key] = { plantId: plant.plant_id, planId: plan, timezone, wip: wip.locationId };
    return plant.plant_id;
  }

  async plan(plantId: bigint, key: string, businessUnitId: bigint): Promise<bigint> {
    const order = await this.prisma.production_order.create({
      data: {
        production_order_no: `${this.prefix}-PO-${key}`, business_unit_id: businessUnitId, plant_id: plantId,
        item_id: this.ids.fg, order_qty: 100, uom_id: this.ids.uom, status_code: 'RECEIVED',
      },
    });
    return (
      await this.prisma.production_plan.create({
        data: {
          production_order_id: order.production_order_id, plan_no: `${this.prefix}-PP-${key}`, plan_date: new Date('2026-09-15T00:00:00.000Z'),
          planned_qty: 100, uom_id: this.ids.uom, bom_id: this.ids.bom, routing_id: this.ids.routing, status_code: 'CONFIRMED',
        },
      })
    ).production_plan_id;
  }

  /** 다른 사업부의 ERP W/O 계획(FR-035). */
  async otherUnitPlan(plantKey: string): Promise<bigint> {
    return this.plan(this.plants[plantKey].plantId, `${plantKey}-BU2`, this.ids.otherUnit);
  }

  async warehouse(plantId: bigint, code: string, type = 'GENERAL'): Promise<{ warehouseId: bigint; locationId: bigint }> {
    const wh = await this.prisma.warehouse.create({
      data: {
        plant_id: plantId, business_unit_id: this.ids.unit, warehouse_code: `${this.prefix}-${code}`,
        warehouse_name: code, warehouse_type_code: type, management_level_code: 'WAREHOUSE',
      },
    });
    const location = await this.prisma.location.create({
      data: { warehouse_id: wh.warehouse_id, location_code: `${this.prefix}-${code}-01`, location_name: code, location_type_code: 'DEFAULT' },
    });
    return { warehouseId: wh.warehouse_id, locationId: location.location_id };
  }

  async stock(at: { warehouseId: bigint; locationId: bigint }, item: ItemKey, qty: number, created = '2026-10-01T00:00:00Z'): Promise<bigint> {
    const warehouse = await this.prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: at.warehouseId } });
    const lot = await this.prisma.lot.create({
      data: {
        lot_no: `${this.prefix}-L${++this.seq}`, item_id: this.items[item], lot_type_code: 'MATERIAL', plant_id: warehouse.plant_id,
        initial_qty: qty, uom_id: this.ids.uom, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL', created_at: new Date(created),
      },
    });
    await this.prisma.inventory_balance.create({
      data: {
        legal_entity_id: this.ids.entity, business_unit_id: this.ids.unit, plant_id: warehouse.plant_id,
        warehouse_id: at.warehouseId, location_id: at.locationId, item_id: this.items[item], lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: qty, uom_id: this.ids.uom,
      },
    });
    return lot.lot_id;
  }

  async department(code: string, warehouseIds: bigint[]): Promise<bigint> {
    const department = await this.prisma.department.create({
      data: { department_code: `${this.prefix}-${code}`, department_name: code },
    });
    await this.prisma.department_production_warehouse.createMany({
      data: warehouseIds.map((warehouse_id) => ({ department_id: department.department_id, warehouse_id })),
    });
    return department.department_id;
  }

  /** 라인. `wip=false` 면 생산 현장 위치가 없는 라인이다. */
  async line(plantKey: string, code: string, departmentId: bigint | null, wip = true): Promise<bigint> {
    return (
      await this.prisma.production_line.create({
        data: {
          plant_id: this.plants[plantKey].plantId, line_code: `${this.prefix}-${code}`, line_name: code,
          department_id: departmentId, default_wip_location_id: wip ? this.plants[plantKey].wip : null,
        },
      })
    ).production_line_id;
  }

  /** 공장 현지 오늘에서 `days` 뒤의 다음 `weekday`(0 = 일). 출고 작업일이 미래가 되도록 7일 이상 띄운다. */
  nextWeekday(plantKey: string, weekday: number, atLeastDays = 7): string {
    const today = localDate(new Date(), this.plants[plantKey].timezone);
    let date = new Date(new Date(`${today}T00:00:00.000Z`).getTime() + atLeastDays * DAY_MS);
    while (date.getUTCDay() !== weekday) date = new Date(date.getTime() + DAY_MS);
    return date.toISOString().slice(0, 10);
  }

  async workOrder(input: { plantKey: string; lineId: bigint; operation: string; productionDate: string; planId?: bigint }): Promise<bigint> {
    const plant = this.plants[input.plantKey];
    const row = await this.prisma.work_order.create({
      data: {
        work_order_no: `${this.prefix}-WO${++this.seq}`, production_plan_id: input.planId ?? plant.planId,
        routing_operation_id: this.operations[input.operation], item_id: this.ids.fg, order_qty: 1, uom_id: this.ids.uom,
        status_code: 'PLANNED', production_line_id: input.lineId, planned_start_at: new Date(`${input.productionDate}T03:00:00.000Z`),
        default_wip_location_id: plant.wip, default_fg_location_id: plant.wip, default_scrap_location_id: plant.wip,
      },
    });
    return row.work_order_id;
  }

  release(workOrderId: bigint) {
    return request(this.app.getHttpServer())
      .post(`/api/production/work-orders/${workOrderId}:release`)
      .set('Cookie', this.cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize: 1 });
  }

  requests(workOrderId: bigint) {
    return this.prisma.material_issue_request.findMany({
      where: { work_order_id: workOrderId },
      include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
      orderBy: { source_warehouse_id: 'asc' },
    });
  }

  pickings(requestId: bigint) {
    return this.prisma.picking_order.findMany({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: requestId },
      include: { picking_line: true },
    });
  }

  async cleanup(): Promise<void> {
    const p = this.prisma;
    const prefix = this.prefix;
    const plant = { plant: { plant_code: { startsWith: prefix } } };
    const workOrder = { work_order: { work_order_no: { startsWith: prefix } } };
    const warehouse = { warehouse: { warehouse_code: { startsWith: prefix } } };
    await p.picking_line.deleteMany({ where: { picking_order: warehouse } });
    await p.picking_order.deleteMany({ where: warehouse });
    await p.material_issue_unsourced_shortage.deleteMany({ where: workOrder });
    await p.material_issue_request_line.deleteMany({ where: { material_issue_request: workOrder } });
    await p.material_issue_request.deleteMany({ where: workOrder });
    await p.inventory_balance.deleteMany({ where: plant });
    await p.lot_lifecycle_history.deleteMany({ where: { lot: plant } });
    await p.lot.deleteMany({ where: plant });
    await p.work_order.deleteMany({ where: { work_order_no: { startsWith: prefix } } });
    await p.production_plan.deleteMany({ where: { plan_no: { startsWith: prefix } } });
    await p.production_order.deleteMany({ where: { production_order_no: { startsWith: prefix } } });
    await p.production_line.deleteMany({ where: { line_code: { startsWith: prefix } } });
    await p.department_production_warehouse.deleteMany({ where: { department: { department_code: { startsWith: prefix } } } });
    await p.department.deleteMany({ where: { department_code: { startsWith: prefix } } });
    await p.location.deleteMany({ where: warehouse });
    await p.warehouse.deleteMany({ where: { warehouse_code: { startsWith: prefix } } });
    await p.operation_policy.deleteMany({ where: plant });
    await p.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: prefix } } } });
    await p.bom.deleteMany({ where: { bom_code: { startsWith: prefix } } });
    await p.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: prefix } } } });
    await p.routing.deleteMany({ where: { routing_code: { startsWith: prefix } } });
    await p.process.deleteMany({ where: { process_code: { startsWith: prefix } } });
    await p.item.deleteMany({ where: { item_code: { startsWith: prefix } } });
    await p.plant.deleteMany({ where: { plant_code: { startsWith: prefix } } });
    await p.business_unit.deleteMany({ where: { business_unit_code: { startsWith: prefix } } });
    await p.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: prefix } } });
    const users = await p.app_user.findMany({ where: { login_id: { startsWith: prefix } }, select: { app_user_id: true } });
    const userIds = users.map((u) => u.app_user_id);
    await p.idempotency_record.deleteMany({ where: { app_user_id: { in: userIds } } });
    await p.user_role.deleteMany({ where: { app_user_id: { in: userIds } } });
    await p.app_user.deleteMany({ where: { app_user_id: { in: userIds } } });
    const roles = await p.role.findMany({ where: { role_code: { startsWith: prefix } }, select: { role_id: true } });
    await p.role_permission.deleteMany({ where: { role_id: { in: roles.map((r) => r.role_id) } } });
    await p.role.deleteMany({ where: { role_id: { in: roles.map((r) => r.role_id) } } });
  }
}
