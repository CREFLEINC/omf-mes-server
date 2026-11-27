/**
 * 피처 012 출하 지시서 사업부 단위·줄별 출고 창고 e2e 의 바탕(omf-all-around#338 · research R-10).
 *
 * 사업부 X — 공장 P1(창고 A·C·불량창고 D·쓰지 않는 창고 Z), 공장 P2(창고 B). 사업부 Y — 공장 P3(창고 Y1).
 * 사업부 없는 공장 P0(배포 전 지시서용 · US6-3). 품목 FG(OQC 대상)·G(검사 없음), 고객·납품처.
 * 계정: 범위 사업부 X / X·Y / 공장 P1 만 / 범위 없음. 단말: PDA-P1·PDA-P1A(창고 A)·PDA-P2·PDA-P0·POP-P1·POP-P1A(창고 A)·POP-P2·POP-P3·POP-P0.
 *
 * ⭐ 마스터는 접두어로 «있으면 쓴다» — 출하 완료가 원장에 행을 남기고 원장은 지울 수 없어 마스터를 지우면 FK 가 막는다.
 *    거래 행(LOT·지시서·수주)은 실행마다 다른 번호(`run`)로 새로 만든다. 010 의 `shipment-simplified-fixture.ts` 와 같은 방식이다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';

export const BW_PREFIX = 'BWE2E';
const PASSWORD = '출하사업부-비밀번호';
const DAY = new Date('2026-11-20T00:00:00.000Z');

export type WarehouseKey = 'A' | 'B' | 'C' | 'D' | 'Z' | 'Y1' | 'P0W';
export type PlantKey = 'P1' | 'P2' | 'P3' | 'P0';
export type AccountKey = 'X' | 'XY' | 'P1' | 'ALL';
export type TerminalKey = 'PDA_P1' | 'PDA_P1A' | 'PDA_P2' | 'PDA_P0' | 'POP_P1' | 'POP_P1A' | 'POP_P2' | 'POP_P3' | 'POP_P0';

export interface BwTerminal {
  terminalId: bigint;
  token: string;
  workerNo: string;
  workerId: bigint;
  plantId: bigint;
}

export interface BwLine {
  warehouse?: WarehouseKey | null;
  item?: 'FG' | 'G';
  allocated: number;
  requested?: number;
  salesOrderLineId?: number;
}

const PERMISSIONS = ['W-04-01', 'W-04-02', 'W-04-03', 'W-04-04', 'W-04-05', 'W-04-12', 'M-04-01'];

export class ShipmentBuWarehouseFixture {
  readonly run = randomUUID().slice(0, 6).toUpperCase();
  private seq = 0;
  readonly unit = { X: 0n, Y: 0n };
  readonly plant: Record<PlantKey, bigint> = { P1: 0n, P2: 0n, P3: 0n, P0: 0n };
  readonly warehouse = {} as Record<WarehouseKey, bigint>;
  readonly location = {} as Record<WarehouseKey, bigint>;
  readonly item = { FG: 0n, G: 0n };
  readonly cookie = {} as Record<AccountKey, string[]>;
  readonly terminal = {} as Record<TerminalKey, BwTerminal>;
  uom = 0n;
  entity = 0n;
  customer = 0n;
  shipTo = 0n;

  constructor(private readonly app: INestApplication, private readonly prisma: PrismaService) {}

  http() {
    return request(this.app.getHttpServer());
  }

  async setup(): Promise<void> {
    const p = this.prisma;
    const ensure = async <T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> => (await find()) ?? create();
    this.uom = (await p.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } })).uom_id;
    this.entity = (await ensure(
      () => p.legal_entity.findFirst({ where: { legal_entity_code: `${BW_PREFIX}-LE` } }),
      () => p.legal_entity.create({ data: { legal_entity_code: `${BW_PREFIX}-LE`, legal_entity_name: '사업부출하법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' } }),
    )).legal_entity_id;
    for (const key of ['X', 'Y'] as const) {
      this.unit[key] = (await ensure(
        () => p.business_unit.findFirst({ where: { business_unit_code: `${BW_PREFIX}-BU${key}` } }),
        () => p.business_unit.create({ data: { legal_entity_id: this.entity, business_unit_code: `${BW_PREFIX}-BU${key}`, business_unit_name: `사업부${key}` } }),
      )).business_unit_id;
    }
    const plantUnit: Record<PlantKey, bigint | null> = { P1: this.unit.X, P2: this.unit.X, P3: this.unit.Y, P0: null };
    for (const key of ['P1', 'P2', 'P3', 'P0'] as const) {
      this.plant[key] = (await ensure(
        () => p.plant.findFirst({ where: { plant_code: `${BW_PREFIX}-${key}` } }),
        () => p.plant.create({ data: {
          legal_entity_id: this.entity, business_unit_id: plantUnit[key], plant_code: `${BW_PREFIX}-${key}`, plant_name: `${key}공장`, timezone_code: 'Asia/Ho_Chi_Minh',
        } }),
      )).plant_id;
    }
    // 창고의 사업부 칸은 NOT NULL 이다 — 사업부 없는 공장 P0 의 창고는 사업부 X 로 둔다(옛 지시서 피킹용 · 새 지시서로는 못 고른다).
    const specs: [WarehouseKey, PlantKey, bigint, { defect?: boolean; inactive?: boolean }][] = [
      ['A', 'P1', this.unit.X, {}], ['C', 'P1', this.unit.X, {}], ['D', 'P1', this.unit.X, { defect: true }], ['Z', 'P1', this.unit.X, { inactive: true }],
      ['B', 'P2', this.unit.X, {}], ['Y1', 'P3', this.unit.Y, {}], ['P0W', 'P0', this.unit.X, {}],
    ];
    for (const [key, plantKey, unit, flags] of specs) {
      const warehouse = await ensure(
        () => p.warehouse.findFirst({ where: { warehouse_code: `${BW_PREFIX}-${key}` } }),
        () => p.warehouse.create({ data: {
          plant_id: this.plant[plantKey], business_unit_id: unit, warehouse_code: `${BW_PREFIX}-${key}`, warehouse_name: `완제품창고${key}`,
          warehouse_type_code: 'PRODUCT', management_level_code: 'LOCATION', is_defect: flags.defect ?? false, is_active: !(flags.inactive ?? false),
        } }),
      );
      this.warehouse[key] = warehouse.warehouse_id;
      this.location[key] = (await ensure(
        () => p.location.findFirst({ where: { warehouse_id: warehouse.warehouse_id, location_code: `${BW_PREFIX}-L${key}` } }),
        () => p.location.create({ data: { warehouse_id: warehouse.warehouse_id, location_code: `${BW_PREFIX}-L${key}`, location_name: `위치${key}`, location_type_code: 'BIN' } }),
      )).location_id;
    }
    for (const key of ['FG', 'G'] as const) {
      this.item[key] = (await ensure(
        () => p.item.findFirst({ where: { item_code: `${BW_PREFIX}-${key}` } }),
        () => p.item.create({ data: { item_code: `${BW_PREFIX}-${key}`, item_name: `사업부출하품목${key}`, item_type_code: 'FINISHED_GOOD', base_uom_id: this.uom, lot_controlled: true } }),
      )).item_id;
    }
    // 편성이 검사 필수 줄의 품목마다 OQC 의뢰를 세우며 유효한 기준 버전을 요구한다(없으면 400 STATE_LOCKED).
    if ((await p.inspection_plan.findFirst({ where: { inspection_plan_code: `${BW_PREFIX}-OQC-FG` } })) === null) {
      const plan = await p.inspection_plan.create({ data: {
        inspection_plan_code: `${BW_PREFIX}-OQC-FG`, inspection_plan_name: '사업부출하OQC', item_id: this.item.FG, inspection_type_code: 'OQC', is_active: true,
      } });
      await p.inspection_plan_version.create({ data: {
        inspection_plan_id: plan.inspection_plan_id, plan_version: 1, effective_from: new Date('2020-01-01'),
        sampling_method_code: 'FULL_INSPECTION', inspection_frequency_code: 'PRODUCTION_LOT', status_code: 'CONFIRMED',
      } });
    }
    const partner = async (code: string) => (await ensure(
      () => p.partner.findFirst({ where: { partner_code: `${BW_PREFIX}-${code}` } }),
      () => p.partner.create({ data: { partner_code: `${BW_PREFIX}-${code}`, partner_name: `사업부출하${code}`, erp_partner_code: `${BW_PREFIX}${code}` } }),
    )).partner_id;
    this.customer = await partner('C');
    this.shipTo = await partner('S');

    const accounts: [AccountKey, { unit: bigint; plant?: bigint }[]][] = [
      ['X', [{ unit: this.unit.X }]],
      ['XY', [{ unit: this.unit.X }, { unit: this.unit.Y }]],
      ['P1', [{ unit: this.unit.X, plant: this.plant.P1 }]],
      ['ALL', []],
    ];
    for (const [key, scopes] of accounts) this.cookie[key] = await this.account(`e2e-bw-${key.toLowerCase()}`, scopes, PERMISSIONS);

    const terminals: [TerminalKey, 'MOBILE' | 'POP', PlantKey, WarehouseKey | null][] = [
      ['PDA_P1', 'MOBILE', 'P1', null], ['PDA_P1A', 'MOBILE', 'P1', 'A'], ['PDA_P2', 'MOBILE', 'P2', null], ['PDA_P0', 'MOBILE', 'P0', null],
      ['POP_P1', 'POP', 'P1', null], ['POP_P1A', 'POP', 'P1', 'A'], ['POP_P2', 'POP', 'P2', null], ['POP_P3', 'POP', 'P3', null], ['POP_P0', 'POP', 'P0', null],
    ];
    for (const [key, type, plantKey, warehouseKey] of terminals) {
      this.terminal[key] = await this.makeTerminal(key, type, this.plant[plantKey], warehouseKey === null ? null : this.warehouse[warehouseKey]);
    }
  }

  /** 계정 하나 — 범위 줄과 권한을 매번 맞추고 세션 쿠키를 받는다. */
  async account(loginId: string, scopes: { unit: bigint; plant?: bigint }[], permissions: string[]): Promise<string[]> {
    const p = this.prisma;
    let user = await p.app_user.findUnique({ where: { login_id: loginId } });
    if (user === null) {
      user = await p.app_user.create({ data: { login_id: loginId, user_name: loginId, status_code: 'EMPLOYED' } });
      await p.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    }
    const roleCode = `${BW_PREFIX}-${loginId}`.slice(0, 50);
    const role = (await p.role.findUnique({ where: { role_code: roleCode } }))
      ?? await p.role.create({ data: { role_code: roleCode, role_name: loginId } });
    await p.role_permission.deleteMany({ where: { role_id: role.role_id } });
    await p.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await p.user_role.upsert({
      where: { app_user_id_role_id: { app_user_id: user.app_user_id, role_id: role.role_id } },
      update: {}, create: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
    await p.user_data_scope.deleteMany({ where: { app_user_id: user.app_user_id } });
    for (const scope of scopes) {
      await p.user_data_scope.create({ data: { app_user_id: user.app_user_id, business_unit_id: scope.unit, plant_id: scope.plant ?? null } });
    }
    const response = await this.http().post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  private async makeTerminal(code: string, type: 'MOBILE' | 'POP', plantId: bigint, warehouseId: bigint | null): Promise<BwTerminal> {
    const p = this.prisma;
    const terminalCode = `${BW_PREFIX}-${code}`;
    const terminal = (await p.terminal.findFirst({ where: { terminal_code: terminalCode } }))
      ?? await p.terminal.create({ data: { terminal_code: terminalCode, plant_id: plantId, terminal_type_code: type, status_code: 'RUNNING', warehouse_id: warehouseId } });
    const workerNo = `${BW_PREFIX}-W-${code}`;
    const worker = (await p.worker.findFirst({ where: { worker_no: workerNo } }))
      ?? await p.worker.create({ data: {
        worker_no: workerNo, worker_name: `작업자${code}`, business_unit_id: this.unit.X, plant_id: plantId, status_code: 'EMPLOYED',
      } });
    return {
      terminalId: terminal.terminal_id, workerNo, workerId: worker.worker_id, plantId,
      token: this.app.get(JwtService).sign({
        sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode, plantId: Number(plantId),
      }),
    };
  }

  /** 제품 LOT + 잔액 행(창고마다 하나). 잔액의 공장·사업부는 창고의 것이다. */
  async lot(balances: { warehouse: WarehouseKey; qty: number }[], item: 'FG' | 'G' = 'FG'): Promise<{ lotId: number; lotNo: string }> {
    const p = this.prisma;
    this.seq += 1;
    const lotNo = `${BW_PREFIX}-${this.run}-LOT-${this.seq}`;
    const first = await p.warehouse.findUniqueOrThrow({ where: { warehouse_id: this.warehouse[balances[0].warehouse] } });
    const lot = await p.lot.create({ data: {
      lot_no: lotNo, item_id: this.item[item], lot_type_code: 'PRODUCT', plant_id: first.plant_id, initial_qty: 1000,
      uom_id: this.uom, source_type_code: 'WORK_ORDER', source_id: 1, status_code: 'NORMAL',
    } });
    for (const balance of balances) {
      const warehouse = await p.warehouse.findUniqueOrThrow({ where: { warehouse_id: this.warehouse[balance.warehouse] } });
      await p.inventory_balance.create({ data: {
        legal_entity_id: this.entity, business_unit_id: warehouse.business_unit_id, plant_id: warehouse.plant_id,
        warehouse_id: warehouse.warehouse_id, location_id: this.location[balance.warehouse], item_id: this.item[item], lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
        on_hand_qty: balance.qty, picked_qty: 0, uom_id: this.uom,
      } });
    }
    return { lotId: Number(lot.lot_id), lotNo };
  }

  /** ERP S/O 하나(줄마다 주문 수량) — 생성 본문의 `salesOrderId`·`salesOrderLineId` 에 쓴다. */
  async salesOrder(lines: { item?: 'FG' | 'G'; ordered: number; shipped?: number }[]): Promise<{ salesOrderId: number; lineIds: number[] }> {
    this.seq += 1;
    const order = await this.prisma.sales_order.create({
      data: {
        sales_order_no: `${BW_PREFIX}-${this.run}-SO-${this.seq}`, erp_sales_order_no: `ERP${this.run}${this.seq}`, erp_movement_type_code: 'S01',
        customer_id: this.customer, ship_to_partner_id: this.shipTo, order_date: DAY, status_code: 'RECEIVED',
        sales_order_line: { create: lines.map((line, index) => ({
          line_no: index + 1, item_id: this.item[line.item ?? 'FG'], uom_id: this.uom, ordered_qty: line.ordered, shipped_qty: line.shipped ?? 0,
          erp_storage_location_code: 'SL01',
        })) },
      },
      include: { sales_order_line: { orderBy: { line_no: 'asc' } } },
    });
    return { salesOrderId: Number(order.sales_order_id), lineIds: order.sales_order_line.map((line) => Number(line.sales_order_line_id)) };
  }

  /** 생성 본문(W-04-01) — 사업부 X, 줄마다 창고. */
  body(lines: BwLine[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      customerId: Number(this.customer), shipToPartnerId: Number(this.shipTo), requestedShipDate: '2026-11-20',
      businessUnitId: Number(this.unit.X),
      lines: lines.map((line) => ({
        itemId: Number(this.item[line.item ?? 'FG']), requestedQty: line.requested ?? line.allocated, allocatedQty: line.allocated,
        uomId: Number(this.uom), shippingInspectionRequired: (line.item ?? 'FG') === 'FG',
        ...(line.salesOrderLineId === undefined ? {} : { salesOrderLineId: line.salesOrderLineId }),
        ...(line.warehouse === null ? {} : { warehouseId: Number(this.warehouse[line.warehouse ?? 'A']) }),
      })),
      ...overrides,
    };
  }

  /** POST /logistics/shipment-requests(계정 세션, 기본은 범위 X 계정). */
  create(body: Record<string, unknown>, account: AccountKey = 'X'): request.Test {
    return this.http().post('/api/logistics/shipment-requests').set('Cookie', this.cookie[account]).set('Idempotency-Key', randomUUID()).send(body);
  }

  /** 만들고 지시서 id·줄 id 를 돌려준다. */
  async made(lines: BwLine[], overrides: Record<string, unknown> = {}): Promise<{ requestId: number; requestNo: string; lineIds: number[] }> {
    const response = await this.create(this.body(lines, overrides), 'ALL').expect(201);
    return {
      requestId: response.body.shipmentRequestId as number,
      requestNo: response.body.shipmentRequestNo as string,
      lineIds: (response.body.lines as { shipmentRequestLineId: number }[]).map((line) => line.shipmentRequestLineId),
    };
  }

  /** 배포 전 모양의 지시서(공장 단위·창고 미지정 줄) — 마이그레이션 채우기를 거친 모습으로 사업부를 함께 둔다(US6). */
  async legacy(plantKey: PlantKey, lines: { item?: 'FG' | 'G'; allocated: number }[]): Promise<{ requestId: number; requestNo: string; lineIds: number[] }> {
    const p = this.prisma;
    this.seq += 1;
    const requestNo = `${BW_PREFIX}-${this.run}-SR-${this.seq}`;
    const plant = await p.plant.findUniqueOrThrow({ where: { plant_id: this.plant[plantKey] } });
    const header = await p.shipment_request.create({ data: {
      shipment_request_no: requestNo, customer_id: this.customer, ship_to_partner_id: this.shipTo, requested_ship_date: DAY, status_code: 'REGISTERED',
      fulfillment_plant_id: plant.plant_id, business_unit_id: plant.business_unit_id,
    } });
    const lineIds: number[] = [];
    for (const [index, line] of lines.entries()) {
      const created = await p.shipment_request_line.create({ data: {
        shipment_request_id: header.shipment_request_id, line_no: index + 1, item_id: this.item[line.item ?? 'FG'], uom_id: this.uom,
        requested_qty: line.allocated, allocated_qty: line.allocated, shipping_inspection_required: false,
      } });
      lineIds.push(Number(created.shipment_request_line_id));
    }
    return { requestId: Number(header.shipment_request_id), requestNo, lineIds };
  }

  asSession(test: request.Test, account: AccountKey = 'X'): request.Test {
    return test.set('Cookie', this.cookie[account]);
  }

  asTerminal(test: request.Test, key: TerminalKey): request.Test {
    const session = this.terminal[key];
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }
}
