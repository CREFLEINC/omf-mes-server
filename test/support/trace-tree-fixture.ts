/**
 * 피처 015 자재 기준 생산 추적·제품 기준 역추적 e2e 의 바탕(omf-all-around#355 · quickstart 「준비」).
 *
 * 스위트마다 접두어로 «자기 공장»을 둔다 — 최근 목록은 공장 전체를 훑으므로 다른 스위트의 흔적이 섞이면 순서를 못 본다.
 * 공장·창고·품목·파트너·작업자·공정은 접두어로 «있으면 쓴다». 거래 행(LOT·W/O·투입·실적·입고·출하·입하)은
 * 실행마다 새로 만들고 `cleanup` 이 공장·접두어로 지운다. 값은 모두 가상이다(공개 저장소).
 *
 * 계보 사슬(`chain`, quickstart 「준비」):
 *   자재 A(공급사 S·입하 LOT IL-1·공급사 LOT SUP-A) → W/O 1 → 반제품 P1·P2(P2 는 창고 재고)
 *   P1 + 자재 B → W/O 2 → 완제품 P3 → 고객 X 출하 SH-1 · 시리얼 SN-1
 *   A → 분할 A-S1 → W/O 3 → 완제품 P4(재고) → 분리 P4-S1 → 고객 Y 출하 SH-2
 */
import { INestApplication } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface ChainIds {
  a: bigint;
  b: bigint;
  aS1: bigint;
  p1: bigint;
  p2: bigint;
  p3: bigint;
  p4: bigint;
  p4S1: bigint;
  wo1: bigint;
  wo2: bigint;
  wo3: bigint;
  il1: bigint;
  sh1: bigint;
  sh2: bigint;
  sn1: bigint;
}

export class TraceTreeFixture {
  readonly ids: Record<string, bigint> = {};
  private seq = 0;

  constructor(
    private readonly prisma: PrismaService,
    readonly prefix: string,
  ) {}

  /** 공장 현지(하노이, UTC+7) 시각 — `day` 날 `hour` 시. */
  static at(day: string, hour = 10, minute = 0): Date {
    return new Date(Date.parse(`${day}T00:00:00.000Z`) + ((hour - 7) * 60 + minute) * 60_000);
  }

