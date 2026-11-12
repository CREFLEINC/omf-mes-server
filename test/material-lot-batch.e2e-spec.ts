/**
 * 피처 005 S3 — 자재 관리 LOT 발행 묶음·대기 목록·폐기·라벨·대기 LOT 쓰기 거절(omf-all-around#254 · T017).
 * POP(P-01-01)은 단말 토큰 + 작업자, 웹(W-01-14)은 세션 계정으로 부른다.
 */
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { SESSION_COOKIE } from '../src/auth/session-cookie';
import { TOKEN_TYPE } from '../src/auth/session-resolver.service';
import { PERMISSIONS } from '../src/common/permissions/permissions';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = 'E5MB';
const DAY = '2026-11-12';
const BATCHES = '/api/logistics/material-lot-batches';
const WAITING_LOTS = '/api/logistics/waiting-material-lots';
const VOID = '/api/trace/lots:void';
const ISSUES = '/api/app/document-issues';

const key = (): string => randomUUID();

interface LotSummary {
  lotId: number;
  lotNo: string;
  lotQty: number;
  package: { uomId: number; uomCode: string; uomName: string; count: number; qtyPerPackage: number } | null;
  supplierLotNo: string | null;
  lifecycleStatusCode: string;
  statusCode: string;
  inboundLotId: number | null;
  inboundLotNo: string | null;
  lastLabelIssue: { issueSeq: number; issuedAt: string } | null;
  createdChannelCode: string;
}

