/**
 * 공정 인계 — 조회 2건(I-25 PR ①). 확정 등록(`POST`, PR ②)은 이 파일에 뒤이어 더한다.
 *
 * ⭐ 조회가 보는 인계는 **직접 INSERT** 한다 — 이 PR 에 `POST` 가 없다(PR ② 몫).
 * ⭐ 목록도 상세도 `lines` 를 싣는다 — 같은 `OperationHandover` 스키마라 비우면 자리마다
 *    모양이 갈린다(I-25 §3-1).
 * ⛔ 계약이 조회 둘에 403 도 ETag 도 선언하지 않았다 — 권한 없는 계정을 세우지 않는다.
 * ⛔ `TRUNCATE` 를 쓰지 않는다 — 원장 행을 한 건도 만들지 않는다(I-25 §4-1 ⛔ 없는 것).
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

const LOGIN_ID = 'e2e-oh-probe';
const PASSWORD = 'OH-공정인계-비밀번호';
const PREFIX = 'OHE2E';
const HANDOVERS = '/api/production/operation-handovers';
const T1 = '2026-09-08T01:00:00.000Z';
const T2 = '2026-09-08T03:00:00.000Z';
/** `statusCode` 는 `x-no-code-key` 다 — 서버가 대조하지 않는 자유 문자다(§1-5). */
const STATUS_MAIN = 'HANDED_OVER';
const STATUS_OTHER = 'CUSTOM_STATUS';

function validator(operation: string, status = 200): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8'),
  ) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

