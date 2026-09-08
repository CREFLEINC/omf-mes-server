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
// `W-01-10` 은 잔액을 세우는 입고 API 를 부르려고 든다(잔액은 손으로 넣지 않는다).
const PERMISSIONS = ['W-01-12', 'W-01-10'];
const DAY = '2026-06-01';
const AT = '2026-06-01T01:00:00.000Z';

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

describe('재고 조정 조회 3건 + 등록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let plantId: number;
  let warehouseId: number;
  let locationId: number;
  /** 잔액이 «없는» 위치 — 0행 갈래. */
  let emptyLocationId: number;
  /** 잔액 행이 «둘인» 위치 — 차원이 갈리는 갈래. */
  let dualLocationId: number;
  /** 다른 공장의 위치 — 공장 단일 검사 갈래. */
  let otherPlantLocationId: number;
  let itemId: number;
  let lotId: number;
  let uomId: number;
  let inventoryCountId: number;
  let inventoryCountLineId: number;

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
    await makeBalances();
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


  // ── 등록 ────────────────────────────────────────────────────────────────

  it('required 2 로 만들면 201 · statusCode 가 REGISTERED · ETag 가 실린다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-2)] }).expect(201);
    const validate = validator('POST /inventory/adjustments', 201);
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.inventoryAdjustment.statusCode).toBe('REGISTERED');
    expect(response.headers.etag).toBe('1');
  });

  it('inventoryAdjustmentNo 가 IA-{YYYYMMDD}-{SEQ4} 형식이다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-1)] }).expect(201);
    expect(response.body.inventoryAdjustment.inventoryAdjustmentNo).toMatch(/^IA-\d{8}-\d{4}$/);
  });

  it('응답 lines 가 요청 순서대로 lineNo 1..N 이다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [line(-1), line(3)],
    }).expect(201);
    expect(response.body.lines.map((l: { lineNo: number }) => l.lineNo)).toEqual([1, 2]);
    expect(response.body.lines.map((l: { adjustmentQty: number }) => l.adjustmentQty)).toEqual([-1, 3]);
  });

  it('⭐ 라인 reasonCode 를 안 보내면 헤더 값이 복사되어 응답에 실린다', async () => {
    const response = await create({ reasonCode: 'HOPPER_MEASUREMENT', lines: [line(-1)] }).expect(201);
    expect(response.body.lines[0].reasonCode).toBe('HOPPER_MEASUREMENT');

    const explicit = await create({
      reasonCode: 'HOPPER_MEASUREMENT',
      lines: [{ ...line(-1), reasonCode: 'OTHER' }],
    }).expect(201);
    expect(explicit.body.lines[0].reasonCode).toBe('OTHER');
  });

  it('⭐ 저장된 라인의 quality/inventory status 가 잔액 행의 값이다', async () => {
    const response = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(-2)] }).expect(201);
    const row = await prisma.inventory_adjustment_line.findFirstOrThrow({
      where: { inventory_adjustment_id: response.body.inventoryAdjustment.inventoryAdjustmentId },
    });
    expect(row.quality_status_code).toBe('NORMAL');
    expect(row.inventory_status_code).toBe('AVAILABLE');
  });

  it('⭐ 잔액이 없는 위치에 증(+) 라인은 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(5), locationId: emptyLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'INVALID' });
  });

  it('⭐ 잔액이 없는 위치에 감(−) 라인은 400 NEGATIVE_BALANCE 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-5), locationId: emptyLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({
      field: 'lines[0].locationId',
      code: 'NEGATIVE_BALANCE',
    });
  });

  it('⭐ 잔액 행이 둘인 위치는 400 INVALID 다 — 어느 차원을 조정할지 정할 수 없다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-1), locationId: dualLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[0].locationId', code: 'INVALID' });
  });

  it('adjustmentQty 0 은 400 INVALID · lines [] 는 400 LINE_REQUIRED 다', async () => {
    const zero = await create({ reasonCode: 'COUNT_VARIANCE', lines: [line(0)] }).expect(400);
    expect(zero.body.errors[0]).toMatchObject({
      field: 'lines[0].adjustmentQty',
      code: 'INVALID',
    });

    const empty = await create({ reasonCode: 'COUNT_VARIANCE', lines: [] }).expect(400);
    expect(empty.body.errors[0]).toMatchObject({ field: 'lines', code: 'LINE_REQUIRED' });
  });

  it('⭐ inventoryCountId·inventoryCountLineId 를 보내면 둘 다 저장되고 응답에 실린다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      inventoryCountId,
      lines: [{ ...line(-2), inventoryCountLineId }],
    }).expect(201);
    expect(response.body.inventoryAdjustment.inventoryCountId).toBe(inventoryCountId);
    expect(response.body.lines[0].inventoryCountLineId).toBe(inventoryCountLineId);
  });

  it('라인 reasonCode 가 코드값 밖이면 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [{ ...line(-1), reasonCode: 'NOT_A_REASON' }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({
      field: 'lines[0].reasonCode',
      code: 'INVALID',
    });
  });

  it('sendToErp 를 false 로 보내도 201 이고 erpMessageQueued 는 false 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      sendToErp: false,
      lines: [line(-1)],
    }).expect(201);
    expect(response.body.inventoryAdjustment.erpMessageQueued).toBe(false);
  });

  it('⭐ 라인이 두 공장에 걸치면 400 INVALID 다', async () => {
    const response = await create({
      reasonCode: 'COUNT_VARIANCE',
      lines: [line(-1), { ...line(-1), locationId: otherPlantLocationId }],
    }).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'lines[1].locationId', code: 'INVALID' });
  });

  it('무권한 계정은 403 이다', async () => {
    await request(app.getHttpServer())
      .post('/api/inventory/adjustments')
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'COUNT_VARIANCE', lines: [line(-1)] })
      .expect(403);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  function line(adjustmentQty: number): Record<string, unknown> {
    return { locationId, itemId, lotId, adjustmentQty, uomId };
  }

  function create(body: Record<string, unknown>): request.Test {
    return request(app.getHttpServer())
      .post('/api/inventory/adjustments')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }

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
    plantId = Number(plant.plant_id);
    warehouseId = Number(warehouse.warehouse_id);
    const makeLocation = async (suffix: string, warehouse_id: bigint): Promise<number> => {
      const row = await prisma.location.create({
        data: {
          warehouse_id,
          location_code: `${PREFIX}-LOC${suffix}`,
          location_name: `조정검사위치${suffix}`,
          location_type_code: 'BIN',
        },
      });
      return Number(row.location_id);
    };
    locationId = await makeLocation('', warehouse.warehouse_id);
    emptyLocationId = await makeLocation('-E', warehouse.warehouse_id);
    dualLocationId = await makeLocation('-D', warehouse.warehouse_id);

    // 공장 단일 검사(결정 — 통보 133)용 두 번째 공장 한 벌.
    const plant2 = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P2`,
        plant_name: '조정검사공장2',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant2.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '조정검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    otherPlantLocationId = await makeLocation('-X', warehouse2.warehouse_id);

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
    const countLine = await prisma.inventory_count_line.create({
      data: {
        inventory_count_id: count.inventory_count_id,
        line_no: 1,
        location_id: locationId,
        item_id: itemId,
        system_qty: 100,
        counted_qty: 98,
        uom_id: uomId,
        counted_at: new Date(AT),
      },
    });
    inventoryCountLineId = Number(countLine.inventory_count_line_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT`,
        item_id: itemId,
        lot_type_code: 'MATERIAL',
        plant_id: plantId,
        initial_qty: 200,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lotId = Number(lot.lot_id);
  }

  /**
   * ⭐ 잔액을 직접 INSERT 하지 않는다 — 트리거가 지키는 표라 손으로 넣으면 차원 11칸을
   * 우리가 맞춰야 하고, 그것이 등록이 되읽는 바로 그 값이다(I-14.md §10-2). 입고 API 를
   * 부른다. `-D` 위치에는 재고 상태를 갈라 «두 행»을 세운다.
   */
  async function makeBalances(): Promise<void> {
    await receive(locationId, 100, 'AVAILABLE');
    await receive(dualLocationId, 10, 'AVAILABLE');
    await receive(dualLocationId, 10, 'BLOCKED');
  }

  async function receive(destinationLocationId: number, receiptQty: number, inventoryStatusCode: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/logistics/goods-receipts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        receiptTypeCode: 'MATERIAL',
        plantId,
        warehouseId,
        receiptDatetime: AT,
        businessDate: DAY,
        lines: [
          {
            itemId,
            lotId,
            receiptQty,
            uomId,
            qualityStatusCode: 'NORMAL',
            inventoryStatusCode,
            destinationLocationId,
          },
        ],
      })
      .expect(201);
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
    // ⭐ 조정부터 지우고 «그 다음» TRUNCATE 한다 — 등록 오퍼레이션이 만든 전표는
    //    `IA-{YYYYMMDD}-` 채번을 받아 접두어로 못 짚고, TRUNCATE 의 CASCADE 가 라인을
    //    통째로 비우면 헤더가 고아로 남아 다음 회차의 실사·마스터 삭제를 막는다.
    //    짚는 축 셋: 우리 계정이 만든 것 · 우리 실사에 매달린 것 · 손으로 심은 번호.
    const isMine = `created_by IN (SELECT app_user_id FROM app.app_user
                                    WHERE login_id IN ('${LOGIN_ID}', '${NOPERM_ID}'))
                    OR inventory_count_id IN (SELECT inventory_count_id FROM inventory.inventory_count
                                               WHERE inventory_count_no LIKE '${PREFIX}%')
                    OR inventory_adjustment_no LIKE 'IA-${PREFIX}-%'`;
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment_line WHERE inventory_adjustment_id IN
        (SELECT inventory_adjustment_id FROM inventory.inventory_adjustment WHERE ${isMine})`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_adjustment WHERE ${isMine}`,
    );
    // ⚠ 뒤 스위트(`inventory-balance`·`inventory-posting`·`inventory-transaction`)와 같은
    //    TRUNCATE 를 돈다 — 우리 앞 스위트가 남긴 것을 지운다(I-14.md §10-1).
    await prisma.$executeRawUnsafe(
      `TRUNCATE inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count_line WHERE inventory_count_id IN
        (SELECT inventory_count_id FROM inventory.inventory_count
          WHERE inventory_count_no LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_count WHERE inventory_count_no LIKE '${PREFIX}%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.putaway_task WHERE item_id IN
        (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN
        (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM inventory.inventory_balance WHERE warehouse_id IN
        (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`,
    );
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
