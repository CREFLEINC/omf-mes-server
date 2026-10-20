/**
 * ERP 제조오더 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import * as mssql from 'mssql';

import { productionOrderTable } from '../src/integration/erp/apply/production-order.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { PRODUCTION_ORDER } from '../src/integration/erp/relay-tables';
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

const COPY = 'E2E_IF_SND_PROD_ORD_KO324';
const PREFIX = 'E2EPD-';
const TABLE = {
  ...productionOrderTable,
  source: { ...PRODUCTION_ORDER, interfaceCode: 'E2E-IF-ERP-PRODORD-RECV', name: COPY },
};

describeRelay('ERP 제조오더 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;
  const createdPlants: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, PRODUCTION_ORDER.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
    await ensurePlant(prisma, 'PL13', createdPlants);
    const ea = await prisma.uom.findUniqueOrThrow({ where: { uom_code: 'EA' } });
    await prisma.item.create({
      data: {
        item_code: `${PREFIX}F1`,
        item_name: 'e2e 제품',
        item_type_code: 'FINISHED',
        base_uom_id: ea.uom_id,
      },
    });
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
    const po = { production_order_no: { startsWith: PREFIX } };
    await prisma.production_order_change_field.deleteMany({ where: { production_order: po } });
    await prisma.production_order.deleteMany({ where: po });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
  }

  function order(extra: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      PLANT_CD: 'PL13',
      PRODT_ORDER_NO: `${PREFIX}0001`,
      ITEM_CD: `${PREFIX}F1`,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      OPR_NO: '010',
      PLAN_START_DT: '2026-06-08',
      PRODT_ORDER_QTY: 30,
      BASE_UNIT: 'EA',
      RE_WORK_FLG: 'N',
      REMARK: '',
      SL_CD: 'S510',
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  const productionOrder = () =>
    prisma.production_order.findUniqueOrThrow({
      where: { production_order_no: `${PREFIX}0001` },
      include: { production_order_change_field: { orderBy: { field_code: 'asc' } } },
    });

  it('처음 받으면 P/O 를 세우고 계획 시작일·ERP 칸을 담는다 — 납기는 비운다', async () => {
    await insertRow(sa, COPY, order());

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 1, applied: 1, failed: 0, held: 0 });
    expect(await productionOrder()).toMatchObject({
      erp_order_no: `${PREFIX}0001`,
      status_code: 'RECEIVED',
      planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
      due_date: null,
      erp_operation_no: '010',
      erp_storage_location_code: 'S510',
      erp_rework_flag: 'N',
      last_change_received_at: null,
      production_order_change_field: [],
    });
  });

  it('수량·시작일이 바뀌면 이전 값을 남기고 UPDATED 로 둔다', async () => {
    await insertRow(
      sa,
      COPY,
      order({ IF_SEQ: 2, PRODT_ORDER_QTY: 20, PLAN_START_DT: '2026-06-10' }),
    );

    await cycle.run(TABLE);

    const po = await productionOrder();
    expect(po.status_code).toBe('UPDATED');
    expect(po.order_qty.toString()).toBe('20');
    expect(po.last_change_received_at).toBeInstanceOf(Date);
    expect(
      po.production_order_change_field.map((f) => [
        f.field_code,
        f.before_order_qty?.toString() ?? null,
        f.before_planned_start_date,
      ]),
    ).toEqual([
      ['ORDER_QTY', '30', null],
      ['PLANNED_START_DATE', null, new Date('2026-06-08T00:00:00.000Z')],
    ]);
  });

  it('취소(C)면 CANCELLED 로 두고 지난 항목 대신 이전 상태만 남긴다', async () => {
    await insertRow(sa, COPY, order({ IF_SEQ: 3, CREATE_TYPE: 'C', PRODT_ORDER_QTY: 20 }));

    await cycle.run(TABLE);

    const po = await productionOrder();
    expect(po.status_code).toBe('CANCELLED');
    expect(
      po.production_order_change_field.map((f) => [f.field_code, f.before_status_code]),
    ).toEqual([['STATUS_CODE', 'UPDATED']]);
  });
});
