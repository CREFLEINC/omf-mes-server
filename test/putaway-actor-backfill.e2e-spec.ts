/**
 * 피처 011 — 적치 작업자·단말 칸 채우기(omf-all-around#325 · H16). 마이그레이션 20261119090000_putaway_actor 의 채우기 문장을
 * `prisma/sql/putaway-actor-backfill.sql` 에서 읽어 시험 DB 에서 다시 돌린다. 감사 기록이 있는 PDA 적치 전표·단말 완료 지시는
 * 채워지고, 감사 기록이 없는 관리웹 입고·세션 완료·미완료 지시는 NULL 로 남는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

const PREFIX = 'E11BF';
const TZ = 'Asia/Ho_Chi_Minh';
const BACKFILL = readFileSync(join(__dirname, '..', 'prisma', 'sql', 'putaway-actor-backfill.sql'), 'utf8');
const MIGRATION = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261119090000_putaway_actor', 'migration.sql'), 'utf8');
const DIRECT_KEY = 'POST /logistics/putaway-pending-lots/{lotId}:putaway';

describe('피처 011 — 적치 작업자·단말 칸 채우기 (e2e)', () => {
  const prisma = new PrismaClient();
  const ids: Record<string, bigint> = {};
  let seq = 0;

  beforeAll(async () => {
    await cleanup();
    await makeMasters();
    ids.source = await receipt('SOURCE');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('H16 마이그레이션은 채우기 파일의 문장을 그대로 담는다', () => {
    expect(statements()).toHaveLength(2);
    for (const sql of statements()) expect(MIGRATION).toContain(sql);
  });

  it('H16 감사 기록이 있는 PDA 적치 전표는 가장 이른 감사 행의 작업자·단말로 채워지고, 관리웹·다른 경로 전표는 NULL', async () => {
    const direct = await receipt('DIRECT');
    await audit('GOODS_RECEIPT', direct, 'CREATE', ids.w1, ids.t1, DIRECT_KEY, '2026-11-10T01:00:00Z');
    await audit('GOODS_RECEIPT', direct, 'CREATE', ids.w2, ids.t2, DIRECT_KEY, '2026-11-10T02:00:00Z');
    const temporary = await receipt('TEMP');
    await audit('GOODS_RECEIPT', temporary, 'CREATE', ids.w2, ids.t2, 'POST /logistics/putaway-pending-lots/{lotId}:putaway-temporary', '2026-11-10T03:00:00Z');
    const web = await receipt('WEB');
    const other = await receipt('OTHER');
    await audit('GOODS_RECEIPT', other, 'CREATE', ids.w1, ids.t1, 'POST /logistics/goods-receipts', '2026-11-10T04:00:00Z');

    await runBackfill();

    const rows = await prisma.goods_receipt.findMany({ where: { goods_receipt_id: { in: [direct, temporary, web, other] } } });
    const of = (id: bigint) => rows.find((row) => row.goods_receipt_id === id);
    expect(of(direct)).toMatchObject({ putaway_worker_id: ids.w1, putaway_terminal_id: ids.t1 });
    expect(of(temporary)).toMatchObject({ putaway_worker_id: ids.w2, putaway_terminal_id: ids.t2 });
    expect(of(web)).toMatchObject({ putaway_worker_id: null, putaway_terminal_id: null });
    expect(of(other)).toMatchObject({ putaway_worker_id: null, putaway_terminal_id: null });
  });

  it('H16 단말 완료·임시 완료 지시는 채워지고, 세션 완료·미완료 지시는 NULL', async () => {
    const complete = await task('C', 'COMPLETED');
    await audit('PUTAWAY_TASK', complete, 'COMPLETE', ids.w1, ids.t2, 'POST /logistics/putaway-tasks/{putawayTaskId}:complete', '2026-11-11T01:00:00Z');
    const temporary = await task('CT', 'COMPLETED_TEMPORARY');
    await audit('PUTAWAY_TASK', temporary, 'COMPLETE_TEMPORARY', ids.w2, ids.t1, 'POST /logistics/putaway-tasks/{putawayTaskId}:complete-temporary', '2026-11-11T02:00:00Z');
    const session = await task('S', 'COMPLETED');
    const pending = await task('P', 'PENDING');

    await runBackfill();

    const rows = await prisma.putaway_task.findMany({ where: { putaway_task_id: { in: [complete, temporary, session, pending] } } });
    const of = (id: bigint) => rows.find((row) => row.putaway_task_id === id);
    expect(of(complete)).toMatchObject({ completed_worker_id: ids.w1, completed_terminal_id: ids.t2 });
    expect(of(temporary)).toMatchObject({ completed_worker_id: ids.w2, completed_terminal_id: ids.t1 });
    expect(of(session)).toMatchObject({ completed_worker_id: null, completed_terminal_id: null });
    expect(of(pending)).toMatchObject({ completed_worker_id: null, completed_terminal_id: null });
  });

  it('H16 이미 채워진 행은 다시 돌려도 바뀌지 않는다', async () => {
    const filled = await receipt('FILLED');
    await prisma.goods_receipt.update({ where: { goods_receipt_id: filled }, data: { putaway_worker_id: ids.w2, putaway_terminal_id: ids.t2 } });
    await audit('GOODS_RECEIPT', filled, 'CREATE', ids.w1, ids.t1, DIRECT_KEY, '2026-11-09T01:00:00Z');

    await runBackfill();
    await runBackfill();

    expect(await prisma.goods_receipt.findUniqueOrThrow({ where: { goods_receipt_id: filled } }))
      .toMatchObject({ putaway_worker_id: ids.w2, putaway_terminal_id: ids.t2 });
  });

  // ── 도우미 ─────────────────────────────────────────────────────

  function statements(): string[] {
    const body = BACKFILL.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    return body.split(';').map((sql) => sql.trim()).filter((sql) => sql !== '');
  }

  async function runBackfill(): Promise<void> {
    for (const sql of statements()) await prisma.$executeRawUnsafe(sql);
  }

  async function receipt(tag: string): Promise<bigint> {
    const row = await prisma.goods_receipt.create({
      data: {
        goods_receipt_no: `${PREFIX}-GR-${tag}`, receipt_type_code: 'MATERIAL', plant_id: ids.p1, warehouse_id: ids.wh,
        receipt_datetime: new Date('2026-11-10T00:00:00Z'), status_code: 'POSTED',
      },
    });
    return row.goods_receipt_id;
  }

  async function task(tag: string, status: string): Promise<bigint> {
    seq += 1;
    const lot = await prisma.lot.create({
      data: { lot_no: `${PREFIX}-L${String(seq)}`, item_id: ids.item, lot_type_code: 'MATERIAL', plant_id: ids.p1, initial_qty: 10, uom_id: ids.ea,
        source_type_code: 'INBOUND_RECEIPT_LINE', source_id: 1n, status_code: 'NORMAL' },
    });
    // 지시는 출처(입고 라인 또는 보충 수령 라인)가 있어야 한다(ck_putaway_task_origin).
    const line = await prisma.goods_receipt_line.create({
      data: {
        goods_receipt_id: ids.source, line_no: seq, item_id: ids.item, lot_id: lot.lot_id, receipt_qty: 10, uom_id: ids.ea,
        quality_status_code: 'NORMAL', inventory_status_code: 'AVAILABLE', destination_location_id: ids.loc,
      },
    });
    const row = await prisma.putaway_task.create({
      data: {
        putaway_task_no: `${PREFIX}-PT-${tag}`, goods_receipt_line_id: line.goods_receipt_line_id, item_id: ids.item, lot_id: lot.lot_id, task_qty: 10, uom_id: ids.ea,
        from_location_id: ids.loc, actual_location_id: status === 'PENDING' ? null : ids.loc, status_code: status,
        completed_at: status === 'PENDING' ? null : new Date('2026-11-11T00:00:00Z'),
      },
    });
    return row.putaway_task_id;
  }

  async function audit(
    target: string, targetId: bigint, event: string, workerId: bigint, terminalId: bigint, operationKey: string, at: string,
  ): Promise<void> {
    await prisma.audit_event.create({
      data: {
        occurred_at: new Date(at), target_type_code: target, target_id: targetId, event_type_code: event, terminal_id: terminalId,
        correlation_id: `${PREFIX}-${String(targetId)}-${at}`,
        after_value: { workerId: workerId.toString(), workerNo: 'x', plantId: ids.p1.toString(), operationKey, targetId: targetId.toString() },
      },
    });
  }

  async function makeMasters(): Promise<void> {
    const entity = await prisma.legal_entity.create({
      data: { legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '채우기법인', country_code: 'VN', timezone_code: TZ },
    });
    ids.unit = (await prisma.business_unit.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BU`, business_unit_name: '채우기사업부' },
    })).business_unit_id;
    ids.p1 = (await prisma.plant.create({
      data: { legal_entity_id: entity.legal_entity_id, business_unit_id: ids.unit, plant_code: `${PREFIX}-P1`, plant_name: '채우기공장', timezone_code: TZ },
    })).plant_id;
    ids.ea = (await prisma.uom.findFirstOrThrow({ where: { uom_code: 'EA' } })).uom_id;
    ids.item = (await prisma.item.create({
      data: { item_code: `${PREFIX}-X`, item_name: '채우기자재', item_type_code: 'RAW_MATERIAL', base_uom_id: ids.ea, lot_controlled: true },
    })).item_id;
    ids.wh = (await prisma.warehouse.create({
      data: { plant_id: ids.p1, business_unit_id: ids.unit, warehouse_code: `${PREFIX}-WH`, warehouse_name: '채우기창고', warehouse_type_code: 'MATERIAL', management_level_code: 'LOCATION' },
    })).warehouse_id;
    ids.loc = (await prisma.location.create({ data: { warehouse_id: ids.wh, location_code: `${PREFIX}-R1`, location_name: 'R1' } })).location_id;
    for (const key of ['1', '2']) {
      ids[`w${key}`] = (await prisma.worker.create({
        data: { worker_no: `${PREFIX}-W${key}`, worker_name: `채우기작업자 ${key}`, business_unit_id: ids.unit, plant_id: ids.p1, status_code: 'EMPLOYED' },
      })).worker_id;
      ids[`t${key}`] = (await prisma.terminal.create({
        data: { terminal_code: `${PREFIX}-T${key}`, plant_id: ids.p1, terminal_type_code: 'MOBILE', status_code: 'RUNNING' },
      })).terminal_id;
    }
  }

  async function cleanup(): Promise<void> {
    const terminals = `SELECT terminal_id FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`;
    const plants = `SELECT plant_id FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`;
    for (const sql of [
      `DELETE FROM audit.audit_event WHERE terminal_id IN (${terminals})`,
      `DELETE FROM logistics.putaway_task WHERE putaway_task_no LIKE '${PREFIX}%'`,
      `DELETE FROM logistics.goods_receipt_line WHERE goods_receipt_id IN (SELECT goods_receipt_id FROM logistics.goods_receipt WHERE plant_id IN (${plants}))`,
      `DELETE FROM logistics.goods_receipt WHERE plant_id IN (${plants})`,
      `DELETE FROM trace.lot WHERE plant_id IN (${plants})`,
      `DELETE FROM mdm.location WHERE warehouse_id IN (SELECT warehouse_id FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%')`,
      `DELETE FROM mdm.warehouse WHERE warehouse_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.terminal WHERE terminal_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.worker WHERE worker_no LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.item WHERE item_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.plant WHERE plant_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.business_unit WHERE business_unit_code LIKE '${PREFIX}%'`,
      `DELETE FROM mdm.legal_entity WHERE legal_entity_code LIKE '${PREFIX}%'`,
    ]) await prisma.$executeRawUnsafe(sql);
  }
});