  async setup(): Promise<void> {
    const p = this.prisma;
    const P = this.prefix;
    const ensure = async <T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> => (await find()) ?? create();
    const entity = await p.legal_entity.findFirstOrThrow({ orderBy: { legal_entity_id: 'asc' } });
    const unit = await p.business_unit.findFirstOrThrow({ orderBy: { business_unit_id: 'asc' } });
    this.ids.uom = (await p.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } })).uom_id;
    for (const key of ['plant', 'otherPlant']) {
      const code = `${P}-${key === 'plant' ? 'P' : 'P2'}`;
      const plant = await ensure(() => p.plant.findFirst({ where: { plant_code: code } }), () => p.plant.create({ data: {
        plant_code: code, plant_name: `추적공장${code}`, legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id,
        timezone_code: 'Asia/Ho_Chi_Minh',
      } }));
      this.ids[key] = plant.plant_id;
      const warehouse = await ensure(() => p.warehouse.findFirst({ where: { warehouse_code: `${code}-WH` } }), () => p.warehouse.create({ data: {
        plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${code}-WH`, warehouse_name: `추적창고${code}`,
        warehouse_type_code: 'FINISHED', management_level_code: 'WAREHOUSE',
      } }));
      this.ids[`${key}Warehouse`] = warehouse.warehouse_id;
      this.ids[`${key}Location`] = (await ensure(() => p.location.findFirst({ where: { warehouse_id: warehouse.warehouse_id } }), () => p.location.create({ data: {
        warehouse_id: warehouse.warehouse_id, location_code: `${code}-LOC`, location_name: `추적위치${code}`, location_type_code: 'DEFAULT',
      } }))).location_id;
    }
    for (const [key, code, type] of [['mat', 'MAT', 'RAW_MATERIAL'], ['mat2', 'MAT2', 'RAW_MATERIAL'], ['semi', 'SEMI', 'SEMI_FINISHED'], ['fg', 'FG', 'FINISHED']] as const) {
      this.ids[key] = (await ensure(() => p.item.findFirst({ where: { item_code: `${P}-${code}` } }), () => p.item.create({ data: {
        item_code: `${P}-${code}`, item_name: `추적${code}`, item_type_code: type, base_uom_id: this.ids.uom,
      } }))).item_id;
    }
    for (const [key, code] of [['supplierS', 'SUP-S'], ['supplierT', 'SUP-T'], ['customerX', 'CUS-X'], ['customerY', 'CUS-Y']] as const) {
      this.ids[key] = (await ensure(() => p.partner.findFirst({ where: { partner_code: `${P}-${code}` } }), () => p.partner.create({ data: {
        partner_code: `${P}-${code}`, partner_name: `추적${code}`,
      } }))).partner_id;
    }
    this.ids.worker = (await ensure(() => p.worker.findFirst({ where: { worker_no: `${P}-W` } }), () => p.worker.create({ data: {
      worker_no: `${P}-W`, worker_name: '추적작업자', business_unit_id: unit.business_unit_id, plant_id: this.ids.plant, status_code: 'ACTIVE',
    } }))).worker_id;
    const process = await ensure(() => p.process.findFirst({ where: { process_code: `${P}-PR` } }), () => p.process.create({ data: {
      process_code: `${P}-PR`, process_name: '추적공정', process_type_code: 'MOLDING',
    } }));
    const routing = await ensure(() => p.routing.findFirst({ where: { routing_code: `${P}-RT` } }), () => p.routing.create({ data: {
      item_id: this.ids.fg, routing_code: `${P}-RT`, routing_version: 1, status_code: 'ACTIVE',
    } }));
    this.ids.operation = (await ensure(() => p.routing_operation.findFirst({ where: { routing_id: routing.routing_id } }), () => p.routing_operation.create({ data: {
      routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '추적작업',
    } }))).routing_operation_id;
  }

  /** 번호는 접두어를 붙여 만든다(`no('A')` → `TTE2E-A`). */
  no(suffix: string): string {
    return `${this.prefix}-${suffix}`;
  }

  async lot(suffix: string, item: bigint, options: {
    type?: string; source?: string; sourceId?: bigint; plant?: bigint; inboundLotId?: bigint | null; parent?: bigint; qty?: number; status?: string;
  } = {}): Promise<bigint> {
    return (await this.prisma.lot.create({ data: {
      lot_no: this.no(suffix), item_id: item, lot_type_code: options.type ?? 'MATERIAL', plant_id: options.plant ?? this.ids.plant,
      initial_qty: options.qty ?? 100, uom_id: this.ids.uom, source_type_code: options.source ?? 'MATERIAL_LOT_BATCH', source_id: options.sourceId ?? 1n,
      status_code: options.status ?? 'NORMAL', lifecycle_status_code: 'ACTIVE', inbound_lot_id: options.inboundLotId ?? null, parent_lot_id: options.parent ?? null,
    } })).lot_id;
  }

  async workOrder(suffix: string, item: bigint): Promise<bigint> {
    return (await this.prisma.work_order.create({ data: {
      work_order_no: this.no(`WO-${suffix}`), routing_operation_id: this.ids.operation, item_id: item, order_qty: 100, uom_id: this.ids.uom, status_code: 'IN_PROGRESS',
    } })).work_order_id;
  }

  /** 생산 LOT — 원천 W/O. */
  async productionLot(suffix: string, item: bigint, workOrderId: bigint, plant?: bigint): Promise<bigint> {
    return this.lot(suffix, item, { type: 'PRODUCTION', source: 'WORK_ORDER', sourceId: workOrderId, plant });
  }

  async consume(workOrderId: bigint, lotId: bigint, qty: number, at: Date, correctsId?: bigint): Promise<bigint> {
    this.seq += 1;
    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } });
    return (await this.prisma.material_consumption.create({ data: {
      consumption_no: this.no(`MC-${this.seq}-${randomUUID().slice(0, 6)}`), work_order_id: workOrderId, item_id: lot.item_id, lot_id: lotId,
      consumption_type_code: 'NORMAL', input_qty: qty, uom_id: this.ids.uom, occurred_at: at, worker_id: this.ids.worker, status_code: 'RECORDED',
      idempotency_key: this.no(`MC-${this.seq}-${randomUUID()}`), corrects_consumption_id: correctsId ?? null,
    } })).material_consumption_id;
  }

  /** 실적 — 생산 LOT 에 배분하고, `sources` 마다 계보(CONSUMED, 추정)를 남긴다. 빈 목록이면 계보 없는 W/O(W/O 단위 추정). */
  async produce(workOrderId: bigint, lotId: bigint, qty: number, at: Date, sources: bigint[]): Promise<void> {
    this.seq += 1;
    const sequence = (await this.prisma.production_result.count({ where: { work_order_id: workOrderId } })) + 1;
    const result = await this.prisma.production_result.create({ data: {
      production_result_no: this.no(`PR-${this.seq}-${randomUUID().slice(0, 6)}`), work_order_id: workOrderId, result_sequence: sequence, good_qty: qty,
      uom_id: this.ids.uom, result_source_code: 'POP', occurred_at: at, worker_id: this.ids.worker, status_code: 'CONFIRMED',
      idempotency_key: this.no(`PR-${this.seq}-${randomUUID()}`),
      production_result_lot_allocation: { create: [{ lot_id: lotId, allocated_qty: qty, uom_id: this.ids.uom }] },
    } });
    if (sources.length === 0) return;
    await this.prisma.lot_relation.createMany({ data: sources.map((source) => ({
      source_lot_id: source, target_lot_id: lotId, relation_type_code: 'CONSUMED', relation_qty: qty, uom_id: this.ids.uom,
      source_event_type_code: 'PRODUCTION_RESULT', source_event_id: result.production_result_id, allocation_method_code: 'INPUT_TIME_WINDOW',
      trace_accuracy_code: 'ESTIMATED', occurred_at: at,
    })) });
  }

  /** 분할(008 부분 출고 `GOODS_ISSUE_SPLIT`) 또는 분리(013 `PRODUCT_LOT_SPLIT`) 자식 LOT. */
  async split(parent: bigint, suffix: string, qty: number, at: Date, source: 'GOODS_ISSUE_SPLIT' | 'PRODUCT_LOT_SPLIT'): Promise<bigint> {
    const base = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: parent } });
    const child = await this.lot(suffix, base.item_id, { type: base.lot_type_code, source, sourceId: parent, parent, qty });
    await this.prisma.lot_relation.create({ data: {
      source_lot_id: parent, target_lot_id: child, relation_type_code: 'SPLIT', relation_qty: qty, uom_id: this.ids.uom,
      allocation_method_code: 'EXACT', trace_accuracy_code: 'EXACT', occurred_at: at,
      // 출고 줄·분리 기록은 만들지 않는다 — 추적은 계보 줄만 본다(출고 번호는 비어 보인다).
      source_event_type_code: source === 'GOODS_ISSUE_SPLIT' ? 'GOODS_ISSUE_LINE' : 'PRODUCT_LOT_SPLIT', source_event_id: 0n,
    } });
    return child;
  }

  /** 입하(005) — 입하 문서·줄 하나와 입하 LOT. `receivingDate` 는 공장 현지 날짜다. */
  async inboundLot(suffix: string, item: bigint, supplier: bigint, receivingDate: string, at: Date, plant?: bigint): Promise<bigint> {
    const receipt = await this.prisma.inbound_receipt.create({
      data: { inbound_receipt_no: this.no(`IR-${suffix}`), supplier_id: supplier, plant_id: plant ?? this.ids.plant, receipt_datetime: at, status_code: 'RECEIVED',
        inbound_receipt_line: { create: [{ line_no: 1, item_id: item, received_qty: 100, uom_id: this.ids.uom, inspection_required: false,
          supplier_lot_label_attached: false, status_code: 'RECEIVED' }] } },
      include: { inbound_receipt_line: true },
    });
    return (await this.prisma.inbound_lot.create({ data: {
      inbound_lot_no: this.no(suffix), plant_id: plant ?? this.ids.plant, item_id: item, supplier_id: supplier, uom_id: this.ids.uom, status_code: 'RECEIVED', received_closed_at: at,
      receiving_date: new Date(`${receivingDate}T00:00:00.000Z`), open_since_date: new Date(`${receivingDate}T00:00:00.000Z`), erp_send_mode_code: 'PER_RECEIPT',
      inbound_receipt_line_id: receipt.inbound_receipt_line[0].inbound_receipt_line_id,
    } })).inbound_lot_id;
  }

  /** 옛 입하(005 이전) — 입하 줄에 LOT 을 직접 잇고 공급사 LOT 번호를 줄에 둔다. */
  async legacyInbound(suffix: string, lotId: bigint, item: bigint, supplier: bigint, at: Date, supplierLotNo: string | null): Promise<void> {
    await this.prisma.inbound_receipt.create({ data: {
      inbound_receipt_no: this.no(`IR-${suffix}`), supplier_id: supplier, plant_id: this.ids.plant, receipt_datetime: at, status_code: 'RECEIVED',
      inbound_receipt_line: { create: [{ line_no: 1, item_id: item, received_qty: 100, uom_id: this.ids.uom, inspection_required: false,
        supplier_lot_label_attached: supplierLotNo !== null, supplier_lot_no: supplierLotNo, status_code: 'RECEIVED', lot_id: lotId }] },
    } });
  }

  async supplierLotNo(lotId: bigint, value: string, supplier: bigint): Promise<void> {
    await this.prisma.lot_external_identifier.create({ data: { lot_id: lotId, identifier_type_code: 'SUPPLIER_LOT', external_identifier: value, partner_id: supplier } });
  }

  /** 입고 — 자재(MATERIAL)·생산(PRODUCT). */
  async receive(type: 'MATERIAL' | 'PRODUCT', lotId: bigint, qty: number, at: Date, status = 'POSTED'): Promise<void> {
    this.seq += 1;
    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } });
    await this.prisma.goods_receipt.create({ data: {
      goods_receipt_no: this.no(`GR-${this.seq}-${randomUUID().slice(0, 6)}`), receipt_type_code: type, plant_id: lot.plant_id,
      warehouse_id: lot.plant_id === this.ids.plant ? this.ids.plantWarehouse : this.ids.otherPlantWarehouse, receipt_datetime: at, status_code: status,
      goods_receipt_line: { create: [{ line_no: 1, item_id: lot.item_id, lot_id: lotId, receipt_qty: qty, uom_id: this.ids.uom, quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE', destination_location_id: lot.plant_id === this.ids.plant ? this.ids.plantLocation : this.ids.otherPlantLocation }] },
    } });
  }

  /** 출하 — 지시서 하나·출하 하나. 완료는 CONFIRMED + shipped_at. 배분마다 LOT 한 줄. */
  async ship(suffix: string, customer: bigint, at: Date, allocations: { lot: bigint; qty: number }[], status = 'CONFIRMED'): Promise<bigint> {
    const item = (await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: allocations[0].lot } })).item_id;
    const total = allocations.reduce((sum, row) => sum + row.qty, 0);
    const req = await this.prisma.shipment_request.create({
      data: { shipment_request_no: this.no(`SR-${suffix}`), customer_id: customer, ship_to_partner_id: customer, requested_ship_date: at, status_code: 'CONFIRMED',
        shipment_request_line: { create: [{ line_no: 1, item_id: item, requested_qty: total, uom_id: this.ids.uom }] } },
      include: { shipment_request_line: true },
    });
    return (await this.prisma.shipment.create({ data: {
      shipment_no: this.no(suffix), shipment_request_id: req.shipment_request_id, warehouse_id: this.ids.plantWarehouse, status_code: status,
      shipped_at: status === 'UNCONFIRMED' ? null : at,
      shipment_line: { create: [{ line_no: 1, shipment_request_line_id: req.shipment_request_line[0].shipment_request_line_id, item_id: item, shipped_qty: total,
        uom_id: this.ids.uom, shipment_lot_allocation: { create: allocations.map((row) => ({ lot_id: row.lot, allocated_qty: row.qty, uom_id: this.ids.uom })) } }] },
    } })).shipment_id;
  }

  async stock(lotId: bigint, qty: number): Promise<void> {
    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } });
    const warehouse = await this.prisma.warehouse.findUniqueOrThrow({ where: { warehouse_id: this.ids.plantWarehouse } });
    const plant = await this.prisma.plant.findUniqueOrThrow({ where: { plant_id: this.ids.plant } });
    await this.prisma.inventory_balance.create({ data: {
      legal_entity_id: plant.legal_entity_id, business_unit_id: warehouse.business_unit_id, plant_id: this.ids.plant, warehouse_id: this.ids.plantWarehouse,
      location_id: this.ids.plantLocation, item_id: lot.item_id, lot_id: lotId, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE',
      ownership_type_code: 'OWNED', on_hand_qty: qty, uom_id: this.ids.uom,
    } });
  }

  async serial(suffix: string, lotId: bigint, at: Date): Promise<bigint> {
    const lot = await this.prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId } });
    return (await this.prisma.serial_number.create({ data: {
      serial_no: this.no(suffix), item_id: lot.item_id, lot_id: lotId, status_code: 'PRODUCED', produced_at: at,
    } })).serial_number_id;
  }

  /** quickstart 「준비」 계보 사슬. `day` 하루 안에 시각 순으로 쌓는다. */
  async chain(day: string): Promise<ChainIds> {
    const t = (hour: number, minute = 0) => TraceTreeFixture.at(day, hour, minute);
    const il1 = await this.inboundLot('IL-1', this.ids.mat, this.ids.supplierS, day, t(7));
    const ilB = await this.inboundLot('IL-B', this.ids.mat2, this.ids.supplierT, day, t(7, 30));
    const a = await this.lot('A', this.ids.mat, { inboundLotId: il1 });
    const b = await this.lot('B', this.ids.mat2, { inboundLotId: ilB });
    await this.supplierLotNo(a, this.no('SUP-A'), this.ids.supplierS);
    const wo1 = await this.workOrder('1', this.ids.semi);
    const wo2 = await this.workOrder('2', this.ids.fg);
    const wo3 = await this.workOrder('3', this.ids.fg);
    const p1 = await this.productionLot('P1', this.ids.semi, wo1);
    const p2 = await this.productionLot('P2', this.ids.semi, wo1);
    const p3 = await this.productionLot('P3', this.ids.fg, wo2);
    const p4 = await this.productionLot('P4', this.ids.fg, wo3);
    await this.consume(wo1, a, 40, t(8));
    await this.produce(wo1, p1, 20, t(9), [a]);
    await this.produce(wo1, p2, 20, t(9, 30), [a]);
    await this.receive('PRODUCT', p2, 20, t(9, 40));
    await this.stock(p2, 20);
    await this.consume(wo2, p1, 20, t(10));
    await this.consume(wo2, b, 10, t(10));
    await this.produce(wo2, p3, 20, t(11), [p1, b]);
    await this.receive('PRODUCT', p3, 20, t(11, 30));
    const sh1 = await this.ship('SH-1', this.ids.customerX, t(12), [{ lot: p3, qty: 20 }]);
    const sn1 = await this.serial('SN-1', p3, t(11));
    const aS1 = await this.split(a, 'A-S1', 30, t(13), 'GOODS_ISSUE_SPLIT');
    await this.consume(wo3, aS1, 30, t(14));
    await this.produce(wo3, p4, 30, t(15), [aS1]);
    await this.receive('PRODUCT', p4, 30, t(15, 30));
    const p4S1 = await this.split(p4, 'P4-S1', 10, t(16), 'PRODUCT_LOT_SPLIT');
    await this.stock(p4, 20);
    const sh2 = await this.ship('SH-2', this.ids.customerY, t(17), [{ lot: p4S1, qty: 10 }]);
    return { a, b, aS1, p1, p2, p3, p4, p4S1, wo1, wo2, wo3, il1, sh1, sh2, sn1 };
  }

  async cleanup(): Promise<void> {
    const p = this.prisma;
    const P = this.prefix;
    const plants = (await p.plant.findMany({ where: { plant_code: { startsWith: `${P}-` } }, select: { plant_id: true } })).map((row) => row.plant_id);
    if (plants.length === 0) return;
    const LOTS = `SELECT lot_id FROM trace.lot WHERE plant_id = ANY($1::bigint[])`;
    const WOS = `SELECT work_order_id FROM production.work_order WHERE work_order_no LIKE '${P}-%'`;
    for (const sql of [
      `DELETE FROM logistics.shipment_lot_allocation WHERE lot_id IN (${LOTS})`,
      `DELETE FROM logistics.shipment_line WHERE shipment_id IN (SELECT shipment_id FROM logistics.shipment WHERE shipment_no LIKE '${P}-%')`,
      `DELETE FROM logistics.shipment WHERE shipment_no LIKE '${P}-%'`,
      `DELETE FROM logistics.shipment_request_line WHERE shipment_request_id IN (
         SELECT shipment_request_id FROM logistics.shipment_request WHERE shipment_request_no LIKE '${P}-%')`,
      `DELETE FROM logistics.shipment_request WHERE shipment_request_no LIKE '${P}-%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE lot_id IN (${LOTS})`,
      `DELETE FROM logistics.goods_receipt WHERE goods_receipt_no LIKE '${P}-%'`,
      `DELETE FROM inventory.inventory_balance WHERE plant_id = ANY($1::bigint[])`,
      `DELETE FROM trace.serial_component_relation WHERE parent_serial_number_id IN (SELECT serial_number_id FROM trace.serial_number WHERE lot_id IN (${LOTS}))
          OR component_serial_number_id IN (SELECT serial_number_id FROM trace.serial_number WHERE lot_id IN (${LOTS}))`,
      `DELETE FROM trace.serial_number WHERE lot_id IN (${LOTS})`,
      `DELETE FROM quality.inspection_request WHERE inspection_request_no LIKE '${P}-%'`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${LOTS})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${LOTS}) OR target_lot_id IN (${LOTS})`,
      `DELETE FROM production.production_result_lot_allocation WHERE lot_id IN (${LOTS})`,
      `DELETE FROM production.production_result WHERE work_order_id IN (${WOS})`,
      `DELETE FROM production.material_consumption WHERE work_order_id IN (${WOS})`,
      `DELETE FROM production.work_order WHERE work_order_no LIKE '${P}-%'`,
      `UPDATE logistics.inbound_receipt_line SET lot_id = NULL WHERE lot_id IN (${LOTS})`,
      `UPDATE trace.lot SET parent_lot_id = NULL, inbound_lot_id = NULL WHERE plant_id = ANY($1::bigint[])`,
      `DELETE FROM trace.lot WHERE plant_id = ANY($1::bigint[])`,
      `DELETE FROM trace.inbound_lot WHERE plant_id = ANY($1::bigint[])`,
      `DELETE FROM logistics.inbound_receipt_line WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt WHERE plant_id = ANY($1::bigint[]))`,
      `DELETE FROM logistics.inbound_receipt WHERE plant_id = ANY($1::bigint[])`,
    ]) {
      await (sql.includes('$1') ? p.$executeRawUnsafe(sql, plants) : p.$executeRawUnsafe(sql));
    }
  }
}

const PASSWORD = '추적-시험-비밀번호';

/** 권한을 가진 역할 하나로 로그인한 계정 — 쿠키를 돌려준다. 같은 이름이 남아 있으면 먼저 지운다. */
export async function traceLogin(app: INestApplication, prisma: PrismaService, loginId: string, permissions: string[]): Promise<string[]> {
  await dropTraceUser(prisma, loginId);
  const user = await prisma.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
  await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
  const role = await prisma.role.create({ data: { role_code: `${loginId}-ROLE`, role_name: loginId } });
  await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
  await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
  const response = await request(app.getHttpServer()).post('/api/app/sessions').set('Idempotency-Key', randomUUID())
    .send({ loginId, password: PASSWORD }).expect(200);
  const raw: unknown = response.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
}

export async function dropTraceUser(prisma: PrismaService, loginId: string): Promise<void> {
  const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
  if (user) {
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
  const role = await prisma.role.findUnique({ where: { role_code: `${loginId}-ROLE` } });
  if (role) {
    await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
    await prisma.role.delete({ where: { role_id: role.role_id } });
  }
}

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 계약 `logistics-01자재창고.json` 의 응답 스키마로 본문을 검사한다. */
export function conformsTo(path: string, method: 'get' | 'post', body: unknown): void {
  const contract = JSON.parse(readFileSync(join(__dirname, '../../contracts/logistics-01자재창고.json'), 'utf8')) as object;
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  const validate = ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
  if (!validate(body)) throw new Error(JSON.stringify(validate.errors));
}

export type { Body };
