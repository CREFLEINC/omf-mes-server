/**
 * 피처 016 공정 반제품(WIP) LOT e2e 의 바탕(omf-all-around#359) — 3공정 품목 ABC(공정 10·20·30, 공정 마스터 P10·P20·P30)의
 * Routing 두 Rev(같은 공정 마스터), 1공정 BOM 자재 A, 공정 하나 품목 X, 2공정 다른 품목 OTH, 각 생산계획, 계정·작업자.
 *
 * ⭐ W/O 는 계획 아래 PLANNED 로 세우고 **배포·실적·투입은 API 로** 탄다 — 이 피처가 보는 것이 그 마디들이다.
 * ⭐ 마스터는 접두어로 «있으면 쓴다» — 원장 행은 지울 수 없어(`block_ledger_header_mutation`) 마스터를 지우면 FK 가 막는다.
 *    W/O·LOT 같은 거래 행은 실행마다 다른 번호(`run`)로 새로 만든다(피처 013 픽스처와 같은 방식).
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { PrismaService } from '../../src/prisma/prisma.service';

const PASSWORD = '반제품LOT-비밀번호';
const BASE_PERMISSIONS = ['W-02-04', 'W-02-10', 'W-02-03', 'W-02-05', 'P-02-04', 'P-02-03', 'W-03-01'];
const TIMEZONE = 'Asia/Ho_Chi_Minh';

/** 품목·Routing 의 공정 자리 — `abc1_10` 은 ABC 의 Rev 1 공정 10 이다. */
export type Operation = 'abc1_10' | 'abc1_20' | 'abc1_30' | 'abc2_10' | 'abc2_20' | 'abc2_30' | 'x_10' | 'oth_10' | 'oth_20';

export interface LotRowLite {
  lot_id: bigint;
  lot_no: string;
  lot_type_code: string;
  status_code: string;
  lifecycle_status_code: string | null;
  work_order_lot_seq: number | null;
}

export class WipLotFixture {
  readonly run = randomUUID().slice(0, 6).toUpperCase();
  private seq = 0;
  cookie: string[] = [];
  readonly workerNo: string;
  readonly ids = {
    entity: 0n, unit: 0n, plant: 0n, uom: 0n, itemAbc: 0n, itemA: 0n, itemX: 0n, itemOth: 0n,
    p10: 0n, p20: 0n, p30: 0n, location: 0n, line: 0n, userId: 0n, workerId: 0n,
    planAbc1: 0n, planAbc2: 0n, planX: 0n, planOth: 0n,
  };
  readonly operations = {} as Record<Operation, bigint>;
  private readonly itemOf = {} as Record<Operation, bigint>;
  private readonly planOf = {} as Record<Operation, bigint>;

  constructor(
    private readonly app: INestApplication,
    private readonly prisma: PrismaService,
    readonly prefix: string,
    private readonly permissions: string[] = [],
  ) {
    this.workerNo = `${prefix}-WK`;
  }

