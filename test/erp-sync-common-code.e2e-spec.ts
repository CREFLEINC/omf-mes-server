/**
 * ERP 공통코드 받기 — 실제 MSSQL 에 붙는다.
 *
 * ⭐ `ERP_RELAY_E2E=1` 일 때만 돈다. 중계 DB 가 없는 곳에서 «몰래 통과»하지 않고 «건너뜀»으로
 * 보이게 하려는 것이다. 로컬 중계 DB 는 `erp-mock/docker`(README)로 띄운다.
 * 원본 표(실데이터 244행)를 건드리지 않으려고 같은 모양의 사본 표를 만들어 거기서 돈다 —
 * 표를 만드는 권한이 앱 계정에 없어 sa 로 만든다.
 */
import * as mssql from 'mssql';

import { InboundCycle, INBOUND } from '../src/integration/erp/inbound-cycle';
import { commonCodeTable } from '../src/integration/erp/apply/common-code.apply';
import { RelayClient, RelayConfig } from '../src/integration/erp/relay-client';
import { COMMON_CODE } from '../src/integration/erp/relay-tables';
import { MESSAGE_STATUS } from '../src/integration/message/integration-message.service';
import { PrismaService } from '../src/prisma/prisma.service';

const RELAY: RelayConfig = {
  host: process.env.ERP_E2E_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.ERP_E2E_DB_PORT ?? 1433),
  user: 'mes-system',
  password: process.env.ERP_E2E_DB_PASSWORD ?? 'LocalDev!2026',
  database: 'sample_mes',
  encrypt: true,
};
const SA_PASSWORD = process.env.ERP_E2E_SA_PASSWORD ?? 'LocalDev!2026';
const COPY = 'E2E_ERP_TYPE_TIG_DOWN';
/** TYPE_CODE 가 nvarchar(15) 라 짧게. */
const PREFIX = 'E2EC_';
const TABLE = {
  ...commonCodeTable,
  source: { ...COMMON_CODE, interfaceCode: 'E2E-IF-ERP-CODE-RECV', name: COPY },
};

const describeRelay = process.env.ERP_RELAY_E2E === '1' ? describe : describe.skip;

describeRelay('ERP 공통코드 받기 (e2e · 중계 DB)', () => {
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let cycle: InboundCycle;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await new mssql.ConnectionPool({
      server: RELAY.host,
      port: RELAY.port,
      user: 'sa',
      password: SA_PASSWORD,
      database: RELAY.database,
      options: { encrypt: true, trustServerCertificate: true },
    }).connect();
    await sa
      .request()
      .query(
        `IF OBJECT_ID('dbo.${COPY}') IS NOT NULL DROP TABLE dbo.${COPY}; ` +
          `SELECT TOP 0 * INTO dbo.${COPY} FROM dbo.${COMMON_CODE.name};`,
      );
    relay = new RelayClient(RELAY);
    cycle = new InboundCycle(prisma, relay);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await sa?.request().query(`IF OBJECT_ID('dbo.${COPY}') IS NOT NULL DROP TABLE dbo.${COPY}`);
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
      await sa
        .request()
        .input('seq', mssql.BigInt, r.seq)
        .input('flag', r.flag)
        .input('type', `${PREFIX}${r.type}`)
        .input('code', r.code)
        .input('name', r.name)
        .query(
          `INSERT INTO dbo.${COPY} (T_SEQ, T_FLAG, TYPE_CODE, TYPE_NAME, CODE, CODE_NAME, IF_YN) ` +
            `VALUES (@seq, @flag, @type, N'단위코드', @code, @name, 'N')`,
        );
    }
  }

  async function flags(): Promise<Record<string, string>> {
    const result = await sa
      .request()
      .query<{ CODE: string; T_SEQ: string; IF_YN: string }>(
        `SELECT CODE, T_SEQ, IF_YN FROM dbo.${COPY}`,
      );
    return Object.fromEntries(result.recordset.map((r) => [`${r.CODE}#${r.T_SEQ}`, r.IF_YN]));
  }

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
