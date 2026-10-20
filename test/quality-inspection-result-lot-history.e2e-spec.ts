import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E2E-AA85-IQCH';
const LIST = '/api/quality/inspection-results';

type Row = { inspectionResultNo: string; lotId?: number; inspectorId: number; inspectorName?: string; inspectionRound: number };

/**
 * IQC 이력 상세 조회(omf-all-around#85 · 장부 P-76) — 검사 결과 목록을 LOT 하나로 좁히고(기간 없이 전 이력),
 * 검사자 이름을 내린다. LOT A 는 1·2회차(재검사), LOT B 는 1회차. 두 해에 걸쳐 놓아 «기간 없이»를 본다.
 */
describe('검사 결과 목록 — LOT 별 전 이력 · 검사자 이름 (omf-all-around#85)', () => {
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

  const list = (query: Record<string, string>) => request(app.getHttpServer()).get(LIST).query(query).set('Cookie', cookie);

  it('⭐ lotId 만 주면 기간 없이 그 LOT 의 전 회차가 온다 — 다른 LOT 은 섞이지 않는다', async () => {
    const response = await list({ lotId: ids.lotA.toString(), inspectionTypeCode: 'IQC' }).expect(200);
    const items = response.body.items as Row[];

    expect(items.map((row) => row.inspectionResultNo)).toEqual([`${PREFIX}-A-1`, `${PREFIX}-A-2`]);
    expect(items.every((row) => row.lotId === Number(ids.lotA))).toBe(true);
  });

  it('⭐ 검사자 이름이 함께 온다(목록·상세)', async () => {
    const items = (await list({ lotId: ids.lotB.toString() }).expect(200)).body.items as Row[];
    expect(items).toEqual([expect.objectContaining({ inspectorId: Number(ids.worker), inspectorName: `${PREFIX}-검사원` })]);

    const detail = await request(app.getHttpServer())
      .get(`${LIST}/${String(ids.resultB)}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body).toMatchObject({ inspectorName: `${PREFIX}-검사원` });
  });

  it('lotId 와 기간을 함께 주면 둘 다 건다', async () => {
    const items = (
      await list({
        lotId: ids.lotA.toString(), inspectedFrom: '2026-01-01T00:00:00Z', inspectedTo: '2026-12-31T23:59:59Z', finalRoundOnly: 'true',
      }).expect(200)
    ).body.items as Row[];

    // 1회차(2025-12)는 기간 밖 — 2026 년 안의 2회차만 남는다.
    expect(items.map((row) => row.inspectionResultNo)).toEqual([`${PREFIX}-A-2`]);
  });

  it('⛔ lotId·의뢰·기간이 모두 없으면 종전대로 400 · 기간 한쪽만이면 400', async () => {
    await list({ inspectionTypeCode: 'IQC' }).expect(400);
    await list({ lotId: ids.lotA.toString(), inspectedFrom: '2026-01-01T00:00:00Z' }).expect(400);
  });

  async function fixtures(): Promise<void> {
    ids.user = (await prisma.app_user.create({ data: { login_id: `${PREFIX}-USER`, user_name: PREFIX, status_code: 'EMPLOYED' } }))
      .app_user_id;
    ids.role = (await prisma.role.create({ data: { role_code: `${PREFIX}-ROLE`, role_name: PREFIX } })).role_id;
    await prisma.role_permission.create({ data: { role_id: ids.role, permission_code: 'W-03-05' } });
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
        data: { legal_entity_id: ids.legal, business_unit_id: ids.unit, plant_code: PREFIX, plant_name: PREFIX, timezone_code: 'Asia/Ho_Chi_Minh' },
      })
    ).plant_id;
    ids.worker = (
      await prisma.worker.create({
        data: { worker_no: PREFIX, worker_name: `${PREFIX}-검사원`, business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
      })
    ).worker_id;
    ids.uom = (await prisma.uom.findFirstOrThrow()).uom_id;
    ids.item = (
      await prisma.item.create({
        data: { item_code: PREFIX, item_name: PREFIX, item_type_code: 'RAW_MATERIAL', base_uom_id: ids.uom, lot_controlled: true },
      })
    ).item_id;

    const lot = async (suffix: string) =>
      (
        await prisma.lot.create({
          data: {
            lot_no: `${PREFIX}-LOT-${suffix}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.plant, initial_qty: 10,
            uom_id: ids.uom, source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 990001n, status_code: 'NORMAL',
          },
        })
      ).lot_id;
    const iqc = async (suffix: string, lotId: bigint, requestedAt: string) =>
      (
        await prisma.inspection_request.create({
          data: {
            inspection_request_no: `${PREFIX}-IRQ-${suffix}`, inspection_type_code: 'IQC', target_type_code: 'LOT', target_id: lotId,
            item_id: ids.item, lot_id: lotId, target_qty: 10, uom_id: ids.uom, status_code: 'COMPLETED', requested_at: new Date(requestedAt),
          },
        })
      ).inspection_request_id;
    const result = async (no: string, requestId: bigint, round: number, at: string, accepted: number, previous: bigint | null = null) =>
      (
        await prisma.inspection_result.create({
          data: {
            inspection_result_no: no, inspection_request_id: requestId, inspection_round: round, inspected_qty: 10,
            accepted_qty: accepted, rejected_qty: 10 - accepted, held_qty: 0, uom_id: ids.uom,
            overall_judgment_code: accepted === 10 ? 'ACCEPTED' : 'REJECTED', inspector_id: ids.worker,
            inspected_at: new Date(at), confirmed_at: new Date(at), status_code: 'CONFIRMED', previous_result_id: previous, idempotency_key: no,
          },
        })
      ).inspection_result_id;

    ids.lotA = await lot('A');
    ids.lotB = await lot('B');
    const requestA = await iqc('A', ids.lotA, '2025-12-20T01:00:00Z');
    const first = await result(`${PREFIX}-A-1`, requestA, 1, '2025-12-20T02:00:00Z', 6);
    await result(`${PREFIX}-A-2`, requestA, 2, '2026-01-05T02:00:00Z', 10, first);
    ids.resultB = await result(`${PREFIX}-B-1`, await iqc('B', ids.lotB, '2026-02-01T01:00:00Z'), 1, '2026-02-01T02:00:00Z', 10);
  }

  async function cleanup(): Promise<void> {
    await prisma.inspection_result.updateMany({ where: { inspection_result_no: { startsWith: PREFIX } }, data: { previous_result_id: null } });
    await prisma.inspection_result.deleteMany({ where: { inspection_result_no: { startsWith: PREFIX } } });
    await prisma.inspection_request.deleteMany({ where: { inspection_request_no: { startsWith: PREFIX } } });
    await prisma.lot.deleteMany({ where: { lot_no: { startsWith: PREFIX } } });
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
