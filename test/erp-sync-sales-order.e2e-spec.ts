/**
 * ERP 수주 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import { Prisma } from '@prisma/client';
import * as mssql from 'mssql';

import { salesOrderTable } from '../src/integration/erp/apply/sales-order.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { SALES_ORDER } from '../src/integration/erp/relay-tables';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_IF_SND_SO_INFOR_KO324';
const PREFIX = 'E2ESO-';
const TABLE = {
  ...salesOrderTable,
  source: { ...SALES_ORDER, interfaceCode: 'E2E-IF-ERP-SO-RECV', name: COPY },
};

describeRelay('ERP 수주 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, SALES_ORDER.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
    await prisma.partner.create({
      data: {
        partner_code: `${PREFIX}BP`,
        partner_name: 'e2e 고객사',
        erp_partner_code: `${PREFIX}BP`,
      },
    });
    const ea = await prisma.uom.findUniqueOrThrow({ where: { uom_code: 'EA' } });
    for (const code of ['F1', 'F2']) {
      await prisma.item.create({
        data: {
          item_code: `${PREFIX}${code}`,
          item_name: `e2e 제품 ${code}`,
          item_type_code: 'FINISHED',
          base_uom_id: ea.uom_id,
        },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await dropCopy(sa, COPY);
    await sa?.close();
    await relay?.close();
    await prisma?.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.integration_message.deleteMany({
      where: { interface_code: TABLE.source.interfaceCode },
    });
    const so = { erp_sales_order_no: { startsWith: PREFIX } };
    await prisma.sales_order_line.deleteMany({ where: { sales_order: so } });
    await prisma.sales_order.deleteMany({ where: so });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
  }

  function line(seq: number, item: string, qty: number, extra: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      SO_NO: `${PREFIX}0001`,
      SO_SEQ_NO: seq,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      PLANT_CD: 'PL13',
      ITEM_CD: `${PREFIX}${item}`,
      SO_TYPE_CD: 'ESOA',
      SO_TYPE_NM: '국외수출(EXPORT S/O) - OA',
      SO_DT: '2026-06-01',
      SO_QTY: qty,
      BASE_UNIT: 'EA',
      SL_CD: seq === 1 ? 'S510' : 'S520',
      BP_CD: `${PREFIX}BP`,
      MOV_TYPE: 'I44',
      SALES_GRP_CD: 'S22',
      SALES_GRP_NM: 'OA',
      CUST_PO_NO: '',
      REMARK_H: '',
      REMARK_D: '',
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  const salesOrder = (soNo = `${PREFIX}0001`) =>
    prisma.sales_order.findFirstOrThrow({
      where: { erp_sales_order_no: soNo },
      include: { sales_order_line: { orderBy: { line_no: 'asc' } } },
    });

  it('라인 둘을 한 수주로 세우고 ERP 칸을 온 그대로 담는다', async () => {
    await insertRow(sa, COPY, line(1, 'F1', 84));
    await insertRow(sa, COPY, line(2, 'F2', 39));

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const so = await salesOrder();
    expect(so).toMatchObject({
      sales_order_no: `${PREFIX}0001`,
      status_code: 'RECEIVED',
      erp_order_type_code: 'ESOA',
      erp_movement_type_code: 'I44',
      erp_sales_group_code: 'S22',
      order_date: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(so.customer_id).toBe(so.ship_to_partner_id);
    expect(
      so.sales_order_line.map((l) => [
        l.line_no,
        l.ordered_qty.toString(),
        l.erp_storage_location_code,
        l.requested_delivery_date,
      ]),
    ).toEqual([
      [1, '84', 'S510', null],
      [2, '39', 'S520', null],
    ]);
  });

  it('출하된 수량 밑으로 줄이는 판은 원본에 사유를 남기고 N 으로 둔다', async () => {
    const so = await salesOrder();
    await prisma.sales_order_line.update({
      where: { sales_order_line_id: so.sales_order_line[0].sales_order_line_id },
      data: { shipped_qty: new Prisma.Decimal(50) },
    });
    await insertRow(sa, COPY, line(1, 'F1', 40, { IF_SEQ: 2 }));

    const result = await cycle.run(TABLE);

    expect(result).toMatchObject({ failed: 1 });
    const failed = await sa
      .request()
      .query<{ MES_APPLY_FLAG: string; MES_APPLY_ERROR: string }>(
        `SELECT MES_APPLY_FLAG, MES_APPLY_ERROR FROM dbo.${COPY} WHERE IF_SEQ = 2`,
      );
    expect(failed.recordset[0].MES_APPLY_FLAG).toBe('N');
    expect(failed.recordset[0].MES_APPLY_ERROR).toContain('출하 수량 50');
    expect((await salesOrder()).sales_order_line[0].ordered_qty.toString()).toBe('84');
  });

  it('처음부터 취소(C)로 온 수주는 CANCELLED 로 선다 — 라인은 남는다', async () => {
    const other = { SO_NO: `${PREFIX}0002` };
    await insertRow(sa, COPY, line(1, 'F1', 84, { ...other, CREATE_TYPE: 'C' }));
    await insertRow(sa, COPY, line(2, 'F2', 39, { ...other, CREATE_TYPE: 'C' }));

    await cycle.run(TABLE);

    const so = await salesOrder(other.SO_NO);
    expect(so.status_code).toBe('CANCELLED');
    expect(so.sales_order_line).toHaveLength(2);
    expect(so.sales_order_line.every((l) => l.cancelled_at instanceof Date)).toBe(true);
  });
});
