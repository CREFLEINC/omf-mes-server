/**
 * P/O(생산오더, ERP 수신) 조회 2건(I-24 PR ①). `:acknowledge`·`:resync`·권한 403 은 PR ④ 몫이다.
 *
 * ⛔ P/O 는 이 시스템이 만들지 않는다(수신기 부재 · I-24.md §2-2) — `prisma` 로 직접
 * INSERT 한다. `production_order_change_field`·`production_order_acknowledgement` 도 같다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-po24-probe';
const PASSWORD = 'PO24-검사-비밀번호';
const PREFIX = 'PO24';
const ROLE = 'E2E_PO24';

interface ChangedField {
  field: string;
  label: string;
  beforeText: string;
  afterText: string;
  beforeQty: number | null;
}

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('P/O 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let mainBusinessUnitId = 0;
  let treeBusinessUnitId = 0;
  let plantId = 0;
  let itemId = 0;

  let orderMainId = 0;
  let orderWithPlanId = 0;
  let orderRootId = 0;
  let orderChildId = 0;
  let orderChangeFullId = 0;
  let orderChangeEmptyId = 0;

  const T1 = new Date('2026-09-01T00:00:00.000Z');
  const T2 = new Date('2026-09-10T00:00:00.000Z'); // T1 보다 뒤 — §14 재수신
  const T3 = new Date('2026-09-02T00:00:00.000Z');
  let statusNameOf: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    cookie = await login();

    const statusValues = await prisma.code_value.findMany({
      where: { code_group: { group_code: 'PRODUCTION_ORDER_STATUS' }, code: { in: ['RECEIVED', 'UPDATED'] } },
      select: { code: true, code_name: true },
    });
    statusNameOf = Object.fromEntries(statusValues.map((row) => [row.code, row.code_name]));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('목록 — 필터', () => {
    it('1. businessUnitId·plantId·itemId 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, plantId, itemId })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual(
        expect.arrayContaining([orderMainId, orderWithPlanId, orderChangeFullId, orderChangeEmptyId]),
      );
      expect(ids).not.toContain(orderRootId);
      expect(ids).not.toContain(orderChildId);
      expect(validator('GET /planning/production-orders')(response.body)).toBe(true);
    });

    it('2. dueDateFrom·dueDateTo 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, dueDateFrom: '2026-09-10', dueDateTo: '2026-09-16' })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual([orderMainId]);
    });

    it('3. q 가 P/O 번호 부분일치다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, q: 'MAIN' })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual([orderMainId]);
    });
  });

  describe('상세 — 파생 두 칸', () => {
    it('4. expandedWorkOrderCount·plannedWorkOrderCount 가 0/3 이다(계획은 있고 전개 전)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderWithPlanId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.expandedWorkOrderCount).toBe(0);
      expect(response.body.plannedWorkOrderCount).toBe(3);
    });

    it('6. 계획이 없는 P/O 는 0/0 이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderMainId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.expandedWorkOrderCount).toBe(0);
      expect(response.body.plannedWorkOrderCount).toBe(0);
    });
  });

  describe('includeChildren', () => {
    // 계약이 「**참이면** 필터·page·size·total 은 «루트 P/O» 기준」이라 한정했다 — 거짓은 루트로
    // 안 세는 «평면 목록»이다. 자식에 도달할 질의 칸이 0이라 루트만 내면 자식 P/O 가 어떤 질의로도
    // 안 보인다(I-24 리뷰 #274 §5 — 계획서 §8-4 7번 이름을 이 판정으로 정정했다).
    it('7. includeChildren 미지정은 필터 그대로의 평면 목록이다 — 자식도 실린다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: treeBusinessUnitId })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderRootId);
      expect(ids).toContain(orderChildId);
      expect(response.body.page.total).toBe(ids.length);
    });

    it('8. includeChildren=true 는 total 이 루트 수인데 items 가 더 많다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: treeBusinessUnitId, itemId, includeChildren: true })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(1);
      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual(expect.arrayContaining([orderRootId, orderChildId]));
      expect(ids.length).toBe(2);
      // bom_level asc — 루트(0)가 자식(1)보다 먼저다.
      expect(ids[0]).toBe(orderRootId);
    });
  });

  describe('withLastChange', () => {
    it('9. withLastChange=false 면 lastChange 키가 없다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.lastChange).toBeUndefined();
    });

    it('10. withLastChange=true 면 changedFields 가 수량→납기→상태 고정 순이고 label 이 옳다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      const fields: ChangedField[] = response.body.lastChange.changedFields;
      expect(fields.map((f) => f.field)).toEqual(['ORDER_QTY', 'DUE_DATE', 'STATUS_CODE']);
      expect(fields.map((f) => f.label)).toEqual(['수량', '납기', '상태']);
      expect(fields[2].beforeText).toBe(statusNameOf.RECEIVED ?? 'RECEIVED');
      expect(fields[2].afterText).toBe(statusNameOf.UPDATED ?? 'UPDATED');
      expect(validator('GET /planning/production-orders/{productionOrderId}')(response.body)).toBe(true);
    });

    it('11. beforeQty 는 ORDER_QTY 항목에만 있고 나머지는 null 이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      const fields: ChangedField[] = response.body.lastChange.changedFields;
      expect(fields.find((f) => f.field === 'ORDER_QTY')?.beforeQty).toBe(1000);
      expect(fields.find((f) => f.field === 'DUE_DATE')?.beforeQty).toBeNull();
      expect(fields.find((f) => f.field === 'STATUS_CODE')?.beforeQty).toBeNull();
    });

    it('12. 변경 행이 0건이면 changedFields 가 빈 배열이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeEmptyId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.lastChange.receivedAt).toBeDefined();
      expect(response.body.lastChange.changedFields).toEqual([]);
    });
  });

  describe('unacknowledgedOnly', () => {
    it('13. 미확인 P/O 를 낸다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, unacknowledgedOnly: true })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderChangeEmptyId);
      expect(ids).not.toContain(orderChangeFullId);
    });

    it('14. 확인한 뒤 ERP 가 또 보내면(last_change_received_at 이 뒤로 가면) 다시 미확인이다', async () => {
      await prisma.production_order.update({
        where: { production_order_id: orderChangeFullId },
        data: { last_change_received_at: T2 },
      });

      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, unacknowledgedOnly: true })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderChangeFullId);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'PO조회검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const mainUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU-M`, business_unit_name: 'PO조회검사사업부' },
    });
    mainBusinessUnitId = Number(mainUnit.business_unit_id);
    const treeUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU-T`, business_unit_name: 'PO조회계층검사사업부' },
    });
    treeBusinessUnitId = Number(treeUnit.business_unit_id);
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'PO조회검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();

    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'PO조회검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    itemId = Number(item.item_id);
    // 하위 P/O(전개 레벨)의 품목 — 루트와 다른 품목이라 itemId 필터가 자연히 하위를 뺀다(§8-4 7).
    const componentItem = await prisma.item.create({
      data: { item_code: `${PREFIX}-CI`, item_name: 'PO조회검사구성품', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    await prisma.routing_operation.createMany({
      data: [10, 20, 30].map((seq) => ({ routing_id: routing.routing_id, operation_seq: seq, process_id: process.process_id, operation_name: `공정${seq}` })),
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });

    const orderMain = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-MAIN`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        due_date: new Date('2026-09-15T00:00:00.000Z'),
        status_code: 'RECEIVED',
      },
    });
    orderMainId = Number(orderMain.production_order_id);

    const orderWithPlan = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-PLAN`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 200,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
      },
    });
    orderWithPlanId = Number(orderWithPlan.production_order_id);
    await prisma.production_plan.create({
      data: {
        production_order_id: orderWithPlan.production_order_id,
        plan_no: `${PREFIX}-PP-PLAN`,
        plan_date: new Date('2026-09-01T00:00:00.000Z'),
        planned_qty: 200,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'DRAFT',
      },
    });

    const orderRoot = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-ROOT`,
        business_unit_id: treeUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 50,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        bom_level: 0,
      },
    });
    orderRootId = Number(orderRoot.production_order_id);
    const orderChild = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHILD`,
        business_unit_id: treeUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: componentItem.item_id,
        order_qty: 50,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        parent_production_order_id: orderRoot.production_order_id,
        bom_level: 1,
      },
    });
    orderChildId = Number(orderChild.production_order_id);

    const orderChangeFull = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHFULL`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 1200,
        uom_id: uom.uom_id,
        due_date: new Date('2026-09-20T00:00:00.000Z'),
        status_code: 'UPDATED',
        last_change_received_at: T1,
      },
    });
    orderChangeFullId = Number(orderChangeFull.production_order_id);
    // 고정 순 검사용 — 저장 순서를 일부러 섞는다(상태 → 수량 → 납기).
    await prisma.production_order_change_field.createMany({
      data: [
        { production_order_id: orderChangeFull.production_order_id, field_code: 'STATUS_CODE', before_status_code: 'RECEIVED' },
        { production_order_id: orderChangeFull.production_order_id, field_code: 'ORDER_QTY', before_order_qty: 1000 },
        { production_order_id: orderChangeFull.production_order_id, field_code: 'DUE_DATE', before_due_date: new Date('2026-09-05T00:00:00.000Z') },
      ],
    });

    const orderChangeEmpty = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHEMPTY`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 300,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        last_change_received_at: T3,
      },
    });
    orderChangeEmptyId = Number(orderChangeEmpty.production_order_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'PO조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'PO조회검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-01' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    // §2-3 확인 3칸 — «확인됨» 판정용(acknowledged_at >= last_change_received_at).
    await prisma.production_order_acknowledgement.create({
      data: {
        production_order_id: orderChangeFullId,
        acknowledgement_type_code: 'PO_CHANGE',
        received_at: T1,
        acknowledged_at: T1,
        status_code: 'ACKNOWLEDGED',
        acknowledged_by: user.app_user_id,
        acknowledge_decision_code: 'APPLY',
      },
    });
  }

  async function login(): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** §8-2 — 자가 치유 `deleteMany`(역순). `beforeAll`·`afterAll` 둘 다 부른다. */
  async function cleanup(): Promise<void> {
    await prisma.production_order_acknowledgement.deleteMany({
      where: { production_order: { production_order_no: { startsWith: PREFIX } } },
    });
    await prisma.production_order_change_field.deleteMany({
      where: { production_order: { production_order_no: { startsWith: PREFIX } } },
    });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    // 자식(전개 레벨)을 먼저 지운다 — 자기참조 FK(parent_production_order_id).
    await prisma.production_order.deleteMany({ where: { production_order_no: `${PREFIX}-PO-CHILD` } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
