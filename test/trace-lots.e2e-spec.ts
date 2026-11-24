/**
 * 피처 015 LOT 목록 — GET /trace/material-trace-lots · GET /trace/product-trace-lots (contracts §1 · FR-013·021·025 · R-12).
 *
 * 자기 공장에 목록 시험용 LOT 을 쌓는다(quickstart 「준비」 목록 시험용).
 * - 자재 LM000~LM119: 2026-10-01 부터 1분 간격으로 투입(LM050 은 반제품 생산 LOT). 정정된 투입·다른 공장 LOT 은 빠져야 한다.
 * - 제품 LP000~LP119: 짝수는 출하(고객 X), 홀수는 생산 입고만. 짝수는 더 늦은 입고도 있지만 출하일이 기준이다.
 * - 공급사 S 입하 LOT 150개(2026-08-01~08-30, 하루 5개) + 공급사 T·기간 밖·옛 입하 LOT.
 * - 고객 X 출하: 계보 사슬의 SH-1(09-10) + SHX-1(09-20: C1·C2) + SHX-2(09-21: C2·C3), 취소·기간 밖·고객 Y 는 빠진다.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { Body, ChainIds, TraceTreeFixture, conformsTo, dropTraceUser, traceLogin } from './support/trace-tree-fixture';

const PREFIX = 'TLSE2E';
const USERS = { both: `${PREFIX}-both`, material: `${PREFIX}-material`, product: `${PREFIX}-product` };
const at = TraceTreeFixture.at;
const pad = (i: number) => String(i).padStart(3, '0');
const minutes = (base: Date, n: number) => new Date(base.getTime() + n * 60_000);

describe('피처 015 LOT 목록 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: TraceTreeFixture;
  let chain: ChainIds;
  const cookies: Record<keyof typeof USERS, string[]> = { both: [], material: [], product: [] };
  const lots: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new TraceTreeFixture(prisma, PREFIX);
    await fx.cleanup();
    await fx.setup();
    chain = await fx.chain('2026-09-10');
    await materialLots();
    await productLots();
    await supplierLots();
    await customerShipments();
    cookies.both = await traceLogin(app, prisma, USERS.both, ['W-02-13', 'W-02-14']);
    cookies.material = await traceLogin(app, prisma, USERS.material, ['W-02-13']);
    cookies.product = await traceLogin(app, prisma, USERS.product, ['W-02-14']);
  }, 180_000);

  afterAll(async () => {
    await fx.cleanup();
    for (const loginId of Object.values(USERS)) await dropTraceUser(prisma, loginId);
    await app.close();
  });

  const get = (path: string, query: Record<string, string | number>, who: keyof typeof USERS = 'both') =>
    request(app.getHttpServer()).get(`/api/trace/${path}`).query({ plantId: Number(fx.ids.plant), ...query }).set('Cookie', cookies[who]);
  const nos = (body: Body) => (body.items as Body[]).map((row) => (row.lot.lotNo as string).replace(`${PREFIX}-`, ''));

  describe('자재 기준 GET /trace/material-trace-lots', () => {
    it('US3-1 Q1 최근 — 마지막 투입 시각 내림차순 100개, 정정된 투입·다른 공장은 빠지고 반제품도 투입되면 들어간다', async () => {
      const started = Date.now();
      const body = (await get('material-trace-lots', {}).expect(200)).body as Body;
      const elapsed = Date.now() - started;

      conformsTo('/trace/material-trace-lots', 'get', body);
      expect(body.mode).toBe('RECENT');
      expect(nos(body)).toEqual(Array.from({ length: 100 }, (_, i) => `LM${pad(119 - i)}`));
      expect(body.page).toEqual({ page: 1, size: 100, total: 100 });
      const first = (body.items as Body[])[0];
      expect(first).toMatchObject({
        lot: { lotId: Number(lots.LM119), lotTypeCode: 'MATERIAL', statusCode: 'NORMAL', lifecycleStatusCode: 'ACTIVE' },
        item: { itemId: Number(fx.ids.mat), code: `${PREFIX}-MAT` }, qty: 100, partner: null, inboundLotNo: null,
        sortDate: minutes(at('2026-10-01', 8), 119).toISOString(), sortDateKind: 'CONSUMED',
      });
      expect((body.items as Body[]).find((row) => row.lot.lotNo === `${PREFIX}-LM050`)?.lot.lotTypeCode).toBe('PRODUCTION');
      // Q23 SC-002 최근 목록 응답 시간 — 목표 2초.
      // eslint-disable-next-line no-console -- 응답 시간 기록(verification SC-002 · Q23)
      console.log(`[Q23] material-trace-lots 최근 ${elapsed}ms`);
      expect(elapsed).toBeLessThan(2000);
    });

    it('US3-1 Q1 최근 목록에는 정정된 투입만 늦은 LOT·다른 공장 LOT·투입 없는 LOT 이 없다', async () => {
      const body = (await get('material-trace-lots', {}).expect(200)).body as Body;
      for (const absent of ['MCORR', 'OTHER', 'MNONE']) expect(nos(body)).not.toContain(absent);
    });

    it('US3-5 Q7 공급사 S + 기간 — 입하일 내림차순 100개·전체 150, 다음 쪽 50, 고른 것 없음', async () => {
      const query = { partnerId: Number(fx.ids.supplierS), dateFrom: '2026-08-01', dateTo: '2026-08-31' };
      const first = (await get('material-trace-lots', query).expect(200)).body as Body;

      conformsTo('/trace/material-trace-lots', 'get', first);
      expect(first.mode).toBe('CONDITION');
      expect(first.page).toEqual({ page: 1, size: 100, total: 150 });
      expect(nos(first)).toEqual(Array.from({ length: 100 }, (_, i) => `LS${pad(149 - i)}`));
      expect((first.items as Body[])[0]).toMatchObject({
        partner: { partnerId: Number(fx.ids.supplierS), code: `${PREFIX}-SUP-S` }, inboundLotNo: `${PREFIX}-IL-S149`,
        sortDate: minutes(at('2026-08-30', 8), 4).toISOString(), sortDateKind: 'INBOUND',
      });

      const second = (await get('material-trace-lots', { ...query, page: 2 }).expect(200)).body as Body;
      expect(second.page).toEqual({ page: 2, size: 100, total: 150 });
      expect(nos(second)).toEqual(Array.from({ length: 50 }, (_, i) => `LS${pad(49 - i)}`));
    });

    it('US3-5 공급사 조건의 입하일은 입하 LOT 입하일, 없으면(옛 입하) 첫 자재 입고일이다', async () => {
      const body = (await get('material-trace-lots', { partnerId: Number(fx.ids.supplierS), dateFrom: '2026-07-01', dateTo: '2026-07-31' }).expect(200)).body as Body;
      expect(nos(body)).toEqual(['LOUT', 'LLEG']);
      expect((body.items as Body[])[1]).toMatchObject({ partner: { code: `${PREFIX}-SUP-S` }, inboundLotNo: null, sortDateKind: 'INBOUND',
        sortDate: at('2026-07-15', 9).toISOString() });
    });

    it('US3-5 조건 일부만·기간 역전·366일 초과는 400', async () => {
      const supplier = Number(fx.ids.supplierS);
      for (const query of [
        { partnerId: supplier }, { dateFrom: '2026-08-01', dateTo: '2026-08-31' }, { partnerId: supplier, dateFrom: '2026-08-01' },
        { partnerId: supplier, dateFrom: '2026-08-31', dateTo: '2026-08-01' }, { partnerId: supplier, dateFrom: '2025-01-01', dateTo: '2026-08-31' },
      ] as Record<string, string | number>[]) {
        const response = await get('material-trace-lots', query).expect(400);
        expect(response.body.errors[0]).toMatchObject({ scope: 'field' });
      }
    });

    it('US3-1 plantId 가 없으면 400 이다', async () => {
      await request(app.getHttpServer()).get('/api/trace/material-trace-lots').set('Cookie', cookies.both).expect(400);
    });

    it('US3-1 W-02-13 이 없으면 403 이다', async () => {
      await get('material-trace-lots', {}, 'product').expect(403);
    });
  });

  describe('제품 기준 GET /trace/product-trace-lots', () => {
    it('US3-2 Q2 최근 — LOT 마다 마지막 출하일, 없으면 입고일 하나로 섞인 내림차순 100개, 취소 출하·출하도 입고도 없는 LOT 은 없다', async () => {
      const started = Date.now();
      const body = (await get('product-trace-lots', {}).expect(200)).body as Body;
      const elapsed = Date.now() - started;

      conformsTo('/trace/product-trace-lots', 'get', body);
      expect(body.mode).toBe('RECENT');
      expect(nos(body)).toEqual(Array.from({ length: 100 }, (_, i) => `LP${pad(119 - i)}`));
      const rows = body.items as Body[];
      expect(rows[0]).toMatchObject({ sortDateKind: 'RECEIVED', partner: null, sortDate: minutes(at('2026-10-02', 8), 119).toISOString() });
      expect(rows[1]).toMatchObject({ sortDateKind: 'SHIPPED', partner: { code: `${PREFIX}-CUS-X` }, sortDate: minutes(at('2026-10-02', 8), 118).toISOString() });
      expect(nos(body)).not.toContain('LPCX');
      // eslint-disable-next-line no-console -- 응답 시간 기록(verification SC-002 · Q23)
      console.log(`[Q23] product-trace-lots 최근 ${elapsed}ms`);
      expect(elapsed).toBeLessThan(2000);
    });

    it('US3-6 Q11 고객 X + 기간 — 출하 완료분의 배분 제품 LOT, 같은 LOT 은 한 줄(기간 안 마지막 출하일)', async () => {
      const body = (await get('product-trace-lots', { partnerId: Number(fx.ids.customerX), dateFrom: '2026-09-01', dateTo: '2026-09-30' }).expect(200)).body as Body;

      conformsTo('/trace/product-trace-lots', 'get', body);
      expect(body.mode).toBe('CONDITION');
      expect(nos(body)).toEqual(['C3', 'C2', 'C1', 'P3']);
      expect(body.page).toEqual({ page: 1, size: 100, total: 4 });
      expect((body.items as Body[])[1]).toMatchObject({ sortDateKind: 'SHIPPED', sortDate: at('2026-09-21').toISOString(), partner: { code: `${PREFIX}-CUS-X` } });
    });

    it('US3-2 경계-없는 번호 다른 공장 LOT 은 나오지 않는다', async () => {
      const body = (await get('product-trace-lots', {}).expect(200)).body as Body;
      expect(nos(body)).not.toContain('OTHERP');
    });

    it('US3-6 기간 역전은 400, W-02-14 가 없으면 403 이다', async () => {
      await get('product-trace-lots', { partnerId: Number(fx.ids.customerX), dateFrom: '2026-09-30', dateTo: '2026-09-01' }).expect(400);
      await get('product-trace-lots', {}, 'material').expect(403);
    });
  });

  async function materialLots(): Promise<void> {
    const wo = await fx.workOrder('LIST-M', fx.ids.fg);
    const semiWo = await fx.workOrder('LIST-S', fx.ids.semi);
    const base = at('2026-10-01', 8);
    for (let i = 0; i < 120; i += 1) {
      lots[`LM${pad(i)}`] = i === 50 ? await fx.productionLot(`LM${pad(i)}`, fx.ids.semi, semiWo) : await fx.lot(`LM${pad(i)}`, fx.ids.mat);
      await fx.consume(wo, lots[`LM${pad(i)}`], 1, minutes(base, i));
    }
    // 정정된 원 투입은 가장 늦지만 빠진다 — 정정 투입(오래전)만 남는다.
    const corrected = await fx.lot('MCORR', fx.ids.mat);
    const original = await fx.consume(wo, corrected, 1, at('2026-10-05'));
    await fx.consume(wo, corrected, 1, at('2026-09-02'), original);
    const other = await fx.lot('OTHER', fx.ids.mat, { plant: fx.ids.otherPlant });
    await fx.consume(wo, other, 1, at('2026-10-06'));
    await fx.lot('MNONE', fx.ids.mat);
  }

  async function productLots(): Promise<void> {
    const wo = await fx.workOrder('LIST-P', fx.ids.fg);
    const base = at('2026-10-02', 8);
    for (let i = 0; i < 120; i += 1) {
      const lot = await fx.productionLot(`LP${pad(i)}`, fx.ids.fg, wo);
      if (i % 2 === 0) {
        await fx.ship(`SHL-${pad(i)}`, fx.ids.customerX, minutes(base, i), [{ lot, qty: 1 }]);
        // 출하된 LOT 의 늦은 입고 — 기준은 그래도 출하일이다.
        await fx.receive('PRODUCT', lot, 1, at('2026-10-20'));
      } else {
        await fx.receive('PRODUCT', lot, 1, minutes(base, i));
      }
    }
    const cancelled = await fx.productionLot('LPCX', fx.ids.fg, wo);
    await fx.ship('SHL-CX', fx.ids.customerX, at('2026-10-30'), [{ lot: cancelled, qty: 1 }], 'CANCELLED');
    const other = await fx.productionLot('OTHERP', fx.ids.fg, wo, fx.ids.otherPlant);
    await fx.receive('PRODUCT', other, 1, at('2026-10-31'));
  }

  async function supplierLots(): Promise<void> {
    for (let i = 0; i < 150; i += 1) {
      const day = `2026-08-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`;
      const inbound = await fx.inboundLot(`IL-S${pad(i)}`, fx.ids.mat, fx.ids.supplierS, day, minutes(at(day, 8), i % 5));
      lots[`LS${pad(i)}`] = await fx.lot(`LS${pad(i)}`, fx.ids.mat, { inboundLotId: inbound });
    }
    const otherSupplier = await fx.inboundLot('IL-T', fx.ids.mat, fx.ids.supplierT, '2026-08-10', at('2026-08-10'));
    await fx.lot('LT', fx.ids.mat, { inboundLotId: otherSupplier });
    const outside = await fx.inboundLot('IL-OUT', fx.ids.mat, fx.ids.supplierS, '2026-07-31', at('2026-07-31'));
    await fx.lot('LOUT', fx.ids.mat, { inboundLotId: outside });
    // 옛 입하(005 이전) — 입하 LOT 이 없고 입하 줄이 LOT 을 직접 잇는다. 입하일은 첫 자재 입고일.
    const legacy = await fx.lot('LLEG', fx.ids.mat, { source: 'INBOUND_RECEIPT_LINE' });
    await fx.legacyInbound('LEG', legacy, fx.ids.mat, fx.ids.supplierS, at('2026-07-14'), 'SUP-LEG');
    await fx.receive('MATERIAL', legacy, 100, at('2026-07-15', 9));
    await fx.receive('MATERIAL', legacy, 100, at('2026-07-16', 9));
  }

  async function customerShipments(): Promise<void> {
    const wo = await fx.workOrder('LIST-C', fx.ids.fg);
    const c1 = await fx.productionLot('C1', fx.ids.fg, wo);
    const c2 = await fx.productionLot('C2', fx.ids.fg, wo);
    const c3 = await fx.productionLot('C3', fx.ids.fg, wo);
    await fx.ship('SHX-1', fx.ids.customerX, at('2026-09-20'), [{ lot: c1, qty: 1 }, { lot: c2, qty: 1 }]);
    await fx.ship('SHX-2', fx.ids.customerX, at('2026-09-21'), [{ lot: c2, qty: 1 }, { lot: c3, qty: 1 }]);
    await fx.ship('SHX-CX', fx.ids.customerX, at('2026-09-22'), [{ lot: c1, qty: 1 }], 'CANCELLED');
    await fx.ship('SHX-LATE', fx.ids.customerX, at('2026-10-01'), [{ lot: c3, qty: 1 }]);
    expect(chain.sh1).toBeDefined();
  }
});
