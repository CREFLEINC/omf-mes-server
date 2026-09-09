/**
 * 취급 단위 조회 3건(I-16 PR ①) — 목록·상세·구성 목록. 등록·구성 치환·포장 확정·재구성
 * 이력 조회는 뒤 PR 몫이다(`docs/coverage-100/slices/I-16-a2.md` §11-3).
 *
 * ⚠ 저장소 다른 e2e(`logistics-stock-transfer.e2e-spec.ts`)가 `status_code:'ACTIVE'` 인
 * 취급 단위를 남길 수 있다(통보 164 ⓐ · S-11) — 목록 단언은 «자기 픽스처»의 id 로만
 * 걸러서 본다(§9-1).
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

const LOGIN_ID = 'e2e-hu-probe';
const PASSWORD = '취급단위-검사-비밀번호';
const PREFIX = 'HUE2E';
const PATH = '/api/inventory/handling-units';

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

interface HandlingUnitBody {
  handlingUnitId: number;
  handlingUnitNo: string;
  handlingUnitTypeCode: string;
  parentHandlingUnitId: number | null;
  warehouseId: number | null;
  locationId: number | null;
  statusCode: string;
}
interface PagedHandlingUnits {
  items: HandlingUnitBody[];
  page: { page: number; size: number; total: number };
}

describe('취급 단위 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let warehouse1Id: number;
  let warehouse2Id: number;
  let location1Id: number;
  let location2Id: number;
  let uomId: number;
  let uom2Id: number;
  let item1Id: number;
  let item2Id: number;
  let lot1Id: number;
  let lot2Id: number;

  // §9-2 「픽스처 축의 값이 둘 이상인가」— A: 창고1·위치1·PALLET·OPEN·부모없음·⭐구성 1행.
  // B: 창고2·위치2·BOX·OPEN·부모=A·구성 2행. C: 창고·위치 NULL·PALLET·PACKED·부모없음.
  // ⭐ A 도 구성을 갖는다(PR #485 리뷰 Major-1) — B 만 가지면 `where` 를 통째로 빼도
  //    12건이 전부 초록이라 「남의 파렛트 내용물이 섞여 나온다」가 안 잡힌다.
  // ⭐ `uom` 은 «둘»이다(리뷰 Major-2) — 하나면 uomId 단언이 언제나 초록이고,
  //    단위 변경 이력(통보 165 · R-2)의 심장이 PR ④ 에서 반증 불가가 된다.
  let huA: number;
  let huB: number;
  let huC: number;
  let contentB1: number;
  let contentB2: number;
  let contentA1: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixture();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('질의 없이 부르면 등록 역순으로 온다(HU 3개) · page 가 {page,size,total} 세 칸이다', async () => {
    const body = await list('');
    expect(Object.keys(body.page).sort()).toEqual(['page', 'size', 'total']);

    const ownIds = body.items
      .filter((hu) => hu.handlingUnitNo.startsWith(PREFIX))
      .map((hu) => hu.handlingUnitId);
    expect(ownIds).toEqual([huC, huB, huA]);
  });

  it('warehouseId 로 거른다 — 다른 창고 행과 창고가 NULL 인 행이 둘 다 안 잡힌다', async () => {
    const body = await list(`warehouseId=${warehouse1Id}`);
    const ids = body.items.map((hu) => hu.handlingUnitId);

    expect(ids).toContain(huA);
    expect(ids).not.toContain(huB);
    expect(ids).not.toContain(huC);
  });

  it('locationId 로 거른다 — 다른 위치 행과 위치가 NULL 인 행이 둘 다 안 잡힌다', async () => {
    const body = await list(`locationId=${location1Id}`);
    const ids = body.items.map((hu) => hu.handlingUnitId);

    expect(ids).toContain(huA);
    expect(ids).not.toContain(huB);
    expect(ids).not.toContain(huC);
  });

  it('handlingUnitTypeCode=PALLET 로 거른다 — BOX 행이 안 잡힌다 · 값 목록에 없는 코드는 빈 목록(400 아님)', async () => {
    const body = await list('handlingUnitTypeCode=PALLET');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huC]));
    expect(ids).not.toContain(huB);

    const empty = await list('handlingUnitTypeCode=NONEXISTENT_TYPE');
    expect(empty.items).toEqual([]);
  });

  it('statusCode=OPEN 으로 거른다 — PACKED 행이 안 잡힌다', async () => {
    const body = await list('statusCode=OPEN');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huB]));
    expect(ids).not.toContain(huC);
  });

  it('q 는 번호 부분 일치다 — 안 걸리는 번호의 행이 있는데도 안 잡힌다', async () => {
    const body = await list('q=ALPHA');
    const ids = body.items.map((hu) => hu.handlingUnitId);
    expect(ids).toEqual(expect.arrayContaining([huA, huB]));
    expect(ids).not.toContain(huC);
  });

  it('size=1000 을 넘겨도 page.size 가 200 이고 page=2 가 두 번째 쪽이다', async () => {
    const capped = await list('size=1000');
    expect(capped.page.size).toBe(200);

    // `q=PREFIX` 로 자기 픽스처 3건만 스코프해 등록 역순 [C,B,A] 를 한 쪽씩 확인한다.
    const page1 = await list(`q=${PREFIX}&size=1&page=1`);
    const page2 = await list(`q=${PREFIX}&size=1&page=2`);
    expect(page1.items[0].handlingUnitId).toBe(huC);
    expect(page2.items[0].handlingUnitId).toBe(huB);
  });

  it('상세 200 — handlingUnit 7칸과 contents 6칸을 값으로 단언한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huB}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units/{handlingUnitId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);

    // 같은 형끼리 뒤바꾸면 ajv 가 못 잡는다 — 값으로 단언한다
    // (warehouseId↔locationId, handlingUnitId↔parentHandlingUnitId).
    expect(response.body.handlingUnit).toMatchObject({
      handlingUnitId: huB,
      handlingUnitNo: `${PREFIX}-ALPHA-2`,
      handlingUnitTypeCode: 'BOX',
      parentHandlingUnitId: huA,
      warehouseId: warehouse2Id,
      locationId: location2Id,
      statusCode: 'OPEN',
    });
    expect(response.body.contents).toEqual([
      expect.objectContaining({
        handlingUnitContentId: contentB1,
        handlingUnitId: huB,
        itemId: item1Id,
        lotId: lot1Id,
        qty: 12.5,
        uomId,
      }),
      expect.objectContaining({
        handlingUnitContentId: contentB2,
        handlingUnitId: huB,
        itemId: item2Id,
        lotId: lot2Id,
        qty: 7.25,
        uomId: uom2Id, // ⭐ 두 행의 단위가 다르다 — 한 값을 상수로 실어도 초록이 되지 않는다
      }),
    ]);

    // ⭐ ajv 는 여분 칸을 못 잡는다(`additionalProperties` 미선언) — 키 집합을 명시로 잰다
    //   (리뷰 Major-3 · `versionNo`·`createdAt` 이 새도 `toMatchObject` 는 초록이었다).
    expect(Object.keys(response.body).sort()).toEqual(['contents', 'handlingUnit']);
    expect(Object.keys(response.body.handlingUnit).sort()).toEqual([
      'handlingUnitId',
      'handlingUnitNo',
      'handlingUnitTypeCode',
      'locationId',
      'parentHandlingUnitId',
      'statusCode',
      'warehouseId',
    ]);
    expect(Object.keys(response.body.contents[0]).sort()).toEqual([
      'handlingUnitContentId',
      'handlingUnitId',
      'itemId',
      'lotId',
      'qty',
      'uomId',
    ]);

    // ⭐ 남의 구성이 섞여 나오지 않는다 — `contentsOf` 의 `where` 를 빼면 여기가 빨개진다.
    expect(response.body.contents.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentB1,
      contentB2,
    ]);
  });

  it('상세 응답 ETag 헤더가 version_no 문자열과 같다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huA}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.headers.etag).toBe('1');
  });

  it('상세 — 없는 id 는 404 다', async () => {
    await request(app.getHttpServer()).get(`${PATH}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('contents 는 {items[]} 만 오고 etag 헤더가 버전 토큰이 아니다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huB}/contents`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units/{handlingUnitId}/contents');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(Object.keys(response.body)).toEqual(['items']);

    // ⭐ B 의 두 행만 온다 — A 의 구성(contentA1)이 섞이면 빨개진다(리뷰 Major-1).
    expect(response.body.items.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentB1,
      contentB2,
    ]);
    expect(response.body.items.map((c: { uomId: number }) => c.uomId)).toEqual([uomId, uom2Id]);

    // ⭐ R-5 — express 가 JSON 본문에 약한 검증자(W/"...")를 스스로 단다. `toBeUndefined()`
    //   도 `!== String(version_no)` 로도 재지 않는다(저장소 선례 11건 · 두 경로가 다 version
    //   을 +1 해 그 형은 변이를 못 잡는다).
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
  });

  it('⭐ contents — A 를 물으면 A 의 한 행만 온다(반대 방향으로도 걸러진다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${PATH}/${huA}/contents`)
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body.items.map((c: { handlingUnitContentId: number }) => c.handlingUnitContentId)).toEqual([
      contentA1,
    ]);
  });

  it('contents — 없는 id 는 404 다(계약 미선언 · 서버가 낸다)', async () => {
    await request(app.getHttpServer()).get(`${PATH}/999999999/contents`).set('Cookie', cookie).expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  async function list(qs: string): Promise<PagedHandlingUnits> {
    const response = await request(app.getHttpServer())
      .get(qs ? `${PATH}?${qs}` : PATH)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /inventory/handling-units');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    return response.body as PagedHandlingUnits;
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

  async function makeFixture(): Promise<void> {
    // ⛔ 조회 3건은 계약이 403 을 선언하지 않는다 — 역할·권한을 하나도 안 준다
    //    (`permission.guard.ts:37-41` · `app-attachment.e2e-spec.ts` 선례).
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '취급단위검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    cookie = await login();

    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '취급단위검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '취급단위검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '취급단위검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });

    const warehouse1 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH1`,
        warehouse_name: '취급단위검사창고1',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse1Id = Number(warehouse1.warehouse_id);
    const warehouse2 = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH2`,
        warehouse_name: '취급단위검사창고2',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouse2Id = Number(warehouse2.warehouse_id);

    const location1 = await prisma.location.create({
      data: {
        warehouse_id: warehouse1.warehouse_id,
        location_code: `${PREFIX}-LOC1`,
        location_name: '취급단위검사위치1',
        location_type_code: 'BIN',
      },
    });
    location1Id = Number(location1.location_id);
    const location2 = await prisma.location.create({
      data: {
        warehouse_id: warehouse2.warehouse_id,
        location_code: `${PREFIX}-LOC2`,
        location_name: '취급단위검사위치2',
        location_type_code: 'BIN',
      },
    });
    location2Id = Number(location2.location_id);

    const uoms = await prisma.uom.findMany({ take: 2, orderBy: { uom_id: 'asc' } });
    expect(uoms).toHaveLength(2); // 축의 값이 하나면 아래 uomId 단언이 언제나 초록이다
    const [uom, uom2] = uoms;
    uomId = Number(uom.uom_id);
    uom2Id = Number(uom2.uom_id);

    const item1 = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT1`,
        item_name: '취급단위검사품목1',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    item1Id = Number(item1.item_id);
    const item2 = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT2`,
        item_name: '취급단위검사품목2',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    item2Id = Number(item2.item_id);

    const lot1 = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT1`,
        item_id: item1.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lot1Id = Number(lot1.lot_id);
    const lot2 = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT2`,
        item_id: item2.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'INSPECTION_PENDING',
      },
    });
    lot2Id = Number(lot2.lot_id);

    const a = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-ALPHA-1`,
        handling_unit_type_code: 'PALLET',
        warehouse_id: warehouse1.warehouse_id,
        location_id: location1.location_id,
        status_code: 'OPEN',
      },
    });
    huA = Number(a.handling_unit_id);

    const b = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-ALPHA-2`,
        handling_unit_type_code: 'BOX',
        warehouse_id: warehouse2.warehouse_id,
        location_id: location2.location_id,
        status_code: 'OPEN',
        parent_handling_unit_id: a.handling_unit_id,
      },
    });
    huB = Number(b.handling_unit_id);

    const c = await prisma.handling_unit.create({
      data: {
        handling_unit_no: `${PREFIX}-BETA-1`,
        handling_unit_type_code: 'PALLET',
        status_code: 'PACKED',
      },
    });
    huC = Number(c.handling_unit_id);

    const content1 = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: b.handling_unit_id,
        item_id: item1.item_id,
        lot_id: lot1.lot_id,
        qty: 12.5,
        uom_id: uom.uom_id,
      },
    });
    contentB1 = Number(content1.handling_unit_content_id);
    const content2 = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: b.handling_unit_id,
        item_id: item2.item_id,
        lot_id: lot2.lot_id,
        qty: 7.25,
        uom_id: uom2.uom_id,
      },
    });
    contentB2 = Number(content2.handling_unit_content_id);

    // ⭐ A 의 구성 — B 조회에 «섞여 나오면» 안 되는 행이다(리뷰 Major-1).
    const contentA = await prisma.handling_unit_content.create({
      data: {
        handling_unit_id: a.handling_unit_id,
        item_id: item1.item_id,
        lot_id: lot1.lot_id,
        qty: 3.5,
        uom_id: uom2.uom_id,
      },
    });
    contentA1 = Number(contentA.handling_unit_content_id);
  }

  /**
   * ⚠ S-12 — `handling_unit` 이 `WAREHOUSE_REFERRERS`·`LOCATION_REFERRERS` 에 있다. HU 를
   * 먼저 지우지 않으면 창고·위치 삭제가 막혀 다음 실행이 붉어진다. 자기참조(`parent_
   * handling_unit_id`)는 먼저 풀어 둔 뒤 지운다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      UPDATE inventory.handling_unit SET parent_handling_unit_id = NULL
       WHERE handling_unit_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM inventory.handling_unit_content
       WHERE handling_unit_id IN (
         SELECT handling_unit_id FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'
       )`);
    await prisma.$executeRawUnsafe(`DELETE FROM inventory.handling_unit WHERE handling_unit_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
  }
});
