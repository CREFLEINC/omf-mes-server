/**
 * 4M 교대·작업자 추천(장부 P-68) — `GET /production/work-orders/{workOrderId}/resource-recommendations` 의 `shifts`·`workers`.
 * 이력 W/O 는 오퍼레이션으로 만들 길이 없다(책임자·교대를 정하는 4M 저장이 배포 흐름에 묶여 있다) — prisma 로 심는다.
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

const LOGIN_ID = 'e2e-cr74-probe';
const PASSWORD = 'CR74-검사-비밀번호';
const PREFIX = 'CR74';
const ROLE = 'E2E_CR74';
const TIMEZONE = 'Asia/Ho_Chi_Minh';

function validator(operation: string, status = '200'): ValidateFunction {
  const contract = JSON.parse(readFileSync(join(__dirname, '../contracts/production-02생산실행.json'), 'utf8')) as object;
  const [method, path] = operation.split(' ');
  const pointer = `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of ['int64', 'int32', 'double', 'float', 'binary', 'password']) ajv.addFormat(f, true);
  ajv.addSchema(contract, 'https://omf-mes.invalid/contract');
  return ajv.compile({ $ref: `https://omf-mes.invalid/contract#${pointer}` });
}

/** 하노이 벽시계 → UTC 순간. */
const hanoi = (local: string): Date => new Date(new Date(`${local}Z`).getTime() - 7 * 60 * 60 * 1000);

