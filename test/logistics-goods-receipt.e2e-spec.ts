/**
 * 입고 — 원장에 «쓰는» 첫 도메인. 화면 `W-01-10`.
 *
 * ⭐ 이 스위트가 못 박는 것 넷 — 등록 한 번이 **전표·원장·잔액을 함께** 만든다 ·
 * 라인마다 **적치 지시**가 생기고 응답이 그 식별자를 싣는다 · 권장 위치는 **적치 규칙만이**
 * 낸다 · 같은 멱등키 재전송이 **원장을 두 번 만들지 않는다**.
 *
 * ⛔ 보류 해제는 여기 없다 — 「LOT 재고 상태」와 「의심자재 보류 기록」은 다른 축이고
 * 뒤의 것은 `W-03-02` 소관이다(되돌림 §Z-8).
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

const LOGIN_ID = 'e2e-gr-probe';
const NOPERM_ID = 'e2e-gr-noperm';
const PASSWORD = 'GR-검사-비밀번호';
const PREFIX = 'GRE2E';
const ROLE = 'E2E_GR';
const PERMISSIONS = ['W-01-10', 'W-01-05', 'W-01-06'];
const DAY = '2026-05-04';
const AT = '2026-05-04T02:00:00.000Z';

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

const key = (): string => randomUUID();

interface ReceiptBody {
  goodsReceiptId: number;
  goodsReceiptNo: string;
  statusCode: string;
  erpMessageQueued: boolean;
}
interface LineBody {
  goodsReceiptLineId: number;
  lineNo: number;
  putawayTaskId: number | null;
  inventoryTransactionLineId: number | null;
  receiptQty: number;
}
interface Detail {
  goodsReceipt: ReceiptBody;
  lines: LineBody[];
}
interface LineDraft {
  itemId: number;
  lotId: number;
  receiptQty: number;
  uomId: number;
  qualityStatusCode: string;
  inventoryStatusCode: string;
  destinationLocationId: number;
}
interface Draft {
  receiptTypeCode: string;
  plantId: number;
  warehouseId: number;
  receiptDatetime: string;
  businessDate: string;
  lines: LineDraft[];
  sourceDocumentTypeCode?: string;
  sourceDocumentId?: number;
}

describe('입고 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let otherPlantId: number;
  let itemId: number;
  let ruledItemId: number;
  let uomId: number;
  let warehouseId: number;
  let dockId: number;
  let rackId: number;
  let otherLocationId: number;
  let ruleId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUsers();
    await makeMasters();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 권한이 없으면 입고 처리가 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await body())
      .expect(403);
  });

  it('⛔ 라인이 없으면 400 이다 — 계약이 「최소 1행」이라 적고 minItems 를 안 걸었다', async () => {
    const rejected = await post({ ...(await body()), lines: [] }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('⛔ 원천 문서 유형만 채우면 400 이다 — 유형과 식별자는 짝이다', async () => {
    const rejected = await post({
      ...(await body()),
      sourceDocumentTypeCode: 'INBOUND_RECEIPT',
    }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'sourceDocumentTypeCode',
      code: 'PAIR',
    });
  });

  it('⛔ 다른 공장의 창고면 400 이다 — 잔량의 조직 축이 전표와 어긋난다', async () => {
    const rejected = await post({ ...(await body()), plantId: otherPlantId }).expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toContain('warehouseId');
  });

  it('⛔ 남의 창고 위치로는 못 잡는다', async () => {
    const draft = await body();
    draft.lines[0].destinationLocationId = otherLocationId;

    const rejected = await post(draft).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lines[0].destinationLocationId',
      code: 'INVALID',
    });
  });

  it('⛔ LOT 의 품목이 아니면 400 이다 — 계보가 그 두 축으로 이어진다', async () => {
    const draft = await body();
    draft.lines[0].itemId = ruledItemId;

    const rejected = await post(draft).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lines[0].itemId', code: 'INVALID' });
  });

  it('⛔ 없는 입고 유형 코드는 400 이다', async () => {
    const rejected = await post({ ...(await body()), receiptTypeCode: 'NO_SUCH' }).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'receiptTypeCode', code: 'INVALID' });
  });

  it('⭐ 등록 한 번이 전표·원장·잔액을 함께 만든다', async () => {
    const detail = await create();

    expect(detail.goodsReceipt.statusCode).toBe('POSTED');
    expect(detail.goodsReceipt.goodsReceiptNo).toMatch(/^GR-20260504-\d{4}$/);
    expect(detail.lines[0].inventoryTransactionLineId).not.toBeNull();

    const ledger = await prisma.inventory_transaction.findFirstOrThrow({
      where: {
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: detail.goodsReceipt.goodsReceiptId,
      },
      include: { inventory_transaction_line: true },
    });
    expect(ledger.transaction_no).toBe(detail.goodsReceipt.goodsReceiptNo);
    expect(ledger.inventory_transaction_line).toHaveLength(1);
    // 도착지만 있고 출발지가 없다 — 그것이 「들어왔다」의 표현이다.
    expect(ledger.inventory_transaction_line[0].from_warehouse_id).toBeNull();
    expect(Number(ledger.inventory_transaction_line[0].to_location_id)).toBe(dockId);
  });

  it('⭐ 잔액이 입고 수량만큼 는다', async () => {
    const before = await onHand();

    await create({ receiptQty: 7 });

    expect(await onHand()).toBe(before + 7);
  });

  it('⛔ 같은 멱등키 재전송은 전표를 두 번 만들지 않는다 — 원장도 하나다', async () => {
    const draft = await body();
    const idempotencyKey = key();

    const first = await send(draft, idempotencyKey).expect(201);
    const before = await onHand();
    const second = await send(draft, idempotencyKey).expect(201);

    expect(second.body.goodsReceipt.goodsReceiptId).toBe(first.body.goodsReceipt.goodsReceiptId);
    expect(await onHand()).toBe(before);
    const ledgers = await prisma.inventory_transaction.count({
      where: {
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: first.body.goodsReceipt.goodsReceiptId,
      },
    });
    expect(ledgers).toBe(1);
  });

  it('⭐ 라인마다 적치 지시가 생기고 응답이 그 식별자를 싣는다', async () => {
    const detail = await create();

    expect(detail.lines[0].putawayTaskId).not.toBeNull();
    const task = await prisma.putaway_task.findUniqueOrThrow({
      where: { putaway_task_id: detail.lines[0].putawayTaskId as number },
    });
    expect(task.status_code).toBe('PENDING');
    expect(task.putaway_task_no).toMatch(/^PT-20260504-\d{4}$/);
    // 라인이 보낸 목적지는 「전기 시점의 장부 위치」라 지시의 «출발지»가 된다.
    expect(Number(task.from_location_id)).toBe(dockId);
    expect(Number(task.task_qty)).toBe(detail.lines[0].receiptQty);
  });

  it('⭐ 권장 위치는 적치 규칙만이 낸다', async () => {
    const detail = await create({ itemId: ruledItemId, lotId: await makeLot(ruledItemId) });

    const task = await prisma.putaway_task.findUniqueOrThrow({
      where: { putaway_task_id: detail.lines[0].putawayTaskId as number },
    });
    expect(Number(task.recommended_location_id)).toBe(rackId);
    expect(Number(task.applied_putaway_rule_id)).toBe(ruleId);
  });

  it('⛔ 규칙이 없으면 권장 위치가 비어 있다 — 「관리 위치가 없다」는 뜻이다', async () => {
    const detail = await create();

    const task = await prisma.putaway_task.findUniqueOrThrow({
      where: { putaway_task_id: detail.lines[0].putawayTaskId as number },
    });
    expect(task.recommended_location_id).toBeNull();
    expect(task.applied_putaway_rule_id).toBeNull();
  });

  it('⛔ ERP 송신 적재는 하지 않는다 — 한도승인을 가를 축이 물리에 없다', async () => {
    const detail = await create();
    expect(detail.goodsReceipt.erpMessageQueued).toBe(false);
  });

  it('⭐ 목록이 입고번호로 검색된다', async () => {
    const detail = await create();

    const found = await list(`q=${detail.goodsReceipt.goodsReceiptNo}`);
    expect(found.items.map((row) => row.goodsReceiptId)).toContain(
      detail.goodsReceipt.goodsReceiptId,
    );
  });

  it('⭐ 상세가 ETag 를 준다 — 다음 쓰기의 If-Match 다', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-receipts/${detail.goodsReceipt.goodsReceiptId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-receipts/{goodsReceiptId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.headers.etag).toBeDefined();
  });

  it('⭐ 라인 목록을 따로 준다', async () => {
    const detail = await create();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-receipts/${detail.goodsReceipt.goodsReceiptId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-receipts/{goodsReceiptId}/lines');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.items).toHaveLength(1);
  });

  it('⛔ 없는 전표는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/goods-receipts/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  function send(payload: object, idempotencyKey = key()): request.Test {
    return request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
  }

  const post = send;

  async function create(
    overrides: { receiptQty?: number; itemId?: number; lotId?: number } = {},
  ): Promise<Detail> {
    const draft = await body();
    if (overrides.itemId !== undefined) draft.lines[0].itemId = overrides.itemId;
    if (overrides.lotId !== undefined) draft.lines[0].lotId = overrides.lotId;
    if (overrides.receiptQty !== undefined) draft.lines[0].receiptQty = overrides.receiptQty;

    const created = await send(draft).expect(201);
    const validate = validator('POST /logistics/goods-receipts', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return created.body as Detail;
  }

  async function list(query: string): Promise<{ items: ReceiptBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-receipts?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-receipts');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  /** ⛔ LOT 이 잔량의 «차원»이라 건마다 행이 갈린다 — 그 자리의 잔액은 합이다. */
  async function onHand(location = dockId, item = itemId): Promise<number> {
    const sum = await prisma.inventory_balance.aggregate({
      where: { item_id: item, location_id: location, quality_status_code: 'NORMAL' },
      _sum: { on_hand_qty: true },
    });
    return Number(sum._sum.on_hand_qty ?? 0);
  }

  /** 라인마다 LOT 이 하나씩 필요하다 — 같은 LOT 을 두 번 잡으면 잔량 차원이 겹친다. */
  async function body(): Promise<Draft> {
    return {
      receiptTypeCode: 'MATERIAL',
      plantId,
      warehouseId,
      receiptDatetime: AT,
      businessDate: DAY,
      lines: [
        {
          itemId,
          lotId: await makeLot(itemId),
          receiptQty: 10,
          uomId,
          qualityStatusCode: 'NORMAL',
          inventoryStatusCode: 'AVAILABLE',
          destinationLocationId: dockId,
        },
      ],
    };
  }

  let lotSeq = 0;
  async function makeLot(item: number): Promise<number> {
    lotSeq += 1;
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${lotSeq}`,
        item_id: item,
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
        legal_entity_name: '입고검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '입고검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '입고검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);
    const other = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '입고검사공장2',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    otherPlantId = Number(other.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    for (const [suffix, target] of [['IT', 'plain'], ['IT2', 'ruled']] as const) {
      const item = await prisma.item.create({
        data: {
          item_code: `${PREFIX}-${suffix}`,
          item_name: `입고검사품목${suffix}`,
          item_type_code: 'RAW_MATERIAL',
          base_uom_id: uom.uom_id,
          lot_controlled: true,
        },
      });
      if (target === 'plain') itemId = Number(item.item_id);
      else ruledItemId = Number(item.item_id);
    }

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '입고검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);
    const otherWarehouse = await prisma.warehouse.create({
      data: {
        plant_id: other.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '입고검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });

    const dock = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-DOCK`,
        location_name: '입하장',
        location_type_code: 'BIN',
      },
    });
    dockId = Number(dock.location_id);
    const rack = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-RACK`,
        location_name: '보관랙',
        location_type_code: 'BIN',
      },
    });
    rackId = Number(rack.location_id);
    const foreign = await prisma.location.create({
      data: {
        warehouse_id: otherWarehouse.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '남의창고위치',
        location_type_code: 'BIN',
      },
    });
    otherLocationId = Number(foreign.location_id);

    // 규칙은 한 품목에만 둔다 — 「규칙이 없으면 권장이 비어 있다」를 함께 보이려면 둘이 필요하다.
    const rule = await prisma.putaway_rule.create({
      data: {
        item_id: ruledItemId,
        warehouse_id: warehouse.warehouse_id,
        location_id: rack.location_id,
        capacity_qty: 1000,
        uom_id: uom.uom_id,
      },
    });
    ruleId = Number(rule.putaway_rule_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '입고검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    noPermCookie = await login(NOPERM_ID);

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '입고검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();
  }

  async function login(loginId: string = LOGIN_ID): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** ⛔ 원장은 트리거가 행 삭제를 막아 TRUNCATE 뿐이다 — 재고 스위트들과 같은 이유다. */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.putaway_task
       WHERE putaway_task_no LIKE 'PT-%'
         AND item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt_line
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.putaway_rule
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    for (const id of [LOGIN_ID, NOPERM_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: id } });
      if (!target) continue;
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
