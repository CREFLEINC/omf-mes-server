/**
 * P/O(생산오더, ERP 수신) 조회 2건(I-24 PR ①) + `:acknowledge`·`:resync`(PR ④) +
 * 권한 403 6건(PR ③ — `:confirm` 이 서고 나서야 여섯을 한자리에서 물을 수 있다).
 *
 * ⛔ P/O 는 이 시스템이 만들지 않는다(수신기 부재 · I-24.md §2-2) — `prisma` 로 직접
 * INSERT 한다. `production_order_change_field`·`production_order_acknowledgement` 도 같다.
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

const LOGIN_ID = 'e2e-po24-probe';
const PASSWORD = 'PO24-검사-비밀번호';
const PREFIX = 'PO24';
const ROLE = 'E2E_PO24';
/** 권한이 한 줄도 없는 계정 — 403 여섯 갈래 검사용(§8-4 21). */
const STRANGER_ID = 'e2e-po24-stranger';
const STRANGER_ROLE = 'E2E_PO24_STRANGER';
/** R-11 — `{인터페이스}:{P/O id}:{멱등키}`. 문서번호를 쓰지 않는다. */
const RESYNC_KEY_PREFIX = 'IF-PO-RESYNC-REQUEST:';

interface ChangedField {
  field: string;
  label: string;
  beforeText: string;
  afterText: string;
  beforeQty: number | null;
}

