/**
 * 자재 투입 — 조회 2건(I-10 PR ①) + 등록 `POST /production/material-consumptions`(PR ②).
 *
 * ⭐ 조회가 보는 투입은 **직접 INSERT** 한다 — 등록 스위트와 픽스처를 섞지 않으려는 것이다.
 * ⭐ M2 마디 ⑨→⑩ — 수령(`shopfloor_receipt`+라인)을 **직접 INSERT** 하고 그 라인이 서버
 *    귀속으로 잡히는지를 본다. 진짜 출고를 태우지 않는다(원장 무변화 단언이 뜻을 가지려면
 *    이 스위트가 원장에 손대지 않아야 한다 · I-9 §7-1 과 같은 이유).
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
const NOPERM_ID = 'e2e-mc-noperm';
const PASSWORD = 'MC-자재투입-비밀번호';
const PREFIX = 'MCE2E';
const ROLE = 'E2E_MATERIAL_CONSUMPTION';
/** 등록만 403 을 선언했다 — POP 화면 셋 중 하나면 통과한다(`derived-permissions.ts:229`). */
const PERMISSIONS = ['P-02-03'];
const WORKER_NO = `${PREFIX}-WK`;
const CONSUMPTIONS = '/api/production/material-consumptions';
const OCCURRED_1 = '2026-09-07T01:00:00.000Z';
const OCCURRED_2 = '2026-09-07T03:00:00.000Z';
const OCCURRED_3 = '2026-09-07T05:00:00.000Z';
/** 계약 `consumptionTypeCode` 는 `x-no-code-key` 다 — 서버가 대조하지 않는 자유 문자다. */
const TYPE_DEFAULT = 'NORMAL';
const TYPE_OTHER = 'SPECIAL';

