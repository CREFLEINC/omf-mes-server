/**
 * ERP 품목 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`). SND 계열이라 반영 시각·실패 사유가
 * 원본 행에 남는지까지 본다.
 */
import * as mssql from 'mssql';

import { itemTable } from '../src/integration/erp/apply/item.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { ITEM } from '../src/integration/erp/relay-tables';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_IF_SND_ITEM_INFOR_KO324';
const PREFIX = 'E2EI-';
const TABLE = {
  ...itemTable,
  source: { ...ITEM, interfaceCode: 'E2E-IF-ERP-ITEM-RECV', name: COPY },
};

describeRelay('ERP 품목 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, ITEM.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
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
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
  }

  function item(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date();
    return {
      PLANT_CD: 'PL11',
      ITEM_CD: `${PREFIX}${code}`,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      ITEM_NM: 'RESIN PC 【 30100-001WH0 】',
      SPEC: 'PC, ER1006FH, 5VA, WHITE',
      ITEM_ACCT_CD: '30',
      ITEM_ACCT_NM: 'Raw Material',
      ITEM_GROUP_CD: 'ZZ400',
      BASIC_UNIT: 'GR',
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  async function relayRows(): Promise<Record<string, unknown>[]> {
    const result = await sa
      .request()
      .query(
        `SELECT PLANT_CD, ITEM_CD, CREATE_TYPE, MES_APPLY_FLAG, MES_APPLY_DT, MES_APPLY_ERROR, UPDT_USER_ID ` +
          `FROM dbo.${COPY} ORDER BY MES_INF_ID`,
      );
    return result.recordset;
  }

  it('두 공장의 같은 품목은 하나로 만들고, 원본에 반영 시각과 MES 를 남긴다', async () => {
    await insertRow(sa, COPY, item('001'));
    await insertRow(sa, COPY, item('001', { PLANT_CD: 'PL13' }));

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const items = await prisma.item.findMany({
      where: { item_code: { startsWith: PREFIX } },
      include: { uom: true },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      item_name: 'RESIN PC 【 30100-001WH0 】',
      item_type_code: 'RAW_MATERIAL',
      erp_spec: 'PC, ER1006FH, 5VA, WHITE',
      erp_item_group_code: 'ZZ400',
    });
    expect(items[0].uom.uom_code).toBe('GR');
    const rows = await relayRows();
    expect(rows.map((r) => [r.MES_APPLY_FLAG, r.UPDT_USER_ID, r.MES_APPLY_ERROR])).toEqual([
      ['Y', 'MES', null],
      ['Y', 'MES', null],
    ]);
    expect(rows.every((r) => r.MES_APPLY_DT instanceof Date)).toBe(true);
  });

  it('반영에 실패하면 원본은 N 으로 두고 사유를 MES_APPLY_ERROR 에 남긴다', async () => {
    await insertRow(sa, COPY, item('002', { BASIC_UNIT: 'BX' }));

    await cycle.run(TABLE);

    const failed = (await relayRows()).find((r) => r.ITEM_CD === `${PREFIX}002`);
    expect(failed).toMatchObject({
      MES_APPLY_FLAG: 'N',
      MES_APPLY_ERROR: '단위 BX 이 없다',
      UPDT_USER_ID: 'MES',
    });
  });

  it('취소(C)가 오면 품목을 끈다', async () => {
    await insertRow(sa, COPY, item('001', { CREATE_TYPE: 'C' }));

    await cycle.run(TABLE);

    const row = await prisma.item.findUniqueOrThrow({ where: { item_code: `${PREFIX}001` } });
    expect(row.is_active).toBe(false);
  });
});
