/**
 * 피처 013 생산 LOT 수량 분리 e2e 의 바탕(omf-all-around#303) — 공장 둘, 제품 창고(위치 둘 + 적치 대기 자리)·불량 창고·
 * 일반 창고, 품목(일반·시리얼·자재), W/O(공정 하나), POP 단말 셋(라벨 공정 매핑·매핑 없음·남의 공장)·PDA, 계정 세션.
 *
 * ⭐ 마스터는 접두어로 «있으면 쓴다» — 원장 행은 지울 수 없어(`block_ledger_header_mutation`) 마스터를 지우면 FK 가 막는다.
 *    LOT·W/O 같은 거래 행은 실행마다 다른 번호(`run`)로 새로 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';

export const PLS_PREFIX = 'PLSE2E';
const LOGIN_ID = 'e2e-product-lot-split';
const PASSWORD = '생산LOT분리-비밀번호';
const PERMISSIONS = ['P-04-08', 'M-04-05', 'M-04-01', 'W-03-01', 'W-02-09'];

export interface TerminalSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
  workerId: bigint;
  plantId: bigint;
}

export type Spot = 'A' | 'B' | 'staging' | 'defect' | 'general';

export interface BalanceSpec {
  at: Spot;
  qty: number;
  reserved?: number;
  picked?: number;
  quality?: string;
  inventoryStatus?: string;
}

export interface LotSpec {
  item?: 'A' | 'S' | 'M';
  status?: string;
  lifecycle?: string | null;
  lotType?: string;
  initialQty?: number;
  balances: BalanceSpec[];
  plant?: bigint;
  workOrderId?: bigint;
}

export class ProductLotSplitFixture {
  readonly run = randomUUID().slice(0, 6).toUpperCase();
  private seq = 0;
  cookie: string[] = [];
  pop!: TerminalSession;
  popNoLabel!: TerminalSession;
  foreignPop!: TerminalSession;
  pda!: TerminalSession;
  readonly ids = {
    entity: 0n, unit: 0n, plant: 0n, plant2: 0n, uom: 0n, itemA: 0n, itemS: 0n, itemM: 0n,
    fg: 0n, defect: 0n, general: 0n, locA: 0n, locB: 0n, staging: 0n, locDefect: 0n, locGeneral: 0n,
    process: 0n, operation: 0n, line: 0n, userId: 0n,
  };

  constructor(private readonly app: INestApplication, private readonly prisma: PrismaService) {}

  http() {
    return request(this.app.getHttpServer());
  }

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  async setup(): Promise<void> {
    const p = this.prisma;
    const ensure = async <T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> => (await find()) ?? create();
    // 정수 단위(소수 자리 0) — Q11 「정수 단위에 2.5」.
    this.ids.uom = (await ensure(
      () => p.uom.findFirst({ where: { uom_code: `${PLS_PREFIX}-EA` } }),
      () => p.uom.create({ data: { uom_code: `${PLS_PREFIX}-EA`, uom_name: '분리검사개', decimal_scale: 0 } }),
    )).uom_id;
    const entity = await ensure(
      () => p.legal_entity.findFirst({ where: { legal_entity_code: `${PLS_PREFIX}-LE` } }),
      () => p.legal_entity.create({ data: { legal_entity_code: `${PLS_PREFIX}-LE`, legal_entity_name: '분리검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' } }),
    );
    this.ids.entity = entity.legal_entity_id;
    const unit = await ensure(
      () => p.business_unit.findFirst({ where: { business_unit_code: `${PLS_PREFIX}-BU` } }),
      () => p.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PLS_PREFIX}-BU`, business_unit_name: '분리검사사업부' } }),
    );
    this.ids.unit = unit.business_unit_id;
    const plant = async (code: string) => (await ensure(
      () => p.plant.findFirst({ where: { plant_code: `${PLS_PREFIX}-${code}` } }),
      () => p.plant.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${PLS_PREFIX}-${code}`, plant_name: `분리검사공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh' } }),
    )).plant_id;
    this.ids.plant = await plant('P1');
    this.ids.plant2 = await plant('P2');

    const warehouse = async (code: string, type: string, isDefect: boolean) => (await ensure(
      () => p.warehouse.findFirst({ where: { warehouse_code: `${PLS_PREFIX}-${code}` } }),
      () => p.warehouse.create({ data: {
        plant_id: this.ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${PLS_PREFIX}-${code}`,
        warehouse_name: `분리검사${code}`, warehouse_type_code: type, management_level_code: 'LOCATION', is_defect: isDefect,
      } }),
    )).warehouse_id;
    this.ids.fg = await warehouse('FG', 'PRODUCT', false);
    this.ids.defect = await warehouse('DEF', 'PRODUCT', true);
    this.ids.general = await warehouse('GEN', 'GENERAL', false);
    const location = async (warehouseId: bigint, code: string) => (await ensure(
      () => p.location.findFirst({ where: { warehouse_id: warehouseId, location_code: `${PLS_PREFIX}-${code}` } }),
      () => p.location.create({ data: { warehouse_id: warehouseId, location_code: `${PLS_PREFIX}-${code}`, location_name: `분리검사${code}`, location_type_code: 'BIN' } }),
    )).location_id;
    this.ids.locA = await location(this.ids.fg, 'A01');
    this.ids.locB = await location(this.ids.fg, 'A02');
    this.ids.locDefect = await location(this.ids.defect, 'D01');
    this.ids.locGeneral = await location(this.ids.general, 'G01');
    // 적치 대기 자리 — 창고를 만들 때 트리거(`mdm.create_system_locations`)가 세운다.
    this.ids.staging = (await p.location.findFirstOrThrow({ where: { warehouse_id: this.ids.fg, system_role_code: 'PUTAWAY_STAGING' } })).location_id;

    const item = async (code: string, type: string, serial: string) => (await ensure(
      () => p.item.findFirst({ where: { item_code: `${PLS_PREFIX}-${code}` } }),
      () => p.item.create({ data: {
        item_code: `${PLS_PREFIX}-${code}`, item_name: `분리검사품목${code}`, item_type_code: type, base_uom_id: this.ids.uom,
        lot_controlled: true, serial_control_type_code: serial,
      } }),
    )).item_id;
    this.ids.itemA = await item('A', 'FINISHED_GOOD', 'NONE');
    this.ids.itemS = await item('S', 'FINISHED_GOOD', 'SERIAL');
    this.ids.itemM = await item('M', 'RAW_MATERIAL', 'NONE');

    this.ids.process = (await ensure(
      () => p.process.findFirst({ where: { process_code: `${PLS_PREFIX}-PR` } }),
      () => p.process.create({ data: { process_code: `${PLS_PREFIX}-PR`, process_name: '분리검사공정', process_type_code: 'ASSEMBLY' } }),
    )).process_id;
    const routing = await ensure(
      () => p.routing.findFirst({ where: { routing_code: `${PLS_PREFIX}-RT` } }),
      () => p.routing.create({ data: { item_id: this.ids.itemA, routing_code: `${PLS_PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' } }),
    );
    this.ids.operation = (await ensure(
      () => p.routing_operation.findFirst({ where: { routing_id: routing.routing_id } }),
      () => p.routing_operation.create({ data: { routing_id: routing.routing_id, process_id: this.ids.process, operation_seq: 10, operation_name: '분리검사' } }),
    )).routing_operation_id;
    this.ids.line = (await ensure(
      () => p.production_line.findFirst({ where: { line_code: `${PLS_PREFIX}-LN` } }),
      () => p.production_line.create({ data: { plant_id: this.ids.plant, line_code: `${PLS_PREFIX}-LN`, line_name: '분리검사라인' } }),
    )).production_line_id;

    await this.makeUser();
    this.pop = await this.terminal('POP1', 'POP', this.ids.plant, true);
    this.popNoLabel = await this.terminal('POP3', 'POP', this.ids.plant, false);
    this.foreignPop = await this.terminal('POP2', 'POP', this.ids.plant2, false);
    this.pda = await this.terminal('PDA1', 'MOBILE', this.ids.plant, false);
  }

  /** 단말 하나 — `printLabel` 이면 공정(기본: W/O 공정)에 라벨 출력 매핑을 단다. */
  async terminal(code: string, type: 'MOBILE' | 'POP', plantId: bigint, printLabel: boolean, processId?: bigint): Promise<TerminalSession> {
    const p = this.prisma;
    const terminal = (await p.terminal.findFirst({ where: { terminal_code: `${PLS_PREFIX}-${code}` } }))
      ?? await p.terminal.create({ data: { terminal_code: `${PLS_PREFIX}-${code}`, plant_id: plantId, terminal_type_code: type, status_code: 'RUNNING' } });
    if (printLabel && (await p.terminal_process.findFirst({ where: { terminal_id: terminal.terminal_id } })) === null) {
      await p.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: processId ?? this.ids.process, can_print_label: true } });
    }
    const worker = (await p.worker.findFirst({ where: { worker_no: `${PLS_PREFIX}-W-${code}` } }))
      ?? await p.worker.create({ data: {
        worker_no: `${PLS_PREFIX}-W-${code}`, worker_name: `분리검사작업자${code}`, business_unit_id: this.ids.unit, plant_id: plantId, status_code: 'EMPLOYED',
      } });
    return {
      terminalId: terminal.terminal_id, workerNo: worker.worker_no, workerId: worker.worker_id, plantId,
      token: this.app.get(JwtService).sign({
        sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plantId),
      }),
    };
  }

  private async makeUser(): Promise<void> {
    const p = this.prisma;
    let user = await p.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user === null) {
      user = await p.app_user.create({ data: { login_id: LOGIN_ID, user_name: '분리검사', status_code: 'EMPLOYED' } });
      await p.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
      const role = await p.role.create({ data: { role_code: `${PLS_PREFIX}-ROLE`, role_name: '분리검사용' } });
      await p.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      await p.user_data_scope.create({ data: { app_user_id: user.app_user_id, business_unit_id: this.ids.unit, plant_id: this.ids.plant } });
    }
    const role = await p.role.findUniqueOrThrow({ where: { role_code: `${PLS_PREFIX}-ROLE` } });
    await p.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })), skipDuplicates: true,
    });
    this.ids.userId = user.app_user_id;
    const response = await this.http().post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    this.cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** W/O 하나 — 생산 LOT 의 원천. `resultAt` 을 주면 그 시각의 실적과 LOT 배분을 함께 만든다(`withResult`). */
  async workOrder(): Promise<{ workOrderId: bigint; workOrderNo: string }> {
    const workOrderNo = `${PLS_PREFIX}-${this.run}-WO-${this.next()}`;
    const created = await this.prisma.work_order.create({ data: {
      work_order_no: workOrderNo, routing_operation_id: this.ids.operation, item_id: this.ids.itemA, order_qty: 1000,
      uom_id: this.ids.uom, production_line_id: this.ids.line, status_code: 'IN_PROGRESS',
    } });
    return { workOrderId: created.work_order_id, workOrderNo };
  }

  /** 실적 한 건 + 그 LOT 배분(양품 `qty`). 라벨 생산일·수량의 근거다. */
  async result(workOrderId: bigint, lotId: number, qty: number, occurredAt: string): Promise<void> {
    const n = this.next();
    const worker = await this.prisma.worker.findFirstOrThrow({ where: { worker_no: this.pop.workerNo } });
    const created = await this.prisma.production_result.create({ data: {
      production_result_no: `${PLS_PREFIX}-${this.run}-R${n}`, work_order_id: workOrderId, result_sequence: n,
      good_qty: qty, uom_id: this.ids.uom, result_source_code: 'MANUAL', occurred_at: new Date(occurredAt),
      worker_id: worker.worker_id, status_code: 'CONFIRMED', idempotency_key: `${PLS_PREFIX}-${this.run}-R${n}`,
    } });
    await this.prisma.production_result_lot_allocation.create({ data: {
      production_result_id: created.production_result_id, lot_id: BigInt(lotId), allocated_qty: qty, uom_id: this.ids.uom,
    } });
  }

  /** 생산 LOT(기본: 품목 A·정상·활성·W/O 원천) + 잔액 행. */
  async lot(spec: LotSpec): Promise<{ lotId: number; lotNo: string; workOrderId: bigint }> {
    const p = this.prisma;
    const itemId = spec.item === 'S' ? this.ids.itemS : spec.item === 'M' ? this.ids.itemM : this.ids.itemA;
    const lotNo = `${PLS_PREFIX}-${this.run}-L${this.next()}`;
    const workOrderId = spec.workOrderId ?? (await this.workOrder()).workOrderId;
    const material = spec.item === 'M';
    const total = spec.balances.reduce((sum, balance) => sum + balance.qty, 0);
    const lot = await p.lot.create({ data: {
      lot_no: lotNo, item_id: itemId, lot_type_code: spec.lotType ?? (material ? 'MATERIAL' : 'PRODUCTION'),
      plant_id: spec.plant ?? this.ids.plant, initial_qty: spec.initialQty ?? total, uom_id: this.ids.uom,
      source_type_code: material ? 'INBOUND_RECEIPT_LINE' : 'WORK_ORDER', source_id: material ? 1n : workOrderId,
      status_code: spec.status ?? 'NORMAL',
      ...(spec.lifecycle === null ? {} : { lifecycle_status_code: spec.lifecycle ?? 'ACTIVE' }),
      manufactured_at: new Date('2026-11-17T02:00:00.000Z'), expiry_date: new Date('2027-11-17T00:00:00.000Z'),
    } });
    for (const balance of spec.balances) await this.balance(lot.lot_id, itemId, balance);
    return { lotId: Number(lot.lot_id), lotNo, workOrderId };
  }

  async balance(lotId: bigint, itemId: bigint, balance: BalanceSpec): Promise<void> {
    const where: Record<Spot, [bigint, bigint]> = {
      A: [this.ids.fg, this.ids.locA], B: [this.ids.fg, this.ids.locB], staging: [this.ids.fg, this.ids.staging],
      defect: [this.ids.defect, this.ids.locDefect], general: [this.ids.general, this.ids.locGeneral],
    };
    const [warehouseId, locationId] = where[balance.at];
    await this.prisma.inventory_balance.create({ data: {
      legal_entity_id: this.ids.entity, business_unit_id: this.ids.unit, plant_id: this.ids.plant,
      warehouse_id: warehouseId, location_id: locationId, item_id: itemId, lot_id: lotId,
      quality_status_code: balance.quality ?? 'NORMAL', inventory_status_code: balance.inventoryStatus ?? 'AVAILABLE',
      ownership_type_code: 'OWNED', on_hand_qty: balance.qty, reserved_qty: balance.reserved ?? 0, picked_qty: balance.picked ?? 0,
      uom_id: this.ids.uom,
    } });
  }

  locationOf(spot: Spot): number {
    return Number({ A: this.ids.locA, B: this.ids.locB, staging: this.ids.staging, defect: this.ids.locDefect, general: this.ids.locGeneral }[spot]);
  }

  asTerminal(test: request.Test, session: TerminalSession): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  asSession(test: request.Test): request.Test {
    return test.set('Cookie', this.cookie);
  }

  /** POP 스캔 조회(기본은 자기 공장 라벨 POP). */
  lookup(lotNo: string, session: TerminalSession | 'session' = this.pop): request.Test {
    const test = this.http().get('/api/logistics/product-lot-splits:lookup').query({ lotNo });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** POP 분리(기본은 자기 공장 라벨 POP). */
  split(
    body: { lotId: number; locationId: number; qty: number | string },
    session: TerminalSession | 'session' = this.pop,
    key: string = randomUUID(),
  ): request.Test {
    const test = this.http().post('/api/logistics/product-lot-splits').set('Idempotency-Key', key)
      .send({ businessDate: '2026-11-20', ...body });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** 분리 목록(기본은 자기 공장 라벨 POP). */
  list(query: Record<string, string | number>, session: TerminalSession | 'session' = this.pop): request.Test {
    const test = this.http().get('/api/logistics/product-lot-splits').query(query);
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** PDA 분리 확인(기본은 자기 공장 PDA). */
  confirm(splitId: number, lotIds: number[], session: TerminalSession | 'session' = this.pda, key: string = randomUUID()): request.Test {
    const test = this.http().post(`/api/logistics/product-lot-splits/${splitId}:confirm`).set('Idempotency-Key', key).send({ lotIds });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** LOT 의 위치별 보유(0 초과만) — `[locationId, onHand]`. */
  async onHand(lotId: number): Promise<[number, number][]> {
    const rows = await this.prisma.inventory_balance.findMany({
      where: { lot_id: BigInt(lotId), on_hand_qty: { gt: 0 } }, orderBy: { location_id: 'asc' },
    });
    return rows.map((row) => [Number(row.location_id), Number(row.on_hand_qty)]);
  }
}
