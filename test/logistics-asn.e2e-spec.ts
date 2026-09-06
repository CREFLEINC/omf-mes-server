/**
 * ASN 조회 3건 — 화면 `W-01-09`. ERP 수신본이라 등록·수정·삭제가 없다(계약
 * `x-internal-note`) — 픽스처는 `prisma.asn.create`/`asn_line.create` 로 직접 세운다
 * (P/O e2e:750 선례).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-asn-probe';
const PASSWORD = 'ASN-조회-검사-비밀번호';
const PREFIX = 'ASNE2E';

describe('ASN 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let supplierId: bigint;
  let plantId: bigint;
  let itemId: bigint;
  let uomId: bigint;
  let purchaseOrderId: bigint;
  let purchaseOrderLineId: bigint;
  let asnId: bigint;
  let asnLineWithPoId: bigint;
  let asnLineNoPoId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeMasters();
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('ASN — 상세가 헤더와 라인을 함께 준다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/asns/${asnId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.asn.asnId).toBe(Number(asnId));
    const lines = response.body.lines as { asnLineId: number; orderedQty: number | null; receivedQty: number | null }[];
    expect(lines.map((line) => line.asnLineId).sort((a, b) => a - b)).toEqual(
      [Number(asnLineWithPoId), Number(asnLineNoPoId)].sort((a, b) => a - b),
    );
    const withPo = lines.find((line) => line.asnLineId === Number(asnLineWithPoId));
    expect(withPo).toMatchObject({ orderedQty: 100, receivedQty: 20 });
    const noPo = lines.find((line) => line.asnLineId === Number(asnLineNoPoId));
    expect(noPo).toMatchObject({ orderedQty: null, receivedQty: null });
  });

  it('ASN — 없는 ASN 상세는 404 다(계약 선언)', async () => {
    await request(app.getHttpServer())
      .get('/api/logistics/asns/999999999')
      .set('Cookie', cookie)
      .expect(404);
  });

  it('ASN — 없는 ASN 의 라인 목록은 빈 배열이다(404 가 아니다 — 계약 미선언 · P/O 선례)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/logistics/asns/999999999/lines')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.items).toEqual([]);
  });

  it('ASN — 상세에 ETag 가 없다(계약이 헤더를 선언하지 않았다)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/logistics/asns/${asnId}`)
      .set('Cookie', cookie)
      .expect(200);

    // express 가 본문 해시로 자동 붙이는 약한 ETag 는 남는다 — 우리가 확인할 것은
    // `setEtag()`(낙관적 잠금 토큰, 순수 숫자 문자열)가 걸리지 않았다는 사실뿐이다.
    expect(response.headers.etag).not.toMatch(/^\d+$/);
  });

  it('ASN — 등록 경로가 없다(픽스처를 직접 INSERT 로 세운다)', async () => {
    await request(app.getHttpServer())
      .post('/api/logistics/asns')
      .set('Cookie', cookie)
      .send({ asnNo: `${PREFIX}-미등록` })
      .expect(404);
  });

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: 'ASN검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: 'ASN검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: 'ASN검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    plantId = plant.plant_id;

    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: 'ASN검사품목',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
      },
    });
    itemId = item.item_id;

    const supplier = await prisma.partner.create({
      data: { partner_code: `${PREFIX}-SUP`, partner_name: 'ASN검사공급사' },
    });
    supplierId = supplier.partner_id;

    const order = await prisma.purchase_order.create({
      data: {
        purchase_order_no: `${PREFIX}-PO`,
        supplier_id: supplierId,
        business_unit_id: unit.business_unit_id,
        plant_id: plantId,
        order_date: new Date('2026-08-01T00:00:00.000Z'),
        status_code: 'REGISTERED',
      },
    });
    purchaseOrderId = order.purchase_order_id;
    const line = await prisma.purchase_order_line.create({
      data: {
        purchase_order_id: purchaseOrderId,
        line_no: 1,
        item_id: itemId,
        ordered_qty: 100,
        uom_id: uomId,
        received_qty: 20,
      },
    });
    purchaseOrderLineId = line.purchase_order_line_id;

    const asn = await prisma.asn.create({
      data: {
        asn_no: `${PREFIX}-ASN`,
        supplier_id: supplierId,
        plant_id: plantId,
        expected_arrival_date: new Date('2026-08-06T00:00:00.000Z'),
        delivery_note_no: `${PREFIX}-DN`,
        status_code: 'EXPECTED', // 값 목록 없음(x-no-code-key) — 우리 코드가 이 값으로 판정하지 않는다.
      },
    });
    asnId = asn.asn_id;

    const withPo = await prisma.asn_line.create({
      data: {
        asn_id: asnId,
        line_no: 1,
        purchase_order_line_id: purchaseOrderLineId,
        item_id: itemId,
        expected_qty: 100,
        uom_id: uomId,
      },
    });
    asnLineWithPoId = withPo.asn_line_id;

    const noPo = await prisma.asn_line.create({
      data: {
        asn_id: asnId,
        line_no: 2,
        item_id: itemId,
        expected_qty: 50,
        uom_id: uomId,
      },
    });
    asnLineNoPoId = noPo.asn_line_id;
  }

  async function login(): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'ASN조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId: LOGIN_ID, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 순서: asn_line → asn → purchase_order_line → purchase_order(브리프 지정) → 마스터. */
  async function cleanup(): Promise<void> {
    const ownPlants = `(SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%')`;
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.asn_line
       WHERE asn_id IN (SELECT asn_id FROM logistics.asn WHERE plant_id IN ${ownPlants})`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.asn WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`
      DELETE FROM logistics.purchase_order_line
       WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}
       )`);
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.purchase_order WHERE plant_id IN ${ownPlants}`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`);
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (user) {
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
  }
});
