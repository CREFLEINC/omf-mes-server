/**
 * 재고 조정 조회 3건 — `GET /inventory/adjustments`·`/{inventoryAdjustmentId}`·
 * `/{inventoryAdjustmentId}/lines`. 화면 `W-01-12`. 등록·치환·상신·전기는 뒤 PR(②③④) 몫이라
 * 이 스위트는 전표를 **prisma 로 직접 INSERT** 한다(계약 경로가 아직 없다).
 *
 * ⚠ **시퀀서 순서에 기댄다** — `alphabetical-sequencer.js` 는 파일 이름 순으로 돈다.
 * `inventory-adjustment` 는 `inventory-balance`·`inventory-posting`·`inventory-transaction`
 * 보다 **앞**이다(cleanup 이 `TRUNCATE inventory.inventory_transaction_line,
 * inventory.inventory_transaction CASCADE` 를 돈다) — 우리 흔적을 뒤 스위트가 치운다
 * (I-4.md §10-1).
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

const LOGIN_ID = 'e2e-ia-probe';
const NOPERM_ID = 'e2e-ia-noperm';
const PASSWORD = '조정-조회-비밀번호';
const PREFIX = 'IAE2E';
const ROLE = 'E2E_IA';
const PERMISSIONS = ['W-01-12'];

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

interface AdjustmentBody {
  inventoryAdjustmentId: number;
  inventoryAdjustmentNo: string;
  statusCode: string;
  reasonCode: string;
  inventoryCountId: number | null;
  adjustedAt: string | null;
}

describe('재고 조정 조회 3건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let locationId: number;
  let itemId: number;
  let uomId: number;
  let inventoryCountId: number;

  /** 전기 완료(조회됨) · 미전기(REGISTERED · adjustedAt=NULL) 한 벌씩. */
  let postedId: number;
  let registeredId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUsers();
    await makeAdjustments();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('GET /inventory/adjustments — 목록이 뜨고 page 메타가 있다', async () => {
    const body = await list('');
    expect(body.page).toMatchObject({ page: 1, size: 50 });
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual(
      expect.arrayContaining([postedId, registeredId]),
    );
  });

  it('목록이 statusCode 로 걸러진다', async () => {
    const posted = await list('statusCode=POSTED');
    expect(posted.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);

    const registered = await list('statusCode=REGISTERED');
    expect(registered.items.map((i) => i.inventoryAdjustmentId)).toEqual([registeredId]);
  });

  it('⭐ 목록이 reasonCode 로 걸러진다 — 헤더 사유 축이다', async () => {
    const body = await list('reasonCode=SYSTEM_ERROR_CORRECTION');
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual([registeredId]);
  });

  it('목록이 inventoryCountId 로 걸러진다', async () => {
    const body = await list(`inventoryCountId=${inventoryCountId}`);
    expect(body.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);
  });

  it('목록이 adjustedAtFrom·adjustedAtTo 구간으로 걸러진다 — 미전기 전표는 안 잡힌다', async () => {
    const inRange = await list('adjustedAtFrom=2026-06-01&adjustedAtTo=2026-06-01');
    expect(inRange.items.map((i) => i.inventoryAdjustmentId)).toEqual([postedId]);

    const outOfRange = await list('adjustedAtFrom=2026-06-02&adjustedAtTo=2026-06-02');
    expect(outOfRange.items).toHaveLength(0);
  });

  it('⭐ 숫자 축에 글자가 섞이면 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/inventory/adjustments?inventoryCountId=abc')
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'inventoryCountId', code: 'INVALID' });
  });

  it('상세가 200 에 ETag 로 version_no 를 내리고 본문이 {inventoryAdjustment, lines} 다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${postedId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.headers.etag).toBe('1');

    const validate = validator('GET /inventory/adjustments/{inventoryAdjustmentId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(detail.body.inventoryAdjustment.inventoryAdjustmentId).toBe(postedId);
    expect(detail.body.lines).toHaveLength(1);
  });

  it('없는 상세는 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/inventory/adjustments/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ GET …/lines 는 ETag 를 안 내린다(자식 컬렉션) · 없는 id 는 404', async () => {
    const lines = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments/${postedId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    expect(lines.headers.etag ?? '').not.toMatch(/^\d+$/);

    const validate = validator('GET /inventory/adjustments/{inventoryAdjustmentId}/lines');
    expect(validate(lines.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(lines.body.items).toHaveLength(1);
    expect(lines.body.items[0].lineNo).toBe(1);

    await request(app.getHttpServer())
      .get('/api/inventory/adjustments/999999999/lines')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 권한을 묻지 않는다 — 계약이 조회 3건에 403 을 선언하지 않았다', async () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    expect(contract.paths['/inventory/adjustments'].get.responses['403']).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/inventory/adjustments')
      .set('Cookie', noPermCookie)
      .expect(200);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(query: string): Promise<{ items: AdjustmentBody[]; page: { page: number; size: number; total: number } }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/adjustments?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/adjustments');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '조정검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '조정검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '조정검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '조정검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '조정검사위치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(location.location_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '조정검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: false,
        negative_stock_allowed: false,
      },
    });
    itemId = Number(item.item_id);

    const count = await prisma.inventory_count.create({
      data: {
        inventory_count_no: `${PREFIX}-IC`,
        count_type_code: 'CYCLE',
        warehouse_id: warehouse.warehouse_id,
        planned_date: new Date('2026-06-01T00:00:00.000Z'),
        status_code: 'IN_PROGRESS',
      },
    });
    inventoryCountId = Number(count.inventory_count_id);
  }

  /** 전기됨(inventoryCountId 로 이어짐) 한 벌 · 미전기 한 벌 — 목록 필터 축을 가른다. */
  async function makeAdjustments(): Promise<void> {
    const posted = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `IA-${PREFIX}-0001`,
        inventory_count_id: inventoryCountId,
        reason_code: 'COUNT_VARIANCE',
        status_code: 'POSTED',
        adjusted_at: new Date('2026-06-01T02:00:00.000Z'),
      },
    });
    postedId = Number(posted.inventory_adjustment_id);
    await prisma.inventory_adjustment_line.create({
      data: {
        inventory_adjustment_id: posted.inventory_adjustment_id,
        line_no: 1,
        location_id: locationId,
        item_id: itemId,
        quality_status_code: 'NORMAL',
        inventory_status_code: 'AVAILABLE',
        adjustment_qty: -2,
        uom_id: uomId,
        reason_code: 'COUNT_VARIANCE',
      },
    });

    const registered = await prisma.inventory_adjustment.create({
      data: {
        inventory_adjustment_no: `IA-${PREFIX}-0002`,
        reason_code: 'SYSTEM_ERROR_CORRECTION',
        status_code: 'REGISTERED',
      },
    });
    registeredId = Number(registered.inventory_adjustment_id);
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '조정검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '조정검사용' } });
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

  /**
   * ⚠ `inventory_adjustment_line.inventory_transaction_line_id` FK 때문에 뒤 스위트
   * (`inventory-balance`·`inventory-posting`·`inventory-transaction`)의 cleanup 이 도는
   * `TRUNCATE … CASCADE` 가 조정 라인까지 비운다(I-14.md §10-1). 우리는 앞선 스위트가
   * 남긴 것과 무관하게 우리 접두어(`IA-{PREFIX}-`)로만 지운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment_line WHERE inventory_adjustment_id IN
        (SELECT inventory_adjustment_id FROM inventory.inventory_adjustment
          WHERE inventory_adjustment_no LIKE 'IA-${PREFIX}-%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment WHERE inventory_adjustment_no LIKE 'IA-${PREFIX}-%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count WHERE inventory_count_no LIKE '${PREFIX}%'`,
    );
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
