/**
 * 피처 010 출하 공정 단순화 e2e 의 바탕(omf-all-around#305) — 공장 둘·완제품 창고 둘(위치 셋)·불량창고·품목 A(OQC)·B,
 * 계정 세션 하나, PDA·POP 단말(자기 공장)과 남의 공장 PDA.
 *
 * ⭐ 마스터는 접두어로 «있으면 쓴다» — 출하 완료가 원장에 행을 남기고 원장은 지울 수 없어(`block_ledger_header_mutation`)
 *    마스터를 지우면 FK 가 막는다. 거래 행(LOT·지시서·수주)은 실행마다 다른 번호(`run`)로 새로 만든다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';
import { seedRoute } from '../approval-request.fixture';

export const SS_PREFIX = 'SSE2E';
const LOGIN_ID = 'e2e-shipment-simplified';
const PASSWORD = '출하단순화-비밀번호';
const PERMISSIONS = ['M-04-01', 'W-04-01', 'W-04-02', 'W-04-03', 'W-04-12', 'W-03-09', 'W-03-10', 'W-04-04', 'W-04-05', 'W-01-01', 'W-01-15'];

export interface TerminalSession {
  terminalId: bigint;
  token: string;
  workerNo: string;
  workerId: bigint;
  plantId: bigint;
}

export interface BalanceSpec {
  warehouse: 'wh1' | 'wh2' | 'defect';
  location?: 'loc1a' | 'loc1b' | 'loc2' | 'defect';
  qty: number;
  /** 다른 작업의 피킹분 — 통째 피킹을 막는다. */
  picked?: number;
}

export interface LineSpec {
  item?: 'A' | 'B';
  allocated: number;
  requested?: number;
  /** 수주 라인을 단다 — 수주 수량(기본 = 배정). */
  salesOrdered?: number;
  inspection?: boolean;
}

export interface MadeRequest {
  requestId: number;
  requestNo: string;
  lineIds: number[];
  salesOrderLineIds: (number | null)[];
  oqcRequestIds: Record<string, number>;
}

