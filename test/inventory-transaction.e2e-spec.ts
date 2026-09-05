/**
 * 수불 이력 — 재고 원장을 밖에서 보는 유일한 창.
 *
 * ⭐ 이 스위트의 진짜 목적은 필터가 아니라 **엔진과 조회가 같은 것을 말하는지**다.
 * `InventoryPostingService` 로 직접 넣고 계약 경로로 읽어 대조한다.
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
import { InventoryPostingModule, InventoryPostingService } from '../src/core/inventory-posting';
import { PostingEndpoint, PostingInput } from '../src/core/inventory-posting/posting.types';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-invtx-probe';
const NOPERM_ID = 'e2e-invtx-noperm';
const PASSWORD = '수불-검사-비밀번호';
const PREFIX = 'INVTX';
const ROLE = 'E2E_INVTX';
/** 목록은 W-01-07, 상세는 W-01-13 이 부른다 — 가드는 「하나라도 있으면」이다. */
const PERMISSIONS = ['W-01-07', 'W-01-13'];

const D2 = '2026-03-01';
const D1 = '2026-03-02';
const D0 = '2026-03-03';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('수불 이력 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let lotId: number;
  let hereA: PostingEndpoint;
  let hereB: PostingEndpoint;
  /** 영업일 → 그날 넣은 거래 id. */
  const posted = new Map<string, number>();

  beforeAll(async () => {
    // ⚠ InventoryPostingModule 을 «따로» 물린다 — AppModule 은 아직 그것을 안 쓴다.
    // 원장에 쓰는 도메인이 하나도 없기 때문이고(입고가 붙을 때 바뀐다), 이 검사는 그
    // 엔진을 «채워 넣는 도구»로만 쓴다.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, InventoryPostingModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    posting = app.get(InventoryPostingService);

    await cleanup();
    await makeUsers();
    await makeMasters();
    await makeLedger();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 영업일 범위가 없으면 400 이다 — 파티션 전체를 훑지 않는다', async () => {
    const rejected = await request(app.getHttpServer())
      .get('/api/inventory/transactions')
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'businessDateFrom',
      'businessDateTo',
    ]);
    expect(rejected.body.errors[0].code).toBe('REQUIRED');
  });

  it('⛔ 영업일 형식이 아니면 400 이다', async () => {
    await request(app.getHttpServer())
      .get('/api/inventory/transactions?businessDateFrom=2026-3-1&businessDateTo=2026-03-03')
      .set('Cookie', cookie)
      .expect(400);
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const body = await list(`businessDateFrom=${D2}&businessDateTo=${D0}`);
    expect(body.items.length).toBeGreaterThanOrEqual(3);
  });

  it('⭐ 영업일 범위 밖은 안 나온다', async () => {
    const only = await list(`businessDateFrom=${D1}&businessDateTo=${D1}`);
    expect(only.items.map((t) => t.businessDate)).toEqual([D1]);
  });

  it('⭐ 창고 필터는 나간 쪽·들어온 쪽을 둘 다 본다', async () => {
    // A 는 입고(to)와 이동(from) 둘에 걸린다 — 한쪽만 보면 이동이 사라진다.
    const fromA = await list(
      `businessDateFrom=${D2}&businessDateTo=${D0}&warehouseId=${hereA.warehouseId}`,
    );
    expect(new Set(fromA.items.map((t) => t.businessDate))).toEqual(new Set([D2, D1]));

    const fromB = await list(
      `businessDateFrom=${D2}&businessDateTo=${D0}&warehouseId=${hereB.warehouseId}`,
    );
    expect(new Set(fromB.items.map((t) => t.businessDate))).toEqual(new Set([D1, D0]));
  });

  it('⭐ LOT 필터가 그 LOT 을 가진 헤더만 고른다', async () => {
    const held = await list(`businessDateFrom=${D2}&businessDateTo=${D0}&lotId=${lotId}`);
    expect(held.items).toHaveLength(3);

    const other = await list(`businessDateFrom=${D2}&businessDateTo=${D0}&lotId=999999999`);
    expect(other.items).toHaveLength(0);
  });

  it('⭐ 원천 문서 유형으로 거른다', async () => {
    const issues = await list(
      `businessDateFrom=${D2}&businessDateTo=${D0}&sourceDocumentTypeCode=GOODS_ISSUE`,
    );
    expect(issues.items.map((t) => t.businessDate)).toEqual([D0]);
  });

  it('⭐ 상세가 헤더와 라인을 함께 준다 — 계약 스키마 만족', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/inventory/transactions/${D1}/${posted.get(D1) as number}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /inventory/transactions/{businessDate}/{inventoryTransactionId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(detail.body.inventoryTransaction.businessDate).toBe(D1);
    // 이동은 한 라인이 양쪽 끝을 다 갖는다.
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0]).toMatchObject({
      fromWarehouseId: hereA.warehouseId,
      toWarehouseId: hereB.warehouseId,
      qty: 4,
    });
  });

  it('⛔ 영업일이 다르면 같은 id 라도 404 다 — 복합 키가 식별자다', async () => {
    await request(app.getHttpServer())
      .get(`/api/inventory/transactions/${D0}/${posted.get(D1) as number}`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⛔ 없는 거래는 404 다', async () => {
    await request(app.getHttpServer())
      .get(`/api/inventory/transactions/${D0}/999999999`)
      .set('Cookie', cookie)
      .expect(404);
  });

  it('⭐ 권한을 묻지 않는다 — 계약이 이 두 자리에 403 을 선언하지 않았다', async () => {
    // ⛔ 가드는 계약이 403 을 «선언한» 자리에서만 본다. 선언 없는 곳에서 403 을 내면
    // 계약과 어긋나므로, 역할 없는 사용자도 원장을 읽는다. 계약이 403 을 더하면 이
    // 검사가 먼저 깨져 게이트를 함께 세우게 된다.
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../contracts/logistics-01자재창고.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    expect(contract.paths['/inventory/transactions'].get.responses['403']).toBeUndefined();

    await request(app.getHttpServer())
      .get(`/api/inventory/transactions?businessDateFrom=${D2}&businessDateTo=${D0}`)
      .set('Cookie', noPermCookie)
      .expect(200);
  });

  it('⭐ posting 이 남긴 것을 이 경로가 그대로 읽는다 — 원장의 유일한 창', async () => {
    const input = ledgerInput({
      businessDate: D0,
      transactionNo: `${PREFIX}-EXTRA`,
      transactionTypeCode: 'ISSUE',
      sourceDocumentTypeCode: 'GOODS_ISSUE',
      lines: [{ itemId, lotId, qty: 1, uomId, from: hereB, ownershipTypeCode: 'OWNED' }],
    });
    const result = await prisma.$transaction((tx) => posting.post(tx, input));

    const detail = await request(app.getHttpServer())
      .get(`/api/inventory/transactions/${D0}/${Number(result.inventoryTransactionId)}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(detail.body.inventoryTransaction).toMatchObject({
      transactionNo: `${PREFIX}-EXTRA`,
      transactionTypeCode: 'ISSUE',
      sourceDocumentTypeCode: 'GOODS_ISSUE',
      businessDate: D0,
    });
    expect(detail.body.lines[0]).toMatchObject({
      qty: 1,
      fromWarehouseId: hereB.warehouseId,
      toWarehouseId: null,
    });
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(
    query: string,
  ): Promise<{ items: { businessDate: string; inventoryTransactionId: number }[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/inventory/transactions?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/transactions');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  function ledgerInput(over: Partial<PostingInput> & Pick<PostingInput, 'businessDate' | 'transactionNo' | 'lines'>): PostingInput {
    return {
      occurredAt: new Date(`${over.businessDate}T02:00:00.000Z`),
      transactionTypeCode: 'RECEIPT',
      statusCode: 'POSTED',
      plantId,
      sourceDocumentTypeCode: 'GOODS_RECEIPT',
      sourceDocumentId: 1,
      idempotencyKey: `${PREFIX}-${randomUUID()}`,
      ...over,
    };
  }

  async function makeLedger(): Promise<void> {
    const rows: PostingInput[] = [
      ledgerInput({
        businessDate: D2,
        transactionNo: `${PREFIX}-GR`,
        lines: [{ itemId, lotId, qty: 10, uomId, to: hereA, ownershipTypeCode: 'OWNED' }],
      }),
      ledgerInput({
        businessDate: D1,
        transactionNo: `${PREFIX}-TR`,
        transactionTypeCode: 'TRANSFER',
        sourceDocumentTypeCode: 'STOCK_TRANSFER',
        lines: [{ itemId, lotId, qty: 4, uomId, from: hereA, to: hereB, ownershipTypeCode: 'OWNED' }],
      }),
      ledgerInput({
        businessDate: D0,
        transactionNo: `${PREFIX}-GI`,
        transactionTypeCode: 'ISSUE',
        sourceDocumentTypeCode: 'GOODS_ISSUE',
        lines: [{ itemId, lotId, qty: 2, uomId, from: hereB, ownershipTypeCode: 'OWNED' }],
      }),
    ];
    for (const input of rows) {
      const result = await prisma.$transaction((tx) => posting.post(tx, input));
      posted.set(input.businessDate, Number(result.inventoryTransactionId));
    }
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '수불검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '수불검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '수불검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '수불검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
        negative_stock_allowed: false,
      },
    });
    itemId = Number(item.item_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 10,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    lotId = Number(lot.lot_id);

    hereA = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'A');
    hereB = await makeEndpoint(unit.business_unit_id, plant.plant_id, 'B');
  }

  async function makeEndpoint(
    businessUnitId: bigint,
    plantIdValue: bigint,
    suffix: string,
  ): Promise<PostingEndpoint> {
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plantIdValue,
        business_unit_id: businessUnitId,
        warehouse_code: `${PREFIX}-WH${suffix}`,
        warehouse_name: `수불검사창고${suffix}`,
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC${suffix}`,
        location_name: `수불검사위치${suffix}`,
        location_type_code: 'BIN',
      },
    });
    return {
      warehouseId: Number(warehouse.warehouse_id),
      locationId: Number(location.location_id),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    };
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '수불검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '수불검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({
      data: { app_user_id: user.app_user_id, role_id: role.role_id },
    });
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
   * ⛔ 원장은 **행 단위로 지울 수 없다** — 트리거가 UPDATE·DELETE 를 막는다(append-only,
   * 정정은 역트랜잭션이다). 그래서 우리 것만 골라 지우는 길이 없고 `TRUNCATE` 뿐이다.
   * `inventory-posting.e2e-spec.ts` 도 같은 이유로 같은 방식을 쓴다. e2e 는 `--runInBand`
   * 라 스위트가 겹치지 않고, 이 표에 시드가 넣는 행은 없다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.inventory_balance
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    );
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