describe('4M 교대·작업자 추천 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string[];

  const ids = {
    plant: 0n, farPlant: 0n, unit: 0n, uom: 0n, item: 0n, process: 0n, otherProcess: 0n, operation: 0n, otherOperation: 0n,
    line: 0n, otherLine: 0n, farLine: 0n, equipment: 0n, dayShift: 0n, nightShift: 0n,
  };
  const workers: Record<string, bigint> = {};
  let targetId = 0n;
  let bareTargetId = 0n;
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);

    await cleanup();
    await makeFixtures();
    await makeUser();
    cookie = await login();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const recommend = (workOrderId: bigint) =>
    request(app.getHttpServer()).get(`/api/production/work-orders/${workOrderId}/resource-recommendations`).set('Cookie', cookie).expect(200);

  it('1. 교대는 공장의 활성 교대 전부이고, 같은 설비가 같은 근무일에 쓰는 교대가 뒤로 간다', async () => {
    const response = await recommend(targetId);

    expect(validator('GET /production/work-orders/{workOrderId}/resource-recommendations')(response.body)).toBe(true);
    expect(response.body.shifts).toEqual([
      { shiftId: Number(ids.nightShift), shiftCode: `${PREFIX}-N`, shiftName: '야간', startTime: '20:00:00', endTime: '08:00:00', busy: false },
      { shiftId: Number(ids.dayShift), shiftCode: `${PREFIX}-D`, shiftName: '주간', startTime: '08:00:00', endTime: '20:00:00', busy: true },
    ]);
  });

  it('2. 작업자는 설비 → 라인 → 공정 → 자격 순이고, 중복·다른 공장·비활성·공정 미지정 자격은 빠진다', async () => {
    const response = await recommend(targetId);

    expect(response.body.workers).toEqual([
      { workerId: Number(workers.onEquipment), workerNo: `${PREFIX}-W-onEquipment`, workerName: '작업자-onEquipment', source: 'EQUIPMENT', busy: true },
      { workerId: Number(workers.onLine), workerNo: `${PREFIX}-W-onLine`, workerName: '작업자-onLine', source: 'LINE', busy: false },
      { workerId: Number(workers.onProcess), workerNo: `${PREFIX}-W-onProcess`, workerName: '작업자-onProcess', source: 'PROCESS', busy: false },
      { workerId: Number(workers.qualified), workerNo: `${PREFIX}-W-qualified`, workerName: '작업자-qualified', source: 'QUALIFIED', busy: false },
    ]);
  });

  it('3. 설비·시작 시각이 없는 W/O 는 교대가 모두 비어 있고 시작 시각 순이다 — 작업자는 라인·공정 이력에서 다섯 명까지', async () => {
    const response = await recommend(bareTargetId);

    expect(response.body.shifts.map((shift: { shiftId: number; busy: boolean }) => [shift.shiftId, shift.busy])).toEqual([
      [Number(ids.dayShift), false],
      [Number(ids.nightShift), false],
    ]);
    expect(response.body.workers.map((worker: { workerId: number; source: string; busy: boolean }) => [worker.workerId, worker.source, worker.busy])).toEqual([
      [Number(workers.onOtherProcess), 'LINE', false],
      [Number(workers.onProcess), 'LINE', false],
      [Number(workers.onEquipment), 'PROCESS', false],
      [Number(workers.onLine), 'PROCESS', false],
      [Number(workers.qualified), 'QUALIFIED', false],
    ]);
  });

  async function makeFixtures(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '교대작업자추천검사법인', country_code: 'VN', timezone_code: TIMEZONE },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '교대작업자추천검사사업부' },
    })).business_unit_id;
    const plant = (code: string) =>
      prisma.plant.create({ data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: code, plant_name: code, timezone_code: TIMEZONE } });
    ids.plant = (await plant(`${PREFIX}-P`)).plant_id;
    ids.farPlant = (await plant(`${PREFIX}-P2`)).plant_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
    ids.dayShift = (await prisma.shift.create({ data: { plant_id: ids.plant, shift_code: `${PREFIX}-D`, shift_name: '주간', start_time: time('08:00'), end_time: time('20:00') } })).shift_id;
    ids.nightShift = (await prisma.shift.create({
      data: { plant_id: ids.plant, shift_code: `${PREFIX}-N`, shift_name: '야간', start_time: time('20:00'), end_time: time('08:00'), crosses_midnight: true },
    })).shift_id;
    await prisma.shift.create({ data: { plant_id: ids.plant, shift_code: `${PREFIX}-X`, shift_name: '안쓰는교대', start_time: time('06:00'), end_time: time('14:00'), is_active: false } });

    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-IT`, item_name: '교대작업자추천품목', item_type_code: 'FINISHED_GOODS', base_uom_id: ids.uom, lot_controlled: true },
    })).item_id;
    ids.process = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR`, process_name: '사출', process_type_code: 'MOLDING' } })).process_id;
    ids.otherProcess = (await prisma.process.create({ data: { process_code: `${PREFIX}-PR2`, process_name: '조립', process_type_code: 'MOLDING' } })).process_id;
    const routing = await prisma.routing.create({ data: { item_id: ids.item, routing_code: `${PREFIX}-RT`, routing_version: 1, status_code: 'CONFIRMED' } });
    ids.operation = (await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 10, process_id: ids.process, operation_name: '사출' },
    })).routing_operation_id;
    ids.otherOperation = (await prisma.routing_operation.create({
      data: { routing_id: routing.routing_id, operation_seq: 20, process_id: ids.otherProcess, operation_name: '조립' },
    })).routing_operation_id;
    const line = (plantId: bigint, code: string) => prisma.production_line.create({ data: { plant_id: plantId, line_code: code, line_name: code } });
    ids.line = (await line(ids.plant, `${PREFIX}-LN`)).production_line_id;
    ids.otherLine = (await line(ids.plant, `${PREFIX}-LN2`)).production_line_id;
    ids.farLine = (await line(ids.farPlant, `${PREFIX}-LN-FAR`)).production_line_id;
    ids.equipment = (await prisma.equipment.create({
      data: { plant_id: ids.plant, equipment_code: `${PREFIX}-EQ`, equipment_name: '사출기', equipment_type_code: 'PRESS', status_code: 'IN_SERVICE', production_line_id: ids.line },
    })).equipment_id;

    const worker = async (key: string, plantId = ids.plant, isActive = true) => {
      workers[key] = (await prisma.worker.create({
        data: { worker_no: `${PREFIX}-W-${key}`, worker_name: `작업자-${key}`, business_unit_id: ids.unit, plant_id: plantId, status_code: 'EMPLOYED', is_active: isActive },
      })).worker_id;
    };
    for (const key of ['onEquipment', 'onLine', 'onProcess', 'qualified', 'expired', 'unscoped', 'onOtherProcess']) await worker(key);
    await worker('inactive', ids.plant, false);
    await worker('far', ids.farPlant);

    const day = hanoi('2026-11-02T08:00:00');
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    targetId = await workOrder({ line: ids.line, equipment: ids.equipment, start: day, end: nextDay });
    bareTargetId = await workOrder({ line: ids.otherLine });

    // 같은 설비·같은 근무일·주간 — 주간이 막히고, 책임자가 같은 시간대에 바쁘다.
    await workOrder({ line: ids.line, equipment: ids.equipment, shift: ids.dayShift, start: day, end: hanoi('2026-11-02T20:00:00'), worker: workers.onEquipment });
    // 같은 설비·같은 근무일·야간이지만 취소 — 야간은 비어 있다. 다른 공장 사람은 추천하지 않는다.
    await workOrder({ line: ids.line, equipment: ids.equipment, shift: ids.nightShift, start: hanoi('2026-11-02T21:00:00'), status: 'CANCELLED', worker: workers.far });
    // 비활성 작업자 — 설비 이력이라도 빠진다.
    await workOrder({ line: ids.line, equipment: ids.equipment, start: hanoi('2026-10-01T08:00:00'), worker: workers.inactive });
    // 같은 라인(설비 없음) — 앞 출처에 나온 사람은 다시 넣지 않는다.
    await workOrder({ line: ids.line, start: hanoi('2026-10-10T08:00:00'), worker: workers.onLine });
    await workOrder({ line: ids.line, start: hanoi('2026-10-09T08:00:00'), worker: workers.onEquipment });
    // 같은 공정·다른 라인.
    await workOrder({ line: ids.otherLine, start: hanoi('2026-10-05T08:00:00'), worker: workers.onProcess });
    // 다른 공정 — 공정 출처에 안 든다.
    await workOrder({ line: ids.otherLine, operation: ids.otherOperation, start: hanoi('2026-10-06T08:00:00'), worker: workers.onOtherProcess });
    // 다른 공장 W/O 의 같은 공정 — 공장을 넘지 않는다.
    await workOrder({ line: ids.farLine, start: hanoi('2026-10-07T08:00:00'), worker: workers.far });

    const qualification = (key: string, data: { process_id: bigint | null; valid_from: string; valid_to?: string }) =>
      prisma.worker_qualification.create({
        data: {
          worker_id: workers[key],
          qualification_type_code: 'PROCESS_OPERATION',
          process_id: data.process_id,
          valid_from: new Date(`${data.valid_from}T00:00:00.000Z`),
          valid_to: data.valid_to === undefined ? null : new Date(`${data.valid_to}T00:00:00.000Z`),
        },
      });
    await qualification('qualified', { process_id: ids.process, valid_from: '2026-01-01' });
    await qualification('expired', { process_id: ids.process, valid_from: '2025-01-01', valid_to: '2025-12-31' });
    await qualification('unscoped', { process_id: null, valid_from: '2026-01-01' });
    await qualification('far', { process_id: ids.process, valid_from: '2026-01-01' });
  }

  async function workOrder(input: {
    line: bigint;
    operation?: bigint;
    equipment?: bigint;
    shift?: bigint;
    start?: Date;
    end?: Date;
    worker?: bigint;
    status?: string;
  }): Promise<bigint> {
    seq += 1;
    const row = await prisma.work_order.create({
      data: {
        work_order_no: `${PREFIX}-WO-${seq}`,
        routing_operation_id: input.operation ?? ids.operation,
        item_id: ids.item,
        order_qty: 10,
        uom_id: ids.uom,
        production_line_id: input.line,
        planned_equipment_id: input.equipment ?? null,
        planned_shift_id: input.shift ?? null,
        planned_start_at: input.start ?? null,
        planned_end_at: input.end ?? null,
        responsible_worker_id: input.worker ?? null,
        status_code: input.status ?? 'PLANNED',
      },
    });
    return row.work_order_id;
  }

  async function makeUser(): Promise<void> {
    const user = await prisma.app_user.create({ data: { login_id: LOGIN_ID, user_name: '교대작업자추천검사', status_code: 'EMPLOYED' } });
    await prisma.user_credential.create({ data: { app_user_id: user.app_user_id, password_hash: await hashPassword(PASSWORD) } });
    const role = await prisma.role.create({ data: { role_code: ROLE, role_name: '교대작업자추천검사용' } });
    await prisma.role_permission.create({ data: { role_id: role.role_id, permission_code: 'W-02-04' } });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
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

  /** 자가 치유 `deleteMany`(역순). `beforeAll`·`afterAll` 둘 다 부른다. */
  async function cleanup(): Promise<void> {
    await prisma.work_order.deleteMany({ where: { work_order_no: { startsWith: PREFIX } } });
    await prisma.worker_qualification.deleteMany({ where: { worker: { worker_no: { startsWith: PREFIX } } } });
    await prisma.worker.deleteMany({ where: { worker_no: { startsWith: PREFIX } } });
    await prisma.equipment.deleteMany({ where: { equipment_code: { startsWith: PREFIX } } });
    await prisma.production_line.deleteMany({ where: { line_code: { startsWith: PREFIX } } });
    await prisma.routing_operation.deleteMany({ where: { routing: { routing_code: { startsWith: PREFIX } } } });
    await prisma.routing.deleteMany({ where: { routing_code: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: { startsWith: PREFIX } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.shift.deleteMany({ where: { plant: { plant_code: { startsWith: PREFIX } } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: PREFIX } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: PREFIX } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: PREFIX } } });

    const target = await prisma.app_user.findUnique({ where: { login_id: LOGIN_ID } });
    if (target) {
      await prisma.user_role.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.user_credential.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.idempotency_record.deleteMany({ where: { app_user_id: target.app_user_id } });
      await prisma.app_user.delete({ where: { app_user_id: target.app_user_id } });
    }
    const role = await prisma.role.findUnique({ where: { role_code: ROLE } });
    if (role) {
      await prisma.role_permission.deleteMany({ where: { role_id: role.role_id } });
      await prisma.role.delete({ where: { role_id: role.role_id } });
    }
  }
});
