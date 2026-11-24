/**
 * 피처 015 번호 풀기 — GET /trace/trace-starts (contracts §2 · FR-004·007·016·023 · R-5·R-6).
 *
 * 계보 사슬(quickstart 「준비」, 2026-09-10)에 더해:
 * - 입하 LOT IL-1 에 A 말고 A2 도 직접 든다(분할 A-S1 은 빠진다).
 * - 공급사 LOT SUP-A: A(새 칸 lot_external_identifier) + 옛 입하 줄의 LEGA.
 * - 같은 글자 DUP: LOT 번호이자 입하 LOT 번호. BIG: 관리 LOT 201개가 든 입하 LOT.
 * - 출하 SH-M(C1·C2), 피킹만 된 SH-U, 다른 공장 LOT.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { Body, ChainIds, TraceTreeFixture, conformsTo, dropTraceUser, traceLogin } from './support/trace-tree-fixture';

const PREFIX = 'TSTE2E';
const DAY = '2026-09-10';
const USERS = { both: `${PREFIX}-both`, material: `${PREFIX}-material`, product: `${PREFIX}-product`, none: `${PREFIX}-none` };
const at = TraceTreeFixture.at;

describe('피처 015 번호 풀기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: TraceTreeFixture;
  let chain: ChainIds;
  const cookies = {} as Record<keyof typeof USERS, string[]>;
  const ids: Record<string, bigint> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new TraceTreeFixture(prisma, PREFIX);
    await fx.cleanup();
    await fx.setup();
    chain = await fx.chain(DAY);
    await extras();
    cookies.both = await traceLogin(app, prisma, USERS.both, ['W-02-13', 'W-02-14']);
    cookies.material = await traceLogin(app, prisma, USERS.material, ['W-02-13']);
    cookies.product = await traceLogin(app, prisma, USERS.product, ['W-02-14']);
    cookies.none = await traceLogin(app, prisma, USERS.none, ['W-02-09']);
  }, 120_000);

  afterAll(async () => {
    await fx.cleanup();
    for (const loginId of Object.values(USERS)) await dropTraceUser(prisma, loginId);
    await app.close();
  });

  const starts = (direction: 'FORWARD' | 'BACKWARD', q: string, who: keyof typeof USERS = 'both') =>
    request(app.getHttpServer()).get('/api/trace/trace-starts')
      .query({ plantId: Number(fx.ids.plant), direction, q }).set('Cookie', cookies[who]);
  const resolve = async (direction: 'FORWARD' | 'BACKWARD', q: string) => {
    const body = (await starts(direction, q).expect(200)).body as Body;
    conformsTo('/trace/trace-starts', 'get', body);
    return body.matches as Body[];
  };
  const lotNos = (match: Body) => (match.lots as Body[]).map((row) => (row.lot.lotNo as string).replace(`${PREFIX}-`, ''));

  describe('정방향(FORWARD)', () => {
    it('US1-1 Q3 자재 LOT 번호 → MATERIAL_LOT_NO, 줄 하나(공급사·입하 LOT·마지막 투입)', async () => {
      const matches = await resolve('FORWARD', `  ${fx.no('A')} `);

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ matchedBy: 'MATERIAL_LOT_NO', label: fx.no('A'), serialNo: null, otherDirection: false, truncated: false });
      expect(matches[0].lots).toEqual([{
        lot: { lotId: Number(chain.a), lotNo: fx.no('A'), lotTypeCode: 'MATERIAL', statusCode: 'NORMAL', lifecycleStatusCode: 'ACTIVE' },
        item: { itemId: Number(fx.ids.mat), code: `${PREFIX}-MAT`, name: '추적MAT' }, qty: 100, uomCode: expect.any(String),
        partner: { partnerId: Number(fx.ids.supplierS), code: `${PREFIX}-SUP-S`, name: '추적SUP-S' }, inboundLotNo: fx.no('IL-1'),
        sortDate: at(DAY, 8).toISOString(), sortDateKind: 'CONSUMED',
      }]);
    });

    it('US1-3 분할 LOT 줄은 원래 LOT 의 공급사·입하 LOT 을 싣는다', async () => {
      const [match] = await resolve('FORWARD', fx.no('A-S1'));
      expect(match.lots[0]).toMatchObject({ partner: { code: `${PREFIX}-SUP-S` }, inboundLotNo: fx.no('IL-1'), sortDate: at(DAY, 14).toISOString() });
    });

    it('US3-4 Q6 입하 LOT 번호 → 직접 든 관리 LOT 들(분할 자손 빼고)', async () => {
      const [match] = await resolve('FORWARD', fx.no('IL-1'));
      expect(match).toMatchObject({ matchedBy: 'INBOUND_LOT_NO', label: fx.no('IL-1'), otherDirection: false });
      expect(lotNos(match).sort()).toEqual(['A', 'A2']);
    });

    it('US3-4 Q6 공급사 LOT 번호 → 새 칸(lot_external_identifier)과 옛 입하 줄 둘 다', async () => {
      const [match] = await resolve('FORWARD', fx.no('SUP-A'));
      expect(match).toMatchObject({ matchedBy: 'SUPPLIER_LOT_NO', label: fx.no('SUP-A') });
      expect(lotNos(match).sort()).toEqual(['A', 'LEGA']);
      const legacy = (match.lots as Body[]).find((row) => row.lot.lotNo === fx.no('LEGA'));
      expect(legacy).toMatchObject({ partner: { code: `${PREFIX}-SUP-S` }, inboundLotNo: null, sortDate: null, sortDateKind: null });
    });

    it('US3-4 같은 글자가 여러 종류에 맞으면 모두 준다 — matchedBy 순서대로', async () => {
      const matches = await resolve('FORWARD', fx.no('DUP'));
      expect(matches.map((match) => [match.matchedBy, lotNos(match)])).toEqual([['MATERIAL_LOT_NO', ['DUP']], ['INBOUND_LOT_NO', ['DUPX']]]);
    });

    it('US3-4 200개 넘는 묶음은 앞 200개와 truncated', async () => {
      const [match] = await resolve('FORWARD', fx.no('IL-BIG'));
      expect(match.truncated).toBe(true);
      expect(match.lots).toHaveLength(200);
    });

    it('경계-반대 방향 Q13 완제품·분리 자식 LOT 은 otherDirection, 반제품 P1 은 아니다', async () => {
      expect((await resolve('FORWARD', fx.no('P3')))[0]).toMatchObject({ matchedBy: 'MATERIAL_LOT_NO', otherDirection: true });
      expect((await resolve('FORWARD', fx.no('P4-S1')))[0]).toMatchObject({ otherDirection: true });
      expect((await resolve('FORWARD', fx.no('P1')))[0]).toMatchObject({ otherDirection: false });
    });
  });

  describe('역방향(BACKWARD)', () => {
    it('US2-1 Q10 제품 LOT 번호 → PRODUCT_LOT_NO, 줄에 마지막 출하의 고객·출하일', async () => {
      const [match] = await resolve('BACKWARD', fx.no('P3'));
      expect(match).toMatchObject({ matchedBy: 'PRODUCT_LOT_NO', otherDirection: false });
      expect(match.lots[0]).toMatchObject({
        lot: { lotId: Number(chain.p3), lotTypeCode: 'PRODUCTION' }, partner: { partnerId: Number(fx.ids.customerX) }, inboundLotNo: null,
        sortDate: at(DAY, 12).toISOString(), sortDateKind: 'SHIPPED',
      });
      const [p2] = await resolve('BACKWARD', fx.no('P2'));
      expect(p2.lots[0]).toMatchObject({ partner: null, sortDate: at(DAY, 9, 40).toISOString(), sortDateKind: 'RECEIVED' });
    });

    it('US2-2 Q10 출하번호 → 배분 LOT 들, 피킹만 된 출하는 없다', async () => {
      const [one] = await resolve('BACKWARD', fx.no('SH-1'));
      expect(one).toMatchObject({ matchedBy: 'SHIPMENT_NO', label: fx.no('SH-1') });
      expect(lotNos(one)).toEqual(['P3']);
      const [many] = await resolve('BACKWARD', fx.no('SH-M'));
      expect(lotNos(many).sort()).toEqual(['C1', 'C2']);
      expect(await resolve('BACKWARD', fx.no('SH-U'))).toEqual([]);
    });

    it('US2-3 Q10 시리얼 → 그 생산 LOT 하나 + serialNo', async () => {
      const [match] = await resolve('BACKWARD', fx.no('SN-1'));
      expect(match).toMatchObject({ matchedBy: 'SERIAL_NO', label: fx.no('SN-1'), serialNo: fx.no('SN-1') });
      expect(lotNos(match)).toEqual(['P3']);
    });

    it('경계-반대 방향 Q13 자재 LOT·분할 자재 LOT 은 otherDirection, 반제품 P1 은 아니다', async () => {
      expect((await resolve('BACKWARD', fx.no('A')))[0]).toMatchObject({ matchedBy: 'PRODUCT_LOT_NO', otherDirection: true });
      expect((await resolve('BACKWARD', fx.no('A-S1')))[0]).toMatchObject({ otherDirection: true });
      const [semi] = await resolve('BACKWARD', fx.no('P1'));
      expect(semi).toMatchObject({ otherDirection: false });
      expect(semi.lots[0]).toMatchObject({ sortDate: null, sortDateKind: null });
    });
  });

  describe('경계', () => {
    it('경계-없는 번호 Q14 없는 번호·다른 공장 번호는 matches 가 비어 있다', async () => {
      expect(await resolve('FORWARD', fx.no('NOPE'))).toEqual([]);
      expect(await resolve('FORWARD', fx.no('OTHA'))).toEqual([]);
      expect(await resolve('BACKWARD', fx.no('OTHA'))).toEqual([]);
    });

    it('US3-4 direction·q 가 없거나 direction 이 틀리면 400', async () => {
      const base = { plantId: Number(fx.ids.plant) };
      for (const query of [{ ...base, q: 'X' }, { ...base, direction: 'FORWARD' }, { ...base, direction: 'SIDEWAYS', q: 'X' }]) {
        await request(app.getHttpServer()).get('/api/trace/trace-starts').query(query).set('Cookie', cookies.both).expect(400);
      }
    });

    it('US3-4 권한 — FORWARD 는 W-02-13, BACKWARD 는 W-02-14 가 없으면 403, 둘 다 없으면 403', async () => {
      await starts('FORWARD', fx.no('A'), 'material').expect(200);
      await starts('BACKWARD', fx.no('P3'), 'material').expect(403);
      await starts('BACKWARD', fx.no('P3'), 'product').expect(200);
      await starts('FORWARD', fx.no('A'), 'product').expect(403);
      await starts('FORWARD', fx.no('A'), 'none').expect(403);
    });
  });

  async function extras(): Promise<void> {
    ids.a2 = await fx.lot('A2', fx.ids.mat, { inboundLotId: chain.il1 });
    const legacy = await fx.lot('LEGA', fx.ids.mat, { source: 'INBOUND_RECEIPT_LINE' });
    await fx.legacyInbound('LEGA', legacy, fx.ids.mat, fx.ids.supplierS, at(DAY, 6), fx.no('SUP-A'));
    await fx.lot('DUP', fx.ids.mat);
    const dup = await fx.inboundLot('DUP', fx.ids.mat, fx.ids.supplierS, DAY, at(DAY, 6));
    await fx.lot('DUPX', fx.ids.mat, { inboundLotId: dup });
    const big = await fx.inboundLot('IL-BIG', fx.ids.mat, fx.ids.supplierS, DAY, at(DAY, 6));
    await prisma.lot.createMany({ data: Array.from({ length: 201 }, (_, i) => ({
      lot_no: fx.no(`BIG-${String(i).padStart(3, '0')}`), item_id: fx.ids.mat, lot_type_code: 'MATERIAL', plant_id: fx.ids.plant, initial_qty: 1,
      uom_id: fx.ids.uom, source_type_code: 'MATERIAL_LOT_BATCH', source_id: 1n, status_code: 'NORMAL', inbound_lot_id: big,
    })) });
    const wo = await fx.workOrder('EXTRA', fx.ids.fg);
    const c1 = await fx.productionLot('C1', fx.ids.fg, wo);
    const c2 = await fx.productionLot('C2', fx.ids.fg, wo);
    await fx.ship('SH-M', fx.ids.customerX, at(DAY, 18), [{ lot: c1, qty: 1 }, { lot: c2, qty: 1 }]);
    await fx.ship('SH-U', fx.ids.customerX, at(DAY, 19), [{ lot: c1, qty: 1 }], 'UNCONFIRMED');
    await fx.lot('OTHA', fx.ids.mat, { plant: fx.ids.otherPlant });
  }
});