  http() {
    return request(this.app.getHttpServer());
  }

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  async setup(): Promise<void> {
    const p = this.prisma;
    const P = this.prefix;
    const ensure = async <T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> => (await find()) ?? create();
    this.ids.uom = (await p.uom.findUniqueOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    const entity = await ensure(
      () => p.legal_entity.findFirst({ where: { legal_entity_code: `${P}-LE` } }),
      () => p.legal_entity.create({ data: { legal_entity_code: `${P}-LE`, legal_entity_name: `${P} 법인`, country_code: 'VN', timezone_code: TIMEZONE } }),
    );
    this.ids.entity = entity.legal_entity_id;
    const unit = await ensure(
      () => p.business_unit.findFirst({ where: { business_unit_code: `${P}-BU` } }),
      () => p.business_unit.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${P}-BU`, business_unit_name: `${P} 사업부` } }),
    );
    this.ids.unit = unit.business_unit_id;
    this.ids.plant = (await ensure(
      () => p.plant.findFirst({ where: { plant_code: `${P}-PL` } }),
      () => p.plant.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_id: unit.business_unit_id, plant_code: `${P}-PL`, plant_name: `${P} 공장`, timezone_code: TIMEZONE } }),
    )).plant_id;

    const item = async (code: string, type: string) => (await ensure(
      () => p.item.findFirst({ where: { item_code: `${P}-${code}` } }),
      () => p.item.create({ data: { item_code: `${P}-${code}`, item_name: `${P} 품목 ${code}`, item_type_code: type, base_uom_id: this.ids.uom, lot_controlled: true } }),
    )).item_id;
    this.ids.itemAbc = await item('ABC', 'FINISHED');
    this.ids.itemA = await item('A', 'RAW_MATERIAL');
    this.ids.itemX = await item('X', 'FINISHED');
    this.ids.itemOth = await item('OTH', 'FINISHED');

    const process = async (code: string, name: string) => (await ensure(
      () => p.process.findFirst({ where: { process_code: `${P}-${code}` } }),
      () => p.process.create({ data: { process_code: `${P}-${code}`, process_name: name, process_type_code: 'MACHINING' } }),
    )).process_id;
    this.ids.p10 = await process('P10', '가공');
    this.ids.p20 = await process('P20', '조립');
    this.ids.p30 = await process('P30', '포장');

    const warehouse = await ensure(
      () => p.warehouse.findFirst({ where: { warehouse_code: `${P}-WH` } }),
      () => p.warehouse.create({ data: {
        plant_id: this.ids.plant, business_unit_id: unit.business_unit_id, warehouse_code: `${P}-WH`, warehouse_name: `${P} 창고`,
        warehouse_type_code: 'GENERAL', management_level_code: 'WAREHOUSE',
      } }),
    );
    this.ids.location = (await ensure(
      () => p.location.findFirst({ where: { warehouse_id: warehouse.warehouse_id, location_code: `${P}-WH-01` } }),
      () => p.location.create({ data: { warehouse_id: warehouse.warehouse_id, location_code: `${P}-WH-01`, location_name: `${P} 자리`, location_type_code: 'DEFAULT' } }),
    )).location_id;
    this.ids.line = (await ensure(
      () => p.production_line.findFirst({ where: { line_code: `${P}-LN` } }),
      () => p.production_line.create({ data: { plant_id: this.ids.plant, line_code: `${P}-LN`, line_name: `${P} 라인` } }),
    )).production_line_id;

    const steps: Record<string, [Operation, number, bigint][]> = {
      ABC1: [['abc1_10', 10, this.ids.p10], ['abc1_20', 20, this.ids.p20], ['abc1_30', 30, this.ids.p30]],
      // 두 번째 Rev — 같은 공정 마스터(Q12 · FR-009). 순번도 같다.
      ABC2: [['abc2_10', 10, this.ids.p10], ['abc2_20', 20, this.ids.p20], ['abc2_30', 30, this.ids.p30]],
      X: [['x_10', 10, this.ids.p10]],
      OTH: [['oth_10', 10, this.ids.p10], ['oth_20', 20, this.ids.p20]],
    };
    const itemOfRouting: Record<string, bigint> = { ABC1: this.ids.itemAbc, ABC2: this.ids.itemAbc, X: this.ids.itemX, OTH: this.ids.itemOth };
    const planKey: Record<string, 'planAbc1' | 'planAbc2' | 'planX' | 'planOth'> = { ABC1: 'planAbc1', ABC2: 'planAbc2', X: 'planX', OTH: 'planOth' };
    for (const [code, ops] of Object.entries(steps)) {
      const itemId = itemOfRouting[code];
      const version = code === 'ABC2' ? 2 : 1;
      const routing = await ensure(
        () => p.routing.findFirst({ where: { routing_code: `${P}-RT-${code}` } }),
        () => p.routing.create({ data: { item_id: itemId, routing_code: `${P}-RT-${code}`, routing_version: version, status_code: 'CONFIRMED' } }),
      );
      for (const [key, seqNo, processId] of ops) {
        this.operations[key] = (await ensure(
          () => p.routing_operation.findFirst({ where: { routing_id: routing.routing_id, operation_seq: seqNo } }),
          () => p.routing_operation.create({ data: { routing_id: routing.routing_id, operation_seq: seqNo, process_id: processId, operation_name: `${code}-${seqNo}` } }),
        )).routing_operation_id;
        this.itemOf[key] = itemId;
      }
      const bom = await ensure(
        () => p.bom.findFirst({ where: { bom_code: `${P}-BOM-${code}` } }),
        async () => {
          const created = await p.bom.create({ data: {
            parent_item_id: itemId, bom_code: `${P}-BOM-${code}`, bom_version: version, status_code: 'CONFIRMED',
            effective_from: new Date('2026-01-01T00:00:00.000Z'), base_qty: 1, base_uom_id: this.ids.uom,
          } });
          // 자재 A 는 1공정에서만 쓴다 — 다음 공정의 투입은 반제품이다.
          await p.bom_component.create({ data: {
            bom_id: created.bom_id, component_item_id: this.ids.itemA, required_qty: 1, routing_operation_id: this.operations[ops[0][0]],
            uom_id: this.ids.uom, sequence_no: 1,
          } });
          return created;
        },
      );
      const order = await ensure(
        () => p.production_order.findFirst({ where: { production_order_no: `${P}-PO-${code}` } }),
        () => p.production_order.create({ data: {
          production_order_no: `${P}-PO-${code}`, business_unit_id: unit.business_unit_id, plant_id: this.ids.plant,
          item_id: itemId, order_qty: 1000, uom_id: this.ids.uom, status_code: 'RECEIVED',
        } }),
      );
      const plan = await ensure(
        () => p.production_plan.findFirst({ where: { plan_no: `${P}-PP-${code}` } }),
        () => p.production_plan.create({ data: {
          production_order_id: order.production_order_id, plan_no: `${P}-PP-${code}`, plan_date: new Date('2026-11-25T00:00:00.000Z'),
          planned_qty: 1000, uom_id: this.ids.uom, bom_id: bom.bom_id, routing_id: routing.routing_id, status_code: 'CONFIRMED',
        } }),
      );
      this.ids[planKey[code]] = plan.production_plan_id;
      for (const [key] of ops) this.planOf[key] = plan.production_plan_id;
    }

    const worker = await ensure(
      () => p.worker.findFirst({ where: { worker_no: this.workerNo } }),
      () => p.worker.create({ data: { worker_no: this.workerNo, worker_name: `${P} 작업자`, business_unit_id: unit.business_unit_id, plant_id: this.ids.plant, status_code: 'EMPLOYED' } }),
    );
    this.ids.workerId = worker.worker_id;
    await this.login();
  }

  private async login(): Promise<void> {
    const p = this.prisma;
    const loginId = `e2e-${this.prefix.toLowerCase()}`;
    const roleCode = `${this.prefix}-ROLE`;
    let user = await p.app_user.findUnique({ where: { login_id: loginId } });
    if (user === null) {
      user = await p.app_user.create({ data: { login_id: loginId, user_name: `${this.prefix} 검사`, status_code: 'EMPLOYED' } });
      await p.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
      const role = await p.role.create({ data: { role_code: roleCode, role_name: `${this.prefix} 검사용` } });
      await p.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    const role = await p.role.findUniqueOrThrow({ where: { role_code: roleCode } });
    await p.role_permission.createMany({
      data: [...BASE_PERMISSIONS, ...this.permissions].map((permission_code) => ({ role_id: role.role_id, permission_code })),
      skipDuplicates: true,
    });
    this.ids.userId = user.app_user_id;
    const response = await this.http().post('/api/app/sessions').set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD }).expect(200);
    const raw: unknown = response.headers['set-cookie'];
    this.cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 그 공정의 W/O 하나(PLANNED) — 배포 전이다. */
  async plannedWorkOrder(operation: Operation, orderQty = 100): Promise<bigint> {
    const row = await this.prisma.work_order.create({ data: {
      work_order_no: `${this.prefix}-${this.run}-WO${this.next()}`,
      production_plan_id: this.planOf[operation],
      routing_operation_id: this.operations[operation],
      item_id: this.itemOf[operation],
      order_qty: orderQty,
      uom_id: this.ids.uom,
      status_code: 'PLANNED',
      production_line_id: this.ids.line,
      default_wip_location_id: this.ids.location,
      default_fg_location_id: this.ids.location,
      default_scrap_location_id: this.ids.location,
    } });
    return row.work_order_id;
  }

  release(workOrderId: bigint, lotSize: number): request.Test {
    return this.http()
      .post(`/api/production/work-orders/${workOrderId}:release`)
      .set('Cookie', this.cookie)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '1')
      .send({ lotSize });
  }

  /** 계획 → 배포(API) → 선발행 슬롯. */
  async releasedWorkOrder(operation: Operation, orderQty = 100, lotSize = orderQty): Promise<{ workOrderId: bigint; lots: LotRowLite[] }> {
    const workOrderId = await this.plannedWorkOrder(operation, orderQty);
    await this.release(workOrderId, lotSize).expect(200);
    return { workOrderId, lots: await this.slots(workOrderId) };
  }

  slots(workOrderId: bigint): Promise<LotRowLite[]> {
    return this.prisma.lot.findMany({
      where: { source_type_code: 'WORK_ORDER', source_id: workOrderId },
      orderBy: { work_order_lot_seq: 'asc' },
      select: { lot_id: true, lot_no: true, lot_type_code: true, status_code: true, lifecycle_status_code: true, work_order_lot_seq: true },
    });
  }

  /** 실적(양품 `qty`)을 그 LOT 에 배분 — POP 생산 작업 경로. */
  result(workOrderId: bigint, lotId: bigint, qty: number, occurredAt: string): request.Test {
    return this.http()
      .post('/api/production/production-results')
      .set('Cookie', this.cookie)
      .set('Idempotency-Key', randomUUID())
      .set('X-Worker-No', this.workerNo)
      .send({
        workOrderId: Number(workOrderId), uomId: Number(this.ids.uom), resultSourceCode: 'MANUAL', occurredAt, goodQty: qty,
        lotAllocations: [{ lotId: Number(lotId), allocatedQty: qty }],
      });
  }

  /** 자재 투입 — POP 자재 투입 경로. `itemId` 는 스캔한 LOT 의 품목이다. */
  consume(workOrderId: bigint, lot: { lotId: bigint; itemId: bigint }, qty: number, occurredAt: string, key = randomUUID()): request.Test {
    return this.http()
      .post('/api/production/material-consumptions')
      .set('Cookie', this.cookie)
      .set('Idempotency-Key', key)
      .set('X-Worker-No', this.workerNo)
      .send({
        workOrderId: Number(workOrderId), itemId: Number(lot.itemId), lotId: Number(lot.lotId), inputQty: qty,
        uomId: Number(this.ids.uom), occurredAt,
      });
  }

  /** 정상 자재 A LOT — 1공정 투입용. */
  async materialLot(qty = 1000): Promise<bigint> {
    const lot = await this.prisma.lot.create({ data: {
      lot_no: `${this.prefix}-${this.run}-A${this.next()}`, item_id: this.ids.itemA, lot_type_code: 'MATERIAL', plant_id: this.ids.plant,
      initial_qty: qty, uom_id: this.ids.uom, source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: 'NORMAL',
    } });
    return lot.lot_id;
  }

  getLot(lotId: bigint): request.Test {
    return this.http().get(`/api/trace/lots/${lotId}`).set('Cookie', this.cookie);
  }

  listLots(query: Record<string, string | number | boolean>): request.Test {
    return this.http().get('/api/trace/lots').query(query).set('Cookie', this.cookie);
  }
}
