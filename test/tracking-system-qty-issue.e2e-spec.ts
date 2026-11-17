/**
 * 추적 시스템 연동 — 재고 조회·수량 출고 처리(flowtrack 연동 제안 §3-5 · §8 의 10-5 · HTTP 입구 10-6).
 *
 * 둘 다 «수량 출고가 실제로 뺄 수 있는 재고»를 본다 — 정상 품질·가용·보류 없음·LOT 정상·맨 아래 위치·LOT 있음, 시리얼 달린 LOT 은 뺀다.
 * 수량 출고는 오래된 LOT 부터 빼 출고 전표 하나로 남긴다. 거절한 전송은 아무것도 남기지 않는다. HTTP 입구는 연동 단말 토큰만 받는다.
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
import { QtyIssue, TrackingStockService } from '../src/integration/tracking-system/tracking-stock.service';
import { PrismaService } from '../src/prisma/prisma.service';

const PREFIX = `E2E_TQI_${randomUUID().slice(0, 8)}`;
const OCCURRED = new Date('2026-11-16T03:00:00.000Z');
const WAREHOUSE = `${PREFIX}-S410`;

interface Stock {
  lotId: bigint | null;
  balanceId: bigint;
}

describe('추적 시스템 연동 — 재고 조회·수량 출고 처리 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stocks: TrackingStockService;
  let seq = 0;
  const ids: Record<string, bigint> = {};
  const callers: Record<string, [string, string]> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    stocks = app.get(TrackingStockService);
    await fixtures();
  });

  afterAll(async () => {
    await app.close();
  });

  const issue = (itemCode: string, qty: number, patch: Partial<QtyIssue> = {}): QtyIssue => ({
    transmissionId: randomUUID(), warehouseCode: WAREHOUSE, itemCode, qty, businessDate: '2026-11-16', ...patch,
  });

  it('재고 조회 — 뺄 수 있는 양만 센다 · 품목을 주면 그 품목(없으면 0) · 안 주면 재고가 있는 품목 전부', async () => {
    const [a, b, empty] = await items('a', 'b', 'empty');
    await stock(a.id, 5);
    await stock(a.id, 3);
    await stock(a.id, 10, { reserved: 4 });
    const held = await stock(a.id, 4);
    await prisma.lot_hold.create({ data: { lot_id: held.lotId as bigint, reason_code: 'SUSPECT', status_code: 'HELD', held_at: OCCURRED, held_worker_id: ids.worker } });
    await stock(a.id, 2, { quality: 'DEFECTIVE' });
    await stock(a.id, 2, { lotStatus: 'DEFECTIVE' });
    await stock(a.id, 6, { serial: true });
    await stock(a.id, 7, { withoutLot: true });
    await stock(a.id, 9, { warehouseId: ids.otherWarehouse, locationId: ids.otherLocation });
    await stock(b.id, 2);

    expect(await stocks.stocks(ids.plant, WAREHOUSE, a.code)).toEqual({ items: [{ itemCode: a.code, qty: 14 }] });
    expect(await stocks.stocks(ids.plant, WAREHOUSE, empty.code)).toEqual({ items: [{ itemCode: empty.code, qty: 0 }] });
    const all = await stocks.stocks(ids.plant, WAREHOUSE);
    expect(all.items.filter((row) => row.itemCode.startsWith(`${PREFIX}-`))).toEqual([{ itemCode: a.code, qty: 14 }, { itemCode: b.code, qty: 2 }]);
  });

  it('수량 출고 — 오래된 LOT 부터 빼 출고 전표 하나 · 조회한 양이 그만큼 준다 · 같은 전송은 다시 빼지 않는다', async () => {
    const [item] = await items('fifo');
    const older = await stock(item.id, 3, { lotCreatedAt: new Date('2026-11-01T00:00:00.000Z') });
    const newer = await stock(item.id, 5);
    const input = issue(item.code, 4);

    expect(await stocks.issue(input, ids.plant)).toEqual({ replayed: false });

    const transmission = await prisma.tracking_transmission.findUniqueOrThrow({
      where: { transmission_id: input.transmissionId }, include: { tracking_transmission_document: true },
    });
    expect(transmission).toMatchObject({ kind_code: 'QTY_ISSUE', plant_id: ids.plant, work_order_id: null });
    const written = await prisma.goods_issue.findMany({
      where: { source_document_type_code: 'TRACKING_TRANSMISSION', source_document_id: transmission.tracking_transmission_id },
      include: { goods_issue_line: { orderBy: { line_no: 'asc' } } },
    });
    expect(written.map((row) => [row.issue_type_code, row.source_warehouse_id, row.status_code])).toEqual([['SHIPMENT', ids.warehouse, 'POSTED']]);
    expect(written[0].goods_issue_line.map((line) => [line.lot_id, line.issue_qty.toNumber()])).toEqual([[older.lotId, 3], [newer.lotId, 1]]);
    expect(transmission.tracking_transmission_document).toEqual([expect.objectContaining({ document_type_code: 'GOODS_ISSUE', document_id: written[0].goods_issue_id })]);
    expect(await onHand(older, newer)).toEqual([0, 4]);
    expect(await stocks.stocks(ids.plant, WAREHOUSE, item.code)).toEqual({ items: [{ itemCode: item.code, qty: 4 }] });

    expect(await stocks.issue(input, ids.plant)).toEqual({ replayed: true });
    expect(await onHand(older, newer)).toEqual([0, 4]);
  });

  const rejections: [string, string, () => Promise<{ input: QtyIssue; stocks: Stock[] }>][] = [
    ['이 공장에 없는 창고', 'INVALID', async () => {
      const [item] = await items('other-plant');
      return { input: issue(item.code, 1, { warehouseCode: `${PREFIX}-OTHER` }), stocks: [await stock(item.id, 5)] };
    }],
    ['MES 에 없는 품목', 'INVALID', async () => ({ input: issue(`${PREFIX}-NONE`, 1), stocks: [] })],
    ['뺄 수 있는 재고가 모자람(시리얼 LOT 은 세지 않는다)', 'NEGATIVE_BALANCE', async () => {
      const [item] = await items('short');
      return { input: issue(item.code, 3), stocks: [await stock(item.id, 2), await stock(item.id, 10, { serial: true })] };
    }],
  ];

  it.each(rejections)('수량 출고 — 거절하면 아무것도 남기지 않는다 · %s', async (_name, code, arrange) => {
    const { input, stocks: touched } = await arrange();
    const before = await onHand(...touched);

    await expect(stocks.issue(input, ids.plant)).rejects.toMatchObject({ errors: [expect.objectContaining({ code })] });

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
    expect(await onHand(...touched)).toEqual(before);
  });

  it('재고 조회 — 이 공장에 없는 창고는 거절한다', async () => {
    await expect(stocks.stocks(ids.plant, `${PREFIX}-OTHER`)).rejects.toMatchObject({ errors: [expect.objectContaining({ field: 'warehouseCode', code: 'INVALID' })] });
  });

  const get = (query: Record<string, string>, caller: [string, string]) => request(app.getHttpServer())
    .get('/api/integration/tracking-system/stocks').query(query).set(...caller);
  const post = (input: QtyIssue, caller: [string, string], key = input.transmissionId) => request(app.getHttpServer())
    .post('/api/integration/tracking-system/qty-issues').set(...caller).set('Idempotency-Key', key).send(input);

  it('HTTP — 연동 토큰이면 재고를 조회하고 수량 출고를 받는다 · 같은 전송을 다시 보내면 200 에 replayed 로 답한다', async () => {
    const [item] = await items('http');
    await stock(item.id, 5);

    expect((await get({ warehouseCode: WAREHOUSE, itemCode: item.code }, callers.tracking).expect(200)).body).toEqual({ items: [{ itemCode: item.code, qty: 5 }] });
    const input = issue(item.code, 2);
    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: false });
    expect((await post(input, callers.tracking).expect(200)).body).toEqual({ replayed: true });
    expect((await get({ warehouseCode: WAREHOUSE, itemCode: item.code }, callers.tracking).expect(200)).body).toEqual({ items: [{ itemCode: item.code, qty: 3 }] });
  });

  it('HTTP — 재고 조회는 창고가 없으면 400 · 연동 토큰이 아니면 401', async () => {
    await get({}, callers.tracking).expect(400);
    await get({ warehouseCode: WAREHOUSE }, callers.web).expect(401);
    await get({ warehouseCode: WAREHOUSE }, callers.pop).expect(401);
  });

  it.each([
    ['헤더 요청 키와 전송 번호가 다름', (input: QtyIssue) => post(input, callers.tracking, randomUUID()), 400],
    ['수량이 0', (input: QtyIssue) => post({ ...input, qty: 0 }, callers.tracking), 400],
    ['계정 세션', (input: QtyIssue) => post(input, callers.web), 401],
    ['POP 토큰', (input: QtyIssue) => post(input, callers.pop), 401],
  ] as const)('HTTP — 수량 출고가 %s 이면 거절하고 아무것도 남기지 않는다', async (_name, send, status) => {
    const [item] = await items(`refused-${++seq}`);
    const row = await stock(item.id, 5);
    const input = issue(item.code, 2);

    await send(input).expect(status);

    expect(await prisma.tracking_transmission.count({ where: { transmission_id: input.transmissionId } })).toBe(0);
    expect(await onHand(row)).toEqual([5]);
  });

  async function items(...names: string[]): Promise<{ id: bigint; code: string }[]> {
    const created: { id: bigint; code: string }[] = [];
    for (const name of names) {
      const code = `${PREFIX}-${name}`;
      created.push({ id: (await prisma.item.create({ data: { item_code: code, item_name: name, item_type_code: 'FINISHED', base_uom_id: ids.uom } })).item_id, code });
    }
    return created;
  }

  /** S410 위치의 정상·가용 재고 — 고친 칸만 다르다. `serial` 이면 그 LOT 에 시리얼 하나를 단다. */
  async function stock(itemId: bigint, qty: number, patch: {
    lotCreatedAt?: Date; lotStatus?: string; withoutLot?: boolean; quality?: string; reserved?: number; serial?: boolean;
    warehouseId?: bigint; locationId?: bigint;
  } = {}): Promise<Stock> {
    const lotId = patch.withoutLot === true ? null : (await prisma.lot.create({ data: {
      lot_no: `${PREFIX}-LOT-${++seq}`, item_id: itemId, lot_type_code: 'PRODUCTION', plant_id: ids.plant, initial_qty: qty, uom_id: ids.uom,
      source_type_code: 'GOODS_RECEIPT', source_id: 0, status_code: patch.lotStatus ?? 'NORMAL', created_at: patch.lotCreatedAt ?? OCCURRED,
    } })).lot_id;
    if (patch.serial === true) {
      await prisma.serial_number.create({ data: { serial_no: `${PREFIX}-SN-${++seq}`, item_id: itemId, lot_id: lotId as bigint, status_code: 'REGISTERED' } });
    }
    const balance = await prisma.inventory_balance.create({ data: {
      legal_entity_id: ids.entity, business_unit_id: ids.unit, plant_id: patch.warehouseId === ids.otherWarehouse ? ids.otherPlant : ids.plant,
      warehouse_id: patch.warehouseId ?? ids.warehouse,
      location_id: patch.locationId ?? ids.location, item_id: itemId, lot_id: lotId, quality_status_code: patch.quality ?? 'NORMAL',
      inventory_status_code: 'AVAILABLE', ownership_type_code: 'OWNED', on_hand_qty: qty, reserved_qty: patch.reserved ?? 0, uom_id: ids.uom,
    } });
    return { lotId, balanceId: balance.inventory_balance_id };
  }

  async function onHand(...rows: Stock[]): Promise<number[]> {
    const found = await prisma.inventory_balance.findMany({ where: { inventory_balance_id: { in: rows.map((row) => row.balanceId) } } });
    return rows.map((row) => (found.find((entry) => entry.inventory_balance_id === row.balanceId) as (typeof found)[number]).on_hand_qty.toNumber());
  }

  async function fixtures(): Promise<void> {
    const base = await prisma.plant.findFirstOrThrow({ orderBy: { plant_id: 'asc' } });
    ids.entity = base.legal_entity_id;
    ids.unit = base.business_unit_id ?? (await prisma.business_unit.findFirstOrThrow()).business_unit_id;
    for (const key of ['plant', 'otherPlant']) {
      ids[key] = (await prisma.plant.create({ data: {
        plant_code: `${PREFIX}-${key}`, plant_name: PREFIX, legal_entity_id: base.legal_entity_id, business_unit_id: ids.unit, timezone_code: 'Asia/Ho_Chi_Minh',
      } })).plant_id;
    }
    ids.uom = (await prisma.uom.findFirstOrThrow({ where: { decimal_scale: 0 } })).uom_id;
    for (const [key, plantKey, code] of [['warehouse', 'plant', WAREHOUSE], ['otherWarehouse', 'otherPlant', `${PREFIX}-OTHER`]]) {
      ids[key] = (await prisma.warehouse.create({ data: {
        plant_id: ids[plantKey], business_unit_id: ids.unit, warehouse_code: code, warehouse_name: code, warehouse_type_code: 'FINISHED',
        management_level_code: 'LOCATION',
      } })).warehouse_id;
    }
    for (const [key, warehouseKey] of [['location', 'warehouse'], ['otherLocation', 'otherWarehouse']]) {
      ids[key] = (await prisma.location.create({ data: {
        warehouse_id: ids[warehouseKey], location_code: `${PREFIX}-${key}`, location_name: key, location_type_code: 'BIN',
      } })).location_id;
    }
    ids.worker = (await prisma.worker.create({ data: {
      worker_no: PREFIX, worker_name: PREFIX, plant_id: ids.plant, business_unit_id: ids.unit, status_code: 'EMPLOYED',
    } })).worker_id;

    // 단말 토큰은 `terminal.service.ts` 가 서명하는 클레임 그대로 직접 낸다(다른 단말 e2e 와 같은 관례).
    const jwt = app.get(JwtService);
    for (const [caller, type] of [['tracking', 'TRACKING_SYSTEM'], ['pop', 'POP']]) {
      const terminal = await prisma.terminal.create({ data: {
        terminal_code: `${PREFIX}-${type}`, plant_id: ids.plant, terminal_type_code: type, status_code: 'RUNNING',
      } });
      callers[caller] = ['Authorization', `Bearer ${jwt.sign({
        sub: Number(terminal.terminal_id), typ: 'terminal', tv: terminal.token_version, terminalCode: terminal.terminal_code, plantId: Number(ids.plant),
      })}`];
    }
    const user = await prisma.app_user.create({ data: { login_id: `${PREFIX}-WEB`, user_name: PREFIX, status_code: 'EMPLOYED' } });
    callers.web = ['Cookie', `${SESSION_COOKIE}=${jwt.sign({ sub: Number(user.app_user_id), typ: TOKEN_TYPE.SESSION })}`];
  }
});
