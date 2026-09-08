/**
 * LOT — 추적성의 뿌리. 화면 `M-01-02`·`P-01-01`.
 *
 * ⭐ 이 스위트가 못 박는 것 셋 — 번호 출처 둘의 «실패가 서로 다르다» · 서버가 스스로
 * 보류를 건다 · **원장이 움직인 LOT 은 수량을 못 바꾼다**(A1 이 세운 표를 되읽는다).
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
import { PostingEndpoint } from '../src/core/inventory-posting/posting.types';
import { LOT_NO_LENGTH } from '../src/core/lot/lot-number';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-lot-probe';
const NOPERM_ID = 'e2e-lot-noperm';
const PASSWORD = 'LOT-검사-비밀번호';
const PREFIX = 'LOTE2E';
const ROLE = 'E2E_LOT';
const PERMISSIONS = ['M-01-02', 'P-01-01', 'M-01-04'];
const DAY = '2026-05-01';

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

interface LotBody {
  lotId: number;
  lotNo: string;
  statusCode: string;
  held: boolean;
  initialQty: number;
}

describe('LOT (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let posting: InventoryPostingService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let itemId: number;
  let uomId: number;
  let here: PostingEndpoint;
  let inboundReceiptId: bigint;
  let lineNo = 0;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('⛔ 권한이 없으면 등록이 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .send(await body({ numberSourceCode: 'MES' }))
      .expect(403);
  });

  it('⛔ SUPPLIER 인데 번호가 없으면 400 이다', async () => {
    const rejected = await post(await body({ numberSourceCode: 'SUPPLIER' })).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lotNo', code: 'REQUIRED' });
  });

  it('⛔ MES 인데 번호를 보내면 400 이다', async () => {
    const rejected = await post(
      await body({ numberSourceCode: 'MES', lotNo: `${PREFIX}-손으로` }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'lotNo', code: 'INVALID' });
  });

  it('⭐ SUPPLIER 는 스캔값이 그대로 번호가 된다', async () => {
    const lot = await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-SCAN-1` });
    expect(lot.lotNo).toBe(`${PREFIX}-SCAN-1`);
  });

  it('⛔ 같은 공장에 같은 번호는 400 이다 — 재시도해도 안 풀린다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-DUP` });

    const rejected = await post(
      await body({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-DUP` }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'lotNo',
      code: 'UNIQUE_VIOLATION',
      uniqueScope: ['plantId', 'lotNo'],
    });
  });

  it('⭐ MES 는 서버가 34자리로 매긴다 — 화면은 번호를 안 보낸다', async () => {
    const first = await create({ numberSourceCode: 'MES' });
    const second = await create({ numberSourceCode: 'MES' });

    expect(first.lotNo).toHaveLength(LOT_NO_LENGTH);
    expect(second.lotNo).toHaveLength(LOT_NO_LENGTH);
    expect(first.lotNo).not.toBe(second.lotNo);
    expect(first.lotNo.startsWith('M')).toBe(true);
  });

  it('⭐ 등록 즉시 보류가 걸린다 — 화면이 보내지 않고 서버가 건다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect(lot.held).toBe(true);

    const holds = await prisma.lot_hold.findMany({ where: { lot_id: lot.lotId } });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ reason_code: 'INCOMING_INSPECTION_WAIT', released_at: null });
  });

  /**
   * ⭐⭐ R-9 회귀(I-20 PR ②a) + **PR ③ 2-5** — `holdView()` 는 `lotStatusCode` 를 `lot.status_code`
   * (지금 상태)가 아니라 `lot_hold.target_lot_status_code`(등록 때 간 상태)로 채운다. PR ③ 이
   * 코어(`lot-registry.service.ts:96`)에 그 칸을 채우게 해서 **오늘 태어난 보류는 값을 갖는다**.
   * ⛔ 백필은 없다(마이그 0) — PR ③ 이전에 태어난 옛 보류는 칸이 영구히 비고, 널 금지라
   * **키가 생략된다**. 마지막 단언이 그 갈래를 함께 잠근다.
   */
  it('⭐⭐ R-9 — 보류의 lotStatusCode 는 target_lot_status_code 다(lot.status_code 의 「지금」이 아니다)', async () => {
    const lot = await create({ numberSourceCode: 'MES' });

    const before = await detailOf(lot.lotId);
    const hold = before.holds[0] as { lotHoldId: number; lotStatusCode?: string };
    expect(hold.lotStatusCode).toBe('INSPECTION_PENDING'); // ⭐ 2-5 — 코어가 등록 때 채운다

    await prisma.lot.update({ where: { lot_id: BigInt(lot.lotId) }, data: { status_code: 'NORMAL' } });

    const after = await detailOf(lot.lotId);
    const movedHold = after.holds[0] as { lotStatusCode?: string };
    expect(after.lot.statusCode).toBe('NORMAL'); // LOT 은 옮겨졌다
    expect(movedHold.lotStatusCode).toBe('INSPECTION_PENDING'); // 그래도 「등록 때」 값 그대로 — lot.status_code 를 베끼면 'NORMAL' 이 나와 깨진다

    await prisma.lot_hold.update({
      where: { lot_hold_id: BigInt(hold.lotHoldId) },
      data: { target_lot_status_code: null },
    });
    const legacy = await detailOf(lot.lotId);
    expect(legacy.holds[0]).not.toHaveProperty('lotStatusCode'); // 옛 행(백필 안 함) — 널 금지로 키 생략
  });

  it('⭐ 등록하면 상태가 검사 대기다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect(lot.statusCode).toBe('INSPECTION_PENDING');
  });

  it('⭐ 외부 식별자를 함께 받는다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-EXT`,
      externalIdentifiers: [
        { identifierTypeCode: 'SUPPLIER_LOT', externalIdentifier: `${PREFIX}-SUP-9` },
      ],
    });

    const detail = await detailOf(lot.lotId);
    expect(detail.externalIdentifiers).toHaveLength(1);
    expect(detail.externalIdentifiers[0]).toMatchObject({
      identifierTypeCode: 'SUPPLIER_LOT',
      externalIdentifier: `${PREFIX}-SUP-9`,
    });
  });

  it('⛔ 마스터에 없는 식별자 유형은 400 이다', async () => {
    await post(
      await body({
        numberSourceCode: 'SUPPLIER',
        lotNo: `${PREFIX}-BADEXT`,
        externalIdentifiers: [
          { identifierTypeCode: '없는유형', externalIdentifier: 'x' },
        ],
      }),
    ).expect(400);
  });

  it('⭐ 상세가 «해제되지 않은» 보류만 준다 — 푼 것은 이력이지 지금이 아니다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    expect((await detailOf(lot.lotId)).holds).toHaveLength(1);

    await release(lot.lotId);

    const after = await detailOf(lot.lotId);
    expect(after.holds).toHaveLength(0);
    expect(after.lot.held).toBe(false);
  });

  it('⭐ 목록이 계약 스키마를 만족한다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-LIST` });
    const body = await list(`plantId=${plantId}`);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('⭐ lotNo 는 정확 일치다 — 스캔값 하나로 한 건을 집는다', async () => {
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-EXACT-1` });
    await create({ numberSourceCode: 'SUPPLIER', lotNo: `${PREFIX}-EXACT-12` });

    const exact = await list(`lotNo=${PREFIX}-EXACT-1`);
    expect(exact.items.map((l) => l.lotNo)).toEqual([`${PREFIX}-EXACT-1`]);
  });

  it('⭐ q 는 번호와 외부 식별자를 함께 본다', async () => {
    const lot = await create({
      numberSourceCode: 'SUPPLIER',
      lotNo: `${PREFIX}-QNO`,
      externalIdentifiers: [
        { identifierTypeCode: 'ERP_LOT', externalIdentifier: `${PREFIX}-찾을값` },
      ],
    });

    const byIdentifier = await list(`q=${encodeURIComponent(`${PREFIX}-찾을값`)}`);
    expect(byIdentifier.items.map((l) => l.lotId)).toContain(lot.lotId);

    const byNo = await list(`q=${PREFIX}-QNO`);
    expect(byNo.items.map((l) => l.lotId)).toContain(lot.lotId);
  });

  it('⭐ heldOnly 가 보류 중인 것만 준다', async () => {
    const held = await create({ numberSourceCode: 'MES' });
    const released = await create({ numberSourceCode: 'MES' });
    await release(released.lotId);

    const ids = (await list(`plantId=${plantId}&heldOnly=true`)).items.map((l) => l.lotId);
    expect(ids).toContain(held.lotId);
    expect(ids).not.toContain(released.lotId);
  });

  it('⛔ 원장이 움직인 LOT 은 수량을 바꿀 수 없다 — A1 이 세운 표를 되읽는다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await prisma.$transaction((tx) =>
      posting.post(tx, {
        businessDate: DAY,
        occurredAt: new Date(`${DAY}T02:00:00.000Z`),
        transactionTypeCode: 'RECEIPT',
        transactionNo: `${PREFIX}-GR-${lot.lotId}`,
        statusCode: 'POSTED',
        plantId,
        sourceDocumentTypeCode: 'GOODS_RECEIPT',
        sourceDocumentId: 1,
        idempotencyKey: `${PREFIX}-${randomUUID()}`,
        lines: [{ itemId, lotId: lot.lotId, qty: 5, uomId, to: here, ownershipTypeCode: 'OWNED' }],
      }),
    );

    const rejected = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 99 })
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({
      field: 'initialQty',
      code: 'STATE_LOCKED',
    });
  });

  it('⭐ 원장이 안 움직였으면 수량을 고칠 수 있다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    const updated = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 42, remarks: '고침' })
      .expect(200);
    expect(updated.body.lot.initialQty).toBe(42);
    expect(Number(updated.headers.etag)).toBe(Number(etag) + 1);
  });

  it('⛔ 수정이 If-Match 를 쓰고, 낡은 값은 409 다', async () => {
    const lot = await create({ numberSourceCode: 'MES' });
    const etag = await etagOf(lot.lotId);

    await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 7 })
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/trace/lots/${lot.lotId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send({ initialQty: 8 })
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⛔ 없는 sourceId 는 400 INVALID 다 — 고아 참조를 더 이상 안 받는다', async () => {
    const rejected = await post(
      await body({ numberSourceCode: 'MES', sourceId: 999999999 }),
    ).expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'sourceId', code: 'INVALID' });
  });

  it('⛔ 없는 LOT 은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/trace/lots/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /**
   * ⚠ `sourceId` 는 «실재하는» 입하 라인이어야 한다 — 등록이 그 라인의 `lot_id` 를 채운다.
   * 라인 하나에 LOT 은 하나라 호출마다 새 라인을 심는다.
   */
  async function body(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
    return {
      itemId,
      lotTypeCode: 'MATERIAL',
      plantId,
      initialQty: 10,
      uomId,
      sourceTypeCode: 'INBOUND_RECEIPT_LINE',
      sourceId: await newLine(),
      businessDate: DAY,
      occurredAt: `${DAY}T02:00:00.000Z`,
      ...extra,
    };
  }

  async function newLine(): Promise<number> {
    lineNo += 1;
    const line = await prisma.inbound_receipt_line.create({
      data: {
        inbound_receipt_id: inboundReceiptId,
        line_no: lineNo,
        item_id: BigInt(itemId),
        received_qty: 1,
        uom_id: BigInt(uomId),
        inspection_required: false,
        status_code: 'REGISTERED',
      },
    });
    return Number(line.inbound_receipt_line_id);
  }

  function post(payload: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/trace/lots')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .send(payload);
  }

  /** ⚠ 201 은 `Lot` 이 아니라 상세 봉투(`lot`·`externalIdentifiers`·`holds`)를 준다. */
  async function create(extra: Record<string, unknown>): Promise<LotBody> {
    const created = await post(await body(extra)).expect(201);
    const validate = validator('POST /trace/lots', 201);
    expect(validate(created.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return created.body.lot as LotBody;
  }

  async function detailOf(
    lotId: number,
  ): Promise<{ lot: LotBody; externalIdentifiers: { identifierTypeCode: string }[]; holds: unknown[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lotId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots/{lotId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  /**
   * ⛔ 보류 해제는 «사유»가 함께 있어야 한다 — `ck_lot_hold_release_reason` 이 그 짝을
   * 지킨다(해제 전에는 비어 있고 해제되면 반드시 있다). 해제 경로는 아직 없어 표를 민다.
   */
  async function release(lotId: number): Promise<void> {
    await prisma.lot_hold.updateMany({
      where: { lot_id: lotId },
      data: { released_at: new Date(), release_reason_code: 'INSPECTION_PASSED' },
    });
  }

  async function etagOf(lotId: number): Promise<string> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots/${lotId}`)
      .set('Cookie', cookie)
      .expect(200);
    return response.headers.etag;
  }

  async function list(query: string): Promise<{ items: LotBody[] }> {
    const response = await request(app.getHttpServer())
      .get(`/api/trace/lots?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /trace/lots');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body;
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: 'LOT검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: 'LOT검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: 'LOT검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = Number(plant.plant_id);

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: 'LOT검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    itemId = Number(item.item_id);

    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: 'LOT검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: 'LOT검사위치',
        location_type_code: 'BIN',
      },
    });
    here = {
      warehouseId: Number(warehouse.warehouse_id),
      locationId: Number(location.location_id),
      qualityStatusCode: 'NORMAL',
      inventoryStatusCode: 'AVAILABLE',
    };

    // 등록이 채우는 `inbound_receipt_line.lot_id` 의 상대 — 등록 경로가 없어 직접 심는다.
    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP`, partner_name: 'LOT검사공급사' },
    });
    const receipt = await prisma.inbound_receipt.create({
      data: {
        inbound_receipt_no: `${PREFIX}-IR`,
        supplier_id: supplier.partner_id,
        plant_id: plant.plant_id,
        receipt_datetime: new Date(`${DAY}T02:00:00.000Z`),
        status_code: 'REGISTERED',
      },
    });
    inboundReceiptId = receipt.inbound_receipt_id;
  }

  async function makeUsers(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'LOT검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'LOT검사용' } });
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
      DELETE FROM trace.lot_external_identifier
       WHERE lot_id IN (SELECT lot_id FROM trace.lot WHERE lot_no LIKE '%${PREFIX}%' OR lot_no LIKE 'M%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.inbound_receipt_line
       WHERE inbound_receipt_id IN (SELECT inbound_receipt_id FROM logistics.inbound_receipt
                                     WHERE inbound_receipt_no LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot_hold
       WHERE lot_id IN (SELECT lot_id FROM trace.lot
                         WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'))`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM trace.lot
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.inbound_receipt WHERE inbound_receipt_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
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
