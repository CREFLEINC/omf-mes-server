/**
 * ERP 거래처 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import * as mssql from 'mssql';

import { partnerTable } from '../src/integration/erp/apply/partner.apply';
import { InboundCycle } from '../src/integration/erp/inbound-cycle';
import { RelayClient } from '../src/integration/erp/relay-client';
import { PARTNER } from '../src/integration/erp/relay-tables';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_IF_SND_BIZ_PARTNER_KO324';
const PREFIX = 'E2EBP';
const TABLE = {
  ...partnerTable,
  source: { ...PARTNER, interfaceCode: 'E2E-IF-ERP-BP-RECV', name: COPY },
};

describeRelay('ERP 거래처 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, PARTNER.name);
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
    const where = { partner: { partner_code: { startsWith: PREFIX } } };
    await prisma.partner_role.deleteMany({ where });
    await prisma.partner.deleteMany({ where: { partner_code: { startsWith: PREFIX } } });
  }

  function partner(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date();
    return {
      BP_CD: `${PREFIX}${code}`,
      IF_SEQ: 1,
      CREATE_TYPE: 'A',
      BP_NM: 'HUA RUI PLASTICS',
      BP_TYPE: 'CS',
      ADDR: '25 GUZMAN STREET, BELIZE CITY',
      BP_RGST_NO: '0101722435',
      MES_APPLY_FLAG: 'N',
      INSRT_USER_ID: 'ERP',
      INSRT_DT: now,
      UPDT_USER_ID: 'ERP',
      UPDT_DT: now,
      ...extra,
    };
  }

  async function rolesOf(code: string): Promise<string[]> {
    const roles = await prisma.partner_role.findMany({
      where: { partner: { partner_code: `${PREFIX}${code}` } },
      orderBy: { role_type_code: 'asc' },
    });
    return roles.map((r) => r.role_type_code);
  }

  it('거래처와 유형별 역할을 만들고, 칸이 없는 주소는 원본 기록에 남긴다', async () => {
    await insertRow(sa, COPY, partner('001'));
    await insertRow(sa, COPY, partner('002', { BP_TYPE: '*', BP_NM: 'Misc. Customer' }));

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    expect(await rolesOf('001')).toEqual(['CUSTOMER', 'SUPPLIER']);
    expect(await rolesOf('002')).toEqual(['CUSTOMER']);
    const created = await prisma.partner.findUniqueOrThrow({
      where: { partner_code: `${PREFIX}001` },
    });
    expect(created).toMatchObject({ erp_partner_code: `${PREFIX}001`, is_active: true });
    const message = await prisma.integration_message.findFirstOrThrow({
      where: { interface_code: TABLE.source.interfaceCode },
      orderBy: { target_id: 'asc' },
    });
    expect(message.payload).toMatchObject({ row: { ADDR: '25 GUZMAN STREET, BELIZE CITY' } });
  });

  it('뒤 판에서 유형이 S 로 바뀌면 고객 역할만 떼고, 사용자가 붙인 폐기 역할은 남긴다', async () => {
    const found = await prisma.partner.findUniqueOrThrow({
      where: { partner_code: `${PREFIX}001` },
    });
    await prisma.partner_role.create({
      data: { partner_id: found.partner_id, role_type_code: 'DISPOSAL' },
    });
    await insertRow(sa, COPY, partner('001', { IF_SEQ: 2, BP_TYPE: 'S' }));

    await cycle.run(TABLE);

    expect(await rolesOf('001')).toEqual(['DISPOSAL', 'SUPPLIER']);
    const after = await prisma.partner.findUniqueOrThrow({
      where: { partner_code: `${PREFIX}001` },
    });
    expect(after.version_no).toBe(found.version_no + 1);
  });

  it('취소(C)가 오면 거래처를 끈다', async () => {
    await insertRow(
      sa,
      COPY,
      partner('002', { CREATE_TYPE: 'C', BP_TYPE: '*', BP_NM: 'Misc. Customer' }),
    );

    await cycle.run(TABLE);

    const row = await prisma.partner.findUniqueOrThrow({ where: { partner_code: `${PREFIX}002` } });
    expect(row.is_active).toBe(false);
  });
});