describe('자재 투입 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];
  let noPermCookie: string[];

  let workOrderId: number;
  let otherWorkOrderId: number;
  let componentItemId: number;
  let finishedItemId: number;
  let uomId: number;
  let processId: number;
  let bomComponentId: number;
  let receiptLineId: number;
  let balanceId: bigint;
  let lotAId: number;
  let lotBId: number;
  /** 오투입 갈래용 — C 는 `DEFECTIVE` · D 는 BOM 에 없는 완제품 품목의 LOT 이다. */
  let lotCId: number;
  let lotDId: number;
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

  describe('POST — 자재 투입 등록 (PR ②)', () => {
    /** 계약 required 6 을 채운 최소 본문. 나머지 셋은 서버가 채우므로 보내지 않는다. */
    const consumptionBody = (overrides: Record<string, unknown> = {}) => ({
      workOrderId,
      itemId: componentItemId,
      lotId: lotAId,
      inputQty: 12,
      uomId,
      occurredAt: OCCURRED_1,
      ...overrides,
    });

    const register = (body: Record<string, unknown>, options: { cookie?: string[]; workerNo?: string | null } = {}) => {
      const call = request(app.getHttpServer())
        .post(CONSUMPTIONS)
        .set('Cookie', options.cookie ?? cookie)
        .set('Idempotency-Key', randomUUID());
      if (options.workerNo !== null) call.set('X-Worker-No', options.workerNo ?? WORKER_NO);
      return call.send(body);
    };

    it('⭐ M2 마디 — BOM 에 있는 품목·LOT 을 투입하면 201 이고 bom_component_id·actual_use_process_id 가 서버가 채워져 온다', async () => {
      // ⛔ 계약 스키마로 검증하지 않는다 — `terminalId` 가 required 인데 오늘 언제나 빠진다.
      //    설계 미정 — 문의 054. 대신 칸을 손으로 단언한다(PR ① 과 같은 방식).
      const response = await register(consumptionBody({ bomComponentId: 999999, actualUseProcessId: 999999 })).expect(201);

      // ⭐ 본문이 보낸 셋은 무시하고 서버 값으로 덮는다(계약 ⌜화면은 이 값을 보내지 않는다⌝).
      expect(response.body).toMatchObject({
        workOrderId,
        itemId: componentItemId,
        lotId: lotAId,
        bomComponentId,
        actualUseProcessId: processId,
        consumptionTypeCode: TYPE_DEFAULT,
        statusCode: 'RECORDED',
        inputQty: 12,
        actualConsumedQty: 0,
        occurredAt: OCCURRED_1,
      });
      expect(response.body.recordedAt).toEqual(expect.any(String));
    });

    it('⭐ 같은 W/O 의 수령 라인이 있으면 shopfloor_receipt_line_id 가 서버 귀속으로 채워진다', async () => {
      const response = await register(consumptionBody()).expect(201);

      // 같은 (W/O · 품목 · LOT) 라인이 둘인데 최신 PK 를 잇는다 — 상한(`received_qty`)은 안 본다.
      expect(response.body.shopfloorReceiptLineId).toBe(receiptLineId);
    });

    it('수령 라인이 없어도 201 이고 shopfloorReceiptLineId 키가 생략된다', async () => {
      // LOT B 는 수령 라인이 없다 — 계약 ⌜비어 있어도 투입은 선다(출고 귀속 무관)⌝.
      const response = await register(consumptionBody({ lotId: lotBId })).expect(201);

      expect(response.body).not.toHaveProperty('shopfloorReceiptLineId');
    });

    it('⛔ 투입이 trace.lot_relation 을 만들지 않는다', async () => {
      // 설계 미정 — 문의 052. `target_lot_id` 를 가릴 축이 계약·화면·물리 어디에도 없다.
      await register(consumptionBody()).expect(201);

      const relations = await prisma.lot_relation.count({
        where: { OR: [{ source_lot_id: BigInt(lotAId) }, { target_lot_id: BigInt(lotAId) }] },
      });
      expect(relations).toBe(0);
    });

    it('⛔ 투입이 production.material_usage_allocation 을 만들지 않는다', async () => {
      // CHECK `ck_material_usage_target` 이 요구하는 두 축이 투입 시점에 둘 다 없다(§3-10).
      await register(consumptionBody()).expect(201);

      const allocations = await prisma.material_usage_allocation.count({
        where: { material_consumption: { work_order_id: BigInt(workOrderId) } },
      });
      expect(allocations).toBe(0);
    });

    it('⛔ 투입이 inventory_transaction·inventory_transaction_line 을 만들지 않고 inventory_balance 의 on_hand·version_no 가 그대로다', async () => {
      const before = await prisma.inventory_balance.findUniqueOrThrow({
        where: { inventory_balance_id: balanceId },
      });

      await register(consumptionBody()).expect(201);

      const lines = await prisma.inventory_transaction_line.count({ where: { lot_id: BigInt(lotAId) } });
      expect(lines).toBe(0);
      const after = await prisma.inventory_balance.findUniqueOrThrow({ where: { inventory_balance_id: balanceId } });
      expect(Number(after.on_hand_qty)).toBe(Number(before.on_hand_qty));
      expect(after.version_no).toBe(before.version_no);
    });

    it('⛔ 응답에 terminalId 키가 없다(단말 토큰 축이 0건 — 문의 054)', async () => {
      const response = await register(consumptionBody()).expect(201);

      // 계약이 required 로 적었으나 단말 토큰 «검증» 축이 0건이라 서버가 채울 값이 없다.
      expect(response.body).not.toHaveProperty('terminalId');
      const row = await prisma.material_consumption.findUniqueOrThrow({
        where: { material_consumption_id: BigInt(response.body.materialConsumptionId) },
      });
      expect(row.terminal_id).toBeNull();
    });

    it('BOM 에 없는 품목이면 400 INVALID', async () => {
      // ⭐ 오투입 3축에서 «막는 것은 이 하나»다(§3-3).
      const response = await register(consumptionBody({ itemId: finishedItemId, lotId: lotDId })).expect(400);

      expect(response.body.errors).toMatchObject([{ field: 'itemId', code: 'INVALID' }]);
    });

    it('lot.status_code 가 DEFECTIVE 면 400 INVALID', async () => {
      const response = await register(consumptionBody({ lotId: lotCId })).expect(400);

      expect(response.body.errors).toMatchObject([{ field: 'lotId', code: 'INVALID' }]);
    });

    it('러닝체인지 — replacedConsumptionId 가 붙은 둘째 투입이 201 이고 앞 건이 남아 있다', async () => {
      const first = await register(consumptionBody()).expect(201);

      const second = await register(
        consumptionBody({ lotId: lotBId, replacedConsumptionId: first.body.materialConsumptionId }),
      ).expect(201);

      // ⌜지우지 않고 잇는다⌝(`P-02-11` §5-2) — 앞 건이 그대로 조회된다.
      expect(second.body.replacedConsumptionId).toBe(first.body.materialConsumptionId);
      await request(app.getHttpServer())
        .get(`${CONSUMPTIONS}/${first.body.materialConsumptionId}`)
        .set('Cookie', cookie)
        .expect(200);
    });

    it('replacedConsumptionId 가 다른 W/O 의 투입이면 400 INVALID', async () => {
      const response = await register(
        consumptionBody({ workOrderId: otherWorkOrderId, replacedConsumptionId: c1Id }),
      ).expect(400);

      // 러닝체인지는 세션 안에서 일어난다 — W/O 는 무분할이다(`P-02-11` R42).
      expect(response.body.errors).toMatchObject([{ field: 'replacedConsumptionId', code: 'INVALID' }]);
    });

    it('같은 Idempotency-Key 재전송이 투입을 두 벌 만들지 않는다', async () => {
      const key = randomUUID();
      const send = () =>
        request(app.getHttpServer())
          .post(CONSUMPTIONS)
          .set('Cookie', cookie)
          .set('Idempotency-Key', key)
          .set('X-Worker-No', WORKER_NO)
          .send(consumptionBody());

      const first = await send().expect(201);
      const again = await send().expect(201);

      expect(again.body.materialConsumptionId).toBe(first.body.materialConsumptionId);
      const row = await prisma.material_consumption.findUniqueOrThrow({
        where: { material_consumption_id: BigInt(first.body.materialConsumptionId) },
      });
      // 헤더 값이 컬럼에도 그대로 든다 — 멱등 기록 만료 뒤의 재전송을 UNIQUE 가 둘째로 막는다.
      expect(row.idempotency_key).toBe(key);
    });

    it('X-Worker-No 가 없으면 400 REQUIRED', async () => {
      const response = await register(consumptionBody(), { workerNo: null }).expect(400);

      // 계약 검증 가드가 헤더를 안 본다 — 필수 판정은 서비스 몫이다.
      expect(response.body.errors).toMatchObject([{ field: 'X-Worker-No', code: 'REQUIRED' }]);
    });

    it('무권한 사용자는 403', async () => {
      // 계약이 403 을 선언한 자리라 가드가 본다 — `P-02-03` 이 없는 계정이다.
      await register(consumptionBody(), { cookie: noPermCookie }).expect(403);
    });

    it('⭐ 발행된 번호가 MC-{YYYYMMDD}-{SEQ4} 다', async () => {
      const response = await register(consumptionBody()).expect(201);

      // 규칙 미등재라 `DEFAULT_PREFIX` 의 `MC` 로 자동 등재된다 · 기간 키는 `occurredAt` 의 UTC 날짜다.
      expect(response.body.consumptionNo).toMatch(/^MC-\d{8}-\d{4}$/);
      expect(response.body.consumptionNo).toContain('MC-20260907-');
    });
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
    processId = Number(process.process_id);
    uomId = Number(uom.uom_id);
    finishedItemId = Number(item.item_id);
    componentItemId = Number(component.item_id);
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '자재투입검사창고',
        warehouse_type_code: 'PRODUCTION',
        management_level_code: 'LOCATION',
      },
    });
    const location = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LC`,
        location_name: '자재투입검사위치',
        location_type_code: 'SHELF',
      },
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
    bomComponentId = Number(componentRow.bom_component_id);
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
    otherWorkOrderId = Number(other.work_order_id);

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
    // ⓔ `P-02-03` §5-2 ⌜`DEFECTIVE` → ⛔ 차단⌝ 을 e2e 가 본다.
    const lotC = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-C`,
        item_id: component.item_id,
        lot_type_code: 'MATERIAL',
        plant_id: plant.plant_id,
        initial_qty: 1000,
        uom_id: uom.uom_id,
        source_type_code: 'INBOUND_RECEIPT_LINE',
        source_id: 3,
        status_code: 'DEFECTIVE',
      },
    });
    lotCId = Number(lotC.lot_id);
    // BOM 에 없는 품목 — 완제품 축의 LOT 이다(`lot.item_id` 정합은 통과하고 BOM 에서 막힌다).
    const lotD = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}-LOT-D`,
        item_id: item.item_id,
        lot_type_code: 'PRODUCT',
        plant_id: plant.plant_id,
        initial_qty: 10,
        uom_id: uom.uom_id,
        source_type_code: 'WORK_ORDER',
        source_id: Number(main.work_order_id),
        status_code: 'NORMAL',
      },
    });
    lotDId = Number(lotD.lot_id);

    // ⭐ M2 마디 ⑨ — 수령 라인을 직접 세운다. 같은 (W/O · 품목 · LOT) 이 둘이라 서버가
    //    최신 PK 를 고르는 것까지 본다(§3-5). ⛔ 진짜 출고를 태우지 않는다.
    const issue = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}-GI`,
        issue_type_code: 'PRODUCTION',
        source_document_type_code: 'WORK_ORDER',
        source_document_id: main.work_order_id,
        source_warehouse_id: warehouse.warehouse_id,
        issued_at: new Date(OCCURRED_1),
        status_code: 'POSTED',
      },
    });
    const issueLine = await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: issue.goods_issue_id,
        line_no: 1,
        item_id: component.item_id,
        lot_id: lotA.lot_id,
        issue_qty: 100,
        uom_id: uom.uom_id,
        source_location_id: location.location_id,
      },
    });
    const receipt = await prisma.shopfloor_receipt.create({
      data: {
        shopfloor_receipt_no: `${PREFIX}-SR`,
        goods_issue_id: issue.goods_issue_id,
        work_order_id: main.work_order_id,
        destination_location_id: location.location_id,
        received_at: new Date(OCCURRED_1),
        status_code: 'REGISTERED',
      },
    });
    const receiptLine = async () =>
      prisma.shopfloor_receipt_line.create({
        data: {
          shopfloor_receipt_id: receipt.shopfloor_receipt_id,
          goods_issue_line_id: issueLine.goods_issue_line_id,
          item_id: component.item_id,
          lot_id: lotA.lot_id,
          issued_qty: 100,
          received_qty: 100,
          uom_id: uom.uom_id,
        },
      });
    await receiptLine();
    receiptLineId = Number((await receiptLine()).shopfloor_receipt_line_id);

    // 원장 무변화 단언의 기준선 — 투입이 이 행의 `on_hand_qty`·`version_no` 를 건드리지 않는다.
    const balance = await prisma.inventory_balance.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_id: unit.business_unit_id,
        plant_id: plant.plant_id,
        warehouse_id: warehouse.warehouse_id,
        location_id: location.location_id,
        item_id: component.item_id,
        lot_id: lotA.lot_id,
        quality_status_code: 'GOOD',
        inventory_status_code: 'AVAILABLE',
        ownership_type_code: 'OWNED',
        on_hand_qty: 100,
        uom_id: uom.uom_id,
      },
    });
    balanceId = balance.inventory_balance_id;

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
    const user = await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '자재투입검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // 권한 0건 계정 — 조회 둘은 403 미선언이고 등록만 선언했다. 이 계정으로 그 갈래를 본다.
    const other = await prisma.app_user.create({
      data: { login_id: NOPERM_ID, user_name: '자재투입권한없음', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: other.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    // ⚠ 역할을 «먼저» 붙이고 로그인한다 — 세션이 그때의 권한을 담는다.
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '자재투입검사용' } });
    await prisma.role_permission.createMany({
      data: PERMISSIONS.map((permission_code) => ({ role_id: role.role_id, permission_code })),
    });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });

    cookie = await login(LOGIN_ID);
    noPermCookie = await login(NOPERM_ID);
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

  /** 만든 행을 FK 역순으로 지운다(§7-2 · `LIKE '${PREFIX}%'` 또는 id 서브쿼리 · ⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    // ⭐ `POST` 가 만든 행은 `MC-…` 라 접두어로 안 잡힌다 — W/O 축을 함께 건다.
    const consumptionWhere = {
      OR: [{ consumption_no: { startsWith: PREFIX } }, { work_order: orderScope }],
    };
    const consumptionScope = { material_consumption: consumptionWhere };
    await prisma.material_usage_allocation.deleteMany({ where: consumptionScope });
    await prisma.material_loss.deleteMany({ where: consumptionScope });
    await prisma.material_consumption.deleteMany({ where: consumptionWhere });
    await prisma.inventory_balance.deleteMany({ where: { warehouse: { warehouse_code: { startsWith: PREFIX } } } });
    await prisma.shopfloor_receipt_line.deleteMany({
      where: { shopfloor_receipt: { shopfloor_receipt_no: { startsWith: PREFIX } } },
    });
    await prisma.shopfloor_receipt.deleteMany({ where: { shopfloor_receipt_no: { startsWith: PREFIX } } });
    await prisma.goods_issue_line.deleteMany({ where: { goods_issue: { goods_issue_no: { startsWith: PREFIX } } } });
    await prisma.goods_issue.deleteMany({ where: { goods_issue_no: { startsWith: PREFIX } } });
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
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });
    for (const loginId of [LOGIN_ID, NOPERM_ID]) {
      const user = await prisma.app_user.findUnique({ where: { login_id: loginId } });
      if (!user) continue;
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_role.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: user.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: user.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (!role) return;
    await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
    await prisma.role.delete({ where: { role_id: role.role_id } });
    // ⛔ `app.numbering_rule`·`numbering_counter` 의 `MATERIAL_CONSUMPTION` 행은 안 지운다(전역 자원 · §7-2).
  }
});
