/**
 * 피처 012 — 출하 지시서 사업부 채우기(omf-all-around#338 · US6-1·US6-3·Q16). 마이그레이션
 * 20261120090000_shipment_request_bu_warehouse 의 채우기 문장을 `prisma/sql/shipment-request-bu-backfill.sql` 에서 읽어
 * 시험 DB 에서 다시 돌린다. 공장에 사업부가 있는 옛 지시서는 그 사업부로, 사업부 없는 공장·공장 없는 지시서는 NULL,
 * 옛 줄의 창고는 NULL(창고 미지정)로 남는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

const PREFIX = 'E12BF';
const BACKFILL = readFileSync(join(__dirname, '..', 'prisma', 'sql', 'shipment-request-bu-backfill.sql'), 'utf8');
const MIGRATION = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20261120090000_shipment_request_bu_warehouse', 'migration.sql'),
  'utf8',
);

describe('피처 012 — 출하 지시서 사업부 채우기 (e2e)', () => {
  const prisma = new PrismaClient();
  const ids: Record<string, bigint> = {};
  let seq = 0;

  beforeAll(async () => {
    await cleanup();
    const uom = await prisma.uom.findFirstOrThrow({ orderBy: { uom_id: 'asc' } });
    ids.uom = uom.uom_id;
    const entity = await prisma.legal_entity.create({ data: {
      legal_entity_code: `${PREFIX}-LE`, legal_entity_name: '채우기법인', country_code: 'VN', timezone_code: 'Asia/Ho_Chi_Minh',
    } });
    ids.entity = entity.legal_entity_id;
    ids.unitX = (await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BUX`, business_unit_name: '채우기사업부X',
    } })).business_unit_id;
    ids.unitY = (await prisma.business_unit.create({ data: {
      legal_entity_id: entity.legal_entity_id, business_unit_code: `${PREFIX}-BUY`, business_unit_name: '채우기사업부Y',
    } })).business_unit_id;
    ids.p1 = await plant('P1', ids.unitX);
    ids.p0 = await plant('P0', null);
    ids.customer = (await prisma.partner.create({ data: { partner_code: `${PREFIX}-C`, partner_name: '채우기고객' } })).partner_id;
    ids.item = (await prisma.item.create({ data: {
      item_code: `${PREFIX}-FG`, item_name: '채우기품목', item_type_code: 'FINISHED_GOOD', base_uom_id: ids.uom, lot_controlled: true,
    } })).item_id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('US6-1 마이그레이션은 채우기 파일의 문장을 그대로 담는다', () => {
    expect(MIGRATION).toContain(BACKFILL.trim());
  });

  it('US6-1·Q16 공장에 사업부가 있는 옛 지시서는 그 공장의 사업부로 채워지고 옛 줄의 창고는 NULL(창고 미지정)이다', async () => {
    const old = await request(ids.p1);
    await prisma.$executeRawUnsafe(BACKFILL);
    const row = await prisma.shipment_request.findUniqueOrThrow({
      where: { shipment_request_id: old }, include: { shipment_request_line: true },
    });
    expect(row.business_unit_id).toBe(ids.unitX);
    expect(row.fulfillment_plant_id).toBe(ids.p1);
    expect(row.shipment_request_line.map((line) => line.warehouse_id)).toEqual([null]);
  });

  it('US6-3 사업부 없는 공장의 옛 지시서와 공장이 없는 지시서는 NULL(사업부 미지정)로 남는다', async () => {
    const orphan = await request(ids.p0);
    const unassigned = await request(null);
    await prisma.$executeRawUnsafe(BACKFILL);
    const rows = await prisma.shipment_request.findMany({ where: { shipment_request_id: { in: [orphan, unassigned] } } });
    expect(rows.map((row) => row.business_unit_id)).toEqual([null, null]);
  });

  it('US6-1 이미 사업부가 있는 지시서는 다시 돌려도 바뀌지 않는다', async () => {
    const filled = await request(ids.p1);
    await prisma.shipment_request.update({ where: { shipment_request_id: filled }, data: { business_unit_id: ids.unitY } });
    await prisma.$executeRawUnsafe(BACKFILL);
    await prisma.$executeRawUnsafe(BACKFILL);
    const row = await prisma.shipment_request.findUniqueOrThrow({ where: { shipment_request_id: filled } });
    expect(row.business_unit_id).toBe(ids.unitY);
  });

  async function plant(code: string, unit: bigint | null): Promise<bigint> {
    return (await prisma.plant.create({ data: {
      legal_entity_id: ids.entity, business_unit_id: unit, plant_code: `${PREFIX}-${code}`, plant_name: `채우기공장${code}`,
      timezone_code: 'Asia/Ho_Chi_Minh',
    } })).plant_id;
  }

  /** 배포 전 모양의 지시서 — 사업부 없이 공장만, 줄은 창고 없이. */
  async function request(plantId: bigint | null): Promise<bigint> {
    seq += 1;
    const header = await prisma.shipment_request.create({ data: {
      shipment_request_no: `${PREFIX}-SR-${seq}`, customer_id: ids.customer, ship_to_partner_id: ids.customer,
      fulfillment_plant_id: plantId, requested_ship_date: new Date('2026-11-18T00:00:00.000Z'), status_code: 'REGISTERED',
    } });
    await prisma.shipment_request_line.create({ data: {
      shipment_request_id: header.shipment_request_id, line_no: 1, item_id: ids.item, uom_id: ids.uom,
      requested_qty: 10, allocated_qty: 10,
    } });
    return header.shipment_request_id;
  }

  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM logistics.shipment_request_line l USING logistics.shipment_request r
      WHERE l.shipment_request_id = r.shipment_request_id AND r.shipment_request_no LIKE '${PREFIX}-%'`);
    await prisma.shipment_request.deleteMany({ where: { shipment_request_no: { startsWith: `${PREFIX}-` } } });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: `${PREFIX}-` } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: `${PREFIX}-` } } });
    await prisma.plant.deleteMany({ where: { plant_code: { startsWith: `${PREFIX}-` } } });
    await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: `${PREFIX}-` } } });
    await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: `${PREFIX}-` } } });
  }
});