describe('공정 인계 조회 2건 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  let woAId: number;
  let woBId: number;
  let lotAId: number;
  let lotBId: number;
  /** ho1·ho2 동률(T1) · ho3 다른 시각(T2) · ho4 반대 방향(from↔to) · ho5 다른 statusCode. */
  let ho1Id: number;
  let ho2Id: number;
  let ho3Id: number;
  let ho4Id: number;
  let ho5Id: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    // 자가 치유 — 앞 회차가 죽어 남긴 행을 먼저 지운다.
    await cleanup();
    await makeFixtures();
    cookie = await login(LOGIN_ID, null, []);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('목록 200 + 응답 키 집합(헤더 7칸 · receivedAt 은 전 행 NULL 이라 빠진다 · 라인 4칸)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_MAIN}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/operation-handovers')(response.body)).toBe(true);
    const [item] = response.body.items;
    // `version_no`·감사 4칸(created_at·created_by·updated_at·updated_by)이 새면 ajv 는 못 잡는다
    // (additionalProperties 미선언) — 통째 단언이 유일한 그물이다.
    expect(Object.keys(item).sort()).toEqual([
      'fromWorkOrderId',
      'handedOverAt',
      'handoverNo',
      'lines',
      'operationHandoverId',
      'statusCode',
      'toWorkOrderId',
    ]);
    // `line_no`·`receivedQty`·위치 두 칸이 새면 마찬가지로 ajv 가 못 잡는다.
    expect(Object.keys(item.lines[0]).sort()).toEqual([
      'handoverQty',
      'lotId',
      'operationHandoverLineId',
      'uomId',
    ]);
  });

  it('⭐ 정렬 — handed_over_at desc + operation_handover_id desc(동률 두 행 포함 배열 통째)', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_MAIN}`)
      .set('Cookie', cookie)
      .expect(200);

    // ho3(T2) 가 먼저, T1 동률(ho1·ho2)은 PK desc 로 ho2 가 ho1 보다 앞선다.
    expect(response.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho3Id,
      ho2Id,
      ho1Id,
    ]);
  });

  it('⭐ fromWorkOrderId·toWorkOrderId 필터가 방향을 가른다(반대 방향 행이 안 섞인다)', async () => {
    const fromA = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    const fromIds = fromA.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId);
    expect(fromIds).toEqual(expect.arrayContaining([ho1Id, ho2Id, ho3Id, ho5Id]));
    // ho4 는 from=woB·to=woA 다 — fromWorkOrderId=woA 로는 안 잡힌다.
    expect(fromIds).not.toContain(ho4Id);

    const toA = await request(app.getHttpServer())
      .get(`${HANDOVERS}?toWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(toA.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho4Id,
    ]);
  });

  it('⭐ statusCode 필터 — 문자 그대로 건다(x-no-code-key)', async () => {
    const other = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&statusCode=${STATUS_OTHER}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(other.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual([
      ho5Id,
    ]);

    // 필터를 지우면 ho5(다른 status)가 섞인다 — 이 행이 없으면 상수 하나뿐이라 필터 제거가 초록이 된다.
    const unfiltered = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(unfiltered.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId)).toEqual(
      expect.arrayContaining([ho5Id]),
    );
  });

  it('목록이 handedOverFrom 이상 handedOverTo 미만 반개구간으로 걸러진다', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&handedOverFrom=${T1}&handedOverTo=${T2}`)
      .set('Cookie', cookie)
      .expect(200);

    // gte T1 — T1 행(ho1·ho2·ho5)은 포함. lt T2 — T2 정각의 ho3 는 제외(반개구간 · L-3).
    const ids = response.body.items.map((item: { operationHandoverId: number }) => item.operationHandoverId);
    expect(new Set(ids)).toEqual(new Set([ho1Id, ho2Id, ho5Id]));
    expect(ids).not.toContain(ho3Id);
  });

  it('page=2&size=1 — items 1건 + page.total 이 필터 기준. 상한 없는 size 는 200 으로 잘린다', async () => {
    // fromWorkOrderId=woA 전체 4건: 정렬 [ho3, ho5, ho2, ho1](T2 먼저 · T1 동률은 PK desc).
    const page1 = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&page=1&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(page1.body.page).toMatchObject({ page: 1, size: 1, total: 4 });
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.items[0].operationHandoverId).toBe(ho3Id);

    const page2 = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&page=2&size=1`)
      .set('Cookie', cookie)
      .expect(200);
    expect(page2.body.page).toMatchObject({ page: 2, size: 1, total: 4 });
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].operationHandoverId).toBe(ho5Id);

    // 계약이 이 목록에 상한을 선언하지 않았다 — 가드는 통과시키고 `pageRequest` 가 자른다(§1-2).
    const uncapped = await request(app.getHttpServer())
      .get(`${HANDOVERS}?fromWorkOrderId=${woAId}&size=1000`)
      .set('Cookie', cookie)
      .expect(200);
    expect(uncapped.body.page.size).toBe(200);
    expect(uncapped.body.items.length).toBeLessThanOrEqual(200);
  });

  it('상세 200 · 라인이 line_no 오름차순 · 없는 id 는 404', async () => {
    const response = await request(app.getHttpServer())
      .get(`${HANDOVERS}/${ho3Id}`)
      .set('Cookie', cookie)
      .expect(200);

    expect(validator('GET /production/operation-handovers/{operationHandoverId}')(response.body)).toBe(true);
    // ho3 는 line_no 2 를 «먼저» 심었다 — 저장 순서가 아니라 line_no 로 정렬한다.
    expect(response.body.lines.map((line: { lotId: number }) => line.lotId)).toEqual([lotAId, lotBId]);
    expect(response.body).toMatchObject({ operationHandoverId: ho3Id, fromWorkOrderId: woAId, toWorkOrderId: woBId });

    await request(app.getHttpServer()).get(`${HANDOVERS}/999999999`).set('Cookie', cookie).expect(404);
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: `${PREFIX}-LE`,
        legal_entity_name: '공정인계검사법인',
        country_code: 'VN',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const unit = await prisma.business_unit.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        business_unit_code: `${PREFIX}-BU`,
        business_unit_name: '공정인계검사사업부',
      },
    });
    const plant = await prisma.plant.create({
      data: {
        legal_entity_id: entity.legal_entity_id,
        plant_code: `${PREFIX}-P`,
        plant_name: '공정인계검사공장',
        timezone_code: 'Asia/Ho_Chi_Minh',
      },
    });
    const uom = await prisma.uom.findFirstOrThrow();
    const item = await prisma.item.create({
      data: {
        item_code: `${PREFIX}-IT`,
        item_name: '공정인계검사품목',
        item_type_code: 'FINISHED_GOODS',
        base_uom_id: uom.uom_id,
        lot_controlled: true,
      },
    });
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id: unit.business_unit_id,
        warehouse_code: `${PREFIX}-WH`,
        warehouse_name: '공정인계검사창고',
        warehouse_type_code: 'WIP',
        management_level_code: 'LOCATION',
      },
    });
    const locationA = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC-A`,
        location_name: '공정인계검사위치A',
        location_type_code: 'BIN',
      },
    });
    const locationB = await prisma.location.create({
      data: {
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}-LOC-B`,
        location_name: '공정인계검사위치B',
        location_type_code: 'BIN',
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
        plan_date: new Date('2026-09-08T00:00:00.000Z'),
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
    const woA = await workOrder('WOA');
    woAId = Number(woA.work_order_id);
    const woB = await workOrder('WOB');
    woBId = Number(woB.work_order_id);

    const lot = async (suffix: string) =>
      prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT-${suffix}`,
          item_id: item.item_id,
          lot_type_code: 'WIP',
          plant_id: plant.plant_id,
          initial_qty: 100,
          uom_id: uom.uom_id,
          source_type_code: 'WORK_ORDER',
          source_id: woA.work_order_id,
          status_code: 'NORMAL',
        },
      });
    const lotA = await lot('A');
    lotAId = Number(lotA.lot_id);
    const lotB = await lot('B');
    lotBId = Number(lotB.lot_id);

    const handover = async (
      suffix: string,
      fromWorkOrderId: bigint,
      toWorkOrderId: bigint,
      handedOverAt: string,
      statusCode: string,
      lines: { lineNo: number; lotId: bigint; qty: number }[],
    ) =>
      prisma.operation_handover.create({
        data: {
          handover_no: `${PREFIX}-HO-${suffix}`,
          from_work_order_id: fromWorkOrderId,
          to_work_order_id: toWorkOrderId,
          status_code: statusCode,
          handed_over_at: new Date(handedOverAt),
          operation_handover_line: {
            create: lines.map((line) => ({
              line_no: line.lineNo,
              source_lot_id: line.lotId,
              handover_qty: line.qty,
              uom_id: uom.uom_id,
              source_location_id: locationA.location_id,
              destination_location_id: locationB.location_id,
            })),
          },
        },
      });

    ho1Id = Number(
      (await handover('1', woA.work_order_id, woB.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 10 },
      ])).operation_handover_id,
    );
    ho2Id = Number(
      (await handover('2', woA.work_order_id, woB.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotB.lot_id, qty: 20 },
      ])).operation_handover_id,
    );
    // ⭐ line_no 를 «역순»으로 심는다 — 상세가 저장 순서가 아니라 line_no 로 정렬함을 증명한다.
    ho3Id = Number(
      (await handover('3', woA.work_order_id, woB.work_order_id, T2, STATUS_MAIN, [
        { lineNo: 2, lotId: lotB.lot_id, qty: 15 },
        { lineNo: 1, lotId: lotA.lot_id, qty: 5 },
      ])).operation_handover_id,
    );
    // 반대 방향 — from↔to 를 바꿔 fromWorkOrderId 필터가 방향을 가르는지 본다.
    ho4Id = Number(
      (await handover('4', woB.work_order_id, woA.work_order_id, T1, STATUS_MAIN, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 1 },
      ])).operation_handover_id,
    );
    ho5Id = Number(
      (await handover('5', woA.work_order_id, woB.work_order_id, T1, STATUS_OTHER, [
        { lineNo: 1, lotId: lotA.lot_id, qty: 1 },
      ])).operation_handover_id,
    );
  }

  /** 역할 코드가 널이면 역할을 안 붙인다(조회 전용 세션). */
  async function login(loginId: string, roleCode: string | null, permissions: string[]): Promise<string[]> {
    const user = await prisma.app_user.create({
      data: { login_id: loginId, user_name: '공정인계검사', status_code: 'EMPLOYED' },
    });
    await prisma.user_credential.create({
      data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) },
    });
    if (roleCode !== null) {
      const role = await prisma.role.create({ data: { role_code: roleCode, role_name: '공정인계검사용' } });
      await prisma.role_permission.createMany({
        data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })),
      });
      await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    }
    const response = await request(app.getHttpServer())
      .post('/api/app/sessions')
      .set('Idempotency-Key', randomUUID())
      .send({ loginId, password: PASSWORD })
      .expect(200);
    const raw: unknown = response.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  }

  /** 만든 행을 FK 역순으로 지운다(⛔ TRUNCATE 금지). */
  async function cleanup(): Promise<void> {
    const orderScope = { production_plan: { plan_no: { startsWith: PREFIX } } };
    const handoverWhere = { handover_no: { startsWith: PREFIX } };
    await prisma.operation_handover_line.deleteMany({ where: { operation_handover: handoverWhere } });
    await prisma.operation_handover.deleteMany({ where: handoverWhere });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.work_order.deleteMany({ where: orderScope });
    await prisma.production_plan.deleteMany({ where: { plan_no: { startsWith: PREFIX } } });
    await prisma.production_order.deleteMany({ where: { production_order_no: { startsWith: PREFIX } } });
    await prisma.bom.deleteMany({ where: { bom_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.location.deleteMany({ where: { location_code: { startsWith: PREFIX } } });
    await prisma.warehouse.deleteMany({ where: { warehouse_code: { startsWith: PREFIX } } });
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
