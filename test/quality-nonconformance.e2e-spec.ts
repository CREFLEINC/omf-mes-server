/**
 * 부적합 목록 (e2e) — I-21 PR ①a. `GET /quality/nonconformances` 딱 하나다. 상세·처분·후보·
 * 특채·쓰기는 다른 PR 몫이라 이 파일은 목록만 본다(브리프 범위).
 *
 * ⭐ 계약 실측 — `Nonconformance` 는 «목록과 상세가 한 스키마를 공유한다»(계약 `lots` 필드
 * 설명 원문). ⇒ 목록도 `lots[]`·`dispositionProgressCode`·`affectedQtyTotal`·`uomId` 를
 * 전건 채워야 ajv 가 통과한다 — `nonconformance-view.ts` 가 그 값들을 전부 계산한다.
 * 등록 오퍼레이션이 이 PR 의 몫이 아니라 픽스처는 전부 prisma 직접 INSERT 다(0단계 선례).
 *
 * 두 창을 쓴다 — 목록 창(필터·정렬·페이지)과 롤업 창(`dispositionProgressCode` 3분기 + 널
 * 정책 + ajv 전수 검증)을 겹치지 않게 둬 서로의 정렬·페이지 단언이 섞이지 않는다.
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

const PREFIX = 'I21NC';
const LOGIN_ID = 'e2e-i21nc-probe';
const PASSWORD = 'PR-부적합목록-비밀번호';
const NONCONFORMANCES = '/api/quality/nonconformances';

// 목록 창 — [LIST_FROM, LIST_TO). LIST_TO 와 «같은 시각»의 행(boundary)은 빠져야 한다(#3).
const LIST_FROM = '2026-09-01T00:00:00.000Z';
const LIST_TO = '2026-09-02T00:00:00.000Z';
// 롤업 창 — `dispositionProgressCode` 3분기 + 널 정책 + ajv 전수 검증. 목록 창과 안 겹친다.
const ROLLUP_FROM = '2026-09-05T00:00:00.000Z';
const ROLLUP_TO = '2026-09-06T00:00:00.000Z';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/shipment-04제품출하.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('부적합 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId = 0n;

  const ids = {
    item1: 0n,
    item2: 0n,
    uom: 0n,
    warehouse1: 0n,
    warehouse2: 0n,
    lotBase: 0n,
    lotReturn: 0n,
    lotMulti: 0n,
  };
  const ncIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser();
    await makeMasters();
    await makeListWindowFixtures();
    await makeRollupWindowFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);
  const listPeriod = `openedFrom=${LIST_FROM}&openedTo=${LIST_TO}`;

  // 목록 창 기본 정렬 — opened_at DESC, 동률은 nonconformance_id DESC(#11 이 통째로 단언한다).
  const defaultOrderKeys = ['tieLate', 'tieEarly', 'nc_C', 'nc_B', 'nc_A', 'startBoundary'];

  it('⭐ 기간 둘 다 없으면 400 REQUIRED', async () => {
    const response = await get(NONCONFORMANCES).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'openedFrom', code: 'REQUIRED' });
  });

  it('⭐ openedFrom 만 오면 400 REQUIRED(openedTo 가 없다고 짚는다)', async () => {
    const response = await get(`${NONCONFORMANCES}?openedFrom=${LIST_FROM}`).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'openedTo', code: 'REQUIRED' });
  });

  it('⭐ openedTo 만 오면 400 REQUIRED(openedFrom 이 없다고 짚는다)', async () => {
    const response = await get(`${NONCONFORMANCES}?openedTo=${LIST_TO}`).expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'openedFrom', code: 'REQUIRED' });
  });

  it('⭐ openedTo 와 «같은 시각»의 행(boundary)은 빠진다(반열림)', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).not.toContain(ncIds.boundary);
    expect(returnedIds).toContain(ncIds.startBoundary);
  });

  it('⭐ openedFrom 과 «같은 시각»의 행(startBoundary)은 실린다', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toContain(ncIds.startBoundary);
  });

  it('statusCode 필터 — PENDING_DECISION 이 nc_A(NOT_REQUESTED)를 뺀다', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&statusCode=PENDING_DECISION`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toContain(ncIds.nc_B);
    expect(returnedIds).toContain(ncIds.nc_C);
    expect(returnedIds).not.toContain(ncIds.nc_A);
  });

  it('severityCode 필터 — 실제 값이 안 걸리는 행을 뺀다', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&severityCode=CRITICAL`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toEqual([ncIds.nc_A]);
  });

  it('⭐ severityCode 가 시드 밖 값이어도 200 이고 빈 목록이다(400 아니다 · api m-3)', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&severityCode=UNKNOWN_XYZ`).expect(200);

    expect(response.body.items).toEqual([]);
  });

  it('lotId 필터 — EXISTS 로 정확히 그 LOT 이 걸린 부적합만 집는다', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&lotId=${ids.lotReturn}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toEqual([ncIds.nc_B]);
  });

  it('warehouseId 필터 — 잔액이 두 창고에 걸친 LOT 도 그중 하나로 걸린다(창고 둘이어도 안 빠진다)', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&warehouseId=${ids.warehouse1}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toContain(ncIds.nc_C);
    // 잔액 행이 아예 없는 LOT(lotBase) 을 쓰는 nc_A 는 안 걸린다 — 「안 걸리는 행」.
    expect(returnedIds).not.toContain(ncIds.nc_A);
  });

  it('⭐ sourceCode 필터 — RETURN 은 반품 LOT 만, PRODUCT 는 그 반대만 집는다(파생 축)', async () => {
    const returned = await get(`${NONCONFORMANCES}?${listPeriod}&sourceCode=RETURN`).expect(200);
    const product = await get(`${NONCONFORMANCES}?${listPeriod}&sourceCode=PRODUCT`).expect(200);
    const returnedIds = (body: { items: { nonconformanceId: number }[] }) => body.items.map((i) => i.nonconformanceId);

    expect(returnedIds(returned.body)).toContain(ncIds.nc_B);
    expect(returnedIds(returned.body)).not.toContain(ncIds.nc_A);
    expect(returnedIds(product.body)).toContain(ncIds.nc_A);
    expect(returnedIds(product.body)).not.toContain(ncIds.nc_B);

    const ncB = returned.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.nc_B);
    expect(ncB).toMatchObject({ sourceCode: 'RETURN' });
  });

  it('itemId 필터 — 다른 품목 행을 뺀다', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}&itemId=${ids.item2}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toEqual([ncIds.nc_B]);
  });

  it('⭐ 기본 정렬 — opened_at DESC, 동률은 nonconformance_id DESC(통째 단언 · R-19)', async () => {
    const response = await get(`${NONCONFORMANCES}?${listPeriod}`).expect(200);
    const returnedIds = response.body.items.map((item: { nonconformanceId: number }) => item.nonconformanceId);

    expect(returnedIds).toEqual(defaultOrderKeys.map((key) => ncIds[key]));
  });

  it('⭐ 페이지 — page=1&size=2 와 page=2&size=2 가 겹치지 않는다', async () => {
    const page1 = await get(`${NONCONFORMANCES}?${listPeriod}&page=1&size=2`).expect(200);
    const page2 = await get(`${NONCONFORMANCES}?${listPeriod}&page=2&size=2`).expect(200);
    const idsOf = (body: { items: { nonconformanceId: number }[] }) => body.items.map((i) => i.nonconformanceId);

    expect(idsOf(page1.body)).toEqual(defaultOrderKeys.slice(0, 2).map((key) => ncIds[key]));
    expect(idsOf(page2.body)).toEqual(defaultOrderKeys.slice(2, 4).map((key) => ncIds[key]));
    expect(page1.body.page).toEqual({ page: 1, size: 2, total: 6 });
    expect(page2.body.page).toEqual({ page: 2, size: 2, total: 6 });
  });

  describe('롤업·널 정책(§1-4-0) — `dispositionProgressCode` 3분기 + ajv 전수 검증', () => {
    const rollupPeriod = `openedFrom=${ROLLUP_FROM}&openedTo=${ROLLUP_TO}`;

    it('⭐ 결정 0건 — NOT_STARTED', async () => {
      const response = await get(`${NONCONFORMANCES}?${rollupPeriod}`).expect(200);
      const row = response.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.notStarted);

      expect(row).toMatchObject({ dispositionProgressCode: 'NOT_STARTED', affectedQtyTotal: 8 });
    });

    it('⭐ 결정 있고 남은 수량 > 0 — PARTIAL', async () => {
      const response = await get(`${NONCONFORMANCES}?${rollupPeriod}`).expect(200);
      const row = response.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.partial);

      expect(row).toMatchObject({ dispositionProgressCode: 'PARTIAL', affectedQtyTotal: 8 });
    });

    it('⭐ 결정 합이 대상과 «같으면»(한계와 같은 값) 남은 수량 0 — COMPLETED', async () => {
      const response = await get(`${NONCONFORMANCES}?${rollupPeriod}`).expect(200);
      const row = response.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.completed);

      expect(row).toMatchObject({ dispositionProgressCode: 'COMPLETED', affectedQtyTotal: 8 });
    });

    it('⭐⭐ R-13 널 정책 — 널 금지 선택 칸은 키가 없고, 널 허용 칸은 명시로 null 이다', async () => {
      const response = await get(`${NONCONFORMANCES}?${rollupPeriod}`).expect(200);
      const row = response.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.notStarted);

      // 이 픽스처는 workOrderId·responsibleDepartmentId·action*4칸을 전부 안 채웠다(전부 NULL).
      expect(row).not.toHaveProperty('workOrderId');
      expect(row).not.toHaveProperty('responsibleDepartmentId');
      expect(row).not.toHaveProperty('actionDescription');
      expect(row).not.toHaveProperty('actionOwnerId');
      expect(row).not.toHaveProperty('actionDueDate');
      expect(row).not.toHaveProperty('actionCompletedAt');
      expect(row).not.toHaveProperty('versionNo'); // api m-4 — ETag 전용, 본문에 안 싣는다
      expect(row.inspectionResultId).toBeNull();
      expect(row.closedAt).toBeNull();
      expect(row.lots).toHaveLength(1);
      expect(row.lots[0]).toMatchObject({ lotId: Number(ids.lotBase), affectedQty: 8 });
      expect(response.body.items.length).toBeGreaterThan(0);
      expect(validator('GET /quality/nonconformances')(response.body)).toBe(true);
    });

    it('⭐ sourceCode — LOT 이 여럿이면 «하나라도» 반품이면 RETURN이다(.some 이지 .every 가 아니다)', async () => {
      const response = await get(`${NONCONFORMANCES}?${rollupPeriod}`).expect(200);
      const row = response.body.items.find((item: { nonconformanceId: number }) => item.nonconformanceId === ncIds.sourceMixed);

      // lots = [lotBase(반품 아님), lotReturn(반품)] — 하나만 반품이라 «전부」 기준(.every)이면 PRODUCT 로 잘못 나온다.
      expect(row).toMatchObject({ sourceCode: 'RETURN', affectedQtyTotal: 5 }); // 2 + 3 — 첫 행만 읽으면 2가 된다
      expect(row.lots).toHaveLength(2);
    });
  });

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 부적합목록법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const unit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: `${PREFIX} 부적합목록사업부` },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 부적합목록공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    ids.uom = uom.uom_id;
    const item1 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: `${PREFIX} 품목1`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item1 = item1.item_id;
    const item2 = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT2`, item_name: `${PREFIX} 품목2`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    ids.item2 = item2.item_id;

    const wh1 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH1`, warehouse_name: `${PREFIX} 창고1`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION' },
    });
    ids.warehouse1 = wh1.warehouse_id;
    const loc1 = await prisma.location.create({
      data: { warehouse_id: wh1.warehouse_id, location_code: `${PREFIX}-LOC1`, location_name: `${PREFIX} 위치1`, location_type_code: 'BIN' },
    });
    const wh2 = await prisma.warehouse.create({
      data: { plant_id: plant.plant_id, business_unit_id: unit.business_unit_id, warehouse_code: `${PREFIX}-WH2`, warehouse_name: `${PREFIX} 창고2`, warehouse_type_code: 'FINISHED', management_level_code: 'LOCATION' },
    });
    ids.warehouse2 = wh2.warehouse_id;
    const loc2 = await prisma.location.create({
      data: { warehouse_id: wh2.warehouse_id, location_code: `${PREFIX}-LOC2`, location_name: `${PREFIX} 위치2`, location_type_code: 'BIN' },
    });

    ids.lotBase = await newLot('BASE', item1.item_id, plant.plant_id);
    ids.lotReturn = await newLot('RETURN', item2.item_id, plant.plant_id);
    ids.lotMulti = await newLot('MULTI', item1.item_id, plant.plant_id);

    // lotReturn — 반품 입고 한 줄(sourceCode=RETURN 의 원천).
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR`,
        receipt_type_code: 'RETURN',
        plant_id: plant.plant_id,
        warehouse_id: wh1.warehouse_id,
        receipt_datetime: new Date(LIST_FROM),
        status_code: 'REGISTERED',
      },
    });
    await prisma.goods_receipt_line.create({
      data: {
        goods_receipt_id: receipt.goods_receipt_id,
        line_no: 1,
        item_id: item2.item_id,
        lot_id: ids.lotReturn,
        receipt_qty: 20,
        uom_id: uom.uom_id,
        quality_status_code: 'DEFECTIVE',
        inventory_status_code: 'AVAILABLE',
        destination_location_id: loc1.location_id,
      },
    });

    // lotMulti — 두 창고에 걸쳐 잔액(warehouseId 필터가 「창고 둘이면 빠진다」로 잘못 좁히면 안 된다).
    await newBalance(entity.legal_entity_id, unit.business_unit_id, plant.plant_id, wh1.warehouse_id, loc1.location_id, item1.item_id, ids.lotMulti, uom.uom_id, 40);
    await newBalance(entity.legal_entity_id, unit.business_unit_id, plant.plant_id, wh2.warehouse_id, loc2.location_id, item1.item_id, ids.lotMulti, uom.uom_id, 60);
  }

  async function newLot(suffix: string, itemId: bigint, plantId: bigint): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${suffix}`,
        item_id: itemId,
        lot_type_code: 'PRODUCT',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: ids.uom,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'NORMAL',
      },
    });
    return lot.lot_id;
  }

  async function newBalance(
    legalEntityId: bigint,
    businessUnitId: bigint,
    plantId: bigint,
    warehouseId: bigint,
    locationId: bigint,
    itemId: bigint,
    lotId: bigint,
    uomId: bigint,
    onHandQty: number,
  ): Promise<void> {
    await prisma.inventory_balance.create({
      data: {
        legal_entity_id: legalEntityId,
        business_unit_id: businessUnitId,
        plant_id: plantId,
        warehouse_id: warehouseId,
        location_id: locationId,
        item_id: itemId,
        lot_id: lotId,
        quality_status_code: 'DEFECTIVE',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: onHandQty,
        uom_id: uomId,
      },
    });
  }

  async function makeNonconformance(overrides: {
    key: string;
    itemId: bigint;
    statusCode: string;
    severityCode: string;
    openedAt: string;
    lotId: bigint;
    affectedQty: number;
  }): Promise<number> {
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${overrides.key}`,
        item_id: overrides.itemId,
        severity_code: overrides.severityCode,
        description: `${PREFIX} 부적합 ${overrides.key}`,
        status_code: overrides.statusCode,
        opened_at: new Date(overrides.openedAt),
      },
    });
    await prisma.nonconformance_lot.create({
      data: {
        nonconformance_id: nc.nonconformance_id,
        lot_id: overrides.lotId,
        affected_qty: overrides.affectedQty,
        uom_id: ids.uom,
        quality_status_before_code: 'DEFECTIVE',
        quality_status_after_code: 'DEFECTIVE',
      },
    });
    const id = Number(nc.nonconformance_id);
    ncIds[overrides.key] = id;
    return id;
  }

  /** 목록 창(§8-1) — 필터·경계·정렬·페이지 전건을 이 여섯 행으로 잠근다. */
  async function makeListWindowFixtures(): Promise<void> {
    await makeNonconformance({ key: 'startBoundary', itemId: ids.item1, statusCode: 'NOT_REQUESTED', severityCode: 'MINOR', openedAt: LIST_FROM, lotId: ids.lotBase, affectedQty: 1 });
    await makeNonconformance({ key: 'nc_A', itemId: ids.item1, statusCode: 'NOT_REQUESTED', severityCode: 'CRITICAL', openedAt: '2026-09-01T01:00:00.000Z', lotId: ids.lotBase, affectedQty: 10 });
    await makeNonconformance({ key: 'nc_B', itemId: ids.item2, statusCode: 'PENDING_DECISION', severityCode: 'MAJOR', openedAt: '2026-09-01T02:00:00.000Z', lotId: ids.lotReturn, affectedQty: 20 });
    await makeNonconformance({ key: 'nc_C', itemId: ids.item1, statusCode: 'PENDING_DECISION', severityCode: 'MINOR', openedAt: '2026-09-01T03:00:00.000Z', lotId: ids.lotMulti, affectedQty: 5 });
    // ⭐ tieEarly·tieLate — 같은 시각. tieLate 를 «나중에» 만들어 id 가 더 크게 한다(DESC 동률 깨기 검증).
    await makeNonconformance({ key: 'tieEarly', itemId: ids.item1, statusCode: 'NOT_REQUESTED', severityCode: 'MINOR', openedAt: '2026-09-01T04:00:00.000Z', lotId: ids.lotBase, affectedQty: 1 });
    await makeNonconformance({ key: 'tieLate', itemId: ids.item1, statusCode: 'NOT_REQUESTED', severityCode: 'MINOR', openedAt: '2026-09-01T04:00:00.000Z', lotId: ids.lotBase, affectedQty: 1 });
    // boundary — LIST_TO 와 «같은 시각». 반열림 검증(#3)에서만 쓰고 다른 단언에는 안 넣는다.
    await makeNonconformance({ key: 'boundary', itemId: ids.item1, statusCode: 'NOT_REQUESTED', severityCode: 'MINOR', openedAt: LIST_TO, lotId: ids.lotBase, affectedQty: 1 });
  }

  /** 롤업 창 — `dispositionProgressCode` 3분기 + 널 정책(§1-4-0) 전용. 목록 창과 안 겹친다. */
  async function makeRollupWindowFixtures(): Promise<void> {
    const notStartedId = await makeNonconformance({ key: 'notStarted', itemId: ids.item1, statusCode: 'PENDING_DECISION', severityCode: 'MINOR', openedAt: ROLLUP_FROM, lotId: ids.lotBase, affectedQty: 8 });
    const partialId = await makeNonconformance({ key: 'partial', itemId: ids.item1, statusCode: 'PENDING_DECISION', severityCode: 'MINOR', openedAt: '2026-09-05T01:00:00.000Z', lotId: ids.lotBase, affectedQty: 8 });
    const completedId = await makeNonconformance({ key: 'completed', itemId: ids.item1, statusCode: 'DECIDED', severityCode: 'MINOR', openedAt: '2026-09-05T02:00:00.000Z', lotId: ids.lotBase, affectedQty: 8 });

    await makeDecision(partialId, 3); // 남은 5 > 0 — PARTIAL
    await makeDecision(completedId, 8); // 한계와 같은 값(=affectedQtyTotal) — COMPLETED
    void notStartedId;

    // ⭐ sourceCode 파생 축 — LOT 이 둘이고 «하나만» 반품이다(§1-4-1 「하나라도 RETURN이면 RETURN」).
    const mixed = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-sourceMixed`,
        item_id: ids.item1,
        severity_code: 'MINOR',
        description: `${PREFIX} 부적합 sourceMixed`,
        status_code: 'PENDING_DECISION',
        opened_at: new Date('2026-09-05T03:00:00.000Z'),
      },
    });
    await prisma.nonconformance_lot.createMany({
      data: [
        { nonconformance_id: mixed.nonconformance_id, lot_id: ids.lotBase, affected_qty: 2, uom_id: ids.uom, quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
        { nonconformance_id: mixed.nonconformance_id, lot_id: ids.lotReturn, affected_qty: 3, uom_id: ids.uom, quality_status_before_code: 'DEFECTIVE', quality_status_after_code: 'DEFECTIVE' },
      ],
    });
    ncIds.sourceMixed = Number(mixed.nonconformance_id);
  }

  async function makeDecision(nonconformanceId: number, decisionQty: number): Promise<void> {
    await prisma.disposition_decision.create({
      data: {
        nonconformance_id: BigInt(nonconformanceId),
        disposition_type_code: 'REWORK',
        decision_qty: decisionQty,
        uom_id: ids.uom,
        reason: `${PREFIX} 판정 사유`,
        decided_by: userId,
        decided_at: new Date(),
      },
    });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '부적합목록조회', status_code: 'EMPLOYED' } });
    userId = user.app_user_id;
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });

    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유 · §8-2). */
  async function cleanup(): Promise<void> {
    await prisma.disposition_decision.deleteMany({ where: { nonconformance: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } } });
    await prisma.nonconformance_lot.deleteMany({ where: { nonconformance: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } });
    await prisma.inventory_balance.deleteMany({ where: { lot: { lot_no: { startsWith: `${PREFIX}-LOT-` } } } });
    await prisma.goods_receipt_line.deleteMany({ where: { goods_receipt: { goods_receipt_no: { startsWith: `${PREFIX}-GR` } } } });
    await prisma.goods_receipt.deleteMany({ where: { goods_receipt_no: { startsWith: `${PREFIX}-GR` } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: `${PREFIX}-LOC` } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: `${PREFIX}-WH` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: `${PREFIX}-BU` } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: `${PREFIX}-LE` } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
