/**
 * 피처 019 반납 입고 e2e 의 바탕(omf-all-around#367) — 공장 둘, 생산창고 G(지정 S-01·「지정 품목만 받기」 R-01 + 적치 대기)·
 * 다른 생산창고 G2(S-21)·사람 위치 없는 생산창고 G3(창고 전체만)·현장 창고(#362 전 출고 도착 위치 FL-01)·불량창고·자재창고 MAT(M-01)·남의 공장 생산창고 G9(S-91),
 * 자재 품목 셋, W/O(공정 하나),
 * POP 셋(「반납 가능」 켬·끔·남의 공장)·PDA, 계정 세션(P-01-03·M-01-15·M-01-10·W-01-07).
 *
 * ⭐ W/O 출고는 경로(출고 요청 WORK_ORDER → 피킹 → 출고 라인)를 직접 심는다 — 피킹·출고 흐름 자체는 그 피처의 e2e 가 본다.
 * ⭐ 마스터는 접두어로 «있으면 쓴다» — 원장 행은 지울 수 없어 마스터를 지우면 FK 가 막는다. 거래 행은 실행마다 새 번호(`run`).
 * ⭐ 시험 데이터는 합성값만 쓴다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';

export const MR_PREFIX = 'MRT19';
const LOGIN_ID = 'e2e-material-return-019';
const PASSWORD = '반납입고-비밀번호';
const PERMISSIONS = ['P-01-03', 'M-01-15', 'M-01-10', 'W-01-07'];
export const RETURNS = '/api/production/material-returns';

export interface TerminalSession { terminalId: bigint; token: string; workerNo: string; workerId: bigint; plantId: bigint }

export type ItemKey = 'A' | 'B' | 'C';

/** 최종 마감(017) 대역 — 시험이 W/O 를 넣으면 그 W/O 가 최종 마감이다. */
export class FinalCloseFake {
  readonly finalized = new Set<bigint>();
  async finalizedWorkOrders(_db: unknown, ids: readonly bigint[]): Promise<Set<bigint>> {
    return new Set(ids.filter((id) => this.finalized.has(id)));
  }
}

export class MaterialReturnFixture {
  readonly run = randomUUID().slice(0, 6).toUpperCase();
  private seq = 0;
  cookie: string[] = [];
  pop!: TerminalSession;
  popOff!: TerminalSession;
  foreignPop!: TerminalSession;
  pda!: TerminalSession;
  readonly ids = {
    entity: 0n, unit: 0n, plant: 0n, plant2: 0n, uom: 0n, itemA: 0n, itemB: 0n, itemC: 0n, product: 0n,
    g: 0n, g2: 0n, floor: 0n, defect: 0n, material: 0n, foreignG: 0n, s01: 0n, r01: 0n, s21: 0n, fl01: 0n, d01: 0n, m01: 0n, s91: 0n, staging: 0n, staging2: 0n,
    g3: 0n, whole3: 0n,
    process: 0n, operation: 0n, line: 0n,
  };

  constructor(private readonly app: INestApplication, private readonly prisma: PrismaService) {}

  http() { return request(this.app.getHttpServer()); }
  next(): number { this.seq += 1; return this.seq; }
  item(key: ItemKey): bigint { return { A: this.ids.itemA, B: this.ids.itemB, C: this.ids.itemC }[key]; }