describe('피처 005 S3 — 자재 관리 LOT 발행 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let cookie: string;
  let narrowCookie: string;
  let popToken: string;
  let foreignPopToken: string;
  let mobileToken: string;
  const ids: Record<string, bigint> = {};
  let terminalSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await cleanup();
    await makeMasters();
    cookie = await makeUser('ALL', PERMISSIONS.map((permission) => permission.code));
    narrowCookie = await makeUser('NARROW', ['W-01-01']);
    popToken = await terminalToken(ids.plant, 'POP');
    foreignPopToken = await terminalToken(ids.foreignPlant, 'POP');
    mobileToken = await terminalToken(ids.plant, 'MOBILE');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    plantId: Number(ids.plant), supplierId: Number(ids.supplier), itemId: Number(ids.item),
    lotQty: 1000, package: { uomId: Number(ids.box), count: 10, qtyPerPackage: 100 },
    lotCount: 3, businessDate: DAY, occurredAt: `${DAY}T02:00:00.000Z`, ...overrides,
  });

  it('US1-2 POP 이 개수 3 으로 만들면 1,000 짜리 자재 관리 LOT 3개가 대기·각자 번호·입하 LOT 없음·재고 변화 없음이다', async () => {
    const balancesBefore = await prisma.inventory_balance.count({ where: { item_id: ids.item } });
    const response = await popPost(BATCHES).send(body()).expect(201);
    const lots = response.body.lots as LotSummary[];

    expect(lots).toHaveLength(3);
    expect(new Set(lots.map((lot) => lot.lotNo)).size).toBe(3);
    expect(lots.map((lot) => lot.lotNo)).toEqual([1, 2, 3].map((n) => `${PREFIX}-A|1000|261112|${PREFIX}-S|000${String(n)}`));
    for (const lot of lots) {
      expect(lot).toMatchObject({
        lotQty: 1000, lifecycleStatusCode: 'WAITING', statusCode: 'INSPECTION_PENDING', inboundLotId: null, inboundLotNo: null,
        package: { uomId: Number(ids.box), uomCode: 'BOX', count: 10, qtyPerPackage: 100 }, createdChannelCode: 'POP',
        lastLabelIssue: null, supplierLotNo: null,
      });
    }
    const rows = await prisma.lot.findMany({ where: { lot_id: { in: lots.map((lot) => BigInt(lot.lotId)) } }, include: { lot_hold: true } });
    expect(rows.every((row) => row.uom_id === ids.ea && row.source_type_code === 'MATERIAL_LOT_BATCH'
      && row.source_id === BigInt(response.body.batchId) && row.lot_hold.length === 0 && row.inbound_lot_id === null)).toBe(true);
    expect(await prisma.inspection_request.count({ where: { lot_id: { in: rows.map((row) => row.lot_id) } } })).toBe(0);
    expect(await prisma.inventory_balance.count({ where: { item_id: ids.item } })).toBe(balancesBefore);
    const batch = await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: BigInt(response.body.batchId) } });
    expect(batch).toMatchObject({ created_channel_code: 'POP', created_worker_id: ids.worker, created_by: null, lot_count: 3 });

    // Lot 응답(T024)에도 패키징·입하 LOT 칸이 실린다.
    const detail = await get(`/api/trace/lots/${String(lots[0].lotId)}`).expect(200);
    expect(detail.body.lot).toMatchObject({
      lifecycleStatusCode: 'WAITING', inboundLotId: null, inboundLotNo: null,
      package: { uomId: Number(ids.box), uomCode: 'BOX', count: 10, qtyPerPackage: 100 },
    });
    // 패키징 단위 이름(표시용 · G1 잔여) — 발행 응답·Lot 응답 모두.
    const box = await prisma.uom.findUniqueOrThrow({ where: { uom_id: ids.box }, select: { uom_name: true } });
    expect(lots.map((lot) => lot.package?.uomName)).toEqual([box.uom_name, box.uom_name, box.uom_name]);
    expect(detail.body.lot.package.uomName).toBe(box.uom_name);
  });

  it('US1-3 패키징 없이 1 × 5 — 단위는 품목 기본 단위(KG), 패키징 null', async () => {
    const response = await webPost(BATCHES).send(body({ itemId: Number(ids.resin), lotQty: 1, package: null, lotCount: 5 })).expect(201);
    const lots = response.body.lots as LotSummary[];

    expect(lots).toHaveLength(5);
    expect(lots.every((lot) => lot.package === null && lot.lotQty === 1)).toBe(true);
    const rows = await prisma.lot.findMany({ where: { lot_id: { in: lots.map((lot) => BigInt(lot.lotId)) } } });
    expect(rows.every((row) => row.uom_id === ids.kg && row.package_uom_id === null)).toBe(true);
  });

  it('US1-5 공급사 LOT SL-77 → 만든 3개 모두 SL-77', async () => {
    const response = await popPost(BATCHES).send(body({ supplierLotNo: 'SL-77' })).expect(201);
    const lots = response.body.lots as LotSummary[];

    expect(lots.map((lot) => lot.supplierLotNo)).toEqual(['SL-77', 'SL-77', 'SL-77']);
    const identifiers = await prisma.lot_external_identifier.findMany({
      where: { lot_id: { in: lots.map((lot) => BigInt(lot.lotId)) }, identifier_type_code: 'SUPPLIER_LOT' },
    });
    expect(identifiers.map((row) => [row.external_identifier, row.partner_id])).toEqual(Array.from({ length: 3 }, () => ['SL-77', ids.supplier]));
  });

  it('US1-8 웹(W-01-14 세션)도 같은 결과이고 채널은 WEB·만든 사람은 계정이다', async () => {
    const response = await webPost(BATCHES).send(body({ lotCount: 2 })).expect(201);
    const lots = response.body.lots as LotSummary[];

    expect(lots.every((lot) => lot.lifecycleStatusCode === 'WAITING' && lot.createdChannelCode === 'WEB')).toBe(true);
    const batch = await prisma.material_lot_batch.findUniqueOrThrow({ where: { material_lot_batch_id: BigInt(response.body.batchId) } });
    expect(batch).toMatchObject({ created_channel_code: 'WEB', created_by: ids.user, created_worker_id: null });
  });

  it('400 RANGE(수량 ≤0 · 개수 0 · 201)·INVALID(패키징 곱 950 · 기본 단위 아님) — 아무것도 만들지 않는다', async () => {
    const before = await prisma.material_lot_batch.count({ where: { plant_id: ids.plant } });
    const code = async (overrides: Record<string, unknown>) =>
      ((await webPost(BATCHES).send(body(overrides)).expect(400)).body.errors as { code: string }[]).map((error) => error.code);

    expect(await code({ lotQty: 0, package: null })).toContain('RANGE');
    expect(await code({ lotQty: -1, package: null })).toContain('RANGE');
    expect(await code({ lotCount: 0 })).toContain('RANGE');
    expect(await code({ lotCount: 201 })).toContain('RANGE');
    expect(await code({ lotQty: 950 })).toEqual(['INVALID']);
    expect(await code({ uomId: Number(ids.kg) })).toEqual(['INVALID']);
    expect(await prisma.material_lot_batch.count({ where: { plant_id: ids.plant } })).toBe(before);
  });

  describe('대기 LOT 쓰기 거절·폐기·라벨', () => {
    let lots: LotSummary[];

    beforeAll(async () => {
      lots = (await webPost(BATCHES).send(body({ lotCount: 4 })).expect(201)).body.lots as LotSummary[];
    });

    it('US1-6 R3-1 대기 LOT 에 보류·부적합·특채는 「아직 입하되지 않은 LOT」, 재고를 쓰는 이동은 재고가 없어 막힌다 — 상태 변화 없음', async () => {
      const lot = lots[0];
      const before = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lot.lotId) } });
      const message = (response: request.Response): string => (response.body.errors as { message: string }[])[0].message;

      const hold = await webPost('/api/quality/lot-holds').send({
        lots: [{ lotId: lot.lotId, versionNo: before.version_no }], reasonCode: 'FOREIGN_MATTER_SUSPECTED', targetLotStatusCode: 'INSPECTION_PENDING', releaseCondition: '재검',
      }).expect(400);
      expect(message(hold)).toContain('아직 입하되지 않은 LOT');

      const nc = await webPost('/api/quality/nonconformances').send({
        itemId: Number(ids.item), severityCode: 'MAJOR', description: `${PREFIX} 대기 LOT`,
        lots: [{ lotId: lot.lotId, affectedQty: 1, uomId: Number(ids.ea) }],
      }).expect(400);
      expect(message(nc)).toContain('아직 입하되지 않은 LOT');

      // 부적합 등록이 막혀 특채까지 갈 길이 없다 — 이전 데이터처럼 부적합이 이미 있는 대기 LOT 을 직접 만든다.
      const ncRow = await prisma.nonconformance.create({ data: {
        nonconformance_no: `${PREFIX}-NC-1`, item_id: ids.item, severity_code: 'MINOR', description: `${PREFIX} 특채`,
        status_code: 'NOT_REQUESTED', opened_at: new Date(),
      } });
      await prisma.nonconformance_lot.create({ data: {
        nonconformance_id: ncRow.nonconformance_id, lot_id: BigInt(lot.lotId), affected_qty: 1, uom_id: ids.ea,
        quality_status_before_code: 'INSPECTION_PENDING', quality_status_after_code: 'INSPECTION_PENDING',
      } });
      const concession = await webPost('/api/quality/concessions').send({
        nonconformanceId: Number(ncRow.nonconformance_id), lotId: lot.lotId, approvedQty: 1, uomId: Number(ids.ea), validFrom: DAY, reason: '대기',
      }).expect(400);
      expect(message(concession)).toContain('아직 입하되지 않은 LOT');

      const move = await webPost('/api/logistics/location-moves').send({
        warehouseId: Number(ids.warehouse), businessDate: DAY, occurredAt: `${DAY}T03:00:00.000Z`,
        lines: [{ lotId: lot.lotId, fromLocationId: Number(ids.locA), toLocationId: Number(ids.locB),
          qualityStatusCode: 'INSPECTION_PENDING', inventoryStatusCode: 'AVAILABLE', qty: 1 }],
      });
      expect(move.status).toBeGreaterThanOrEqual(400);
      expect(move.status).toBeLessThan(500);

      const after = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lot.lotId) }, include: { lot_hold: true } });
      expect(after).toMatchObject({ lifecycle_status_code: 'WAITING', status_code: 'INSPECTION_PENDING', version_no: before.version_no });
      expect(after.lot_hold).toHaveLength(0);
      expect(await prisma.concession.count({ where: { lot_id: BigInt(lot.lotId) } })).toBe(0);
    });

    it('US1-4 FR-008 대기 LOT 라벨이 발행되고, 재발행은 사유가 필요하며 차수가 오른다', async () => {
      const target = { documentTypeCode: 'MATERIAL_LOT_LABEL', targets: [{ targetTypeCode: 'LOT', targetId: lots[1].lotId }] };
      const first = await webPost(ISSUES).send(target).expect(201);
      expect(first.body.items[0]).toMatchObject({ issueSeq: 1 });

      await webPost(ISSUES).send(target).expect(422);
      const again = await webPost(ISSUES).send({ ...target, reissueReasonCode: 'DAMAGED' }).expect(201);
      expect(again.body.items[0]).toMatchObject({ issueSeq: 2 });
    });

    it('US1-7 폐기 → VOIDED(L5) · 대기 아닌 LOT 은 건별 실패 · 같은 번호를 다시 매기지 않는다', async () => {
      const voided = await popPost(VOID).send({ lotIds: [lots[2].lotId, lots[3].lotId] }).expect(200);
      expect(voided.body.items).toEqual([
        { lotId: lots[2].lotId, lotNo: lots[2].lotNo, voided: true, errorCode: null },
        { lotId: lots[3].lotId, lotNo: lots[3].lotNo, voided: true, errorCode: null },
      ]);
      const history = await prisma.lot_lifecycle_history.findMany({ where: { lot_id: BigInt(lots[2].lotId) } });
      expect(history).toEqual([expect.objectContaining({ from_lifecycle_status_code: 'WAITING', to_lifecycle_status_code: 'VOIDED', transition_code: 'L5' })]);

      const repeat = await webPost(VOID).send({ lotIds: [lots[2].lotId, lots[1].lotId] }).expect(200);
      expect(repeat.body.items).toEqual([
        { lotId: lots[2].lotId, lotNo: lots[2].lotNo, voided: false, errorCode: 'STATE_LOCKED' },
        { lotId: lots[1].lotId, lotNo: lots[1].lotNo, voided: true, errorCode: null },
      ]);

      const next = (await webPost(BATCHES).send(body({ lotCount: 1 })).expect(201)).body.lots as LotSummary[];
      const used = new Set(lots.map((lot) => lot.lotNo));
      expect(used.has(next[0].lotNo)).toBe(false);
    });

    it('US1-4 폐기된 LOT 은 라벨 발행이 422 STATE_LOCKED, 보류는 「폐기된 LOT」', async () => {
      const issued = await webPost(ISSUES).send({ documentTypeCode: 'MATERIAL_LOT_LABEL', targets: [{ targetTypeCode: 'LOT', targetId: lots[2].lotId }] }).expect(422);
      expect(issued.body.errors[0]).toMatchObject({ code: 'STATE_LOCKED' });

      const row = await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lots[2].lotId) } });
      const hold = await webPost('/api/quality/lot-holds').send({
        lots: [{ lotId: lots[2].lotId, versionNo: row.version_no }], reasonCode: 'FOREIGN_MATTER_SUSPECTED', targetLotStatusCode: 'INSPECTION_PENDING', releaseCondition: '재검',
      }).expect(400);
      expect(hold.body.errors[0].message).toContain('폐기된 LOT');
    });

    it('없는 LOT 이 섞인 폐기는 400 이고 아무것도 바꾸지 않는다', async () => {
      await webPost(VOID).send({ lotIds: [lots[0].lotId, 9_000_000_000] }).expect(400);
      expect((await prisma.lot.findUniqueOrThrow({ where: { lot_id: BigInt(lots[0].lotId) } })).lifecycle_status_code).toBe('WAITING');
    });
  });

  it('FR-004 대기 목록은 공급사·품목별로 대기 수·합계·묶음·LOT 을 모으고, 묶음 목록은 hasWaiting·대기/입하/폐기 수를 낸다', async () => {
    const waiting = await get(WAITING_LOTS).query({ plantId: Number(ids.plant), supplierId: Number(ids.supplier) }).expect(200);
    const groups = waiting.body.items as {
      itemId: number; waitingCount: number; waitingQty: number; unprintedCount: number; inspectionRequired: boolean;
      uomCode: string; batches: { batchId: number; waitingCount: number }[]; lots: LotSummary[]; lastIssuedAt: string | null;
    }[];
    const itemA = groups.find((group) => group.itemId === Number(ids.item));
    const waitingLots = await prisma.lot.count({ where: { item_id: ids.item, lifecycle_status_code: 'WAITING' } });
    expect(itemA).toMatchObject({ waitingCount: waitingLots, waitingQty: waitingLots * 1000, inspectionRequired: true, uomCode: 'EA' });
    expect(itemA?.lastIssuedAt).not.toBeNull();
    // 라벨을 찍은 LOT 은 그 뒤 폐기됐다 — 대기 LOT 은 모두 미출력이다.
    expect(itemA?.unprintedCount).toBe(waitingLots);
    expect(itemA?.lots.filter((lot) => lot.lifecycleStatusCode === 'VOIDED')).toHaveLength(3);
    expect(itemA?.lots.find((lot) => lot.lastLabelIssue !== null)?.lastLabelIssue?.issueSeq).toBe(2);
    expect(itemA?.batches.reduce((sum, batch) => sum + batch.waitingCount, 0)).toBe(waitingLots);
    expect(groups.find((group) => group.itemId === Number(ids.resin))).toMatchObject({ waitingCount: 5, waitingQty: 5, uomCode: 'KG' });

    const filtered = await get(WAITING_LOTS).query({ plantId: Number(ids.plant), q: `${PREFIX}-R`, hasWaiting: true }).expect(200);
    expect((filtered.body.items as { itemId: number }[]).map((group) => group.itemId)).toEqual([Number(ids.resin)]);

    const list = await get(BATCHES).query({ plantId: Number(ids.plant), itemId: Number(ids.item), size: 100 }).expect(200);
    const rows = list.body.items as { lotCount: number; waitingCount: number; receivedCount: number; voidedCount: number }[];
    expect(rows.every((row) => row.waitingCount + row.receivedCount + row.voidedCount === row.lotCount)).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.voidedCount, 0)).toBe(3);
    const withWaiting = await get(BATCHES).query({ plantId: Number(ids.plant), itemId: Number(ids.item), hasWaiting: true }).expect(200);
    const without = await get(BATCHES).query({ plantId: Number(ids.plant), itemId: Number(ids.item), hasWaiting: false }).expect(200);
    expect(withWaiting.body.page.totalElements ?? withWaiting.body.items.length).toBeGreaterThan(0);
    expect([...withWaiting.body.items, ...without.body.items]).toHaveLength(rows.length);

    // POP 도 자기 공장 목록을 읽는다.
    await request(app.getHttpServer()).get(WAITING_LOTS).query({ plantId: Number(ids.plant) })
      .set('Authorization', `Bearer ${popToken}`).expect(200);
  });

  it('R19-1 P-01-01·W-01-14 가 없으면 403, 단말은 자기 공장 POP 만', async () => {
    const narrow = (method: 'get' | 'post', path: string) =>
      request(app.getHttpServer())[method](path).set('Cookie', narrowCookie).set('Idempotency-Key', key());
    await narrow('post', BATCHES).send(body()).expect(403);
    await narrow('get', BATCHES).query({ plantId: Number(ids.plant) }).expect(403);
    await narrow('get', WAITING_LOTS).query({ plantId: Number(ids.plant) }).expect(403);
    await narrow('post', VOID).send({ lotIds: [1] }).expect(403);

    await terminalPost(BATCHES, foreignPopToken).send(body()).expect(401);
    await terminalPost(BATCHES, mobileToken).send(body()).expect(401);
    await request(app.getHttpServer()).get(BATCHES).query({ plantId: Number(ids.plant) })
      .set('Authorization', `Bearer ${foreignPopToken}`).expect(401);
    const own = (await popPost(BATCHES).send(body({ lotCount: 1 })).expect(201)).body.lots as LotSummary[];
    await terminalPost(VOID, foreignPopToken).send({ lotIds: [own[0].lotId] }).expect(401);
  });

  it('SC-001 200개 묶음이 3초 안에 만들어진다', async () => {
    const started = Date.now();
    const response = await webPost(BATCHES).send(body({ itemId: Number(ids.resin), lotQty: 2, package: null, lotCount: 200 })).expect(201);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(response.body.lots).toHaveLength(200);
    expect(new Set((response.body.lots as LotSummary[]).map((lot) => lot.lotNo)).size).toBe(200);
  });

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path).set('Cookie', cookie);
  }

  function webPost(path: string): request.Test {
    return request(app.getHttpServer()).post(path).set('Cookie', cookie).set('Idempotency-Key', key());
  }

  function popPost(path: string): request.Test {
    return terminalPost(path, popToken);
  }

  function terminalPost(path: string, token: string): request.Test {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key()).set('X-Worker-No', `${PREFIX}-W1`);
  }

  async function terminalToken(plant: bigint, type: 'POP' | 'MOBILE'): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: { terminal_code: `${PREFIX}-T${String(terminalSeq)}`, plant_id: plant, terminal_type_code: type, status_code: 'RUNNING' },
    });
    return jwt.sign({
      sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version,
      terminalCode: terminal.terminal_code, plantId: Number(plant),
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '발행묶음법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh' },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '발행묶음사업부' },
    })).business_unit_id;
    for (const [name, code] of [['plant', 'P'], ['foreignPlant', 'PF']] as const) {
      ids[name] = (await prisma.plant.create({
        data: {
          legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-${code}`,
          plant_name: `발행묶음공장 ${code}`, timezone_code: 'Asia/Ho_Chi_Minh',
        },
      })).plant_id;
    }
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.kg = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'KG' } })).uom_id;
    ids.box = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'BOX' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-A`, item_name: '발행묶음자재A', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true, inspection_required: true },
    })).item_id;
    ids.resin = (await prisma.item.create({
      data: { item_code: `${PREFIX}-R`, item_name: '발행묶음레진', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.kg, lot_controlled: true },
    })).item_id;
    ids.supplier = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-S`, partner_name: `${PREFIX} 공급사` } })).partner_id;
    ids.worker = (await prisma.worker.create({
      data: { worker_no: `${PREFIX}-W1`, worker_name: '발행묶음작업자', business_unit_id: ids.unit, plant_id: ids.plant, status_code: 'EMPLOYED' },
    })).worker_id;
    ids.warehouse = (await prisma.warehouse.create({
      data: { plant_id: ids.plant, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '발행묶음창고',
        warehouse_type_code: 'RAW_MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    for (const name of ['locA', 'locB'] as const) {
      ids[name] = (await prisma.location.create({
        data: { warehouse_id: ids.warehouse, location_code: `${PREFIX}-${name}`, location_name: name },
      })).location_id;
    }
  }

  async function makeUser(suffix: string, permissions: string[]): Promise<string> {
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-${suffix}`, user_name: `발행묶음 ${suffix}`, status_code: 'EMPLOYED' } });
    if (suffix === 'ALL') ids.user = user.app_user_id;
    const role = await prisma.role.create({ data: { role_code: `${PREFIX}_${suffix}`, role_name: `발행묶음 ${suffix}` } });
    await prisma.role_permission.createMany({ data: permissions.map((permission_code) => ({ role_id: role.role_id, permission_code })) });
    await prisma.user_role.create({ data: { app_user_id: user.app_user_id, role_id: role.role_id } });
    return `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`;
  }

  async function cleanup(): Promise<void> {
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    const lots = `SELECT lot_id FROM trace.lot WHERE plant_id IN (${plants})`;
    const users = `SELECT app_user_id FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`;
    const roles = `SELECT role_id FROM app.role WHERE role_code LIKE '${PREFIX}%'`;
    const ncs = `SELECT nonconformance_id FROM quality.nonconformance WHERE nonconformance_no LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM app.document_issue_log WHERE lot_id IN (${lots})`,
      `DELETE FROM quality.nonconformance_lot WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM quality.nonconformance WHERE nonconformance_id IN (${ncs})`,
      `DELETE FROM trace.lot_lifecycle_history WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_status_event WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_hold WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot_external_identifier WHERE lot_id IN (${lots})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.material_lot_batch WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.location WHERE location_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM audit.audit_event WHERE terminal_id IN (SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM app.idempotency_record WHERE app_user_id IN (${users})`,
      `DELETE FROM app.user_role WHERE app_user_id IN (${users})`,
      `DELETE FROM app.role_permission WHERE role_id IN (${roles})`,
      `DELETE FROM app.role WHERE role_code LIKE '${PREFIX}%'`,
      `DELETE FROM app.app_user WHERE login_id LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.partner WHERE partner_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) {
      await prisma.$executeRawUnsafe(sql);
    }
  }
});