function validator(operation: string): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/200/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('P/O 조회 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let strangerCookie: string[];

  let mainBusinessUnitId = 0;
  let treeBusinessUnitId = 0;
  let plantId = 0;
  let itemId = 0;

  let orderMainId = 0;
  let orderWithPlanId = 0;
  let orderRootId = 0;
  let orderChildId = 0;
  let orderChangeFullId = 0;
  let orderChangeEmptyId = 0;

  // PR ④ — 확인·재동기용. 확인은 W/O 를 고치므로 시험마다 P/O 를 따로 둔다.
  let ackApplyOrderId = 0;
  let ackEmptyOrderId = 0;
  let ackBadOrderId = 0;
  let ackVersionOrderId = 0;
  let ackClosedOrderId = 0;
  let resyncOrderId = 0;
  let workOrderApplyId = 0;
  let workOrderApplyOtherId = 0;
  let workOrderEmptyIds: number[] = [];
  let workOrderBadId = 0;
  let workOrderVersionId = 0;
  let workOrderOpenId = 0;
  let workOrderClosedId = 0;

  const T1 = new Date('2026-09-01T00:00:00.000Z');
  const T2 = new Date('2026-09-10T00:00:00.000Z'); // T1 보다 뒤 — §14 재수신
  const T3 = new Date('2026-09-02T00:00:00.000Z');
  let statusNameOf: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    cookie = await login(LOGIN_ID);
    strangerCookie = await login(STRANGER_ID);

    const statusValues = await prisma.code_value.findMany({
      where: { code_group: { group_code: 'PRODUCTION_ORDER_STATUS' }, code: { in: ['RECEIVED', 'UPDATED'] } },
      select: { code: true, code_name: true },
    });
    statusNameOf = Object.fromEntries(statusValues.map((row) => [row.code, row.code_name]));
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('목록 — 필터', () => {
    it('1. businessUnitId·plantId·itemId 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, plantId, itemId })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual(
        expect.arrayContaining([orderMainId, orderWithPlanId, orderChangeFullId, orderChangeEmptyId]),
      );
      expect(ids).not.toContain(orderRootId);
      expect(ids).not.toContain(orderChildId);
      expect(validator('GET /planning/production-orders')(response.body)).toBe(true);
    });

    it('2. dueDateFrom·dueDateTo 로 걸러진다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, dueDateFrom: '2026-09-10', dueDateTo: '2026-09-16' })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual([orderMainId]);
    });

    it('3. q 가 P/O 번호 부분일치다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, q: 'MAIN' })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual([orderMainId]);
    });
  });

  describe('상세 — 파생 두 칸', () => {
    it('4. expandedWorkOrderCount·plannedWorkOrderCount 가 0/3 이다(계획은 있고 전개 전)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderWithPlanId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.expandedWorkOrderCount).toBe(0);
      expect(response.body.plannedWorkOrderCount).toBe(3);
    });

    it('6. 계획이 없는 P/O 는 0/0 이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderMainId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.expandedWorkOrderCount).toBe(0);
      expect(response.body.plannedWorkOrderCount).toBe(0);
    });
  });

  describe('includeChildren', () => {
    // 계약이 「**참이면** 필터·page·size·total 은 «루트 P/O» 기준」이라 한정했다 — 거짓은 루트로
    // 안 세는 «평면 목록»이다. 자식에 도달할 질의 칸이 0이라 루트만 내면 자식 P/O 가 어떤 질의로도
    // 안 보인다(I-24 리뷰 #274 §5 — 계획서 §8-4 7번 이름을 이 판정으로 정정했다).
    it('7. includeChildren 미지정은 필터 그대로의 평면 목록이다 — 자식도 실린다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: treeBusinessUnitId })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderRootId);
      expect(ids).toContain(orderChildId);
      expect(response.body.page.total).toBe(ids.length);
    });

    it('8. includeChildren=true 는 total 이 루트 수인데 items 가 더 많다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: treeBusinessUnitId, itemId, includeChildren: true })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.page.total).toBe(1);
      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toEqual(expect.arrayContaining([orderRootId, orderChildId]));
      expect(ids.length).toBe(2);
      // bom_level asc — 루트(0)가 자식(1)보다 먼저다.
      expect(ids[0]).toBe(orderRootId);
    });
  });

  describe('withLastChange', () => {
    it('9. withLastChange=false 면 lastChange 키가 없다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.lastChange).toBeUndefined();
    });

    it('10. withLastChange=true 면 changedFields 가 수량→납기→상태 고정 순이고 label 이 옳다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      const fields: ChangedField[] = response.body.lastChange.changedFields;
      expect(fields.map((f) => f.field)).toEqual(['ORDER_QTY', 'DUE_DATE', 'STATUS_CODE']);
      expect(fields.map((f) => f.label)).toEqual(['수량', '납기', '상태']);
      expect(fields[2].beforeText).toBe(statusNameOf.RECEIVED ?? 'RECEIVED');
      expect(fields[2].afterText).toBe(statusNameOf.UPDATED ?? 'UPDATED');
      expect(validator('GET /planning/production-orders/{productionOrderId}')(response.body)).toBe(true);
    });

    it('11. beforeQty 는 ORDER_QTY 항목에만 있고 나머지는 null 이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeFullId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      const fields: ChangedField[] = response.body.lastChange.changedFields;
      expect(fields.find((f) => f.field === 'ORDER_QTY')?.beforeQty).toBe(1000);
      expect(fields.find((f) => f.field === 'DUE_DATE')?.beforeQty).toBeNull();
      expect(fields.find((f) => f.field === 'STATUS_CODE')?.beforeQty).toBeNull();
    });

    it('12. 변경 행이 0건이면 changedFields 가 빈 배열이다', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/planning/production-orders/${orderChangeEmptyId}`)
        .query({ withLastChange: true })
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.lastChange.receivedAt).toBeDefined();
      expect(response.body.lastChange.changedFields).toEqual([]);
    });
  });

  describe('unacknowledgedOnly', () => {
    it('13. 미확인 P/O 를 낸다', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, unacknowledgedOnly: true })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderChangeEmptyId);
      expect(ids).not.toContain(orderChangeFullId);
    });

    it('14. 확인한 뒤 ERP 가 또 보내면(last_change_received_at 이 뒤로 가면) 다시 미확인이다', async () => {
      await prisma.production_order.update({
        where: { production_order_id: orderChangeFullId },
        data: { last_change_received_at: T2 },
      });

      const response = await request(app.getHttpServer())
        .get('/api/planning/production-orders')
        .query({ businessUnitId: mainBusinessUnitId, unacknowledgedOnly: true })
        .set('Cookie', cookie)
        .expect(200);

      const ids = response.body.items.map((item: { productionOrderId: number }) => item.productionOrderId);
      expect(ids).toContain(orderChangeFullId);
    });
  });

  describe(':acknowledge — §5-5 · R-10', () => {
    it('15. APPLY + 조정 1건이 W/O order_qty 를 고치고 200 이며 확인 3칸이 응답에 실린다', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackApplyOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ decisionCode: 'APPLY', workOrderAdjustments: [{ workOrderId: workOrderApplyId, versionNo: 1, orderQty: 77 }] })
        .expect(200);

      expect(response.body.acknowledgedAt).toBeDefined();
      expect(response.body.acknowledgeDecisionCode).toBe('APPLY');
      expect(response.body.acknowledgedBy).toBeDefined();
      // ⑨ P/O 의 version_no 는 안 오른다 — 같은 토큰으로 다시 확인할 수 있다.
      expect(response.body.versionNo).toBe(1);
      expect(validator('POST /planning/production-orders/{productionOrderId}:acknowledge')(response.body)).toBe(true);

      const adjusted = await prisma.work_order.findUnique({ where: { work_order_id: BigInt(workOrderApplyId) } });
      expect(Number(adjusted?.order_qty)).toBe(77);
      expect(adjusted?.version_no).toBe(2);
      expect(adjusted?.po_mismatch).toBe(false);
      // ⑦ 조정하지 않은 영향 W/O 에는 표식이 선다(계약 `WorkOrder.poMismatch` ⓑ).
      const untouched = await prisma.work_order.findUnique({ where: { work_order_id: BigInt(workOrderApplyOtherId) } });
      expect(untouched?.po_mismatch).toBe(true);
    });

    it('16. APPLY + 빈 배열이면 영향 W/O 전건에 po_mismatch 가 선다', async () => {
      await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackEmptyOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ decisionCode: 'APPLY', workOrderAdjustments: [] })
        .expect(200);

      const rows = await prisma.work_order.findMany({ where: { work_order_id: { in: workOrderEmptyIds.map((id) => BigInt(id)) } } });
      expect(rows.map((row) => row.po_mismatch)).toEqual([true, true]);
    });

    it('17. 본문 400 이 다섯 갈래다', async () => {
      const post = (body: object) =>
        request(app.getHttpServer())
          .post(`/api/planning/production-orders/${ackBadOrderId}:acknowledge`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '1')
          .send(body)
          .expect(400);

      const proceedWithAdjustment = await post({
        decisionCode: 'PROCEED',
        reason: '기존 유지',
        workOrderAdjustments: [{ workOrderId: workOrderBadId, versionNo: 1, orderQty: 1 }],
      });
      expect(proceedWithAdjustment.body.errors).toContainEqual(expect.objectContaining({ field: 'workOrderAdjustments', code: 'INVALID' }));

      const proceedWithoutReason = await post({ decisionCode: 'PROCEED' });
      expect(proceedWithoutReason.body.errors).toContainEqual(expect.objectContaining({ field: 'reason', code: 'REQUIRED' }));

      const foreign = await post({ decisionCode: 'APPLY', workOrderAdjustments: [{ workOrderId: workOrderApplyId, versionNo: 1, orderQty: 1 }] });
      expect(foreign.body.errors).toContainEqual(expect.objectContaining({ field: 'workOrderAdjustments[0].workOrderId', code: 'INVALID' }));

      const duplicated = await post({
        decisionCode: 'APPLY',
        workOrderAdjustments: [
          { workOrderId: workOrderBadId, versionNo: 1, orderQty: 1 },
          { workOrderId: workOrderBadId, versionNo: 1, orderQty: 2 },
        ],
      });
      expect(duplicated.body.errors).toContainEqual(expect.objectContaining({ field: 'workOrderAdjustments[1].workOrderId', code: 'UNIQUE_VIOLATION' }));

      const nothingToChange = await post({ decisionCode: 'APPLY', workOrderAdjustments: [{ workOrderId: workOrderBadId, versionNo: 1 }] });
      expect(nothingToChange.body.errors).toContainEqual(expect.objectContaining({ field: 'workOrderAdjustments[0]', code: 'REQUIRED' }));

      // 다섯 갈래가 전부 거부라 W/O 는 그대로다 — 「하나라도 어긋나면 전체를 거부한다」.
      const untouched = await prisma.work_order.findUnique({ where: { work_order_id: BigInt(workOrderBadId) } });
      expect(untouched?.version_no).toBe(1);
    });

    it('18. 본문 versionNo 어긋남은 409 user · P/O If-Match 어긋남은 409 erpSync 다', async () => {
      const byBody = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackVersionOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ decisionCode: 'APPLY', workOrderAdjustments: [{ workOrderId: workOrderVersionId, versionNo: 99, orderQty: 5 }] })
        .expect(409);
      expect(byBody.body).toMatchObject({ conflictCause: 'user', code: 'VERSION_CONFLICT' });

      const byHeader = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackVersionOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '99')
        .send({ decisionCode: 'APPLY', workOrderAdjustments: [] })
        .expect(409);
      expect(byHeader.body).toMatchObject({ conflictCause: 'erpSync', code: 'VERSION_CONFLICT' });
    });

    it('마감 W/O 가 섞여도 500 이 아니다 — po_mismatch 대상에서 마감분을 뺀다(R-10 ⓐ)', async () => {
      await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackClosedOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ decisionCode: 'PROCEED', reason: '기존 유지' })
        .expect(200);

      const open = await prisma.work_order.findUnique({ where: { work_order_id: BigInt(workOrderOpenId) } });
      const closed = await prisma.work_order.findUnique({ where: { work_order_id: BigInt(workOrderClosedId) } });
      expect(open?.po_mismatch).toBe(true);
      expect(closed?.po_mismatch).toBe(false);
    });

    it('조정이 마감 W/O 를 가리키면 400 STATE_LOCKED 다(R-10 ⓑ)', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${ackClosedOrderId}:acknowledge`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '1')
        .send({ decisionCode: 'APPLY', workOrderAdjustments: [{ workOrderId: workOrderClosedId, versionNo: 1, orderQty: 3 }] })
        .expect(400);

      expect(response.body.errors).toContainEqual(
        expect.objectContaining({ field: 'workOrderAdjustments[0].workOrderId', code: 'STATE_LOCKED' }),
      );
    });
  });

  describe(':resync — §5-6 · R-11', () => {
    it('19. 202 이고 integration_message 가 1행이다', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${resyncOrderId}:resync`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(202);
      expect(response.body).toEqual({});

      const rows = await prisma.integration_message.findMany({ where: { message_key: { startsWith: `${RESYNC_KEY_PREFIX}${resyncOrderId}:` } } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        interface_code: 'IF-PO-RESYNC-REQUEST',
        direction_code: 'OUTBOUND',
        status_code: 'PENDING',
        target_type_code: 'PRODUCTION_ORDER',
      });
      expect(Number(rows[0].target_id)).toBe(resyncOrderId);
      // ⭐ 문서번호가 아니라 id 다 — `message_key` 는 VarChar(150) 인데 번호가 VarChar(100) 이다.
      expect(rows[0].message_key.length).toBeLessThanOrEqual(150);
    });

    it('같은 P/O 를 다른 멱등키로 두 번 부르면 행이 2건이다 — 요청 1건 = 행 1건(R-11)', async () => {
      await request(app.getHttpServer())
        .post(`/api/planning/production-orders/${resyncOrderId}:resync`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(202);

      const rows = await prisma.integration_message.findMany({ where: { message_key: { startsWith: `${RESYNC_KEY_PREFIX}${resyncOrderId}:` } } });
      expect(rows).toHaveLength(2);
    });

    it('20. 없는 P/O 의 :resync 는 404 다', async () => {
      await request(app.getHttpServer())
        .post('/api/planning/production-orders/999999999:resync')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(404);
    });
  });

  describe('권한 — 무권한 계정(§8-4 21)', () => {
    it('21. POST·PUT·DELETE·:confirm·:acknowledge·:resync 여섯 전부 403 이다', async () => {
      // 가드 순서가 인증 → 권한 → 계약 검증 → 멱등 → 낙관적 잠금이라(`app.module.ts`)
      // 본문·`Idempotency-Key`·`If-Match` 없이도 권한이 먼저 답한다. 계획 id 는 없는 값을
      // 써도 된다 — 권한이 조회보다 앞이다(그래서 404 가 아니라 403 이다).
      const missingPlanId = 999999999;
      const stranger = () => request(app.getHttpServer());

      await stranger().post('/api/planning/production-plans').set('Cookie', strangerCookie).send({}).expect(403);
      await stranger().put(`/api/planning/production-plans/${missingPlanId}`).set('Cookie', strangerCookie).send({}).expect(403);
      await stranger().delete(`/api/planning/production-plans/${missingPlanId}`).set('Cookie', strangerCookie).expect(403);
      await stranger().post(`/api/planning/production-plans/${missingPlanId}:confirm`).set('Cookie', strangerCookie).send({}).expect(403);
      await stranger().post(`/api/planning/production-orders/${orderMainId}:acknowledge`).set('Cookie', strangerCookie).send({}).expect(403);
      await stranger().post(`/api/planning/production-orders/${orderMainId}:resync`).set('Cookie', strangerCookie).send({}).expect(403);
    });
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: 'PO조회검사법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    const mainUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU-M`, business_unit_name: 'PO조회검사사업부' },
    });
    mainBusinessUnitId = Number(mainUnit.business_unit_id);
    const treeUnit = await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU-T`, business_unit_name: 'PO조회계층검사사업부' },
    });
    treeBusinessUnitId = Number(treeUnit.business_unit_id);
    const plant = await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, plant_code: `${PREFIX}-P`, plant_name: 'PO조회검사공장', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    plantId = Number(plant.plant_id);
    const uom = await prisma.uom.findFirstOrThrow();

    const item = await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: 'PO조회검사품목', item_type_code: 'FINISHED_GOODS', base_uom_id: uom.uom_id, lot_controlled: true },
    });
    itemId = Number(item.item_id);
    // 하위 P/O(전개 레벨)의 품목 — 루트와 다른 품목이라 itemId 필터가 자연히 하위를 뺀다(§8-4 7).
    const componentItem = await prisma.item.create({
      data: { item_code: `${PREFIX}-CI`, item_name: 'PO조회검사구성품', item_type_code: 'RAW_MATERIAL', base_uom_id: uom.uom_id, lot_controlled: true },
    });

    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    await prisma.routing_operation.createMany({
      data: [10, 20, 30].map((seq) => ({ routing_id: routing.routing_id, operation_seq: seq, process_id: process.process_id, operation_name: `공정${seq}` })),
    });
    const bom = await prisma.bom.create({
      data: {
        parent_item_id: item.item_id,
        bom_code: `${PREFIX}-BOM`,
        bom_version: 1,
        status_code: 'ACTIVE',
        effective_from: new Date('2026-01-01T00:00:00.000Z'),
        base_qty: 1,
        base_uom_id: uom.uom_id,
      },
    });

    const orderMain = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-MAIN`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        due_date: new Date('2026-09-15T00:00:00.000Z'),
        status_code: 'RECEIVED',
      },
    });
    orderMainId = Number(orderMain.production_order_id);

    const orderWithPlan = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-PLAN`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 200,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
      },
    });
    orderWithPlanId = Number(orderWithPlan.production_order_id);
    await prisma.production_plan.create({
      data: {
        production_order_id: orderWithPlan.production_order_id,
        plan_no: `${PREFIX}-PP-PLAN`,
        plan_date: new Date('2026-09-01T00:00:00.000Z'),
        planned_qty: 200,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'DRAFT',
      },
    });

    const orderRoot = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-ROOT`,
        business_unit_id: treeUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 50,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        bom_level: 0,
      },
    });
    orderRootId = Number(orderRoot.production_order_id);
    const orderChild = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHILD`,
        business_unit_id: treeUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: componentItem.item_id,
        order_qty: 50,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        parent_production_order_id: orderRoot.production_order_id,
        bom_level: 1,
      },
    });
    orderChildId = Number(orderChild.production_order_id);

    const orderChangeFull = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHFULL`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 1200,
        uom_id: uom.uom_id,
        due_date: new Date('2026-09-20T00:00:00.000Z'),
        status_code: 'UPDATED',
        last_change_received_at: T1,
      },
    });
    orderChangeFullId = Number(orderChangeFull.production_order_id);
    // 고정 순 검사용 — 저장 순서를 일부러 섞는다(상태 → 수량 → 납기).
    await prisma.production_order_change_field.createMany({
      data: [
        { production_order_id: orderChangeFull.production_order_id, field_code: 'STATUS_CODE', before_status_code: 'RECEIVED' },
        { production_order_id: orderChangeFull.production_order_id, field_code: 'ORDER_QTY', before_order_qty: 1000 },
        { production_order_id: orderChangeFull.production_order_id, field_code: 'DUE_DATE', before_due_date: new Date('2026-09-05T00:00:00.000Z') },
      ],
    });

    const orderChangeEmpty = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO-CHEMPTY`,
        business_unit_id: mainUnit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 300,
        uom_id: uom.uom_id,
        status_code: 'RECEIVED',
        last_change_received_at: T3,
      },
    });
    orderChangeEmptyId = Number(orderChangeEmpty.production_order_id);

    // PR ④ — 확인·재동기용. `last_change_received_at` 이 있어야 확인 행의 `received_at` 이 선다.
    const operations = await prisma.routing_operation.findMany({
      where: { routing_id: routing.routing_id },
      orderBy: { operation_seq: 'asc' },
      select: { routing_operation_id: true },
    });
    let seq = 0;
    const makeOrder = async (suffix: string): Promise<bigint> => {
      const order = await prisma.production_order.create({
        data: {
          production_order_no: `${PREFIX}-PO-${suffix}`,
          business_unit_id: mainUnit.business_unit_id,
          plant_id: plant.plant_id,
          item_id: item.item_id,
          order_qty: 500,
          uom_id: uom.uom_id,
          status_code: 'UPDATED',
          last_change_received_at: T1,
        },
      });
      return order.production_order_id;
    };
    const makePlan = async (orderId: bigint, suffix: string): Promise<bigint> => {
      const plan = await prisma.production_plan.create({
        data: {
          production_order_id: orderId,
          plan_no: `${PREFIX}-PP-${suffix}`,
          plan_date: new Date('2026-09-01T00:00:00.000Z'),
          planned_qty: 500,
          uom_id: uom.uom_id,
          bom_id: bom.bom_id,
          routing_id: routing.routing_id,
          status_code: 'CONFIRMED',
        },
      });
      return plan.production_plan_id;
    };
    const makeWorkOrder = async (planId: bigint, closed: boolean): Promise<number> => {
      seq += 1;
      const workOrder = await prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-WO-${seq}`,
          production_plan_id: planId,
          routing_operation_id: operations[seq % operations.length].routing_operation_id,
          item_id: item.item_id,
          order_qty: 500,
          uom_id: uom.uom_id,
          status_code: closed ? 'CLOSED' : 'PLANNED',
          ...(closed ? { closed_at: new Date('2026-09-02T00:00:00.000Z') } : {}),
        },
      });
      return Number(workOrder.work_order_id);
    };

    const applyOrder = await makeOrder('ACKAPPLY');
    ackApplyOrderId = Number(applyOrder);
    const applyPlan = await makePlan(applyOrder, 'ACKAPPLY');
    workOrderApplyId = await makeWorkOrder(applyPlan, false);
    workOrderApplyOtherId = await makeWorkOrder(applyPlan, false);

    const emptyOrder = await makeOrder('ACKEMPTY');
    ackEmptyOrderId = Number(emptyOrder);
    const emptyPlan = await makePlan(emptyOrder, 'ACKEMPTY');
    workOrderEmptyIds = [await makeWorkOrder(emptyPlan, false), await makeWorkOrder(emptyPlan, false)];

    const badOrder = await makeOrder('ACKBAD');
    ackBadOrderId = Number(badOrder);
    workOrderBadId = await makeWorkOrder(await makePlan(badOrder, 'ACKBAD'), false);

    const versionOrder = await makeOrder('ACKVER');
    ackVersionOrderId = Number(versionOrder);
    workOrderVersionId = await makeWorkOrder(await makePlan(versionOrder, 'ACKVER'), false);

    const closedOrder = await makeOrder('ACKCLOSED');
    ackClosedOrderId = Number(closedOrder);
    const closedPlan = await makePlan(closedOrder, 'ACKCLOSED');
    workOrderOpenId = await makeWorkOrder(closedPlan, false);
    workOrderClosedId = await makeWorkOrder(closedPlan, true);

    resyncOrderId = Number(await makeOrder('RESYNC'));
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: 'PO조회검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: 'PO조회검사용' } });
    // `:acknowledge` 는 `W-02-06`, `:resync` 는 `W-06-10` 이 문다(도출표·수동표 실측).
    await prisma.role_permission.createMany({
      data: ['W-02-01', 'W-02-06', 'W-06-10'].map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    // 권한 0줄짜리 역할 — 「역할 없음」이 아니라 「권한 없음」이라야 403 이 권한 판정이다.
    const stranger = await prisma.app_user.create({
      data: { login_id: STRANGER_ID, user_name: 'PO권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({ data: { app_user_id: stranger.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const strangerRole = await prisma.role.create({ data: { role_code: STRANGER_ROLE, role_name: 'PO권한없음용' } });
    await prisma.user_role.create({ data: { app_user_id: stranger.app_user_id, role_id: strangerRole.role_id } });

    // §2-3 확인 3칸 — «확인됨» 판정용(acknowledged_at >= last_change_received_at).
    await prisma.production_order_acknowledgement.create({
      data: {
        production_order_id: orderChangeFullId,
        acknowledgement_type_code: 'PO_CHANGE',
        received_at: T1,
        acknowledged_at: T1,
        status_code: 'ACKNOWLEDGED',
        acknowledged_by: user.app_user_id,
        acknowledge_decision_code: 'APPLY',
      },
    });
  }

  async function login(loginId: string): Promise<string[]> {
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** §8-2 — 자가 치유 `deleteMany`(역순). `beforeAll`·`afterAll` 둘 다 부른다. */
  async function cleanup(): Promise<void> {
    // ⛔ TRUNCATE 를 쓰지 않는다 — 이 접두어가 붙은 것만 지운다.
    await prisma.integration_message.deleteMany({ where: { message_key: { startsWith: RESYNC_KEY_PREFIX } } });
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.production_order_acknowledgement.deleteMany({
      where: { production_order: { production_order_no: { startsWith: PREFIX } } },
    });
    await prisma.production_order_change_field.deleteMany({
      where: { production_order: { production_order_no: { startsWith: PREFIX } } },
    });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    // 자식(전개 레벨)을 먼저 지운다 — 자기참조 FK(parent_production_order_id).
    await prisma.production_order.deleteMany({ where: { production_order_no: `${PREFIX}-PO-CHILD` } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    for (const loginId of [LOGIN_ID, STRANGER_ID]) {
      const target = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!target) continue;
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    for (const roleCode of [ROLE, STRANGER_ROLE]) {
      const role = await prisma.role.findUnique({ where: { role_code: roleCode } });
      if (!role) continue;
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
