/**
 * ERP 발주 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import { Prisma } from '@prisma/client';
import * as mssql from 'mssql';

import { purchaseOrderTable } from '../src/integration/erp/apply/purchase-order.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { PURCHASE_ORDER } from '../src/integration/erp/relay-tables';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  ensurePlant,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_IF_SND_PO_INFOR_KO324';
const PREFIX = 'E2EPO-';
const TABLE = {
  ...purchaseOrderTable,
  source: { ...PURCHASE_ORDER, interfaceCode: 'E2E-IF-ERP-PO-RECV', name: COPY },
};

describeRelay('ERP 발주 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;
  const createdPlants: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, PURCHASE_ORDER.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
    await ensurePlant(prisma, 'PL11', createdPlants);
    await prisma.partner.create({
      data: {
        partner_code: `${PREFIX}BP`,
        partner_name: 'e2e 공급사',
        erp_partner_code: `${PREFIX}BP`,
      },
    });
    const kg = await prisma.uom.findUniqueOrThrow({ where: { uom_code: 'KG' } });
    for (const code of ['I1', 'I2']) {
      await prisma.item.create({
        data: {
          item_code: `${PREFIX}${code}`,
          item_name: `e2e 원자재 ${code}`,
          item_type_code: 'RAW_MATERIAL',
          base_uom_id: kg.uom_id,
        },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.plant.deleteMany({ where: { plant_id: { in: createdPlants } } });
    await dropCopy(sa, COPY);
    await sa?.close();
    await relay?.close();
    await prisma?.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.integration_message.deleteMany({
      where: { interface_code: TABLE.source.interfaceCode },
    });
    const po = { erp_purchase_order_no: { startsWith: PREFIX } };
    await prisma.purchase_order_line.deleteMany({ where: { purchase_order: po } });
    await prisma.purchase_order.deleteMany({ where: po });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
  }

  function line(seq: number, item: string, qty: number, extra: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      PO_NO: `${PREFIX}0001`,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      PO_SEQ_NO: seq,
      PLANT_CD: 'PL11',
      ITEM_CD: `${PREFIX}${item}`,
      PO_TYPE_CD: 'PO',
      PO_TYPE_NM: '외자발주(직수입)(IMPORT P/O)',
      PO_DT: '2026-06-01',
      PO_QTY: qty,
      BASE_UNIT: 'KG',
      SL_CD: seq === 1 ? 'WH31' : 'WH32',
      BP_CD: `${PREFIX}BP`,
      PUR_GRP_CD: 'P11',
      PUR_GRP_NM: 'Parts Purchase',
      IO_TYPE_CD: 'IGR',
      IO_TYPE_NM: '해외입고(Oversea Receipt)',
      DLVY_DT: new Date('2026-06-30T00:00:00.000Z'),
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  const purchaseOrder = () =>
    prisma.purchase_order.findFirstOrThrow({
      where: { erp_purchase_order_no: `${PREFIX}0001` },
      include: { purchase_order_line: { orderBy: { line_no: 'asc' } } },
    });

  it('라인 둘을 한 발주로 세우고 ERP 칸을 온 그대로 담는다', async () => {
    await insertRow(sa, COPY, line(1, 'I1', 1000));
    await insertRow(sa, COPY, line(2, 'I2', 250.5));

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const po = await purchaseOrder();
    expect(po).toMatchObject({
      purchase_order_no: `${PREFIX}0001`,
      status_code: 'REGISTERED',
      erp_order_type_code: 'PO',
      erp_purchase_group_code: 'P11',
      erp_io_type_code: 'IGR',
      order_date: new Date('2026-06-01T00:00:00.000Z'),
      expected_receipt_date: new Date('2026-06-30T00:00:00.000Z'),
    });
    expect(
      po.purchase_order_line.map((l) => [
        l.line_no,
        l.ordered_qty.toString(),
        l.erp_storage_location_code,
      ]),
    ).toEqual([
      [1, '1000', 'WH31'],
      [2, '250.5', 'WH32'],
    ]);
  });

  it('입고된 수량 밑으로 줄이는 판은 원본에 사유를 남기고 N 으로 둔다', async () => {
    const po = await purchaseOrder();
    await prisma.purchase_order_line.update({
      where: { purchase_order_line_id: po.purchase_order_line[0].purchase_order_line_id },
      data: { received_qty: new Prisma.Decimal(800) },
    });
    await insertRow(sa, COPY, line(1, 'I1', 500, { IF_SEQ: 2 }));

    const result = await cycle.run(TABLE);

    expect(result).toMatchObject({ failed: 1 });
    const failed = await sa
      .request()
      .query<{ MES_APPLY_FLAG: string; MES_APPLY_ERROR: string }>(
        `SELECT MES_APPLY_FLAG, MES_APPLY_ERROR FROM dbo.${COPY} WHERE IF_SEQ = 2`,
      );
    expect(failed.recordset[0].MES_APPLY_FLAG).toBe('N');
    expect(failed.recordset[0].MES_APPLY_ERROR).toContain('입고 수량 800');
    expect((await purchaseOrder()).purchase_order_line[0].ordered_qty.toString()).toBe('1000');
  });

  it('라인이 모두 취소되면 발주를 CANCELLED 로 둔다 — 라인은 지우지 않는다', async () => {
    await sa.request().query(`DELETE FROM dbo.${COPY} WHERE IF_SEQ = 2`);
    await insertRow(sa, COPY, line(1, 'I1', 1000, { CREATE_TYPE: 'C' }));
    await insertRow(sa, COPY, line(2, 'I2', 250.5, { CREATE_TYPE: 'C' }));

    await cycle.run(TABLE);

    const po = await purchaseOrder();
    expect(po.status_code).toBe('CANCELLED');
    expect(po.purchase_order_line).toHaveLength(2);
    expect(po.purchase_order_line.every((l) => l.cancelled_at instanceof Date)).toBe(true);
  });

  it('라인의 품목이 바뀌면 판 순서대로 반영한다 — 품목코드 순이 아니다', async () => {
    const other = { PO_NO: `${PREFIX}0002` };
    await insertRow(sa, COPY, line(1, 'I2', 10, { ...other, IF_SEQ: 1 }));
    await insertRow(sa, COPY, line(1, 'I1', 10, { ...other, IF_SEQ: 2 }));

    await cycle.run(TABLE);

    const po = await prisma.purchase_order.findFirstOrThrow({
      where: { erp_purchase_order_no: other.PO_NO },
      include: { purchase_order_line: { include: { item: true } } },
    });
    expect(po.purchase_order_line.map((l) => l.item.item_code)).toEqual([`${PREFIX}I1`]);
  });
});
