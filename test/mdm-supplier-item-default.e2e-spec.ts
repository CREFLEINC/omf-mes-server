/**
 * 공급사·품목 기본 정보(피처 005 · omf-all-around#254 · W-06-25 · 계약 §9). 발행 경로는 아직 없어 「바꿔도 이미 만든
 * 묶음·자재 관리 LOT 는 그대로」는 묶음·LOT 를 직접 넣어 본다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `SID${randomUUID().slice(0, 6)}`;
const PATH = '/api/mdm/supplier-item-defaults';
const ITEM_PATH = '/mdm/supplier-item-defaults/{supplierItemDefaultId}';
const HANOI = 'Asia/Ho_Chi_Minh';

const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const format of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(format, true);
ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
function validator(path: string, method: string, status: number): ValidateFunction {
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method}/responses/${status}/content/application~1json/schema`;
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

interface Row {
  supplierItemDefaultId: number;
  versionNo: number;
}

describe('공급사·품목 기본 정보 W-06-25 (e2e · 피처 005)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ids: Record<string, bigint> = {};
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '기본정보법인', country_code: 'VN', timezone_code: HANOI },
    });
    ids.entity = entity.legal_entity_id;
    for (const key of ['P1', 'P2']) {
      const plant = await prisma.plant.create({
        data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-${key}`, plant_name: `기본정보${key}`, timezone_code: HANOI },
      });
      ids[key] = plant.plant_id;
    }
    for (const key of ['EA', 'BAG']) {
      ids[key] = (await prisma.uom.create({ data: { uom_code: `${PREFIX}-${key}`, uom_name: key } })).uom_id;
    }
    for (const [key, name] of [['S1', '가나공급'], ['S2', '다라공급']]) {
      ids[key] = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-${key}`, partner_name: name } })).partner_id;
    }
    for (const [key, name] of [['I1', '나사'], ['I2', '볼트']]) {
      ids[key] = (
        await prisma.item.create({
          data: { item_code: `${PREFIX}-${key}`, item_name: name, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.EA },
        })
      ).item_id;
    }
    for (const code of ['W-06-25', 'P-01-01', 'W-01-14', 'W-06-05']) cookies[code] = await userWith(code);
  });

  afterAll(async () => {
    const plants = { in: [ids.P1, ids.P2] };
    await prisma.lot.deleteMany({ where: { plant_id: plants } });
    await prisma.material_lot_batch.deleteMany({ where: { plant_id: plants } });
    await prisma.supplier_item_default.deleteMany({ where: { plant_id: plants } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
    await prisma.uom.deleteMany({ where: { uom_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_id: plants } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_id: ids.entity } });
    const users = { app_user: { login_id: { startsWith: PREFIX } } };
    await prisma.idempotency_record.deleteMany({ where: users });
    await prisma.user_role.deleteMany({ where: users });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: { startsWith: PREFIX } } } });
    await prisma.role.deleteMany({ where: { role_code: { startsWith: PREFIX } } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: PREFIX } } });
    await app.close();
  });

  async function userWith(permission: string): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${permission}`, user_name: `기본정보 ${permission}`, status_code: 'EMPLOYED' } });
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}-${permission}`, role_name: permission } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: permission } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(user.app_user_id), typ: 'session' })}`;
  }

  const send = (method: 'post' | 'put' | 'delete', path: string, body?: object, as = cookies['W-06-25']) =>
    request(app.getHttpServer())[method](path).set('Cookie', as).set('Idempotency-Key', randomUUID()).send(body);
  const list = (query: object, as = cookies['W-06-25']) =>
    request(app.getHttpServer()).get(PATH).query({ plantId: Number(ids.P1), ...query }).set('Cookie', as);
  const body = (overrides: object = {}) => ({
    plantId: Number(ids.P1),
    supplierId: Number(ids.S1),
    itemId: Number(ids.I1),
    lotQty: 1000,
    package: { uomId: Number(ids.BAG), count: 10, qtyPerPackage: 100 },
    remarks: '봉지 10 × 100',
    ...overrides,
  });

  let main: Row;

  it('US1-9 등록하면 공급사·품목·기본 단위·패키징을 계약 모양으로 돌려준다', async () => {
    const created = await send('post', PATH, body()).expect(201);
    expect(validator('/mdm/supplier-item-defaults', 'post', 201)(created.body)).toBe(true);
    expect(created.body).toMatchObject({
      plantId: Number(ids.P1),
      supplierId: Number(ids.S1),
      supplierCode: `${PREFIX}-S1`,
      supplierName: '가나공급',
      itemId: Number(ids.I1),
      itemCode: `${PREFIX}-I1`,
      itemName: '나사',
      uomId: Number(ids.EA),
      uomCode: `${PREFIX}-EA`,
      lotQty: 1000,
      package: { uomId: Number(ids.BAG), uomCode: `${PREFIX}-BAG`, count: 10, qtyPerPackage: 100 },
      remarks: '봉지 10 × 100',
      versionNo: 1,
      updatedByName: '기본정보 W-06-25',
    });
    // 패키징 단위 이름(표시용 · G1 잔여).
    expect(created.body.package.uomName).toBe('BAG');
    main = created.body as Row;

    const plain = await send('post', PATH, body({ supplierId: Number(ids.S2), itemId: Number(ids.I2), lotQty: 50, package: null, remarks: null })).expect(201);
    expect(plain.body).toMatchObject({ package: null, remarks: null, lotQty: 50 });
  });

  it('US1-9 목록 — 공장 필수, 공급사·품목 조건, q(공급사·품목 코드·이름), 쪽', async () => {
    const all = await list({}).expect(200);
    expect(validator('/mdm/supplier-item-defaults', 'get', 200)(all.body)).toBe(true);
    expect(all.body.items.map((row: { itemCode: string }) => row.itemCode)).toEqual([`${PREFIX}-I1`, `${PREFIX}-I2`]);
    expect(all.body.page).toMatchObject({ total: 2 });

    const one = await list({ supplierId: Number(ids.S1), itemId: Number(ids.I1) }).expect(200);
    expect(one.body.items).toHaveLength(1);
    expect((await list({ q: '다라' }).expect(200)).body.items.map((row: { itemName: string }) => row.itemName)).toEqual(['볼트']);
    expect((await list({ q: `${PREFIX}-i1` }).expect(200)).body.items).toHaveLength(1);
    expect((await list({ q: '나사' }).expect(200)).body.items).toHaveLength(1);

    const second = await list({ page: 2, size: 1 }).expect(200);
    expect(second.body.items.map((row: { itemCode: string }) => row.itemCode)).toEqual([`${PREFIX}-I2`]);
    expect(second.body.page).toMatchObject({ page: 2, size: 1, total: 2 });

    await request(app.getHttpServer()).get(PATH).set('Cookie', cookies['W-06-25']).expect(400);
  });

  it('US1-9 400 INVALID — 패키징 곱 불일치는 DB 에 닿기 전에 막는다, lotQty 는 0 보다 커야 한다', async () => {
    const mismatch = await send('post', PATH, body({ itemId: Number(ids.I2), lotQty: 999 })).expect(400);
    expect(mismatch.body.errors).toEqual([expect.objectContaining({ field: 'lotQty', code: 'INVALID' })]);
    await send('post', PATH, body({ itemId: Number(ids.I2), lotQty: 0, package: null })).expect(400);
    const update = await send('put', `${PATH}/${main.supplierItemDefaultId}`, { versionNo: main.versionNo, lotQty: 1000, package: { uomId: Number(ids.BAG), count: 3, qtyPerPackage: 100 } }).expect(400);
    expect(update.body.errors).toEqual([expect.objectContaining({ field: 'lotQty', code: 'INVALID' })]);
  });

  it('US1-9 409 DUPLICATE — 같은 공장·공급사·품목', async () => {
    const duplicate = await send('post', PATH, body({ lotQty: 5, package: null })).expect(409);
    expect(duplicate.body.errors[0]).toMatchObject({ code: 'DUPLICATE' });
  });

  it('US1-9 공장 단위 — 다른 공장의 같은 공급사·품목은 따로 둔다', async () => {
    const other = await send('post', PATH, body({ plantId: Number(ids.P2), lotQty: 7, package: null })).expect(201);
    expect(other.body).toMatchObject({ plantId: Number(ids.P2), lotQty: 7 });
    const p1 = await list({ supplierId: Number(ids.S1), itemId: Number(ids.I1) }).expect(200);
    expect(p1.body.items).toEqual([expect.objectContaining({ supplierItemDefaultId: main.supplierItemDefaultId, lotQty: 1000 })]);
  });

  it('US1-9 수정은 versionNo 로 — 바뀌면 판이 오르고, 옛 판은 409 VERSION_CONFLICT', async () => {
    const updated = await send('put', `${PATH}/${main.supplierItemDefaultId}`, {
      versionNo: main.versionNo,
      lotQty: 600,
      package: { uomId: Number(ids.BAG), count: 4, qtyPerPackage: 150 },
      remarks: '봉지 4 × 150',
    }).expect(200);
    expect(validator(ITEM_PATH, 'put', 200)(updated.body)).toBe(true);
    expect(updated.body).toMatchObject({ lotQty: 600, package: { count: 4, qtyPerPackage: 150 }, versionNo: main.versionNo + 1 });

    const stale = await send('put', `${PATH}/${main.supplierItemDefaultId}`, { versionNo: main.versionNo, lotQty: 1, package: null }).expect(409);
    expect(validator(ITEM_PATH, 'put', 409)(stale.body)).toBe(true);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT', conflictCause: 'user', currentVersion: String(main.versionNo + 1) });

    const cleared = await send('put', `${PATH}/${main.supplierItemDefaultId}`, { versionNo: main.versionNo + 1, lotQty: 600 }).expect(200);
    expect(cleared.body).toMatchObject({ package: null, remarks: null, versionNo: main.versionNo + 2 });
    main = cleared.body as Row;
  });

  it('US1-9 고치고 지워도 이미 만든 묶음·자재 관리 LOT 는 그대로다', async () => {
    const userId = (await prisma.app_user.findFirstOrThrow({ where: { login_id: `${PREFIX}-W-06-25` } })).app_user_id;
    const batch = await prisma.material_lot_batch.create({
      data: {
        plant_id: ids.P1, item_id: ids.I1, supplier_id: ids.S1, lot_qty: 600, package_uom_id: ids.BAG, package_count: 4,
        qty_per_package: 150, lot_count: 1, created_channel_code: 'WEB', created_by: userId,
      },
    });
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-1`, item_id: ids.I1, lot_type_code: 'MATERIAL', plant_id: ids.P1, initial_qty: 600, uom_id: ids.EA,
        source_type_code: 'MATERIAL_LOT_BATCH', source_id: batch.material_lot_batch_id, status_code: 'NORMAL',
        package_uom_id: ids.BAG, package_count: 4, qty_per_package: 150,
      },
    });
    const before = { batch: await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: batch.material_lot_batch_id } }), lot: await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lot_id } }) };

    await send('put', `${PATH}/${main.supplierItemDefaultId}`, { versionNo: main.versionNo, lotQty: 200, package: { uomId: Number(ids.EA), count: 2, qtyPerPackage: 100 } }).expect(200);
    expect(await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: batch.material_lot_batch_id } })).toEqual(before.batch);
    expect(await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lot_id } })).toEqual(before.lot);

    await send('delete', `${PATH}/${main.supplierItemDefaultId}`).expect(204);
    expect(await prisma.supplier_item_default.findUnique({ where: { supplier_item_default_id: main.supplierItemDefaultId } })).toBeNull();
    expect(await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: batch.material_lot_batch_id } })).toEqual(before.batch);
    expect(await prisma.lot.findUniqueOrThrow({ where: { lot_id: lot.lot_id } })).toEqual(before.lot);

    await send('delete', `${PATH}/${main.supplierItemDefaultId}`).expect(404);
    await send('put', `${PATH}/${main.supplierItemDefaultId}`, { versionNo: 1, lotQty: 1 }).expect(404);
  });

  describe('R19-1 권한', () => {
    let target: Row;
    beforeAll(async () => {
      target = (await send('post', PATH, body({ itemId: Number(ids.I1), lotQty: 30, package: null })).expect(201)).body as Row;
    });

    it.each(['W-06-25', 'P-01-01', 'W-01-14'])('R19-1 읽기 — %s 는 200', async (code) => {
      await list({}, cookies[code]).expect(200);
    });

    it('R19-1 읽기 — 그 밖 권한(W-06-05)은 403', async () => {
      await list({}, cookies['W-06-05']).expect(403);
    });

    it.each(['P-01-01', 'W-01-14', 'W-06-05'])('R19-1 쓰기 — %s 는 추가·수정·삭제 모두 403', async (code) => {
      await send('post', PATH, body({ supplierId: Number(ids.S2), itemId: Number(ids.I1), lotQty: 1, package: null }), cookies[code]).expect(403);
      await send('put', `${PATH}/${target.supplierItemDefaultId}`, { versionNo: target.versionNo, lotQty: 2 }, cookies[code]).expect(403);
      await send('delete', `${PATH}/${target.supplierItemDefaultId}`, undefined, cookies[code]).expect(403);
    });

    it('R19-1 쓰기 — W-06-25 는 수정·삭제가 된다', async () => {
      await send('put', `${PATH}/${target.supplierItemDefaultId}`, { versionNo: target.versionNo, lotQty: 2 }).expect(200);
      await send('delete', `${PATH}/${target.supplierItemDefaultId}`).expect(204);
    });
  });
});
