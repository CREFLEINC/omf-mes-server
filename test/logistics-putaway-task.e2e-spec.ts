/**
 * 적치 지시 조회 2건 + 뷰(I-12 PR ①). 완료·임시 적재 두 POST 는 PR ② 몫이다.
 *
 * ⛔ 여기서는 지시를 만들지 않는다 — 실제 `POST /logistics/goods-receipts` 로 만든다
 * (입고 스위트가 이미 못 박은 사실 — 라인마다 적치 지시가 생긴다). `temporaryOnly`·
 * `statusCode`·`assignedWorkerId`·`priorityNo` 테스트용 값은 `:complete` 없이
 * `prisma.putaway_task.update` 로 상태 칸만 직접 심는다(원장 없이).
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

const LOGIN_ID = 'e2e-pt-probe';
const PASSWORD = 'PT-검사-비밀번호';
const PREFIX = 'PTE2E';
const ROLE = 'E2E_PT';
const PERMISSIONS = ['W-01-10', 'M-01-05', 'M-01-07', 'M-04-04'];
const DAY = '2026-05-11';
const AT = '2026-05-11T02:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface TaskBody {
  putawayTaskId: number;
  warehouseId: number;
  warehouseManagementLevelCode: string;
  statusCode: string;
  priorityNo: number;
}
interface ReceiptLineDraft {
  itemId: number;
  lotId: number;
  receiptQty: number;
  uomId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  destinationLocationId: number;
}
interface ReceiptDraft {
  receiptTypeCode: string;
  plantId: number;
  warehouseId: number;
  receiptDatetime: string;
  businessDate: string;
  lines: ReceiptLineDraft[];
}
interface ReceiptResult {
  goodsReceipt: { goodsReceiptId: number };
  lines: { putawayTaskId: number | null }[];
}

describe('적치 지시 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let plantId: number;
  let warehouseId: number;
  let otherWarehouseId: number;
  let dockId: number;
  let otherDockId: number;
  let uomId: number;
  let ruledItemId: number;
  let plainItemId: number;
  let worker1Id: number;

  let goodsReceipt1Id: number;
  let lotR1: number;
  let taskR1: number;
  let taskR2: number;
  let taskR3: number;
  let taskR4: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    await makeTasks();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 goodsReceiptId 로 걸러진다', async () => {
    const { items } = await list(`goodsReceiptId=${goodsReceipt1Id}`);

    expect(items.map((task) => task.putawayTaskId)).toEqual([taskR1]);
  });

  it('⭐ 목록이 warehouseId 로 걸러지고 그 축이 goods_receipt.warehouse_id 다', async () => {
    const { items } = await list(`warehouseId=${warehouseId}`);
    const ids = items.map((task) => task.putawayTaskId);

    // 다른 창고 입고(taskR3)가 심겨 있는데도 나오지 않는다 — from_location_id 축이 아니다.
    expect(ids).toEqual(expect.arrayContaining([taskR1, taskR2, taskR4]));
    expect(ids).not.toContain(taskR3);
  });

  it('목록이 assignedWorkerId·lotId·statusCode 로 걸러진다', async () => {
    const byWorker = await list(`assignedWorkerId=${worker1Id}`);
    expect(byWorker.items.map((task) => task.putawayTaskId)).toEqual([taskR2]);

    const byLot = await list(`lotId=${lotR1}`);
    expect(byLot.items.map((task) => task.putawayTaskId)).toEqual([taskR1]);

    const byStatus = await list('statusCode=PENDING');
    const pendingIds = byStatus.items.map((task) => task.putawayTaskId);
    expect(pendingIds).toEqual(expect.arrayContaining([taskR1, taskR2, taskR4]));
    expect(pendingIds).not.toContain(taskR3);
  });

  it('⭐ temporaryOnly=true 는 COMPLETED_TEMPORARY 만 낸다', async () => {
    const { items } = await list('temporaryOnly=true');

    expect(items.map((task) => task.putawayTaskId)).toContain(taskR3);
    expect(items.every((task) => task.statusCode === 'COMPLETED_TEMPORARY')).toBe(true);
  });

  it('temporaryOnly=true 와 statusCode=PENDING 이 겹치면 빈 목록이다', async () => {
    const { items } = await list('temporaryOnly=true&statusCode=PENDING');

    expect(items).toEqual([]);
  });

  it('목록이 priority_no asc · PK asc 로 온다', async () => {
    const { items } = await list(`warehouseId=${warehouseId}`);
    const ids = items.map((task) => task.putawayTaskId);

    // priority_no: taskR2(10) < taskR1(20) = taskR4(20) — 동률은 PK(생성 순서) 로 갈린다.
    expect(ids.indexOf(taskR2)).toBeLessThan(ids.indexOf(taskR1));
    expect(ids.indexOf(taskR1)).toBeLessThan(ids.indexOf(taskR4));
  });

  it('⭐ 항목이 warehouseId·warehouseManagementLevelCode 를 채운다', async () => {
    const main = await getDetail(taskR1).expect(200);
    const validate = validator('GET /logistics/putaway-tasks/{putawayTaskId}');
    expect(validate(main.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(main.body.warehouseId).toBe(warehouseId);
    expect(main.body.warehouseManagementLevelCode).toBe('LOCATION');

    // 다른 창고 지시는 그 창고의 관리 수준을 낸다 — 하드코딩이 아니라 조인이다.
    const other = await getDetail(taskR3).expect(200);
    expect(other.body.warehouseId).toBe(otherWarehouseId);
    expect(other.body.warehouseManagementLevelCode).toBe('RACK');
  });

  it('없는 지시는 404 이고 상세는 ETag 를 내린다', async () => {
    await getDetail(999999999).expect(404);

    const response = await getDetail(taskR1).expect(200);
    expect(response.headers.etag).toBeDefined();
  });

  function getDetail(putawayTaskId: number): request.Test {
    return request(app.getHttpServer())
      .get(`/api/logistics/putaway-tasks/${putawayTaskId}`)
      .set('Cookie', cookie);
  }

  async function list(query: string): Promise<{ items: TaskBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/putaway-tasks?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/putaway-tasks');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body as { items: TaskBody[] };
  }

  async function createReceipt(draft: ReceiptDraft): Promise<ReceiptResult> {
    const response = await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(draft)
      .expect(201);
    return response.body as ReceiptResult;
  }

  /**
   * 입고 4건 — main 창고 3건(권장 있음 1 · 권장 없음 2) · 다른 창고 1건.
   * 그 뒤 완료·임시 적재 POST 없이 `prisma.putaway_task.update` 로 담당자·상태·
   * 우선순위만 직접 심는다(§8-1 — 이 값들을 내는 POST 는 PR ② 몫이다).
   */
  async function makeTasks(): Promise<void> {
    lotR1 = await makeLot(ruledItemId);
    const r1 = await createReceipt(receiptDraft(ruledItemId, lotR1, warehouseId, dockId, 10));
    goodsReceipt1Id = r1.goodsReceipt.goodsReceiptId;
    taskR1 = r1.lines[0].putawayTaskId as number;

    const lot2 = await makeLot(plainItemId);
    const r2 = await createReceipt(receiptDraft(plainItemId, lot2, warehouseId, dockId, 20));
    taskR2 = r2.lines[0].putawayTaskId as number;

    const lot3 = await makeLot(plainItemId);
    const r3 = await createReceipt(
      receiptDraft(plainItemId, lot3, otherWarehouseId, otherDockId, 30),
    );
    taskR3 = r3.lines[0].putawayTaskId as number;

    const lot4 = await makeLot(plainItemId);
    const r4 = await createReceipt(receiptDraft(plainItemId, lot4, warehouseId, dockId, 15));
    taskR4 = r4.lines[0].putawayTaskId as number;

    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR2 },
      data: { assigned_worker_id: worker1Id, priority_no: 10 },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR3 },
      data: { status_code: 'COMPLETED_TEMPORARY' },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR1 },
      data: { priority_no: 20 },
    });
    await prisma.putaway_task.update({
      where: { putaway_task_id: taskR4 },
      data: { priority_no: 20 },
    });
  }

  function receiptDraft(
    itemId: number,
    lotId: number,
    forWarehouseId: number,
    destinationLocationId: number,
    receiptQty: number,
  ): ReceiptDraft {
    return {
      receiptTypeCode: 'MATERIAL',
      plantId,
      warehouseId: forWarehouseId,
      receiptDatetime: AT,
      businessDate: DAY,
      lines: [
        {
          itemId,
          lotId,
          receiptQty,
          uomId,
          qualityStatusCode: 'NORMAL',
          inventoryStatusCode: 'AVAILABLE',
          destinationLocationId,
        },
      ],
    };
  }

  let lotSeq = 0;
  async function makeLot(itemId: number): Promise<number> {
    lotSeq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${lotSeq}`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    return Number(lot.lot_id);
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '적치검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '적치검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '적치검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    // ⚠ main 의 management_level_code 는 입고 e2e 실측값('LOCATION')과 맞춘다 — 두
    // 스위트가 다른 값을 쓸 이유가 없다(코드 값이지만 여기서는 임의 문자열로 충분하다).
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '적치검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const otherWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '적치검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'RACK',
      },
    });
    otherWarehouseId = Number(otherWarehouse.warehouse_id);

    const dock = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK`,
        location_name: '하역장',
        location_type_code: 'BIN',
      },
    });
    dockId = Number(dock.location_id);
    const rack = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-RACK`,
        location_name: '권장위치',
        location_type_code: 'BIN',
      },
    });
    const otherDock = await prisma.location.create({
      data: {
        warehouse_id: otherWarehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK2`,
        location_name: '다른창고하역장',
        location_type_code: 'BIN',
      },
    });
    otherDockId = Number(otherDock.location_id);

    const ruled = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '적치검사품목권장',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    ruledItemId = Number(ruled.item_id);
    const plain = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT2`,
        item_name: '적치검사품목무권장',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    plainItemId = Number(plain.item_id);

    // 규칙은 권장 품목에만 둔다 — 무권장 품목의 지시는 recommendedLocationId 가 null 이다.
    await prisma.putaway_rule.create({
      data: {
        item_id: ruled.item_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: rack.location_id,
        capacity_qty: 1000,
        uom_id: uom.uom_id,
      },
    });

    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-W1`,
        worker_name: '적치검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    worker1Id = Number(worker.worker_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '적치검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '적치검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
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

  /**
   * ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다(입고 스위트와 같은 이유) —
   * CASCADE 가 `goods_receipt_line`·`putaway_task` 까지 함께 비운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.putaway_rule
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

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
