/**
 * 자재 투입 조회 — 목록 `GET /production/material-consumptions` · 단건 `GET …/{id}`(I-10 PR ①).
 *
 * ⭐ 조회가 보는 투입은 **직접 INSERT** 한다 — 이 PR 에 `POST` 가 없다(PR ② 몫).
 * ⭐ 전건 `terminal_id: null` 이다 — M-1(NOT NULL 완화)이 실제로 먹었는지를 픽스처가 증명한다.
 * ⛔ `mdm.terminal` 을 세우지 않는다(I-10 §7-1) — 「단말 없이도 선다」가 이 슬라이스의 판정이다.
 *    그래서 `work_session`(terminal_id NOT NULL)도 못 세운다 — `workSessionId` 는 축이 컬럼에
 *    걸린 것만 보고 양성 사례는 I-11 뒤로 미룬다.
 * ⛔ 계약이 조회 둘에 403 도 ETag 도 선언하지 않았다 — 권한 없는 계정을 세우지 않는다.
 * ⛔ 200 을 계약 스키마로 검증하지 않는다 — `MaterialConsumption.terminalId` 가 required 인데
 *    오늘 언제나 빠지기 때문이다(설계 미정 — 문의 054). 대신 칸을 손으로 단언한다.
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — 원장 행을 한 건도 만들지 않는다(I-10 §7-2).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';

const LOGIN_ID = 'e2e-mc-probe';
const PASSWORD = 'MC-자재투입-비밀번호';
const PREFIX = 'MCE2E';
const CONSUMPTIONS = '/api/production/material-consumptions';
const OCCURRED_1 = '2026-09-07T01:00:00.000Z';
const OCCURRED_2 = '2026-09-07T03:00:00.000Z';
const OCCURRED_3 = '2026-09-07T05:00:00.000Z';
/** 계약 `consumptionTypeCode` 는 `x-no-code-key` 다 — 서버가 대조하지 않는 자유 문자다. */
const TYPE_DEFAULT = 'NORMAL';
const TYPE_OTHER = 'SPECIAL';

