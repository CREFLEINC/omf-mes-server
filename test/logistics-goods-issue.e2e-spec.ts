/**
 * 출고 조회 3건 — `GET /logistics/goods-issues`·`/{goodsIssueId}`·`/{goodsIssueId}/lines`.
 * 화면 `W-01-05`(반품)·`W-01-06`(기타 출고)·`P-01-02`(현장 QR).
 *
 * ⛔ 이 PR 은 쓰기 API 가 없다(등록·전기·라인 치환·상신은 PR ③④⑤) — 전표는 **직접 INSERT**
 * 한다(`insertRegisteredIssue`). PR ③④ 가 같은 헬퍼를 그대로 쓴다(I-4.md R-3 · 브리프
 * 「I-4.md 와 달리 한 것」 — 픽스처 헬퍼를 R-3 대신 여기서 만든다).
 *
 * ⚠ **시퀀서 순서에 기댄다** — `alphabetical-sequencer.js` 는 파일 이름 순으로 돈다.
 * `logistics-goods-issue` 가 `logistics-goods-receipt` **앞**이다. 뒤 스위트
 * (`logistics-goods-receipt.e2e-spec.ts`) 의 `cleanup()` 첫 줄 `TRUNCATE
 * inventory.inventory_transaction_line, inventory.inventory_transaction CASCADE` 가
 * `goods_issue_line.inventory_transaction_line_id` FK 때문에 `logistics.goods_issue_line`
 * 까지 비운다 — 이 스위트가 먼저 끝나 무해하지만, 역순으로 돌면 조용히 깨진다
 * (I-4.md §8-3 ⓘ).
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

const LOGIN_ID = 'e2e-gi-probe';
const PASSWORD = 'GI-조회-비밀번호';
const PREFIX = 'GIE2E';
const ROLE = 'E2E_GI';
const DAY = '2026-05-04';

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

interface IssueBody {
  goodsIssueId: number;
  goodsIssueNo: string;
  issueTypeCode: string;
  statusCode: string;
  destinationTypeCode: string | null;
  destinationId: number | null;
  erpMessageQueued: boolean;
}
interface Fixture extends IssueBody {
  goodsIssueLineId: number;
}

describe('출고 조회 3건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let warehouseId: number;
  let locationId: number;
  let itemId: number;
  let uomId: number;
  let lotId: number;
  let goodsReceiptId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('GET /logistics/goods-issues — 목록이 뜬다 · page 메타가 있다', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      .get('/api/logistics/goods-issues')
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.body.page).toMatchObject({ page: 1, size: 50 });
    expect(response.body.items.map((row: IssueBody) => row.goodsIssueId)).toContain(goodsIssueId);
  });

  it('GET /logistics/goods-issues?issueTypeCode= — 유형으로 걸린다', async () => {
    const target = await insertRegisteredIssue({ issueTypeCode: 'SUPPLIER_RETURN' });
    const other = await insertRegisteredIssue({ issueTypeCode: 'OTHER' });

    const response = await request(app.getHttpServer())
      .get('/api/logistics/goods-issues?issueTypeCode=SUPPLIER_RETURN')
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(target.goodsIssueId);
    expect(ids).not.toContain(other.goodsIssueId);
  });

  it('GET /logistics/goods-issues?statusCode= — 상태로 걸린다', async () => {
    const posted = await insertRegisteredIssue({ statusCode: 'POSTED' });
    const registered = await insertRegisteredIssue({ statusCode: 'REGISTERED' });

    const response = await request(app.getHttpServer())
      .get('/api/logistics/goods-issues?statusCode=POSTED')
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(posted.goodsIssueId);
    expect(ids).not.toContain(registered.goodsIssueId);
  });

  it('GET /logistics/goods-issues?supplierId= — 반품 건이 도착지 짝으로 걸린다', async () => {
    const supplierId = 900000001;
    const returned = await insertRegisteredIssue({
      issueTypeCode: 'SUPPLIER_RETURN',
      destinationTypeCode: 'PARTNER',
      destinationId: supplierId,
    });
    // 자체 폐기 — 도착지 짝을 통째로 비운다. 이 필터로 안 잡힌다(사실이 그렇다).
    const disposal = await insertRegisteredIssue({
      issueTypeCode: 'OTHER',
      destinationTypeCode: null,
      destinationId: null,
    });

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues?supplierId=${supplierId}`)
      .set('Cookie', cookie)
      .expect(200);
    const ids = response.body.items.map((row: IssueBody) => row.goodsIssueId);
    expect(ids).toContain(returned.goodsIssueId);
    expect(ids).not.toContain(disposal.goodsIssueId);
  });

  it('GET /logistics/goods-issues/{id} — 200 에 ETag 가 실린다', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues/{goodsIssueId}');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(response.headers.etag).toMatch(/^\d+$/);
    expect(response.body.goodsIssue).not.toHaveProperty('versionNo');
  });

  it('GET /logistics/goods-issues/{id} — 없는 id 는 404', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/goods-issues/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('GET /logistics/goods-issues/{id}/lines — ETag 를 안 내린다(자식 컬렉션)', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const response = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}/lines`)
      .set('Cookie', cookie)
      .expect(200);
    const validate = validator('GET /logistics/goods-issues/{goodsIssueId}/lines');
    expect(validate(response.body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    // express 약한 ETag 가 늘 붙는다 — 우리가 실은 numeric ETag 가 아니면 된다.
    expect(response.headers.etag ?? '').not.toMatch(/^\d+$/);
  });

  it('조회 3건은 403 을 내지 않는다(계약 미선언)', async () => {
    const { goodsIssueId } = await insertRegisteredIssue();

    const list = await request(app.getHttpServer())
      .get('/api/logistics/goods-issues')
      .set('Cookie', cookie);
    const detail = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}`)
      .set('Cookie', cookie);
    const lines = await request(app.getHttpServer())
      .get(`/api/logistics/goods-issues/${goodsIssueId}/lines`)
      .set('Cookie', cookie);

    expect(list.status).not.toBe(403);
    expect(detail.status).not.toBe(403);
    expect(lines.status).not.toBe(403);
  });

  let issueSeq = 0;
  /** 이 PR 은 쓰기 API 가 없다 — 전표+라인 1건을 직접 INSERT 한다(I-4.md §6-5 · R-3). */
  async function insertRegisteredIssue(
    overrides: {
      issueTypeCode?: string;
      statusCode?: string;
      destinationTypeCode?: string | null;
      destinationId?: number | null;
      issuedAt?: string;
    } = {},
  ): Promise<Fixture> {
    issueSeq += 1;
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-${issueSeq}`,
        issue_type_code: overrides.issueTypeCode ?? 'OTHER',
        source_document_type_code: 'GOODS_RECEIPT',
        source_document_id: goodsReceiptId,
        source_warehouse_id: warehouseId,
        destination_type_code: overrides.destinationTypeCode ?? null,
        destination_id: overrides.destinationId ?? null,
        issued_at: new Date(overrides.issuedAt ?? `${DAY}T02:00:00.000Z`),
        status_code: overrides.statusCode ?? 'REGISTERED',
      },
    });
    const line = await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id,
        line_no: 1,
        item_id: itemId,
        lot_id: lotId,
        issue_qty: 10,
        uom_id: uomId,
        source_location_id: locationId,
      },
    });
    return {
      goodsIssueId: Number(issue.goods_issue_id),
      goodsIssueNo: issue.goods_issue_no,
      issueTypeCode: issue.issue_type_code,
      statusCode: issue.status_code,
      destinationTypeCode: issue.destination_type_code,
      destinationId: issue.destination_id === null ? null : Number(issue.destination_id),
      erpMessageQueued: false,
      goodsIssueLineId: Number(line.goods_issue_line_id),
    };
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '출고조회검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '출고조회검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '출고조회검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = Number(uom.uom_id);

    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '출고조회검사품목',
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
        warehouse_name: '출고조회검사창고',
        warehouse_type_code: 'RAW',
        management_level_code: 'LOCATION',
      },
    });
    warehouseId = Number(warehouse.warehouse_id);

    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC`,
        location_name: '출고조회검사위치',
        location_type_code: 'BIN',
      },
    });
    locationId = Number(location.location_id);

    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-1`,
        item_id: item.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 100,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'AVAILABLE',
      },
    });
    lotId = Number(lot.lot_id);

    // `source_document_id` 는 FK 가 없다(다형) — 실제 `goods_receipt` 행을 가리키게 한다(R-3).
    const receipt = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR-1`,
        receipt_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        warehouse_id: warehouse.warehouse_id,
        receipt_datetime: new Date(`${DAY}T00:00:00.000Z`),
        status_code: 'POSTED',
      },
    });
    goodsReceiptId = Number(receipt.goods_receipt_id);
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '출고조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // 조회 3건은 계약이 403 을 선언하지 않는다 — 이 역할에는 일부러 권한을 하나도 안 준다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '출고조회검사용' } });
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
   * §6-5 순서를 그대로 따르되 이 PR 이 만드는 표만 넣는다. 원장(`inventory_transaction`)에는
   * 아예 쓰지 않으므로 TRUNCATE 가 필요 없다 — 등록·전기는 PR ③④ 의 몫이다.
   */
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue_line
       WHERE item_id IN (SELECT item_id FROM mdm.item WHERE item_code LIKE '${PREFIX}%')`);
    // ⭐ FK 를 먼저 끊는다(I-4.md §6-5 ⑥) — approval_request_id 는 지금은 늘 NULL 이지만
    //   순서 자리를 잡아 둔다(PR ⑤ 가 실제로 채우기 시작한다).
    await prisma.$executeRawUnsafe(`
      UPDATE logistics.goods_issue SET approval_request_id = NULL
       WHERE source_warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_issue
       WHERE source_warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`);
    // 라인 0건 — 잔액 픽스처가 아니라 `source_document_id` 가 가리킬 실제 행일 뿐이다.
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.goods_receipt
       WHERE plant_id IN (SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM trace.lot WHERE lot_no LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
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
    // `app.numbering_counter` 는 지우지 않는다(I-2 R-10 ⓔ) — 이 PR 은 채번을 부르지 않는다.
  }
});
