/**
 * OA 자동 W/O 배포의 자재 출고요청(사용자 결정 2026-11-19) — 라인 없이 배포하되, 공장 정책이 출발·도착을 정한다.
 *
 * 출발은 `AUTO_ISSUE_SOURCE_WAREHOUSE` 창고 하나, 도착은 자재 차감 창고(`BACKFLUSH_WAREHOUSE`)의 받는 자리다.
 * 담는 자재는 자재 차감과 같은 BOM 끝 자재이고, 출고 작업일·부족은 생산 창고 공장의 대기 요청 규칙 그대로다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AutoWorkOrderService } from '../src/integration/tracking-system/auto-work-order.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_AIR_${randomUUID().slice(0, 8)}`;
const SL_CD = 'S510';
const PAST = new Date('2026-01-05T00:00:00.000Z');
/** 수요일 — 출고 작업일은 직전 근무일인 화요일이다(주 5일). */
const WEDNESDAY = new Date('2027-01-06T00:00:00.000Z');
const POLICY_FROM = new Date('2026-01-01T00:00:00.000Z');

describe('OA 자동 W/O 출고요청 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auto: AutoWorkOrderService;
  let seq = 0;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    auto = app.get(AutoWorkOrderService);
    await fixtures();
  });

  afterAll(async () => {
    await prisma.operation_policy.deleteMany({ where: { plant_id: ids.plant } });
    await app.close();
  });

  it('착수일이 지났으면 출발 창고에서 BOM 끝 자재를 담아 바로 배포한다 — 모자란 몫은 줄의 부족, 출발 창고에 없는 자재는 부족 행', async () => {
    const workOrder = await releasedWorkOrder(PAST);
    expect(workOrder).toMatchObject({ status_code: 'RELEASED', production_line_id: null, default_wip_location_id: null });

    const [request, ...others] = await requestsOf(workOrder.work_order_id);
    expect(others).toEqual([]);
    expect(request).toMatchObject({
      source_warehouse_id: ids.source, destination_location_id: ids.staging, status_code: 'REGISTERED', requested_by: null,
    });
    // 반제품 SUB(2개)는 풀려 들어가지 않는다 — LEAF1 = 직접 1 + SUB 2×3, LEAF2 = SUB 2×1. 지시수량 10.
    expect(linesOf(request)).toEqual([
      [ids.leaf1, 70, 0],
      [ids.leaf2, 5, 15],
    ]);
    expect(await unsourcedOf(workOrder.work_order_id)).toEqual([[ids.leaf3, 10]]);
    const pickings = await prisma.picking_order.findMany({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: request.material_issue_request_id },
      select: { warehouse_id: true },
    });
    expect(pickings).toEqual([{ warehouse_id: ids.source }]);
  });

  it('착수일이 아직이면 대기 요청으로 두고 출고 작업일은 착수일의 직전 근무일이다', async () => {
    const workOrder = await releasedWorkOrder(WEDNESDAY);
    const [request] = await requestsOf(workOrder.work_order_id);
    expect(request).toMatchObject({
      status_code: 'WAITING', source_warehouse_id: ids.source, issue_work_date: new Date('2027-01-05T00:00:00.000Z'),
    });
    expect(await prisma.picking_order.count({
      where: { source_document_type_code: 'MATERIAL_ISSUE_REQUEST', source_document_id: request.material_issue_request_id },
    })).toBe(0);
  });

  it('자재 차감 창고 정책이 없으면 배포하지 않고 까닭을 던진다', async () => {
    await prisma.operation_policy.update({ where: { operation_policy_id: ids.backflushPolicy }, data: { effective_to: POLICY_FROM } });
    try {
      const orderId = await order(PAST);
      await expect(auto.run(orderId)).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: expect.stringContaining('BACKFLUSH_WAREHOUSE') })],
      });
      const plan = await prisma.production_plan.findFirstOrThrow({ where: { production_order_id: orderId }, include: { work_order: true } });
      expect(plan.work_order.map((row) => row.released_at)).toEqual([null]);
      expect(await prisma.material_issue_request.count({ where: { work_order_id: plan.work_order[0].work_order_id } })).toBe(0);
    } finally {
      await prisma.operation_policy.update({ where: { operation_policy_id: ids.backflushPolicy }, data: { effective_to: null } });
    }
  });

  async function releasedWorkOrder(start: Date) {
    const orderId = await order(start);
    await auto.run(orderId);
    return prisma.work_order.findFirstOrThrow({ where: { production_plan: { production_order_id: orderId } } });
  }

  function requestsOf(workOrderId: bigint) {
    return prisma.material_issue_request.findMany({
      where: { work_order_id: workOrderId },
      include: { material_issue_request_line: { orderBy: { line_no: 'asc' } } },
    });
  }

  function linesOf(request: Awaited<ReturnType<typeof requestsOf>>[number]): [bigint, number, number][] {
    return request.material_issue_request_line.map((line) => [line.item_id, line.requested_qty.toNumber(), line.shortage_qty.toNumber()]);
  }

  async function unsourcedOf(workOrderId: bigint): Promise<[bigint, number][]> {
    const rows = await prisma.material_issue_unsourced_shortage.findMany({ where: { work_order_id: workOrderId } });
    return rows.map((row) => [row.item_id, row.shortage_qty.toNumber()]);
  }

  async function order(start: Date): Promise<bigint> {
    const row = await prisma.production_order.create({ data: {
      production_order_no: `${PREFIX}-PO-${++seq}`, business_unit_id: ids.unit, plant_id: ids.plant, item_id: ids.product,
      order_qty: 10, uom_id: ids.uom, status_code: 'RECEIVED', erp_storage_location_code: SL_CD, planned_start_date: start,
    } });
    return row.production_order_id;
  }

  async function item(key: string, typeCode: string): Promise<bigint> {
    return (await prisma.item.create({ data: {
      item_code: `${PREFIX}-${key}`, item_name: key, item_type_code: typeCode, base_uom_id: ids.uom,
    } })).item_id;
  }

  /** 그 공장의 기본 BOM — 공정에 묶인 줄이 없다(PL13 BOM 과 같다). */
  async function bom(parentId: bigint, components: [bigint, number][]): Promise<void> {
    await prisma.bom.create({ data: {
      parent_item_id: parentId, plant_id: ids.plant, bom_code: `ERP-${PREFIX}-${++seq}`, bom_version: 1, status_code: 'CONFIRMED',
      is_default: true, effective_from: POLICY_FROM, base_qty: 1, base_uom_id: ids.uom,
      bom_component: { create: components.map(([itemId, qty], index) => ({
        component_item_id: itemId, required_qty: qty, uom_id: ids.uom, sequence_no: index + 1,
      })) },
    } });
  }

  async function warehouse(key: string, typeCode: string): Promise<{ warehouseId: bigint; wholeId: bigint }> {
    const row = await prisma.warehouse.create({ data: {
      plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: key === 'FG' ? SL_CD : `${PREFIX}-${key}`, warehouse_name: key,
      warehouse_type_code: typeCode, management_level_code: 'WAREHOUSE',
    } });
    const whole = await prisma.location.findFirstOrThrow({ where: { warehouse_id: row.warehouse_id, system_role_code: 'WAREHOUSE_WHOLE' } });
    return { warehouseId: row.warehouse_id, wholeId: whole.location_id };
  }

  async function stock(itemId: bigint, qty: number, at: { warehouseId: bigint; wholeId: bigint }): Promise<void> {
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-ML-${++seq}`, item_id: itemId, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: qty, uom_id: ids.uom,
      source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
    } });
    await prisma.inventory_balance.create({ data: {
      legal_entity_id: ids.entity, business_unit_id: ids.unit, plant_id: ids.plant, warehouse_id: at.warehouseId, location_id: at.wholeId,
      item_id: itemId, lot_id: lot.lot_id, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
      on_hand_qty: qty, uom_id: ids.uom,
    } });
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.entity = base.legal_entity_id;
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    ids.plant = (await prisma.plant.create({ data: {
      plant_code: PREFIX, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    await prisma.process.create({ data: { process_code: `${PREFIX}-ASSY`, process_name: '조립', process_type_code: 'ASSEMBLY' } });

    // 출발(자재창고) · 도착(나뉜 생산 원자재 창고) · 정책에 없는 자재창고 · 완제품(ERP SL_CD).
    const source = await warehouse('SRC', 'MATERIAL');
    const destination = await warehouse('DST', 'MATERIAL');
    const other = await warehouse('OTHER', 'MATERIAL');
    await warehouse('FG', 'PRODUCT');
    ids.source = source.warehouseId;
    await prisma.location.create({ data: {
      warehouse_id: destination.warehouseId, location_code: `${PREFIX}-DST-A`, location_name: '선반', location_type_code: 'BIN',
    } });
    ids.staging = (await prisma.location.findFirstOrThrow({
      where: { warehouse_id: destination.warehouseId, system_role_code: 'PUTAWAY_STAGING' },
    })).location_id;

    const policy = (policyCode: string, valueText: string) =>
      prisma.operation_policy.create({ data: { policy_code: policyCode, plant_id: ids.plant, value_text: valueText, effective_from: POLICY_FROM } });
    await policy('AUTO_ROUTING_PROCESS', `${PREFIX}-ASSY`);
    await policy('AUTO_ISSUE_SOURCE_WAREHOUSE', `${PREFIX}-SRC`);
    ids.backflushPolicy = (await policy('BACKFLUSH_WAREHOUSE', `${PREFIX}-DST`)).operation_policy_id;

    // 제품 = LEAF1 1 + 반제품 SUB 2 + LEAF3 1 · SUB = LEAF1 3 + LEAF2 1.
    ids.product = await item('P', 'FINISHED');
    const sub = await item('SUB', 'SEMI_FINISHED');
    ids.leaf1 = await item('LEAF1', 'RAW_MATERIAL');
    ids.leaf2 = await item('LEAF2', 'RAW_MATERIAL');
    ids.leaf3 = await item('LEAF3', 'RAW_MATERIAL');
    await bom(ids.product, [[ids.leaf1, 1], [sub, 2], [ids.leaf3, 1]]);
    await bom(sub, [[ids.leaf1, 3], [ids.leaf2, 1]]);

    await stock(ids.leaf1, 1000, source);
    await stock(ids.leaf2, 5, source);
    // 정책 밖 창고의 재고는 고르지 않는다 — LEAF3 은 출발 창고에 없다.
    await stock(ids.leaf3, 100, other);
    await stock(sub, 100, source);
  }
});
