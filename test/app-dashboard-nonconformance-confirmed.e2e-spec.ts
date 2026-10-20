import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA124-NC';
const SUMMARY = '/api/app/dashboard-summary';
// 하루 조회 → 누계 구간 09-01 ~ 09-20. 기록은 모두 09-10 이다.
const BASE_DATE = '2026-09-20';
const DETECTED_AT = '2026-09-10T03:00:00Z';

type Row = { qty: number };
type Nonconformance = {
  phenomena: (Row & { defectCode: string })[];
  causeGroups: (Row & { causeName: string })[];
};

/**
 * 부적합 현황 탭의 불량현상 파레토·원인 대분류(omf-all-around#124). 검사 결과에 붙은 불량 기록은 그 결과가 확정일 때만
 * 세고, 결과 없는 기록은 그대로 센다. 다른 대시보드 e2e 의 픽스처와 섞지 않으려고 공장을 따로 세운다.
 */
describe('통합 대시보드 부적합 현황 — 확정 전 검사 결과의 불량 기록 제외 (omf-all-around#124)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await fixtures();
    cookie = `${SESSION_COOKIE}=${app.get(JwtService).sign({ sub: Number(ids.user), typ: 'session' })}`;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app.close();
    }
  });

  const nonconformance = async (): Promise<Nonconformance> =>
    (
      (await request(app.getHttpServer())
        .get(SUMMARY)
        .query({ plantId: ids.plant.toString(), baseDate: BASE_DATE })
        .set('Cookie', cookie)
        .expect(200)).body as { quality: { nonconformance: Nonconformance } }
    ).quality.nonconformance;

  it('⛔ 작성중 검사 결과의 기록(DRAFT 5)은 현상·원인 어디에도 들어가지 않는다', async () => {
    const { phenomena, causeGroups } = await nonconformance();

    expect(phenomena.map((row) => row.defectCode)).not.toContain(`${PREFIX}-DRAFT`);
    expect(causeGroups.map((row) => row.causeName)).not.toContain(`${PREFIX}-CAUSE-DRAFT`);
  });

  it('⭐ 확정 검사 결과의 기록(3)과 검사 결과 없는 기록(2)은 그대로 센다', async () => {
    const { phenomena, causeGroups } = await nonconformance();

    expect(phenomena.map(({ defectCode, qty }) => ({ defectCode, qty }))).toEqual([
      { defectCode: `${PREFIX}-CONFIRMED`, qty: 3 },
      { defectCode: `${PREFIX}-MATERIAL`, qty: 2 },
    ]);
    expect(causeGroups.map(({ causeName, qty }) => ({ causeName, qty }))).toEqual([
      { causeName: `${PREFIX}-CAUSE-CONFIRMED`, qty: 3 },
      { causeName: `${PREFIX}-CAUSE-MATERIAL`, qty: 2 },
    ]);
  });

  it('⭐ 작성중 결과를 확정하면 그 기록이 들어온다 — 같은 결과·같은 기록, 상태만 바뀌었다', async () => {
    await prisma.inspection_result.update({
      where: { inspection_result_id: ids.draftResult },
      data: { status_code: 'CONFIRMED', overall_judgment_code: 'REJECTED', confirmed_at: new Date(DETECTED_AT) },
    });
    try {
      const { phenomena } = await nonconformance();
      expect(phenomena[0]).toMatchObject({ defectCode: `${PREFIX}-DRAFT`, qty: 5 });
    } finally {
      await prisma.inspection_result.update({
        where: { inspection_result_id: ids.draftResult },
        data: { status_code: 'DRAFT', overall_judgment_code: null, confirmed_at: null },
      });
    }
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-CO-05' } });
    await prisma.user_role.create({ data: { app_user_id: ids.user, role_id: ids.role } });
    ids.legal = (
      await prisma.legal_entity.create({
        data: { legal_entity_code: PREFIX, legal_entity_name: PREFIX, country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).legal_entity_id;
    ids.unit = (
      await prisma.business_unit.create({ data: { legal_entity_id: ids.legal, business_unit_code: PREFIX, business_unit_name: PREFIX } })
    ).business_unit_id;
    ids.plant = (
      await prisma.plant.create({
        data: {
          legal_entity_id: ids.legal,
          business_unit_id: ids.unit,
          plant_code: PREFIX,
          plant_name: PREFIX,
          timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })
    ).plant_id;
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: PREFIX, worker_name: PREFIX, business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.item = (
      await prisma.item.create({
        data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
      })
    ).item_id;
    ids.process = (
      await prisma.process.create({ data: { process_code: PREFIX, process_name: PREFIX, process_type_code: 'INSPECTION' } })
    ).process_id;
    ids.lot = (
      await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}-LOT`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 100,
          uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 990001n, status_code: 'INSPECTION_PENDING',
        },
      })
    ).lot_id;
    ids.request = (
      await prisma.inspection_request.create({
        data: {
          inspection_request_no: `${PREFIX}-IRQ`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: ids.lot,
          item_id: ids.item, lot_id: ids.lot, target_qty: 100, uom_id: ids.uom, status_code: 'IN_PROGRESS',
          requested_at: new Date('2026-09-09T03:00:00Z'),
        },
      })
    ).inspection_request_id;
    // 1회차 확정(불합격 3) → 2회차 작성중(불합격 사유 5 · 장부 P-48 임시 저장).
    ids.confirmedResult = (
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-1`, inspection_request_id: ids.request, inspection_round: 1,
          inspected_qty: 10, accepted_qty: 7, rejected_qty: 3, held_qty: 0, uom_id: ids.uom,
          overall_judgment_code: 'REJECTED', inspector_id: ids.worker, inspected_at: new Date(DETECTED_AT),
          confirmed_at: new Date(DETECTED_AT), status_code: 'CONFIRMED', idempotency_key: `${PREFIX}-IRS-1`,
        },
      })
    ).inspection_result_id;
    ids.draftResult = (
      await prisma.inspection_result.create({
        data: {
          inspection_result_no: `${PREFIX}-IRS-2`, inspection_request_id: ids.request, inspection_round: 2,
          inspected_qty: 10, accepted_qty: 5, rejected_qty: 5, held_qty: 0, uom_id: ids.uom,
          inspector_id: ids.worker, inspected_at: new Date(DETECTED_AT), status_code: 'DRAFT',
          previous_result_id: ids.confirmedResult, idempotency_key: `${PREFIX}-IRS-2`,
        },
      })
    ).inspection_result_id;

    const record = async (suffix: string, qty: number, source: { inspection_result_id?: bigint; source_type_code?: string; source_document_id?: bigint }) => {
      const defect = await prisma.defect_code.create({ data: { defect_code: `${PREFIX}-${suffix}`, defect_name: `${PREFIX}-${suffix}` } });
      const cause = await prisma.cause_code.create({ data: { cause_code: `${PREFIX}-C-${suffix}`, cause_name: `${PREFIX}-CAUSE-${suffix}` } });
      await prisma.defect_record.create({
        data: {
          ...source, lot_id: ids.lot, defect_code_id: defect.defect_code_id, suspected_cause_code_id: cause.cause_code_id,
          defect_qty: qty, uom_id: ids.uom, occurrence_process_id: ids.process, detection_process_id: ids.process,
          detected_at: new Date(DETECTED_AT), worker_id: ids.worker,
        },
      });
    };
    await record('DRAFT', 5, { inspection_result_id: ids.draftResult });
    await record('CONFIRMED', 3, { inspection_result_id: ids.confirmedResult });
    // POP 자재 불량 등록 — 검사 결과 없이 원천 문서로 선다.
    await record('MATERIAL', 2, { source_type_code: 'MATERIAL', source_document_id: 990002n });
  }

  async function cleanup(): Promise<void> {
    await prisma.defect_record.deleteMany({ where: { defect_code: { defect_code: { startsWith: PREFIX } } } });
    await prisma.defect_code.deleteMany({ where: { defect_code: { startsWith: PREFIX } } });
    await prisma.cause_code.deleteMany({ where: { cause_code: { startsWith: PREFIX } } });
    await prisma.inspection_result.updateMany({ where: { inspection_result_no: { startsWith: PREFIX } }, data: { previous_result_id: null } });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
    await prisma.process.deleteMany({ where: { process_code: PREFIX } });
    await prisma.item.deleteMany({ where: { item_code: PREFIX } });
    await prisma.worker.deleteMany({ where: { worker_no: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: PREFIX } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: PREFIX } });
    const users = await prisma.app_user.findMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
    await prisma.user_role.deleteMany({ where: { app_user_id: { in: users.map((row) => row.app_user_id) } } });
    await prisma.role_permission.deleteMany({ where: { role: { role_code: `${PREFIX}-ROLE` } } });
    await prisma.role.deleteMany({ where: { role_code: `${PREFIX}-ROLE` } });
    await prisma.app_user.deleteMany({ where: { login_id: { startsWith: `${PREFIX}-` } } });
  }
});
