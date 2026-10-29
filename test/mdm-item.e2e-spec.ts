/**
 * 품목 마스터.
 *
 * ERP 수신본이라 등록도 삭제도 없다. 「무엇을 고칠 수 있는가」가 **본문의 모양**으로
 * 정해진 자리이고(원본 필드에 자리가 아예 없다), 그 위에 확정 QA #28 이 얹힌다.
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

const LOGIN_ID = 'e2e-mdmitem-probe';
const NOPERM_ID = 'e2e-mdmitem-noperm';
const PASSWORD = '품목-마스터-검사-비밀번호';
const PREFIX = 'MDMITEM';
const ROLE = 'E2E_MDMITEM';

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/mdm-기준정보.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

const key = (): string => randomUUID();

describe('품목 마스터 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];
  let plainItemId: number;
  let routedItemId: number;
  let baseUomId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '품목검사', status_code: 'EMPLOYED' },
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

    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '품목검사용' } });
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: 'W-06-05' },
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    cookie = await login();

    // 품목은 ERP 수신본이라 등록 엔드포인트가 없다 — 검사 대상을 DB 로 세운다.
    baseUomId = (await prisma.uom.findFirstOrThrow()).uom_id;
    plainItemId = await createItem(`${PREFIX}-A`);
    routedItemId = await createItem(`${PREFIX}-R`);
    await prisma.routing.create({
      data: {
        item_id: routedItemId,
        routing_code: `${PREFIX}-RT`,
        routing_version: 1,
        status_code: 'CONFIRMED',
        effective_from: new Date('2026-01-01'),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 계약 스키마를 만족한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/items');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('⭐ itemTypeCode 는 여러 값을 받는다 — 쉼표로 잇거나 같은 키를 되풀이한다(위치 보관 품목 칸 · 2026-10-29)', async () => {
    const raw = await createItem(`${PREFIX}-TYPE-RAW`, 'RAW_MATERIAL');
    const sub = await createItem(`${PREFIX}-TYPE-SUB`, 'SUBSIDIARY_MATERIAL');
    const fin = await createItem(`${PREFIX}-TYPE-FIN`, 'FINISHED');
    const idsOf = async (query: string): Promise<number[]> => {
      const response = await request(app.getHttpServer())
        .get(`/api/mdm/items?q=${PREFIX}-TYPE&${query}`)
        .set('Cookie', cookie)
        .expect(200);
      return response.body.items.map((i: { itemId: number }) => i.itemId).sort();
    };

    expect(await idsOf('itemTypeCode=RAW_MATERIAL,SUBSIDIARY_MATERIAL')).toEqual([raw, sub].sort());
    expect(await idsOf('itemTypeCode=SUBSIDIARY_MATERIAL&itemTypeCode=FINISHED')).toEqual([sub, fin].sort());
    expect(await idsOf('itemTypeCode=FINISHED')).toEqual([fin]);
  });

  it('⭐ hasRouting=false 는 Routing 이 «한 건도 없는» 품목만 낸다', async () => {
    const without = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}&hasRouting=false`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = without.body.items.map((i: { itemId: number }) => i.itemId);
    expect(ids).toContain(plainItemId);
    expect(ids).not.toContain(routedItemId);

    const withRouting = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}&hasRouting=true`)
      .set('Cookie', cookie)
      .expect(200);
    const withIds = withRouting.body.items.map((i: { itemId: number }) => i.itemId);
    expect(withIds).toContain(routedItemId);
    expect(withIds).not.toContain(plainItemId);
  });

  it('⭐ hasBom 은 그 품목을 모품목으로 하는 BOM 이 있는가로 거른다 — 계약 밖(장부 P-130)', async () => {
    const parentId = await createItem(`${PREFIX}-B`);
    await prisma.bom.create({
      data: {
        parent_item_id: parentId,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01'),
        base_qty: 1,
        base_uom_id: baseUomId,
      },
    });
    const listed = async (hasBom: string): Promise<number[]> =>
      (
        await request(app.getHttpServer())
          .get(`/api/mdm/items?q=${PREFIX}&includeInactive=true&size=50&hasBom=${hasBom}`)
          .set('Cookie', cookie)
          .expect(200)
      ).body.items.map((i: { itemId: number }) => i.itemId);

    const withBom = await listed('true');
    expect(withBom).toContain(parentId);
    expect(withBom).not.toContain(plainItemId);

    const withoutBom = await listed('false');
    expect(withoutBom).toContain(plainItemId);
    expect(withoutBom).not.toContain(parentId);
  });

  it('⛔ hasBom 이 true·false 가 아니면 400 이다 — 무시하면 전 품목이 걸러진 것처럼 보인다', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}&hasBom=yes`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['hasBom']);
  });

  it('⭐ inspectionRequired 는 품목의 IQC 대상 여부로 거른다 — 계약 밖(장부 P-138)', async () => {
    const inspectedId = await createItem(`${PREFIX}-I`);
    await prisma.item.update({ where: { item_id: BigInt(inspectedId) }, data: { inspection_required: true } });
    const listed = async (value: string): Promise<number[]> =>
      (
        await request(app.getHttpServer())
          .get(`/api/mdm/items?q=${PREFIX}&includeInactive=true&size=50&inspectionRequired=${value}`)
          .set('Cookie', cookie)
          .expect(200)
      ).body.items.map((i: { itemId: number }) => i.itemId);

    const inspected = await listed('true');
    expect(inspected).toContain(inspectedId);
    expect(inspected).not.toContain(plainItemId);

    const notInspected = await listed('false');
    expect(notInspected).toContain(plainItemId);
    expect(notInspected).not.toContain(inspectedId);
  });

  it('⛔ inspectionRequired 가 true·false 가 아니면 400 이다', async () => {
    const rejected = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}&inspectionRequired=Y`)
      .set('Cookie', cookie)
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['inspectionRequired']);
  });

  it('ERP 규격·품목그룹이 목록·상세에 실린다 · 없으면 null 이다 — 계약 밖(장부 P-75)', async () => {
    await prisma.item.update({
      where: { item_id: BigInt(plainItemId) },
      data: { erp_spec: '12x34 SUS', erp_item_group_code: 'G100' },
    });
    try {
      const listed = await request(app.getHttpServer())
        .get(`/api/mdm/items?q=${PREFIX}`)
        .set('Cookie', cookie)
        .expect(200);
      const byId = new Map(listed.body.items.map((i: { itemId: number }) => [i.itemId, i]));
      expect(byId.get(plainItemId)).toMatchObject({ erpSpec: '12x34 SUS', erpItemGroupCode: 'G100' });
      expect(byId.get(routedItemId)).toMatchObject({ erpSpec: null, erpItemGroupCode: null });

      const detail = await request(app.getHttpServer())
        .get(`/api/mdm/items/${plainItemId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(detail.body.item).toMatchObject({ erpSpec: '12x34 SUS', erpItemGroupCode: 'G100' });
      expect(validator('GET /mdm/items/{itemId}')(detail.body)).toBe(true);
    } finally {
      await prisma.item.update({
        where: { item_id: BigInt(plainItemId) },
        data: { erp_spec: null, erp_item_group_code: null },
      });
    }
  });

  it('⛔ 상세의 editability 는 항상 RECEIVED_FROM_ERP 다 — 계약이 고정했다', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .expect(200);

    const validate = validator('GET /mdm/items/{itemId}');
    expect(validate(detail.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(detail.body.editability).toEqual({
      codeEditable: false,
      reason: 'RECEIVED_FROM_ERP',
      referenceCount: null,
    });
    expect(detail.headers.etag).toMatch(/^\d+$/);
  });

  it('⛔ 권한이 없으면 수정이 403 이다', async () => {
    const { etag } = await detailOf(plainItemId);
    await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', noPermCookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody())
      .expect(403);
  });

  it('⭐ MES 확장만 고친다 — 원본 필드는 본문에 자리가 없다', async () => {
    const before = await detailOf(plainItemId);

    const updated = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', before.etag)
      .send(
        updateBody({
          inspectionRequired: true,
          negativeStockAllowed: true,
          nameVi: 'Vat lieu',
          developmentItem: true,
        }),
      )
      .expect(200);

    expect(updated.body.inspectionRequired).toBe(true);
    expect(updated.body.nameVi).toBe('Vat lieu');
    expect(updated.body.developmentItem).toBe(true);
    // 원본은 그대로다 — 보낼 자리가 없으므로 구조로 막힌다.
    expect(updated.body.itemCode).toBe(`${PREFIX}-A`);
    expect(updated.body.itemName).toBe(before.body.item.itemName);
    expect(Number(updated.headers.etag)).toBe(Number(before.etag) + 1);
  });

  it('⭐ LOT 기본크기는 새 이름 defaultLotSize 로도 받고, 응답에 두 이름을 함께 싣는다 — 계약 밖(장부 P-139)', async () => {
    const put = async (extra: Record<string, unknown>, status: number) => {
      const { etag } = await detailOf(plainItemId);
      return request(app.getHttpServer())
        .put(`/api/mdm/items/${plainItemId}`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key())
        .set('If-Match', etag)
        .send(updateBody(extra))
        .expect(status);
    };

    const byNew = await put({ defaultLotSize: 250 }, 200);
    expect(byNew.body).toMatchObject({ defaultLotSize: 250, defaultProductionLotSize: 250 });

    const byOld = await put({ defaultProductionLotSize: 400 }, 200);
    expect(byOld.body).toMatchObject({ defaultLotSize: 400, defaultProductionLotSize: 400 });

    const both = await put({ defaultLotSize: 500, defaultProductionLotSize: 500 }, 200);
    expect(both.body.defaultLotSize).toBe(500);

    const cleared = await put({ defaultLotSize: null }, 200);
    expect(cleared.body).toMatchObject({ defaultLotSize: null, defaultProductionLotSize: null });
  });

  it.each([
    ['0 이하', { defaultLotSize: 0 }],
    ['수가 아니다', { defaultLotSize: '250' }],
    ['두 이름의 값이 다르다', { defaultLotSize: 250, defaultProductionLotSize: 300 }],
  ])('⛔ defaultLotSize 가 %s 면 400 이다', async (_, extra) => {
    const { etag } = await detailOf(plainItemId);
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody(extra))
      .expect(400);
    expect(rejected.body.errors.map((e: { field: string }) => e.field)).toEqual(['defaultLotSize']);
  });

  it('⭐ 유효기한을 관리하면 FEFO 여야 한다 — 확정 QA #28', async () => {
    const { etag } = await detailOf(plainItemId);

    // shelfLifeDays 가 있는데 FIFO 면 먼저 만료될 재고를 뒤로 미룬다. DB 는 통과시킨다.
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ shelfLifeDays: 90, fifoPolicyCode: 'FIFO' }))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'fifoPolicyCode', code: 'PAIR' });

    const accepted = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ shelfLifeDays: 90, fifoPolicyCode: 'FEFO' }))
      .expect(200);
    expect(accepted.body.shelfLifeDays).toBe(90);
    expect(accepted.body.fifoPolicyCode).toBe('FEFO');
  });

  it('⛔ 반대도 막는다 — 유효기한을 끄면서 FEFO 로 두지 못한다', async () => {
    const { etag } = await detailOf(plainItemId);

    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ shelfLifeDays: null, fifoPolicyCode: 'FEFO' }))
      .expect(400);
    expect(rejected.body.errors[0]).toMatchObject({ field: 'fifoPolicyCode', code: 'PAIR' });

    // 토글 OFF 는 shelfLifeDays 를 null 로 보내는 것이다(계약 §8-2).
    const off = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ shelfLifeDays: null, fifoPolicyCode: 'FIFO' }))
      .expect(200);
    expect(off.body.shelfLifeDays).toBeNull();
  });

  it('⛔ 마스터에 없는 공통코드는 400 이다', async () => {
    const { etag } = await detailOf(plainItemId);
    const rejected = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ storageConditionCode: '없는조건' }))
      .expect(400);

    expect(rejected.body.errors[0]).toMatchObject({ field: 'storageConditionCode', code: 'INVALID' });
  });

  it('⛔ 낡은 If-Match 는 409 STALE_VERSION 이다', async () => {
    const { etag } = await detailOf(plainItemId);
    await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody())
      .expect(200);

    const stale = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody())
      .expect(409);
    expect(stale.body.conflictCause).toBe('user');
  });

  it('⭐ :deactivate 가 없다 — isActive 를 PUT 본문으로 바꾼다', async () => {
    const { etag } = await detailOf(plainItemId);
    const off = await request(app.getHttpServer())
      .put(`/api/mdm/items/${plainItemId}`)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key())
      .set('If-Match', etag)
      .send(updateBody({ isActive: false }))
      .expect(200);
    expect(off.body.isActive).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/api/mdm/items?q=${PREFIX}-A`)
      .set('Cookie', cookie)
      .expect(200);
    expect(list.body.items.map((i: { itemId: number }) => i.itemId)).not.toContain(plainItemId);
  });

  it('⛔ 없는 품목은 404 다', async () => {
    await request(app.getHttpServer())
      .get('/api/mdm/items/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  // ── 도우미 ──────────────────────────────────────────────────────────────

  /** 계약 `ItemUpdate` 의 필수 칸을 모두 담은 기본 본문. */
  function updateBody(extra: Record<string, unknown> = {}): object {
    return {
      lotControlled: true,
      serialControlTypeCode: 'NONE',
      inspectionRequired: false,
      fifoPolicyCode: 'FIFO',
      negativeStockAllowed: false,
      isActive: true,
      ...extra,
    };
  }

  async function detailOf(
    itemId: number,
  ): Promise<{ etag: string; body: { item: { itemName: string } } }> {
    const detail = await request(app.getHttpServer())
      .get(`/api/mdm/items/${itemId}`)
      .set('Cookie', cookie)
      .expect(200);
    return { etag: detail.headers.etag, body: detail.body };
  }

  async function createItem(itemCode: string, itemTypeCode = 'RAW_MATERIAL'): Promise<number> {
    const created = await prisma.item.create({
      data: {
        item_code: itemCode,
        item_name: itemCode,
        item_type_code: itemTypeCode,
        base_uom_id: baseUomId,
        lot_controlled: true,
      },
    });
    return Number(created.item_id);
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

  async function cleanup(): Promise<void> {
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      select: { item_id: true },
    });
    const ids = items.map((i) => i.item_id);
    await prisma.routing.deleteMany({ where: { item_id: { in: ids } } });
    await prisma.bom.deleteMany({ where: { parent_item_id: { in: ids } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
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
