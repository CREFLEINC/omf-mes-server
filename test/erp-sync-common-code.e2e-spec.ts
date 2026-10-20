/**
 * ERP 공통코드 받기 — 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import * as mssql from 'mssql';

import { InboundCycle, INBOUND } from '../src/integration/erp/inbound-cycle';
import { commonCodeTable } from '../src/integration/erp/apply/common-code.apply';
import { RelayClient } from '../src/integration/erp/relay-client';
import { COMMON_CODE } from '../src/integration/erp/relay-tables';
import { MESSAGE_STATUS } from '../src/integration/message/integration-message.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RELAY,
  connectSa,
  createCopy,
  describeRelay,
  dropCopy,
  flagsOf,
  insertRow,
} from './erp-relay.fixture';

const COPY = 'E2E_ERP_TYPE_TIG_DOWN';
/** TYPE_CODE 가 nvarchar(15) 라 짧게. */
const PREFIX = 'E2EC_';
const TABLE = {
  ...commonCodeTable,
  source: { ...COMMON_CODE, interfaceCode: 'E2E-IF-ERP-CODE-RECV', name: COPY },
};

describeRelay('ERP 공통코드 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY, COMMON_CODE.name);
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
    await prisma.code_value.deleteMany({
      where: { code_group: { group_code: { startsWith: PREFIX } } },
    });
    await prisma.code_group.deleteMany({ where: { group_code: { startsWith: PREFIX } } });
  }

  async function insert(
    rows: { seq: number; flag: string; type: string; code: string; name: string }[],
  ) {
    for (const r of rows) {
      await insertRow(sa, COPY, {
        T_SEQ: r.seq,
        T_FLAG: r.flag,
        TYPE_CODE: `${PREFIX}${r.type}`,
        TYPE_NAME: '단위코드',
        CODE: r.code,
        CODE_NAME: r.name,
        IF_YN: 'N',
      });
    }
  }

  const flags = () => flagsOf(sa, COPY, "CODE + '#' + CAST(T_SEQ AS nvarchar(20))", 'IF_YN');

  it('처음 받은 코드를 시스템 소유 그룹으로 만들고 원본을 Y 로 올린다', async () => {
    await insert([
      { seq: 1, flag: 'I', type: 'UNIT', code: 'GR', name: 'Gram' },
      { seq: 1, flag: 'I', type: 'UNIT', code: 'KG', name: 'Kilogram' },
    ]);

    const result = await cycle.run(TABLE);

    expect(result).toEqual({ read: 2, applied: 2, failed: 0, held: 0 });
    const group = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: `${PREFIX}UNIT` },
      include: { code_value: { orderBy: { code: 'asc' } } },
    });
    expect(group).toMatchObject({ group_name: '단위코드', is_system_owned: true });
    expect(group.code_value.map((v) => [v.code, v.code_name, v.is_active])).toEqual([
      ['GR', 'Gram', true],
      ['KG', 'Kilogram', true],
    ]);
    expect(await flags()).toEqual({ 'GR#1': 'Y', 'KG#1': 'Y' });
    const messages = await prisma.integration_message.findMany({
      where: { interface_code: TABLE.source.interfaceCode },
    });
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.direction_code === INBOUND)).toBe(true);
    expect(messages.every((m) => m.status_code === MESSAGE_STATUS.DONE)).toBe(true);
  });

  it('뒤 판이 오면 이름을 고치고 version_no 를 올리며, D 면 끈다', async () => {
    const before = await prisma.code_value.findFirstOrThrow({
      where: { code: 'GR', code_group: { group_code: `${PREFIX}UNIT` } },
    });
    await insert([
      { seq: 2, flag: 'U', type: 'UNIT', code: 'GR', name: 'Gram (g)' },
      { seq: 2, flag: 'D', type: 'UNIT', code: 'KG', name: 'Kilogram' },
    ]);

    await cycle.run(TABLE);

    const values = await prisma.code_value.findMany({
      where: { code_group: { group_code: `${PREFIX}UNIT` } },
      orderBy: { code: 'asc' },
    });
    expect(values.map((v) => [v.code, v.code_name, v.is_active])).toEqual([
      ['GR', 'Gram (g)', true],
      ['KG', 'Kilogram', false],
    ]);
    expect(values[0].version_no).toBe(before.version_no + 1);
  });

  it('반영에 실패한 행은 N 으로 남고 FAILED 가 쌓인다', async () => {
    await insert([{ seq: 1, flag: 'I', type: 'BAD', code: 'X', name: '' }]);

    const result = await cycle.run(TABLE);

    expect(result).toMatchObject({ read: 1, failed: 1 });
    expect((await flags())['X#1']).toBe('N');
    const failed = await prisma.integration_message.findFirstOrThrow({
      where: { interface_code: TABLE.source.interfaceCode, status_code: MESSAGE_STATUS.FAILED },
    });
    expect(failed).toMatchObject({ retry_count: 1, last_error_message: 'CODE_NAME 이 비어 있다' });
    expect(
      await prisma.code_group.findUnique({ where: { group_code: `${PREFIX}BAD` } }),
    ).toBeNull();
  });
});
