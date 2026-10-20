/**
 * ERP BOM 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`). 모품목 하나의 행을 묶어 판 하나로
 * 반영하고, ERP 가 고치면 새 판을 만드는지 본다.
 */
import * as mssql from 'mssql';

import { bomTable } from '../src/integration/erp/apply/bom.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { BOM } from '../src/integration/erp/relay-tables';
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

const COPY = 'E2E_IF_SND_BOM_INFOR_KO324';
const PREFIX = 'E2EB-';
const TABLE = {
  ...bomTable,
  source: { ...BOM, interfaceCode: 'E2E-IF-ERP-BOM-RECV', name: COPY },
};

describeRelay('ERP BOM 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;
  const createdPlants: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, BOM.name);
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
    await ensurePlant(prisma, 'PL11', createdPlants);
    const ea = await prisma.uom.findUniqueOrThrow({ where: { uom_code: 'EA' } });
    for (const code of ['P', 'C1', 'C2']) {
      await prisma.item.create({
        data: {
          item_code: `${PREFIX}${code}`,
          item_name: `e2e BOM ${code}`,
          item_type_code: code === 'P' ? 'FINISHED' : 'RAW_MATERIAL',
          base_uom_id: ea.uom_id,
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
    const parent = { item: { item_code: { startsWith: PREFIX } } };
    await prisma.bom_component.deleteMany({ where: { bom: parent } });
    await prisma.bom.deleteMany({ where: parent });
    await prisma.item.deleteMany({ where: { item_code: { startsWith: PREFIX } } });
  }

  function line(child: string, seq: number, qty: number, extra: Record<string, unknown> = {}) {
    const now = new Date();
    return {
      PLANT_CD: 'PL11',
      PRNT_ITEM_CD: `${PREFIX}P`,
      CHILD_ITEM_SEQ: seq,
      CHILD_ITEM_CD: `${PREFIX}${child}`,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      PRNT_ITEM_QTY: 1,
      CHILD_ITEM_QTY: qty,
      PRNT_ITEM_UNIT: 'EA',
      CHILD_ITEM_UNIT: 'EA',
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  async function boms() {
    return prisma.bom.findMany({
      where: { item: { item_code: `${PREFIX}P` } },
      include: {
        bom_component: { orderBy: { sequence_no: 'asc' }, include: { item: true } },
      },
      orderBy: { bom_version: 'asc' },
    });
  }

  async function flags(): Promise<string[]> {
    const result = await sa
      .request()
      .query<{ MES_APPLY_FLAG: string; MES_APPLY_ERROR: string | null }>(
        `SELECT MES_APPLY_FLAG, MES_APPLY_ERROR FROM dbo.${COPY} ORDER BY MES_INF_ID`,
      );
    return result.recordset.map((r) => `${r.MES_APPLY_FLAG}:${r.MES_APPLY_ERROR ?? ''}`);
  }

  it('모품목 하나의 행을 묶어 판 1 을 만든다 — 순번 0 과 소요량 0 도 그대로', async () => {
    await insertRow(sa, COPY, line('C1', 0, 0));
    await insertRow(sa, COPY, line('C2', 10, 2.5));

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const [v1] = await boms();
    expect(v1).toMatchObject({
      bom_code: `ERP-${PREFIX}P`,
      bom_version: 1,
      is_default: true,
      status_code: 'CONFIRMED',
    });
    expect(
      v1.bom_component.map((c) => [
        c.item.item_code,
        c.required_qty.toString(),
        c.sequence_no,
        c.erp_child_item_seq,
      ]),
    ).toEqual([
      [`${PREFIX}C1`, '0', 1, 0],
      [`${PREFIX}C2`, '2.5', 2, 10],
    ]);
    expect(await flags()).toEqual(['Y:', 'Y:']);
  });

  it('ERP 가 구성품 하나를 고치면 새 판 2 가 서고 판 1 은 OBSOLETE 로 닫힌다', async () => {
    await insertRow(sa, COPY, line('C2', 10, 4, { IF_SEQ: 2 }));

    await cycle.run(TABLE);

    const [v1, v2] = await boms();
    expect(v1).toMatchObject({ is_default: false, status_code: 'OBSOLETE' });
    expect(v2).toMatchObject({ bom_version: 2, is_default: true, status_code: 'CONFIRMED' });
    expect(v2.bom_component.map((c) => c.required_qty.toString())).toEqual(['0', '4']);
  });

  it('자품목이 없으면 그 모품목의 행이 모두 N 으로 남고 사유가 적힌다', async () => {
    await insertRow(sa, COPY, line('C1', 0, 1, { IF_SEQ: 3 }));
    await insertRow(sa, COPY, line('NOPE', 20, 1));

    const result = await cycle.run(TABLE);

    expect(result).toMatchObject({ read: 2, failed: 2 });
    expect((await flags()).slice(-2)).toEqual([
      `N:품목 ${PREFIX}NOPE 이 없다`,
      `N:품목 ${PREFIX}NOPE 이 없다`,
    ]);
    expect(await boms()).toHaveLength(2);
  });
});