export class ShipmentSimplifiedFixture {
  readonly run = randomUUID().slice(0, 6).toUpperCase();
  private seq = 0;
  cookie: string[] = [];
  pda!: TerminalSession;
  pop!: TerminalSession;
  foreignPda!: TerminalSession;
  readonly ids = {
    entity: 0n, unit: 0n, plant: 0n, plant2: 0n, uom: 0n, itemA: 0n, itemB: 0n, customer: 0n, shipTo: 0n,
    wh1: 0n, wh2: 0n, defect: 0n, loc1a: 0n, loc1b: 0n, loc2: 0n, locDefect: 0n, userId: 0n,
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
    this.ids.uom = (await p.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } })).uom_id;
    const entity = await ensure(
      () => p.legal_entity.findFirst({ where: { legal_entity_code: `${SS_PREFIX}-LE` } }),
      () => p.legal_entity.create({ data: { legal_entity_code: `${SS_PREFIX}-LE`, legal_entity_name: '출하단순화법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' } }),
    );
    this.ids.entity = entity.legal_entity_id;
    const unit = await ensure(
      () => p.business_unit.findFirst({ where: { business_unit_code: `${SS_PREFIX}-BU` } }),
      () => p.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${SS_PREFIX}-BU`, business_unit_name: '출하단순화사업부' } }),
    );
    this.ids.unit = unit.business_unit_id;
    const plant = async (code: string) => (await ensure(
      () => p.plant.findFirst({ where: { plant_code: `${SS_PREFIX}-${code}` } }),
      () => p.plant.create({ data: { legal_entity_id: entity.legal_entity_id, plant_code: `${SS_PREFIX}-${code}`, plant_name: `출하단순화공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh' } }),
    )).plant_id;
    this.ids.plant = await plant('P1');
    this.ids.plant2 = await plant('P2');

    const warehouse = async (code: string, isDefect: boolean) => (await ensure(
      () => p.warehouse.findFirst({ where: { warehouse_code: `${SS_PREFIX}-${code}` } }),
      () => p.warehouse.create({ data: {
        plant_id: this.ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${SS_PREFIX}-${code}`,
        warehouse_name: `출하단순화${code}`, warehouse_type_code: 'PRODUCT', management_level_code: 'LOCATION', is_defect: isDefect,
      } }),
    )).warehouse_id;
    this.ids.wh1 = await warehouse('WH1', false);
    this.ids.wh2 = await warehouse('WH2', false);
    this.ids.defect = await warehouse('DEF', true);
    const location = async (warehouseId: bigint, code: string) => (await ensure(
      () => p.location.findFirst({ where: { warehouse_id: warehouseId, location_code: `${SS_PREFIX}-${code}` } }),
      () => p.location.create({ data: { warehouse_id: warehouseId, location_code: `${SS_PREFIX}-${code}`, location_name: `출하단순화${code}`, location_type_code: 'BIN' } }),
    )).location_id;
    this.ids.loc1a = await location(this.ids.wh1, 'L1A');
    this.ids.loc1b = await location(this.ids.wh1, 'L1B');
    this.ids.loc2 = await location(this.ids.wh2, 'L2');
    this.ids.locDefect = await location(this.ids.defect, 'LD');

    const item = async (code: string) => (await ensure(
      () => p.item.findFirst({ where: { item_code: `${SS_PREFIX}-${code}` } }),
      () => p.item.create({ data: { item_code: `${SS_PREFIX}-${code}`, item_name: `출하단순화품목${code}`, item_type_code: 'FINISHED_GOOD', base_uom_id: this.ids.uom, lot_controlled: true } }),
    )).item_id;
    this.ids.itemA = await item('A');
    this.ids.itemB = await item('B');
    const partner = async (code: string) => (await ensure(
      () => p.partner.findFirst({ where: { partner_code: `${SS_PREFIX}-${code}` } }),
      () => p.partner.create({ data: { partner_code: `${SS_PREFIX}-${code}`, partner_name: `출하단순화${code}`, erp_partner_code: `${SS_PREFIX}${code}` } }),
    )).partner_id;
    this.ids.customer = await partner('C');
    this.ids.shipTo = await partner('S');

    await this.makeUser();
    this.pda = await this.terminal('PDA1', 'MOBILE', this.ids.plant);
    this.pop = await this.terminal('POP1', 'POP', this.ids.plant);
    this.foreignPda = await this.terminal('PDA2', 'MOBILE', this.ids.plant2);
  }

  private async terminal(code: string, type: 'MOBILE' | 'POP', plantId: bigint): Promise<TerminalSession> {
    const p = this.prisma;
    const terminal = (await p.terminal.findFirst({ where: { terminal_code: `${SS_PREFIX}-${code}` } }))
      ?? await p.terminal.create({ data: { terminal_code: `${SS_PREFIX}-${code}`, plant_id: plantId, terminal_type_code: type, status_code: 'RUNNING' } });
    const worker = (await p.worker.findFirst({ where: { worker_no: `${SS_PREFIX}-W-${code}` } }))
      ?? await p.worker.create({ data: {
        worker_no: `${SS_PREFIX}-W-${code}`, worker_name: `출하단순화작업자${code}`, business_unit_id: this.ids.unit, plant_id: plantId, status_code: 'EMPLOYED',
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
      user = await p.app_user.create({ data: { login_id: LOGIN_ID, user_name: '출하단순화검사', status_code: 'EMPLOYED' } });
      await p.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
      const role = await p.role.create({ data: { role_code: `${SS_PREFIX}-ROLE`, role_name: '출하단순화검사용' } });
      await p.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      await p.user_data_scope.create({ data: { app_user_id: user.app_user_id, business_unit_id: this.ids.unit, plant_id: this.ids.plant } });
    }
    // 권한은 매번 맞춘다 — 마스터를 다시 쓰므로 앞 실행의 권한 목록이 남아 있을 수 있다.
    const role = await p.role.findUniqueOrThrow({ where: { role_code: `${SS_PREFIX}-ROLE` } });
    await p.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })), skipDuplicates: true,
    });
    this.ids.userId = user.app_user_id;
    // 관리웹 검사 저장은 계정에 지정된 작업자가 검사자다(`resolveInspector`).
    if ((await p.worker.findFirst({ where: { worker_no: `${SS_PREFIX}-W-WEB` } })) === null) {
      await p.worker.create({ data: {
        worker_no: `${SS_PREFIX}-W-WEB`, worker_name: '출하단순화관리자', business_unit_id: this.ids.unit, plant_id: this.ids.plant,
        status_code: 'EMPLOYED', app_user_id: user.app_user_id,
      } });
    }
    const response = await this.http().post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    this.cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 제품 LOT + 잔액 행. */
  async lot(spec: { item?: 'A' | 'B'; balances: BalanceSpec[]; status?: string; plant?: bigint }): Promise<{ lotId: number; lotNo: string }> {
    const p = this.prisma;
    const itemId = spec.item === 'B' ? this.ids.itemB : this.ids.itemA;
    const lotNo = `${SS_PREFIX}-${this.run}-LOT-${this.next()}`;
    const lot = await p.lot.create({ data: {
      lot_no: lotNo, item_id: itemId, lot_type_code: 'PRODUCT', plant_id: spec.plant ?? this.ids.plant, initial_qty: 1000,
      uom_id: this.ids.uom, source_type_code: 'WORK_ORDER', source_id: 1, status_code: spec.status ?? 'NORMAL',
    } });
    const locationOf: Record<BalanceSpec['warehouse'], bigint> = { wh1: this.ids.loc1a, wh2: this.ids.loc2, defect: this.ids.locDefect };
    for (const balance of spec.balances) {
      const warehouseId = balance.warehouse === 'wh1' ? this.ids.wh1 : balance.warehouse === 'wh2' ? this.ids.wh2 : this.ids.defect;
      const locationId = balance.location === undefined ? locationOf[balance.warehouse] : this.ids[balance.location === 'defect' ? 'locDefect' : balance.location];
      await p.inventory_balance.create({ data: {
        legal_entity_id: this.ids.entity, business_unit_id: this.ids.unit, plant_id: this.ids.plant,
        warehouse_id: warehouseId, location_id: locationId, item_id: itemId, lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
        on_hand_qty: balance.qty, picked_qty: balance.picked ?? 0, uom_id: this.ids.uom,
      } });
    }
    return { lotId: Number(lot.lot_id), lotNo };
  }

  /** 지시서 + 라인 + (수주) + 검사 필요 라인 품목마다 OQC 의뢰(편성과 같은 모양 — 품목별 헤더 대상). */
  async request(lines: LineSpec[], options: { plant?: bigint | null } = {}): Promise<MadeRequest> {
    const p = this.prisma;
    const n = this.next();
    const requestNo = `${SS_PREFIX}-${this.run}-SR-${n}`;
    const withOrder = lines.some((line) => line.salesOrdered !== undefined);
    const order = withOrder ? await p.sales_order.create({
      data: {
        sales_order_no: `${SS_PREFIX}-${this.run}-SO-${n}`, erp_sales_order_no: `ERP${this.run}${n}`, erp_movement_type_code: 'S01',
        customer_id: this.ids.customer, ship_to_partner_id: this.ids.shipTo, order_date: new Date('2026-11-18T00:00:00.000Z'), status_code: 'RECEIVED',
        sales_order_line: { create: lines.flatMap((line, index) => line.salesOrdered === undefined ? [] : [{
          line_no: index + 1, item_id: line.item === 'B' ? this.ids.itemB : this.ids.itemA, uom_id: this.ids.uom,
          ordered_qty: line.salesOrdered, erp_storage_location_code: 'SL01',
        }]) },
      },
      include: { sales_order_line: true },
    }) : null;
    const header = await p.shipment_request.create({ data: {
      shipment_request_no: requestNo, customer_id: this.ids.customer, ship_to_partner_id: this.ids.shipTo,
      fulfillment_plant_id: options.plant === undefined ? this.ids.plant : options.plant,
      requested_ship_date: new Date('2026-11-18T00:00:00.000Z'), status_code: 'REGISTERED', sales_order_id: order?.sales_order_id ?? null,
    } });
    const lineIds: number[] = [];
    const salesOrderLineIds: (number | null)[] = [];
    for (const [index, line] of lines.entries()) {
      const orderLine = order?.sales_order_line.find((row) => row.line_no === index + 1) ?? null;
      const itemId = line.item === 'B' ? this.ids.itemB : this.ids.itemA;
      const created = await p.shipment_request_line.create({ data: {
        shipment_request_id: header.shipment_request_id, line_no: index + 1, item_id: itemId, uom_id: this.ids.uom,
        requested_qty: line.requested ?? line.allocated, allocated_qty: line.allocated,
        sales_order_line_id: orderLine?.sales_order_line_id ?? null,
        shipping_inspection_required: line.inspection ?? (line.item ?? 'A') === 'A',
      } });
      lineIds.push(Number(created.shipment_request_line_id));
      salesOrderLineIds.push(orderLine === null ? null : Number(orderLine.sales_order_line_id));
    }
    const oqcRequestIds: Record<string, number> = {};
    for (const [index, line] of lines.entries()) {
      const item = line.item ?? 'A';
      if (!(line.inspection ?? item === 'A') || oqcRequestIds[item] !== undefined) continue;
      const created = await p.inspection_request.create({ data: {
        inspection_request_no: `${SS_PREFIX}-${this.run}-IRQ-${n}-${index}`, inspection_type_code: 'OQC',
        target_type_code: 'SHIPMENT_REQUEST', target_id: header.shipment_request_id, item_id: item === 'B' ? this.ids.itemB : this.ids.itemA,
        target_qty: line.allocated, uom_id: this.ids.uom, status_code: 'REQUESTED', requested_at: new Date('2026-11-18T01:00:00.000Z'),
      } });
      oqcRequestIds[item] = Number(created.inspection_request_id);
    }
    return { requestId: Number(header.shipment_request_id), requestNo, lineIds, salesOrderLineIds, oqcRequestIds };
  }

  asTerminal(test: request.Test, session: TerminalSession): request.Test {
    return test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  asSession(test: request.Test): request.Test {
    return test.set('Cookie', this.cookie);
  }

  /** OQC 결과 저장(기본은 POP) — 새 흐름은 수량 칸을 무시하므로 0 을 싣는다. */
  oqcResult(
    inspectionRequestId: number,
    body: { matchedLotIds?: number[]; overallJudgmentCode?: string; reinspectionReasonCode?: string; statusCode?: string; serials?: unknown[] },
    session: TerminalSession | 'session' = this.pop,
  ): request.Test {
    const test = this.http().post('/api/quality/inspection-results').set('Idempotency-Key', randomUUID()).send({
      inspectionRequestId, inspectedQty: 0, acceptedQty: 0, rejectedQty: 0, heldQty: 0, uomId: Number(this.ids.uom),
      inspectedAt: '2026-11-18T03:00:00.000Z', statusCode: 'DRAFT', ...body,
    });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** 지시서 상세의 피킹 LOT(라인 순서대로 평탄화). */
  async lotsOf(made: MadeRequest): Promise<{ lotId: number; shipmentRequestLotId: number; statusCode: string; oqcLotStatus: string | null }[]> {
    const response = await this.asSession(this.http().get(`/api/logistics/shipment-requests/${made.requestId}`)).expect(200);
    return (response.body.lines as { lots: { lotId: number; shipmentRequestLotId: number; statusCode: string; oqcLotStatus: string | null }[] }[])
      .flatMap((line) => line.lots);
  }

  /** PDA [교체](기본은 자기 공장 PDA). */
  replaceLot(shipmentRequestLotId: number, session: TerminalSession | 'session' = this.pda): request.Test {
    const test = this.http().post(`/api/logistics/shipment-request-lots/${shipmentRequestLotId}:replace`).set('Idempotency-Key', randomUUID()).send();
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** 출하 관리 코드 저장(기본은 자기 공장 PDA). */
  saveCode(shipmentRequestLotId: number, managementCode: string | null, session: TerminalSession | 'session' = this.pda): request.Test {
    const test = this.http().put(`/api/logistics/shipment-request-lots/${shipmentRequestLotId}/management-code`)
      .set('Idempotency-Key', randomUUID()).send({ managementCode });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** POP 출하 완료(기본은 자기 공장 POP). */
  complete(made: MadeRequest, session: TerminalSession | 'session' = this.pop, key: string = randomUUID()): request.Test {
    const test = this.http().post(`/api/logistics/shipment-requests/${made.requestId}:complete`).set('Idempotency-Key', key)
      .send({ businessDate: '2026-11-18', occurredAt: '2026-11-18T05:00:00.000Z' });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** 지시서 코드 해석(기본은 자기 공장 POP). */
  lookup(code: string, session: TerminalSession | 'session' = this.pop): request.Test {
    const test = this.http().get('/api/logistics/shipment-requests:lookup').query({ code });
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }

  /** 출하 상세(관리웹 세션). */
  async shipment(shipmentId: number): Promise<{ body: Record<string, unknown> & { versionNo: number }; etag: string }> {
    const response = await this.asSession(this.http().get(`/api/logistics/shipments/${shipmentId}`)).expect(200);
    return { body: response.body, etag: response.headers.etag as string };
  }

  /** 취소 상신(관리웹 W-04-12). */
  async requestCancel(shipmentId: number): Promise<request.Response> {
    const { etag } = await this.shipment(shipmentId);
    return this.asSession(this.http().post(`/api/logistics/shipments/${shipmentId}:request-cancel`)
      .set('Idempotency-Key', randomUUID()).set('If-Match', etag).send({ reason: '고객 요청 — 출하 취소' }));
  }

  /** 취소 실행 — 결재 승인은 이 시험의 관심 밖이라 열린 결재를 바로 승인으로 둔다. */
  async cancelApproved(shipmentId: number): Promise<request.Response> {
    await this.prisma.approval_request.updateMany({
      where: { target_type_code: 'SHIPMENT', target_id: BigInt(shipmentId), approval_type_code: 'SHIPMENT_CANCEL', status_code: 'PENDING' },
      data: { status_code: 'APPROVED', decided_at: new Date(), decided_by: this.ids.userId },
    });
    const { etag } = await this.shipment(shipmentId);
    return this.asSession(this.http().post(`/api/logistics/shipments/${shipmentId}:cancel`)
      .set('Idempotency-Key', randomUUID()).set('If-Match', etag)
      .send({ businessDate: '2026-11-18', occurredAt: '2026-11-18T06:00:00.000Z' }));
  }

  /** 출하 취소 결재선 — 없을 때만 이 계정으로 하나 심는다(둘이면 ROUTE_AMBIGUOUS). */
  async ensureCancelRoute(): Promise<void> {
    const found = await this.prisma.approval_route.findFirst({ where: { approval_type_code: 'SHIPMENT_CANCEL' } });
    if (found === null) await seedRoute(this.prisma, 'SHIPMENT_CANCEL', [this.ids.userId]);
  }

  /** PDA 통째 피킹(기본은 자기 공장 PDA). */
  pickLot(made: MadeRequest, lineIndex: number, body: Record<string, unknown>, session: TerminalSession | 'session' = this.pda): request.Test {
    const test = this.http()
      .post(`/api/logistics/shipment-requests/${made.requestId}/lines/${made.lineIds[lineIndex]}:pick-lot`)
      .set('Idempotency-Key', randomUUID())
      .send(body);
    return session === 'session' ? this.asSession(test) : this.asTerminal(test, session);
  }
}