describe('자재 투입 조회 2건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let workOrderId: number;
  let lotAId: number;
  let lotBId: number;
  /** 시간순 C1 → C4. C3·C4 는 `occurred_at` 이 같아 PK 내림차순 동률 처리를 본다. */
  let c1Id: number;
  let c2Id: number;
  let c3Id: number;
  let c4Id: number;
  let otherConsumptionId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    // 자가 치유 — 앞 회차가 죽어 남긴 행을 먼저 지운다.
    await cleanup();
    await makeFixtures();
    await makeUser();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록이 workOrderId 로 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?workOrderId=${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body.page).toMatchObject({ page: 1, size: 50, total: 4 });
    const ids = response.body.items.map((item: { materialConsumptionId: number }) => item.materialConsumptionId);
    expect(ids).not.toContain(otherConsumptionId);
    // 계약 `MaterialConsumption` 의 칸을 손으로 본다 — 뷰가 물리 이름을 camelCase 로 옮긴다.
    expect(response.body.items[0]).toMatchObject({
      materialConsumptionId: c4Id,
      workOrderId,
      lotId: lotAId,
      consumptionTypeCode: TYPE_DEFAULT,
      statusCode: 'RECORDED',
      inputQty: 12,
      actualConsumedQty: 0,
    });
    // ⭐ M-1 실증 — `terminal_id` 가 NULL 인 행이 «저장돼» 있고 뷰가 그때 키를 생략한다.
    //    설계 미정 — 문의 054(계약은 이 칸을 required 로 적었다).
    expect(response.body.items[0]).not.toHaveProperty('terminalId');
    // 값이 없는 선택 칸도 키가 없다(`plan.md` §5 규칙 7).
    expect(response.body.items[0]).not.toHaveProperty('workSessionId');
    expect(response.body.items[0]).not.toHaveProperty('remarks');
  });

  it('목록이 lotId·workSessionId·consumptionTypeCode 로 걸러진다', async () => {
    const byLot = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?lotId=${lotBId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byLot.body.items.map((item: { materialConsumptionId: number }) => item.materialConsumptionId)).toEqual([
      c2Id,
    ]);

    // `x-no-code-key` — 값 목록이 없어 문자 그대로 건다. 대조를 걸면 값이 늘 때 목록이 400 이 된다.
    const byType = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?workOrderId=${workOrderId}&consumptionTypeCode=${TYPE_OTHER}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(byType.body.items.map((item: { materialConsumptionId: number }) => item.materialConsumptionId)).toEqual([
      c2Id,
    ]);

    // ⛔ `mdm.terminal` 을 안 세워 `work_session` 행을 만들 수 없다(§7-1) — 축이 컬럼에 걸린
    //    것만 본다. 안 걸렸다면 이 질의가 위 4건을 그대로 돌려줬을 것이다.
    const bySession = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?workOrderId=${workOrderId}&workSessionId=999999999`)
      .set('Cookie', cookie)
      .expect(200);
    expect(bySession.body.page.total).toBe(0);
  });

  it('목록이 occurredFrom·occurredTo 반개구간으로 걸러진다(To 는 미포함)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?workOrderId=${workOrderId}&occurredFrom=${OCCURRED_1}&occurredTo=${OCCURRED_3}`)
      .set('Cookie', cookie)
      .expect(200);

    // From 이상 · To 미만(공유계약 L-3) — 끝 경계 정각의 둘(C3·C4)이 빠진다.
    expect(response.body.items.map((item: { materialConsumptionId: number }) => item.materialConsumptionId)).toEqual([
      c2Id,
      c1Id,
    ]);
  });

  it('목록이 occurred_at 내림차순 · PK 내림차순으로 온다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}?workOrderId=${workOrderId}`)
      .set('Cookie', cookie)
      .expect(200);

    // C3·C4 는 `occurred_at` 이 같다 — 동률을 PK 로 닫아 쪽 경계가 흔들리지 않는다.
    expect(response.body.items.map((item: { materialConsumptionId: number }) => item.materialConsumptionId)).toEqual([
      c4Id,
      c3Id,
      c2Id,
      c1Id,
    ]);
  });

  it('없는 투입은 404', async () => {
    await request(app.getHttpServer()).get(`${CONSUMPTIONS}/999999999`).set('Cookie', cookie).expect(404);
  });

  it('⛔ 조회 응답에 ETag 가 없다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${CONSUMPTIONS}/${c1Id}`)
      .set('Cookie', cookie)
      .expect(200);

    // 계약이 I-10 6건 어디에도 ETag 를 선언하지 않았다 — `setEtag` 를 부르지 않는다.
    // ⚠ Express 가 붙이는 «약한» 내용 해시는 남는다 — 우리가 싣는 숫자 토큰이 아니다.
    expect(response.headers.etag).toMatch(/^W\/"/);
    expect(response.headers.etag).not.toMatch(/^"?\d+"?$/);
    // 단건은 목록 항목과 «같은 스키마»다 — 상세 전용 스키마가 계약에 없다(§5-2).
    expect(response.body).toMatchObject({
      materialConsumptionId: c1Id,
      workOrderId,
      lotId: lotAId,
      occurredAt: OCCURRED_1,
      statusCode: 'RECORDED',
    });
    expect(response.body).not.toHaveProperty('terminalId');
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '자재투입검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '자재투입검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '자재투입검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '자재투입검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const component = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-CI`,
        item_name: '자재투입검사원자재',
        item_type_code: 'RAW_MATERIAL',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const process = await prisma.process.create({
      data: { process_code: `${PREFIX}-PR`, process_name: '사출공정', process_type_code: 'MOLDING' },
    });
    const routing = await prisma.routing.create({
      data: { item_id: item.item_id, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'ACTIVE' },
    });
    const operation = await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: process.process_id, operation_name: '사출' },
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
    // ⭐ PR ② 의 오투입 3축이 이 위에 선다 — 지금은 조회가 읽지 않지만 미리 세워 충돌을 줄인다.
    const componentRow = await prisma.bom_component.create({
      data: {
        bom_id: bom.bom_id,
        component_item_id: component.item_id,
        routing_operation_id: operation.routing_operation_id,
        required_qty: 10,
        uom_id: uom.uom_id,
      },
    });
    // ⭐ `resolveWorker` 가 사번으로 푸는 자리 — 투입의 `worker_id` 는 NOT NULL 이다.
    const worker = await prisma.worker.create({
      data: {
        worker_no: `${PREFIX}-WK`,
        worker_name: '자재투입검사작업자',
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        status_code: 'EMPLOYED',
      },
    });
    const order = await prisma.production_order.create({
      data: {
        production_order_no: `${PREFIX}-PO`,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        item_id: item.item_id,
        order_qty: 100,
        uom_id: uom.uom_id,
        status_code: 'CONFIRMED',
      },
    });
    const plan = await prisma.production_plan.create({
      data: {
        production_order_id: order.production_order_id,
        plan_no: `${PREFIX}-PP`,
        plan_date: new Date('2026-09-07T00:00:00.000Z'),
        planned_qty: 100,
        uom_id: uom.uom_id,
        bom_id: bom.bom_id,
        routing_id: routing.routing_id,
        status_code: 'CONFIRMED',
      },
    });
    const workOrder = async (suffix: string) =>
      prisma.work_order.create({
        data: {
          work_order_no: `${PREFIX}-${suffix}`,
          production_plan_id: plan.production_plan_id,
          routing_operation_id: operation.routing_operation_id,
          item_id: item.item_id,
          order_qty: 100,
          uom_id: uom.uom_id,
          status_code: 'IN_PROGRESS',
        },
      });
    const main = await workOrder('WO');
    workOrderId = Number(main.work_order_id);
    const other = await workOrder('WO2');

    const lot = async (suffix: string, sourceId: number) =>
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: component.item_id,
          lot_type_code: 'MATERIAL',
          plant_id: plant.plant_id,
          initial_qty: 1000,
          uom_id: uom.uom_id,
          source_type_code: 'INBOUND_RECEIPT_LINE',
          source_id: sourceId,
          status_code: 'NORMAL',
        },
      });
    const lotA = await lot('A', 1);
    lotAId = Number(lotA.lot_id);
    const lotB = await lot('B', 2);
    lotBId = Number(lotB.lot_id);

    let sequence = 0;
    const consumption = async (
      workOrderIdValue: bigint,
      lotId: bigint,
      occurredAt: string,
      consumptionTypeCode: string,
    ) => {
      sequence += 1;
      return prisma.material_consumption.create({
        data: {
          consumption_no: `${PREFIX}-MC-${sequence}`,
          work_order_id: workOrderIdValue,
          bom_component_id: componentRow.bom_component_id,
          item_id: component.item_id,
          lot_id: lotId,
          consumption_type_code: consumptionTypeCode,
          input_qty: 12,
          uom_id: uom.uom_id,
          occurred_at: new Date(occurredAt),
          worker_id: worker.worker_id,
          // ⭐ M-1 — 완화 전이면 이 INSERT 가 NOT NULL 위반으로 죽는다.
          terminal_id: null,
          status_code: 'RECORDED',
          idempotency_key: `${PREFIX}-IK-${sequence}`,
        },
      });
    };
    c1Id = Number((await consumption(main.work_order_id, lotA.lot_id, OCCURRED_1, TYPE_DEFAULT)).material_consumption_id);
    c2Id = Number((await consumption(main.work_order_id, lotB.lot_id, OCCURRED_2, TYPE_OTHER)).material_consumption_id);
    c3Id = Number((await consumption(main.work_order_id, lotA.lot_id, OCCURRED_3, TYPE_DEFAULT)).material_consumption_id);
    c4Id = Number((await consumption(main.work_order_id, lotA.lot_id, OCCURRED_3, TYPE_DEFAULT)).material_consumption_id);
    otherConsumptionId = Number(
      (await consumption(other.work_order_id, lotA.lot_id, OCCURRED_2, TYPE_DEFAULT)).material_consumption_id,
    );
  }

  async function makeUser(): Promise<void> {
    // 조회 둘은 403 미선언이라 역할을 안 붙인다 — 로그인 세션만 있으면 된다.
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '자재투입검사', status_code: 'EMPLOYED' },
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
    cookie = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(§7-2 · `LIKE '${PREFIX}%'` 또는 id 서브쿼리 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const consumptionScope = { material_consumption: { consumption_no: { startsWith: PREFIX } } };
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    await prisma.material_usage_allocation.deleteMany({ where: consumptionScope });
    await prisma.material_loss.deleteMany({ where: consumptionScope });
    await prisma.material_consumption.deleteMany({ where: { consumption_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom_component.deleteMany({ where: { bom: { bom_code: { startsWith: PREFIX } } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    const user = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (!user) return;
    await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
    await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
  }
});