  async setup(): Promise<void> {
    const p = this.prisma;
    const ensure = async <T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> => (await find()) ?? create();
    const X = MR_PREFIX;
    this.ids.uom = (await ensure(() => p.uom.findFirst({ where: { uom_code: `${X}-EA` } }),
      () => p.uom.create({ data: { uom_code: `${X}-EA`, uom_name: '반납검사개', decimal_scale: 0 } }))).uom_id;
    const entity = await ensure(() => p.legal_entity.findFirst({ where: { legal_entity_code: `${X}-LE` } }),
      () => p.legal_entity.create({ data: { legal_entity_code: `${X}-LE`, legal_entity_name: '반납검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' } }));
    this.ids.entity = entity.legal_entity_id;
    const unit = await ensure(() => p.business_unit.findFirst({ where: { business_unit_code: `${X}-BU` } }),
      () => p.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${X}-BU`, business_unit_name: '반납검사사업부' } }));
    this.ids.unit = unit.business_unit_id;
    const plant = async (code: string) => (await ensure(() => p.plant.findFirst({ where: { plant_code: `${X}-${code}` } }),
      () => p.plant.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${X}-${code}`, plant_name: `반납검사공장${code}`, timezone_code: 'Asia/Ho_Chi_Minh' } }))).plant_id;
    this.ids.plant = await plant('P1');
    this.ids.plant2 = await plant('P2');

    const warehouse = async (code: string, type: string, isDefect = false, plantId = this.ids.plant) => (await ensure(
      () => p.warehouse.findFirst({ where: { warehouse_code: `${X}-${code}` } }),
      () => p.warehouse.create({ data: {
        plant_id: plantId, business_unit_id: unit.business_unit_id, warehouse_code: `${X}-${code}`, warehouse_name: `반납검사${code}`,
        warehouse_type_code: type, management_level_code: 'LOCATION', is_defect: isDefect,
      } }),
    )).warehouse_id;
    this.ids.g = await warehouse('G', 'PRODUCTION');
    this.ids.g2 = await warehouse('G2', 'PRODUCTION');
    // G3 에는 사람 위치를 만들지 않는다 — 나뉘지 않은 창고라 도착 위치가 창고 전체다(적치 지시 없음).
    this.ids.g3 = await warehouse('G3', 'PRODUCTION');
    this.ids.floor = await warehouse('FLOOR', 'GENERAL');
    this.ids.defect = await warehouse('DEF', 'GENERAL', true);
    this.ids.material = await warehouse('MAT', 'MATERIAL');
    this.ids.foreignG = await warehouse('G9', 'PRODUCTION', false, this.ids.plant2);
    const location = async (warehouseId: bigint, code: string, restricted = false) => (await ensure(
      () => p.location.findFirst({ where: { location_code: `${X}-${code}` } }),
      () => p.location.create({ data: { warehouse_id: warehouseId, location_code: `${X}-${code}`, location_name: `반납검사${code}`, location_type_code: 'BIN', item_restricted: restricted } }),
    )).location_id;
    this.ids.s01 = await location(this.ids.g, 'S-01');
    this.ids.r01 = await location(this.ids.g, 'R-01', true);
    this.ids.s21 = await location(this.ids.g2, 'S-21');
    this.ids.fl01 = await location(this.ids.floor, 'FL-01');
    this.ids.d01 = await location(this.ids.defect, 'D-01');
    this.ids.m01 = await location(this.ids.material, 'M-01');
    this.ids.s91 = await location(this.ids.foreignG, 'S-91');
    const staging = async (warehouseId: bigint) => (await p.location.findFirstOrThrow({ where: { warehouse_id: warehouseId, system_role_code: 'PUTAWAY_STAGING' } })).location_id;
    this.ids.staging = await staging(this.ids.g);
    this.ids.staging2 = await staging(this.ids.g2);
    this.ids.whole3 = (await p.location.findFirstOrThrow({ where: { warehouse_id: this.ids.g3, system_role_code: 'WAREHOUSE_WHOLE' } })).location_id;

    const item = async (code: string, type: string) => (await ensure(() => p.item.findFirst({ where: { item_code: `${X}-${code}` } }),
      () => p.item.create({ data: { item_code: `${X}-${code}`, item_name: `반납검사품목${code}`, item_type_code: type, base_uom_id: this.ids.uom, lot_controlled: true, serial_control_type_code: 'NONE' } }))).item_id;
    this.ids.itemA = await item('A', 'RAW_MATERIAL');
    this.ids.itemB = await item('B', 'RAW_MATERIAL');
    this.ids.itemC = await item('C', 'RAW_MATERIAL');
    this.ids.product = await item('FG', 'FINISHED_GOOD');
    // S-01 은 A·B 지정 위치, R-01 은 B 만 받는다(「지정 품목만 받기」 — A 를 두면 RESTRICTED_LOCATION).
    await p.location_item.createMany({ data: [
      { location_id: this.ids.s01, item_id: this.ids.itemA }, { location_id: this.ids.s01, item_id: this.ids.itemB },
      { location_id: this.ids.r01, item_id: this.ids.itemB },
    ], skipDuplicates: true });

    this.ids.process = (await ensure(() => p.process.findFirst({ where: { process_code: `${X}-PR` } }),
      () => p.process.create({ data: { process_code: `${X}-PR`, process_name: '반납검사공정', process_type_code: 'ASSEMBLY' } }))).process_id;
    const routing = await ensure(() => p.routing.findFirst({ where: { routing_code: `${X}-RT` } }),
      () => p.routing.create({ data: { item_id: this.ids.product, routing_code: `${X}-RT`, routing_version: 1, status_code: 'ACTIVE' } }));
    this.ids.operation = (await ensure(() => p.routing_operation.findFirst({ where: { routing_id: routing.routing_id } }),
      () => p.routing_operation.create({ data: { routing_id: routing.routing_id, process_id: this.ids.process, operation_seq: 10, operation_name: '반납검사' } }))).routing_operation_id;
    this.ids.line = (await ensure(() => p.production_line.findFirst({ where: { line_code: `${X}-LN` } }),
      () => p.production_line.create({ data: { plant_id: this.ids.plant, line_code: `${X}-LN`, line_name: '반납검사라인' } }))).production_line_id;

    await this.makeUser();
    this.pop = await this.terminal('POP1', 'POP', this.ids.plant, true);
    this.popOff = await this.terminal('POP2', 'POP', this.ids.plant, false);
    this.foreignPop = await this.terminal('POP3', 'POP', this.ids.plant2, true);
    this.pda = await this.terminal('PDA1', 'MOBILE', this.ids.plant, false);
  }

  /** 단말 하나 — POP 은 공정 매핑을 달고 `returnable` 이면 「반납 가능」을 켠다. */
  async terminal(code: string, type: 'MOBILE' | 'POP', plantId: bigint, returnable: boolean): Promise<TerminalSession> {
    const p = this.prisma;
    const terminal = (await p.terminal.findFirst({ where: { terminal_code: `${MR_PREFIX}-${code}` } }))
      ?? await p.terminal.create({ data: { terminal_code: `${MR_PREFIX}-${code}`, plant_id: plantId, terminal_type_code: type, status_code: 'RUNNING' } });
    if (type === 'POP' && (await p.terminal_process.findFirst({ where: { terminal_id: terminal.terminal_id } })) === null) {
      await p.terminal_process.create({ data: { terminal_id: terminal.terminal_id, process_id: this.ids.process, can_print_label: true, can_return_material: returnable } });
    }
    const worker = (await p.worker.findFirst({ where: { worker_no: `${MR_PREFIX}-W-${code}` } }))
      ?? await p.worker.create({ data: { worker_no: `${MR_PREFIX}-W-${code}`, worker_name: `반납검사작업자${code}`, business_unit_id: this.ids.unit, plant_id: plantId, status_code: 'EMPLOYED' } });
    return {
      terminalId: terminal.terminal_id, workerNo: worker.worker_no, workerId: worker.worker_id, plantId,
      token: this.app.get(JwtService).sign({ sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(plantId) }),
    };
  }

  private async makeUser(): Promise<void> {
    const p = this.prisma;
    let user = await p.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user === null) {
      user = await p.app_user.create({ data: { login_id: LOGIN_ID, user_name: '반납검사', status_code: 'EMPLOYED' } });
      await p.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
      const role = await p.role.create({ data: { role_code: `${MR_PREFIX}-ROLE`, role_name: '반납검사용' } });
      await p.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
      await p.user_data_scope.create({ data: { app_user_id: user.app_user_id, business_unit_id: this.ids.unit, plant_id: this.ids.plant } });
    }
    const role = await p.role.findUniqueOrThrow({ where: { role_code: `${MR_PREFIX}-ROLE` } });
    await p.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })), skipDuplicates: true });
    const response = await this.http().post('/api/app/sessions').set('Idempotency-Key', randomUUID()).send({ loginId: LOGIN_ID, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    this.cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  async workOrder(): Promise<{ workOrderId: bigint; workOrderNo: string }> {
    const workOrderNo = `${MR_PREFIX}-${this.run}-WO-${this.next()}`;
    const created = await this.prisma.work_order.create({ data: {
      work_order_no: workOrderNo, routing_operation_id: this.ids.operation, item_id: this.ids.product, order_qty: 1000,
      uom_id: this.ids.uom, production_line_id: this.ids.line, status_code: 'IN_PROGRESS',
    } });
    return { workOrderId: created.work_order_id, workOrderNo };
  }

  /** 자재 LOT(기본 정상·입하 원천). 재고 행은 만들지 않는다 — 출고된 LOT 은 창고 재고가 없다. */
  async lot(key: ItemKey = 'A', over: { lotType?: string; status?: string; plant?: bigint; parentLotId?: bigint; source?: [string, bigint] } = {}): Promise<{ lotId: bigint; lotNo: string }> {
    const lotNo = `${MR_PREFIX}-${this.run}-L${this.next()}`;
    const lot = await this.prisma.lot.create({ data: {
      lot_no: lotNo, item_id: this.item(key), lot_type_code: over.lotType ?? 'MATERIAL', plant_id: over.plant ?? this.ids.plant, initial_qty: 1000,
      uom_id: this.ids.uom, source_type_code: over.source?.[0] ?? 'INBOUND_RECEIPT_LINE', source_id: over.source?.[1] ?? 1n,
      status_code: over.status ?? 'NORMAL', lifecycle_status_code: 'ACTIVE', parent_lot_id: over.parentLotId ?? null,
    } });
    return { lotId: lot.lot_id, lotNo };
  }

  /**
   * LOT 의 W/O 출고 한 줄 — 출고 요청(유형 `requestType`) → 피킹 → 출고(G 에서) 경로를 심는다.
   * `destinationLocationId` 는 #362 전 출고(현장 위치 도착)를 흉내 낸다.
   */
  async issue(lotId: bigint, qty: number, workOrderId: bigint | null, over: {
    at?: string; status?: string; cancelled?: boolean; requestType?: string; destinationLocationId?: bigint; key?: ItemKey; warehouseId?: bigint;
  } = {}): Promise<{ goodsIssueLineId: bigint }> {
    const p = this.prisma;
    const n = this.next();
    const itemId = over.key === undefined ? (await p.lot.findUniqueOrThrow({ where: { lot_id: lotId } })).item_id : this.item(over.key);
    const warehouseId = over.warehouseId ?? this.ids.g;
    const request = await p.material_issue_request.create({ data: {
      issue_request_no: `${MR_PREFIX}-${this.run}-MIR-${n}`, work_order_id: workOrderId, status_code: 'RELEASED',
      request_type_code: over.requestType ?? 'WORK_ORDER', source_warehouse_id: warehouseId, destination_location_id: over.destinationLocationId ?? null,
      material_issue_request_line: { create: [{ line_no: 1, item_id: itemId, requested_qty: qty, uom_id: this.ids.uom }] },
    }, include: { material_issue_request_line: true } });
    const order = await p.picking_order.create({ data: {
      picking_order_no: `${MR_PREFIX}-${this.run}-PO-${n}`, picking_type_code: 'MATERIAL', source_document_type_code: 'MATERIAL_ISSUE_REQUEST',
      source_document_id: request.material_issue_request_id, warehouse_id: warehouseId, status_code: 'COMPLETED',
      picking_line: { create: [{
        line_no: 1, item_id: itemId, lot_id: lotId, location_id: this.ids.s01, planned_qty: qty, picked_qty: qty, uom_id: this.ids.uom,
        status_code: 'PICKED', material_issue_request_line_id: request.material_issue_request_line[0].material_issue_request_line_id,
      }] },
    }, include: { picking_line: true } });
    const issue = await p.goods_issue.create({ data: {
      goods_issue_no: `${MR_PREFIX}-${this.run}-GI-${n}`, issue_type_code: 'PRODUCTION', source_document_type_code: 'PICKING_ORDER',
      source_document_id: order.picking_order_id, source_warehouse_id: warehouseId, issued_at: new Date(over.at ?? '2026-11-27T01:00:00.000Z'),
      status_code: over.status ?? 'POSTED', cancelled_at: over.cancelled === true ? new Date() : null,
      ...(over.destinationLocationId === undefined ? {} : { destination_type_code: 'LOCATION', destination_id: over.destinationLocationId }),
      goods_issue_line: { create: [{
        line_no: 1, picking_line_id: order.picking_line[0].picking_line_id, item_id: itemId, lot_id: lotId, issue_qty: qty,
        uom_id: this.ids.uom, source_location_id: this.ids.s01,
      }] },
    }, include: { goods_issue_line: true } });
    return { goodsIssueLineId: issue.goods_issue_line[0].goods_issue_line_id };
  }

  /** 이 실행만의 지정 없는 위치 — 미지정 위치에 받으면 보관 품목이 붙어 다음 실행이 지정 위치로 본다. */
  async freshLocation(warehouseId: bigint): Promise<bigint> {
    const code = `${MR_PREFIX}-${this.run}-U${this.next()}`;
    return (await this.prisma.location.create({ data: { warehouse_id: warehouseId, location_code: code, location_name: code, location_type_code: 'BIN' } })).location_id;
  }

  /** 재고 행 하나(#362 전 현장 위치 재고 등). */
  async balance(lotId: bigint, key: ItemKey, warehouseId: bigint, locationId: bigint, qty: number): Promise<void> {
    await this.prisma.inventory_balance.create({ data: {
      legal_entity_id: this.ids.entity, business_unit_id: this.ids.unit, plant_id: this.ids.plant, warehouse_id: warehouseId, location_id: locationId,
      item_id: this.item(key), lot_id: lotId, quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
      on_hand_qty: qty, uom_id: this.ids.uom,
    } });
  }

  /** LOT 의 위치별 보유(0 초과만) — `[locationId, onHand, quality, inventoryStatus]`. */
  async onHand(lotId: bigint): Promise<[bigint, number, string, string][]> {
    const rows = await this.prisma.inventory_balance.findMany({ where: { lot_id: lotId, on_hand_qty: { gt: 0 } }, orderBy: { location_id: 'asc' } });
    return rows.map((row) => [row.location_id, Number(row.on_hand_qty), row.quality_status_code, row.inventory_status_code]);
  }

  as(test: request.Test, session: TerminalSession | 'session'): request.Test {
    return session === 'session' ? test.set('Cookie', this.cookie) : test.set('Authorization', `Bearer ${session.token}`).set('X-Worker-No', session.workerNo);
  }

  lookup(lotNo: string, session: TerminalSession | 'session' = this.pop): request.Test {
    return this.as(this.http().get(`${RETURNS}/lot-lookup`).query({ lotNo }), session);
  }

  /** 받는 위치 스캔(PDA) — 기본은 PDA. */
  locationLookup(locationCode: string, session: TerminalSession | 'session' = this.pda): request.Test {
    return this.as(this.http().get(`${RETURNS}/location-lookup`).query({ locationCode }), session);
  }

  async locationCode(locationId: bigint): Promise<string> {
    return (await this.prisma.location.findUniqueOrThrow({ where: { location_id: locationId } })).location_code;
  }

  /** 반납 입고 — 기본은 「반납 가능」 POP, 업무일·시각은 단말 값. */
  receive(
    lines: { lotId: bigint | number; returnQty: number; workOrderId?: bigint | number | null; destinationLocationId?: bigint | number | null; confirmUndesignated?: boolean }[],
    session: TerminalSession | 'session' = this.pop,
    over: { key?: string; businessDate?: string; occurredAt?: string; extra?: Record<string, unknown> } = {},
  ): request.Test {
    const body = {
      businessDate: over.businessDate ?? '2026-11-28', occurredAt: over.occurredAt ?? '2026-11-28T02:10:00.000Z',
      lines: lines.map((line) => ({
        ...line, lotId: Number(line.lotId),
        ...(line.workOrderId === undefined || line.workOrderId === null ? {} : { workOrderId: Number(line.workOrderId) }),
        ...(line.destinationLocationId === undefined || line.destinationLocationId === null ? {} : { destinationLocationId: Number(line.destinationLocationId) }),
      })),
      ...over.extra,
    };
    return this.as(this.http().post(RETURNS).set('Idempotency-Key', over.key ?? randomUUID()).send(body), session);
  }

  /** 반납 줄(줄 번호 순). */
  async returnLines(materialReturnId: number) {
    return this.prisma.material_return_line.findMany({ where: { material_return_id: BigInt(materialReturnId) }, orderBy: { line_no: 'asc' } });
  }

  /** 반납 한 건이 만든 적치 지시(반납 줄 순). */
  async putawayTasks(materialReturnId: number) {
    return this.prisma.putaway_task.findMany({
      where: { material_return_line: { material_return_id: BigInt(materialReturnId) } }, orderBy: { material_return_line_id: 'asc' },
    });
  }

  /** W/O·LOT 별 귀속 반납 합(017 이 빼는 값 · Q14 앞단). */
  async attributedSum(workOrderId: bigint, lotId: bigint): Promise<number> {
    const rows = await this.prisma.material_return_line.aggregate({ where: { work_order_id: workOrderId, lot_id: lotId }, _sum: { return_qty: true } });
    return Number(rows._sum.return_qty ?? new Prisma.Decimal(0));
  }
}
