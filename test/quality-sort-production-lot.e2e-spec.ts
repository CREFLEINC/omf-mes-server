/**
 * 처분 «선별»(SORT) — 생산 LOT · BOM · 재고 (e2e · omf-all-around#108 · 장부 P-53).
 *
 * BOM 이 붙은 생산 LOT(재고 한 위치)을 양품 70 / 불량 30 으로 나눈다 — 자식 LOT 은 `bom_id`·`bom_version` 을 «함께»
 * 옮기고(ck_lot_bom_snapshot), 원장이 같은 위치에서 30 을 옮기고, 불량분이 새 부적합(판정 대기)으로 선다.
 * IQC 자재 LOT(BOM·재고 없음)의 선별은 quality-iqc-rejection-flow 경로 ② 가 본다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'SORTPL';
const LOGIN_ID = 'e2e-sort-production-lot';
const PASSWORD = '선별-생산LOT-비밀번호';
const ITEM_CODE = `${PREFIX}-ITEM`;
const ROLE = 'E2E_SORT_PRODUCTION_LOT';
// 처분(W-03-10).
const PERMISSIONS = ['W-03-10'];
const DAY = '2026-10-16';

const key = (): string => randomUUID();

describe('처분 선별 — 생산 LOT (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId: bigint;
  const ids = {
    legalEntity: 0n, businessUnit: 0n, plant: 0n, item: 0n, uom: 0n,
    warehouse: 0n, location: 0n, bom: 0n, bomVersion: 0,
  };
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeMasters();
    await makeUser();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⭐ 선별 — BOM 있는 생산 LOT 의 불량분이 BOM 을 그대로 가진 자식 LOT 으로 갈리고 재고·부적합이 따라간다', async () => {
    const { lotId, lotNo } = await productionLot(100, 'DEFECTIVE', { stock: 100 });
    const nc = await nonconformance(lotId, 100, 'DEFECTIVE');

    const response = await decide(nc, {
      dispositionTypeCode: 'SORT', decisionQty: 100, acceptedQty: 70, rejectedQty: 30, businessDate: DAY,
    }).expect(201);

    const child = await prisma.lot.findFirstOrThrow({ where: { parent_lot_id: lotId } });
    expect(response.body.sortResult).toMatchObject({ splitLotId: Number(child.lot_id), splitLotNo: `${lotNo}-S1` });
    // ⭐ ck_lot_bom_snapshot — id 와 버전이 짝으로 옮겨 간다(41eab06).
    expect(child).toMatchObject({
      lot_no: `${lotNo}-S1`, bom_id: ids.bom, bom_version: ids.bomVersion, status_code: 'DEFECTIVE',
      source_type_code: 'LOT_SPLIT', source_id: lotId,
    });
    expect(await lotStatus(lotId)).toBe('NORMAL');

    // 같은 위치에서 30 이 원 LOT → 자식 LOT 으로 — 위치 합은 그대로 100 이다.
    expect(await onHand(lotId)).toBe(70);
    expect(await onHand(child.lot_id)).toBe(30);
    const relation = await prisma.lot_relation.findFirstOrThrow({ where: { source_lot_id: lotId, target_lot_id: child.lot_id } });
    expect(relation).toMatchObject({ relation_type_code: 'SPLIT' });
    expect(Number(relation.relation_qty)).toBe(30);

    const transitions = await prisma.lot_status_event.findMany({
      where: { lot_id: { in: [lotId, child.lot_id] }, transition_code: { in: ['C23', 'C24'] } },
      select: { lot_id: true, transition_code: true },
    });
    expect(transitions).toEqual(expect.arrayContaining([
      { lot_id: lotId, transition_code: 'C23' },
      { lot_id: child.lot_id, transition_code: 'C24' },
    ]));

    // 불량분은 새 부적합(판정 대기)으로 — 다음 처분이 원 LOT(양품)을 건드리지 않는다.
    const split = await prisma.nonconformance_lot.findFirstOrThrow({
      where: { lot_id: child.lot_id }, select: { affected_qty: true, nonconformance: { select: { status_code: true, nonconformance_id: true } } },
    });
    expect(split.nonconformance.status_code).toBe('PENDING_DECISION');
    expect(Number(split.affected_qty)).toBe(30);
    expect(response.body.sortResult.splitNonconformanceId).toBe(Number(split.nonconformance.nonconformance_id));
    // 원 부적합은 다 판정돼 닫힌다.
    expect((await prisma.nonconformance.findUniqueOrThrow({ where: { nonconformance_id: nc } })).status_code).toBe('DECIDED');
  });

  it('⛔ 선별 — 양품 + 불량 ≠ 판정 수량이면 400 이고 아무것도 갈리지 않는다', async () => {
    const { lotId } = await productionLot(50, 'DEFECTIVE', { stock: 50 });
    const nc = await nonconformance(lotId, 50, 'DEFECTIVE');

    await decide(nc, {
      dispositionTypeCode: 'SORT', decisionQty: 50, acceptedQty: 30, rejectedQty: 10, businessDate: DAY,
    }).expect(400);

    expect(await prisma.lot.count({ where: { parent_lot_id: lotId } })).toBe(0);
    expect(await onHand(lotId)).toBe(50);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function decide(nonconformanceId: bigint, body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/nonconformances/${String(nonconformanceId)}/disposition-decisions`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', 'W/"1"')
      .send({ uomId: Number(ids.uom), reason: 'e2e 처분', ...body });
  }

  /** BOM 이 붙은 생산 LOT. 재고(`stock`)를 주면 한 위치에 그만큼 둔다. */
  async function productionLot(
    qty: number,
    status: string,
    opts: { stock?: number } = {},
  ): Promise<{ lotId: bigint; lotNo: string }> {
    seq += 1;
    const lot = await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${String(seq)}`, item_id: ids.item, lot_type_code: 'PRODUCTION', plant_id: ids.plant,
      initial_qty: qty, uom_id: ids.uom, source_type_code: 'WORK_ORDER', source_id: BigInt(900000 + seq),
      status_code: status, bom_id: ids.bom, bom_version: ids.bomVersion,
    } });
    if (opts.stock !== undefined) {
      await prisma.inventory_balance.create({ data: {
        legal_entity_id: ids.legalEntity, business_unit_id: ids.businessUnit, plant_id: ids.plant,
        warehouse_id: ids.warehouse, location_id: ids.location, item_id: ids.item, lot_id: lot.lot_id,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED',
        uom_id: ids.uom, on_hand_qty: opts.stock,
      } });
    }
    return { lotId: lot.lot_id, lotNo: lot.lot_no };
  }

  async function nonconformance(lotId: bigint, qty: number, lotStatusCode: string): Promise<bigint> {
    const nc = await prisma.nonconformance.create({ data: {
      nonconformance_no: `${PREFIX}-NC-${String(seq)}`, item_id: ids.item, severity_code: 'MINOR',
      description: 'e2e 부적합', status_code: 'PENDING_DECISION', opened_at: new Date(`${DAY}T01:30:00.000Z`),
      created_by: userId, updated_by: userId,
    } });
    await prisma.nonconformance_lot.create({ data: {
      nonconformance_id: nc.nonconformance_id, lot_id: lotId, affected_qty: qty, uom_id: ids.uom,
      quality_status_before_code: lotStatusCode, quality_status_after_code: lotStatusCode, created_by: userId,
    } });
    return nc.nonconformance_id;
  }

  async function lotStatus(lotId: bigint): Promise<string> {
    return (await prisma.lot.findUniqueOrThrow({ where: { lot_id: lotId }, select: { status_code: true } })).status_code;
  }

  async function onHand(lotId: bigint): Promise<number> {
    const rows = await prisma.inventory_balance.findMany({ where: { lot_id: lotId }, select: { on_hand_qty: true, location_id: true } });
    for (const row of rows) expect(row.location_id).toBe(ids.location);
    return rows.reduce((sum, row) => sum + Number(row.on_hand_qty), 0);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '선별생산LOT법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.legalEntity = entity.legal_entity_id;
    const unit = await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '선별생산LOT사업부',
    } });
    ids.businessUnit = unit.business_unit_id;
    const plant = await prisma.plant.create({ data: {
      legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: '선별생산LOT공장', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.plant = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item = await prisma.item.create({ data: {
      item_code: ITEM_CODE, item_name: '선별생산LOT품목', item_type_code: 'FINISHED_GOOD', base_uom_id: uom.uom_id, lot_controlled: true,
    } });
    ids.item = item.item_id;
    ids.bomVersion = 3;
    const bom = await prisma.bom.create({ data: {
      parent_item_id: item.item_id, bom_code: `${PREFIX}-BOM`, bom_version: ids.bomVersion, status_code: 'ACTIVE',
      effective_from: new Date('2026-01-01'), base_qty: 1, base_uom_id: uom.uom_id,
    } });
    ids.bom = bom.bom_id;
    const warehouse = await prisma.warehouse.create({ data: {
      plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH`,
      warehouse_name: '선별생산LOT창고', warehouse_type_code: 'PRODUCT', management_level_code: 'LOCATION',
    } });
    ids.warehouse = warehouse.warehouse_id;
    const location = await prisma.location.create({ data: {
      warehouse_id: warehouse.warehouse_id, location_code: `${PREFIX}-LOC`, location_name: '선별생산LOT위치', location_type_code: 'BIN',
    } });
    ids.location = location.location_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '선별생산LOT', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '선별생산LOT용' } });
    await prisma.role_permission.createMany({ data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', key())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    if (!prisma) return;
    const plantFilter = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plantFilter})`;
    const ncs = `SELECT nonconformance_id FROM quality.nonconformance WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code = '${ITEM_CODE}')`;
    await prisma.$executeRawUnsafe('TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE');
    for (const sql of [
      `DELETE FROM inventory.inventory_balance WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.disposition_decision WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_relation WHERE source_lot_id IN (${lots}) OR target_lot_id IN (${lots})`,
      `UPDATE trace.lot SET parent_lot_id = NULL WHERE plant_id IN (${plantFilter})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plantFilter})`,
      `DELETE FROM planning.bom WHERE bom_code = '${PREFIX}-BOM'`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code = '${ITEM_CODE}'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
