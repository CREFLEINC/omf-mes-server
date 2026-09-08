/**
 * 특채 목록·상세 (e2e) — I-21 PR ⑤. `GET /quality/concessions` · `…/{concessionId}`.
 *
 * ⛔ 이 표는 **writer 가 0개다**(§2-4 · 통보 089 §2) — 등록·승인·조건수정 오퍼레이션이 계약에
 * 없어 운영에서는 목록이 늘 빈다. 픽스처는 전부 prisma 직접 INSERT 다(0단계 선례).
 *
 * ⭐ `usableOnly=true` 가 **C1 하나만** 남기도록 나머지 픽스처는 전부 `REJECTED` 로 상태 축을
 * 끄거나(C5·C6·tie 계열) 별도 축(기간·잔여)으로 usable=false 를 만든다(C2·C3·C4·C4-a) — 「한
 * 값뿐이라 단언이 공허했다」를 피한다(R-19).
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

const PREFIX = 'I21CN';
const LOGIN_ID = 'e2e-i21cn-probe';
const PASSWORD = 'PR-특채조회-비밀번호';
const CONCESSIONS = '/api/quality/concessions';

const today = (): string => new Date().toISOString().slice(0, 10);
const shift = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/quality-03품질.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('특채 목록·상세 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let userId = 0n;
  let plantId = 0n;
  let itemId = 0n;
  let uomId = 0n;

  const lotIds: Record<string, bigint> = {};
  const ncIds: Record<string, bigint> = {};
  const arIds: Record<string, bigint> = {};
  const concessionIds: Record<string, number> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeUser();
    await makeMasters();
    await makeFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', cookie);
  const idsOf = (body: { items: { concessionId: number }[] }): number[] => body.items.map((i) => i.concessionId);

  describe('목록', () => {
    it('#1 200 · 필터가 없으면 심어 둔 전건이 나온다', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const returned = idsOf(response.body);

      for (const id of Object.values(concessionIds)) expect(returned).toContain(id);
      expect(response.body.page.total).toBeGreaterThanOrEqual(Object.keys(concessionIds).length);
    });

    it('#2 ⭐ usableOnly=true 가 C1 «만» 남긴다(page.total 도 count(where) 축을 본다)', async () => {
      const response = await get(`${CONCESSIONS}?usableOnly=true`).expect(200);

      expect(idsOf(response.body)).toEqual([concessionIds.C1]);
      // ⭐ count(where) 가 usableOnly 축을 놓치면 items 는 줄어도 page.total 은 전건 그대로다.
      expect(response.body.page.total).toBe(1);
    });

    it('#3 ⭐ C1 은 valid_to 가 «오늘과 같은 날»인데 usable=true(경계 `>=`)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c1 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C1);

      expect(c1).toMatchObject({ usable: true, validTo: today() });
    });

    it('#4 C2(어제 만료) 는 usable=false', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c2 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C2);

      expect(c2).toMatchObject({ usable: false });
    });

    it('#4-a ⭐⭐ C4a(valid_from 이 «내일») 는 usable=false — 계약 3항에 없는 4항째(§4-3 · 통보 089 §2)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c4a = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C4a);

      expect(c4a).toMatchObject({ usable: false, validFrom: shift(1) });
    });

    it('#5 ⭐ C3(승인수량 == 소진수량 · 잔여 0) 는 usable=false(`> 0` → `>= 0` 이면 깨진다)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c3 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C3);

      expect(c3).toMatchObject({ usable: false, approvedQty: 50, consumedQty: 50 });
    });

    it('#6 ⭐ C4(REJECTED · 기간·잔여는 정상) 는 «상태 축만으로» usable=false', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c4 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C4);

      expect(c4).toMatchObject({ usable: false, statusCode: 'REJECTED' });
    });

    it('#7 usableOnly=false 는 «필터를 안 건다»(전건 — false 를 「쓸 수 없는 것만」으로 읽지 않는다)', async () => {
      const withoutFilter = await get(CONCESSIONS).expect(200);
      const explicitFalse = await get(`${CONCESSIONS}?usableOnly=false`).expect(200);

      expect(explicitFalse.body.page.total).toBe(withoutFilter.body.page.total);
    });

    it('#8 validOn=<C2 의 유효기간 안 날짜> 면 C2 가 usable=true', async () => {
      const response = await get(`${CONCESSIONS}?validOn=${shift(-5)}`).expect(200);
      const c2 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C2);

      expect(c2).toMatchObject({ usable: true });
    });

    it('#9 approvalRequestId·lotId·nonconformanceId·statusCode 네 필터가 각각 안 걸리는 행을 뺀다', async () => {
      const byApproval = await get(`${CONCESSIONS}?approvalRequestId=${arIds.C2}`).expect(200);
      expect(idsOf(byApproval.body)).toEqual([concessionIds.C2]);
      expect(byApproval.body.page.total).toBe(1); // count(where) 가 같은 축을 본다

      const byLot = await get(`${CONCESSIONS}?lotId=${lotIds.C3}`).expect(200);
      expect(idsOf(byLot.body)).toEqual([concessionIds.C3]);
      expect(byLot.body.page.total).toBe(1);

      const byNc = await get(`${CONCESSIONS}?nonconformanceId=${ncIds.C4}`).expect(200);
      expect(idsOf(byNc.body)).toEqual([concessionIds.C4]);
      expect(byNc.body.page.total).toBe(1);

      const byStatus = await get(`${CONCESSIONS}?statusCode=REJECTED`).expect(200);
      expect(idsOf(byStatus.body)).toContain(concessionIds.C4);
      expect(idsOf(byStatus.body)).not.toContain(concessionIds.C1);
      expect(byStatus.body.page.total).toBe(idsOf(byStatus.body).length);
    });

    it('#10 ⭐ C5 의 unrestrictedAxes 가 «3개»이고 값이 계약 프로퍼티 이름 그대로다', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c5 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C5);

      expect(c5.unrestrictedAxes).toEqual(['allowedWorkOrderId', 'allowedProcessId', 'allowedCustomerId']);
    });

    it('#11 허용 축이 하나만 찬 C6 은 unrestrictedAxes 가 «2개»(반증 행)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c6 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C6);

      expect(c6.unrestrictedAxes).toEqual(['allowedWorkOrderId', 'allowedProcessId']);
    });

    it('#11-a ⭐⭐ R-13 — C5 의 응답에 validTo·remarks·allowed*3·versionNo 키가 «없다»(널이 아니다)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const c5 = response.body.items.find((i: { concessionId: number }) => i.concessionId === concessionIds.C5);

      for (const key of ['validTo', 'remarks', 'allowedWorkOrderId', 'allowedProcessId', 'allowedCustomerId', 'versionNo']) {
        expect(c5).not.toHaveProperty(key);
      }
    });

    it('#13 ⭐ 정렬 — valid_from DESC(가장 미래인 C4a 가 가장 과거인 C2 보다 앞선다) + 2차 키 concession_id DESC(동률 4건 통째 단언)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      const returned = idsOf(response.body);

      expect(returned.indexOf(concessionIds.C4a)).toBeLessThan(returned.indexOf(concessionIds.C2));
      // ⭐ tie1~tie4 는 valid_from 이 «전부 같다» — 2차 키(id DESC)가 없으면 PostgreSQL 의 정렬이
      // 동률 넷을 어떤 순서로도 낼 수 있어(2건짜리 비교는 우연히 일치할 수 있다 — R-19), 넷을
      // «통째로» id 내림차순과 정확히 같은지 잠근다.
      const tieIds = [concessionIds.tie4, concessionIds.tie3, concessionIds.tie2, concessionIds.tie1];
      const tieOrder = returned.filter((id) => tieIds.includes(id));
      expect(tieOrder).toEqual(tieIds);
    });

    it('응답이 계약 스키마를 통과한다(ajv)', async () => {
      const response = await get(CONCESSIONS).expect(200);
      expect(validator('GET /quality/concessions')(response.body)).toBe(true);
    });
  });

  describe('상세', () => {
    it('#12 200 · 필드가 채워진다', async () => {
      const response = await get(`${CONCESSIONS}/${concessionIds.C1}`).expect(200);

      expect(response.body).toMatchObject({ concessionId: concessionIds.C1, lotId: Number(lotIds.C1), nonconformanceId: Number(ncIds.C1) });
      expect(validator('GET /quality/concessions/{concessionId}')(response.body)).toBe(true);
    });

    it('#12 없는 id → 404', async () => {
      await get(`${CONCESSIONS}/999999999`).expect(404);
    });
  });

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: `${PREFIX} 특채목록법인`, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: `${PREFIX} 특채목록공장`, timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = plant.plant_id;
    const uom = await prisma.uom.findFirstOrThrow();
    uomId = uom.uom_id;
    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT1`, item_name: `${PREFIX} 품목1`, item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    itemId = item.item_id;
  }

  async function newLot(suffix: string): Promise<bigint> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-${suffix}`,
        item_id: itemId,
        lot_type_code: 'PRODUCT',
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 1,
        status_code: 'DEFECTIVE',
      },
    });
    return lot.lot_id;
  }

  async function newNonconformance(suffix: string): Promise<bigint> {
    const nc = await prisma.nonconformance.create({
      data: {
        nonconformance_no: `${PREFIX}-NC-${suffix}`,
        item_id: itemId,
        severity_code: 'MINOR',
        description: `${PREFIX} 특채목록 부적합 ${suffix}`,
        status_code: 'DECIDED',
        opened_at: new Date(),
        closed_at: new Date(),
      },
    });
    return nc.nonconformance_id;
  }

  /** `concession.approval_request_id` 가 NOT NULL + FK 다(§8-1 정리 사슬 — I-20 R-20 형). */
  async function newApprovalRequest(suffix: string): Promise<bigint> {
    const ar = await prisma.approval_request.create({
      data: {
        approval_request_no: `${PREFIX}-AR-${suffix}`,
        approval_type_code: 'CONCESSION',
        target_type_code: 'CONCESSION',
        target_id: 1n,
        requested_by: userId,
        requested_at: new Date(),
        status_code: 'APPROVED',
        reason: `${PREFIX} 특채 상신 사유`,
      },
    });
    return ar.approval_request_id;
  }

  async function newConcession(
    key: string,
    opts: {
      statusCode: string;
      validFrom: string;
      validTo: string | null;
      approvedQty: number;
      consumedQty: number;
      allowedWorkOrderId?: bigint | null;
      allowedProcessId?: bigint | null;
      allowedCustomerId?: bigint | null;
      remarks?: string | null;
    },
  ): Promise<number> {
    const lotId = await newLot(key);
    const nonconformanceId = await newNonconformance(key);
    const approvalRequestId = await newApprovalRequest(key);
    lotIds[key] = lotId;
    ncIds[key] = nonconformanceId;
    arIds[key] = approvalRequestId;

    const concession = await prisma.concession.create({
      data: {
        concession_no: `${PREFIX}-CN-${key}`,
        nonconformance_id: nonconformanceId,
        lot_id: lotId,
        approved_qty: opts.approvedQty,
        consumed_qty: opts.consumedQty,
        uom_id: uomId,
        valid_from: new Date(opts.validFrom),
        valid_to: opts.validTo === null ? null : new Date(opts.validTo),
        allowed_work_order_id: opts.allowedWorkOrderId ?? null,
        allowed_process_id: opts.allowedProcessId ?? null,
        allowed_customer_id: opts.allowedCustomerId ?? null,
        approval_request_id: approvalRequestId,
        status_code: opts.statusCode,
        remarks: opts.remarks ?? null,
      },
    });
    const id = Number(concession.concession_id);
    concessionIds[key] = id;
    return id;
  }

  async function makeFixtures(): Promise<void> {
    await newConcession('C1', { statusCode: 'APPROVED', validFrom: shift(-10), validTo: today(), approvedQty: 100, consumedQty: 40 });
    await newConcession('C2', { statusCode: 'APPROVED', validFrom: shift(-10), validTo: shift(-1), approvedQty: 100, consumedQty: 10 });
    await newConcession('C3', { statusCode: 'APPROVED', validFrom: shift(-10), validTo: shift(10), approvedQty: 50, consumedQty: 50 });
    // ⭐ REJECTED — 기간·잔여는 정상이라 「상태 축만으로」 usable=false 인지를 잠근다.
    await newConcession('C4', { statusCode: 'REJECTED', validFrom: shift(-10), validTo: shift(10), approvedQty: 100, consumedQty: 10 });
    await newConcession('C4a', { statusCode: 'APPROVED', validFrom: shift(1), validTo: shift(10), approvedQty: 100, consumedQty: 10 });
    // ⭐ R-13 — validTo·remarks·허용 3축이 전부 NULL. REJECTED 로 usableOnly=true 밖에 둔다
    // (unrestrictedAxes·널 정책 시험이 usable 값과 안 섞이게).
    await newConcession('C5', { statusCode: 'REJECTED', validFrom: shift(-10), validTo: null, approvedQty: 100, consumedQty: 10, remarks: null });

    const customer = await prisma.partner.create({ data: { partner_code: `${PREFIX}-PT`, partner_name: `${PREFIX} 허용거래처` } });
    await newConcession('C6', { statusCode: 'REJECTED', validFrom: shift(-10), validTo: shift(10), approvedQty: 100, consumedQty: 0, allowedCustomerId: customer.partner_id });

    // ⭐ 정렬 2차 키 — valid_from 이 «전부 같은» 네 행. id 는 생성 순서대로 커진다(DESC 로 tie4
    // 가 가장 먼저) — 둘만으로는 PostgreSQL 의 동률 처리가 우연히 일치할 수 있어(R-19) 넷으로 늘렸다.
    await newConcession('tie1', { statusCode: 'REJECTED', validFrom: shift(-3), validTo: shift(10), approvedQty: 10, consumedQty: 0 });
    await newConcession('tie2', { statusCode: 'REJECTED', validFrom: shift(-3), validTo: shift(10), approvedQty: 10, consumedQty: 0 });
    await newConcession('tie3', { statusCode: 'REJECTED', validFrom: shift(-3), validTo: shift(10), approvedQty: 10, consumedQty: 0 });
    await newConcession('tie4', { statusCode: 'REJECTED', validFrom: shift(-3), validTo: shift(10), approvedQty: 10, consumedQty: 0 });
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '특채조회', status_code: 'EMPLOYED' } });
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

  /** FK 역순으로 지운다. `beforeAll`·`afterAll` 둘 다 부른다(자가 치유). */
  async function cleanup(): Promise<void> {
    await prisma.concession.deleteMany({ where: { concession_no: { startsWith: `${PREFIX}-CN-` } } });
    await prisma.approval_request.deleteMany({ where: { approval_request_no: { startsWith: `${PREFIX}-AR-` } } });
    await prisma.nonconformance.deleteMany({ where: { nonconformance_no: { startsWith: `${PREFIX}-NC-` } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: `${PREFIX}-LOT-` } } });
    await prisma.partner.deleteMany({ where: { partner_code: `${PREFIX}-PT` } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-IT` } } });
    await prisma.plant.deleteMany({ where: { plant_code: `${PREFIX}-P` } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: `${PREFIX}-LE` } });

    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
