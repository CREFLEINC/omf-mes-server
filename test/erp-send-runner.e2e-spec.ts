/**
 * ERP 보내기 실행기 — 로컬 DB + 가짜 중계 DB·바꾸개. 마지막 묶음만 실제 MSSQL 에 붙는다(`ERP_RELAY_E2E=1`).
 * 실행기를 직접 만들고 `tick(now)` 를 부른다(e2e 전역 설정이 앱 안의 실행기는 끈다).
 */
import * as mssql from 'mssql';

import { ErpSendRunner, LOCK_TTL_MS } from '../src/integration/erp/erp-send.runner';
import { OutboundBuilder, OutboundMessage } from '../src/integration/erp/outbound-builder';
import { OutboundRows, RowDraft } from '../src/integration/erp/outbound-rows';
import { GOODS_ISSUE, PROD_RSLT, RCV_TABLES } from '../src/integration/erp/rcv-tables';
import { RelayClient, RelayInsert, RelayReply } from '../src/integration/erp/relay-client';
import { SyncLease } from '../src/integration/erp/sync-lease';
import { PrismaService } from '../src/prisma/prisma.service';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy, insertRow } from './erp-relay.fixture';

const RUN = `S${Date.now().toString(36).toUpperCase()}`;
const CODE = `E2E-IF-SEND-${RUN}`;
const LEASE = `e2e-erp-send-${RUN}`;
/**
 * 만든 메시지를 바로 잡을 수 있게 1초 앞으로 둔다 — 기본값은 DB 시계(`clock_timestamp()`)인데 실행기는 Node 시계로 견준다.
 * Docker 안 DB 시계가 몇 ms 앞서면 그 회차에 안 잡힌다(운영은 다음 회차에 잡는다).
 */
const READY = () => new Date(Date.now() - 1_000);

class FakeRelay {
  inserted: RelayInsert[][] = [];
  insertFailure?: Error;
  /** 넣은 행마다 돌려줄 ERP 처리 결과. 없으면 회신 없음. */
  reply?: RelayReply;
  updated: RelayInsert[][] = [];
  /** 고치기가 돌려줄 행 수. 0 이면 그 사이 ERP 가 처리한 행이다. */
  updatedCount = 1;
  calledInTransaction = false;
  private nextId = 5000;

  constructor(private readonly openTransactions: () => number) {}

  async insertRows(rows: readonly RelayInsert[]): Promise<number[]> {
    this.calledInTransaction ||= this.openTransactions() > 0;
    if (this.insertFailure !== undefined) throw this.insertFailure;
    this.inserted.push([...rows]);
    return rows.map(() => this.nextId++);
  }

  async updateRows(rows: readonly RelayInsert[]): Promise<number[]> {
    this.calledInTransaction ||= this.openTransactions() > 0;
    this.updated.push([...rows]);
    return rows.map(() => this.updatedCount);
  }

  async lastIfSeq(): Promise<number> {
    this.calledInTransaction ||= this.openTransactions() > 0;
    return 0;
  }

  async replies(table: { keyColumns: readonly string[] }, rows: readonly Record<string, unknown>[]) {
    this.calledInTransaction ||= this.openTransactions() > 0;
    const reply = this.reply;
    const keys = rows.map((row) => table.keyColumns.map((column) => String(row[column])).join('|'));
    return new Map(reply === undefined ? [] : keys.map((key) => [key, reply]));
  }

  close = (): Promise<void> => Promise.resolve();
}

const result = (order: string, reportType: string, table = PROD_RSLT): RowDraft => ({
  table,
  values: { PLANT_CD: 'PL11', PRODT_ORDER_NO: order, REPORT_TYPE: reportType, PROD_QTY_IN_ORDER_UNIT: '10' },
});

describe('ERP 보내기 실행기 (e2e · 대역)', () => {
  let prisma: PrismaService;
  // 리스 주인 하나를 같이 쓴다 — 시험마다 새로 만들면 앞 실행기가 쥔 리스(120초)를 다음 실행기가 못 잡는다.
  let lease: SyncLease;
  let relay: FakeRelay;
  let runner: ErpSendRunner;
  let build: (message: OutboundMessage) => Promise<RowDraft[]>;
  let builds = 0;
  let openTransactions = 0;
  const builder: OutboundBuilder = {
    interfaceCode: CODE,
    build: (message) => {
      builds += 1;
      return build(message);
    },
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    lease = new SyncLease(prisma, LEASE);
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
      openTransactions += 1;
      return transaction(...args).finally(() => (openTransactions -= 1));
    }) as typeof prisma.$transaction);
  });

  beforeEach(async () => {
    await cleanup();
    relay = new FakeRelay(() => openTransactions);
    runner = new ErpSendRunner(true, prisma, lease, relay, [builder], RCV_TABLES);
    builds = 0;
    build = async () => [];
  });

  afterEach(() => expect(relay.calledInTransaction).toBe(false));

  afterAll(async () => {
    await cleanup();
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${LEASE}`;
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    const where = { interface_code: { in: [CODE, `${CODE}-OTHER`] } };
    await prisma.erp_outbound_row.deleteMany({ where: { integration_message: where } });
    await prisma.integration_message.deleteMany({ where });
  }

  async function message(interfaceCode = CODE): Promise<bigint> {
    const created = await prisma.integration_message.create({
      data: {
        message_key: `${interfaceCode}:${Math.random()}`,
        interface_code: interfaceCode,
        direction_code: 'OUTBOUND',
        target_type_code: 'WORK_ORDER',
        target_id: 1n,
        payload: {},
        status_code: 'PENDING',
        available_at: READY(),
      },
    });
    return created.integration_message_id;
  }

  const stateOf = (id: bigint) =>
    prisma.integration_message.findUniqueOrThrow({ where: { integration_message_id: id } });
  const rowsOf = (id: bigint) =>
    prisma.erp_outbound_row.findMany({ where: { integration_message_id: id }, orderBy: { erp_outbound_row_id: 'asc' } });

  it('묶음의 행에 키를 적고 여러 표의 행을 한 번에 넣은 뒤 처리중·sentAt 을 남긴다', async () => {
    const id = await message();
    build = async () => [result(`${RUN}-A`, 'G'), result(`${RUN}-A`, 'B'), {
      table: GOODS_ISSUE,
      values: { DN_REQ_NO: `${RUN}-DN`, DN_REQ_SEQ: 1, GI_QTY: '5' },
    }];

    await runner.tick();

    expect(relay.inserted).toHaveLength(1);
    expect(relay.inserted[0].map((row) => [row.table.name, row.values.IF_SEQ, row.values.CREATE_TYPE])).toEqual([
      [PROD_RSLT.name, 1, 'A'],
      [PROD_RSLT.name, 2, 'A'],
      [GOODS_ISSUE.name, 1, 'A'],
    ]);
    expect((await rowsOf(id)).map((row) => [row.status_code, row.relay_inf_id])).toEqual([
      ['INSERTED', 5000n],
      ['INSERTED', 5001n],
      ['INSERTED', 5002n],
    ]);
    const state = await stateOf(id);
    expect(state).toMatchObject({ status_code: 'PROCESSING', locked_by: null, completed_at: null, retry_count: 0 });
    expect(state.sent_at).not.toBeNull();
  });

  it('넣은 회차 끝에 ERP 회신도 읽는다 — 반영됐으면 바로 완료', async () => {
    const id = await message();
    build = async () => [result(`${RUN}-R`, 'G')];
    relay.reply = { applied: true, documentNo: 'PR2610220001', error: null };

    await runner.tick();

    expect(await stateOf(id)).toMatchObject({ status_code: 'DONE', locked_by: null });
    expect(await rowsOf(id)).toEqual([
      expect.objectContaining({ status_code: 'APPLIED', erp_document_no: 'PR2610220001' }),
    ]);
  });

  /** ERP 가 둘째 행을 거절해 실패로 둔 묶음을 사람이 재처리했다. */
  async function rejectedThenRetried(order: string): Promise<bigint> {
    const id = await message();
    build = async () => [result(order, 'G'), result(order, 'B')];
    await runner.tick();
    const [first, second] = await rowsOf(id);
    await prisma.erp_outbound_row.update({ where: { erp_outbound_row_id: first.erp_outbound_row_id }, data: { status_code: 'APPLIED' } });
    await prisma.erp_outbound_row.update({
      where: { erp_outbound_row_id: second.erp_outbound_row_id },
      data: { status_code: 'REJECTED', erp_error_message: '수량이 맞지 않습니다' },
    });
    await prisma.integration_message.update({ where: { integration_message_id: id }, data: { status_code: 'PENDING' } });
    return id;
  }

  it('ERP 가 거절한 묶음을 재처리하면 거절된 행만 다시 바꾼 값으로 그 자리에서 고친다', async () => {
    const id = await rejectedThenRetried(`${RUN}-W`);
    build = async () => [result(`${RUN}-W`, 'G'), { ...result(`${RUN}-W`, 'B'), values: { ...result(`${RUN}-W`, 'B').values, PROD_QTY_IN_ORDER_UNIT: '3' } }];

    await runner.tick();

    expect(relay.updated.flat().map((row) => row.values)).toEqual([
      expect.objectContaining({ REPORT_TYPE: 'B', PROD_QTY_IN_ORDER_UNIT: '3', IF_SEQ: 2, CREATE_TYPE: 'A', ERP_APPLY_FLAG: 'N' }),
    ]);
    expect((await rowsOf(id)).map((row) => [row.status_code, row.erp_error_message, (row.row_values as { PROD_QTY_IN_ORDER_UNIT: string }).PROD_QTY_IN_ORDER_UNIT])).toEqual([
      ['APPLIED', null, '10'],
      ['INSERTED', null, '3'],
    ]);
    expect(await stateOf(id)).toMatchObject({ status_code: 'PROCESSING', locked_by: null });
    expect(relay.inserted).toHaveLength(1);
  });

  it('다시 만든 행이 처음과 다르면 고치지 않고 실패로 둔다', async () => {
    const id = await rejectedThenRetried(`${RUN}-X`);
    build = async () => [result(`${RUN}-X`, 'G'), result(`${RUN}-X`, 'B'), result(`${RUN}-X`, 'B')];

    await runner.tick();

    expect(relay.updated).toEqual([]);
    expect(await stateOf(id)).toMatchObject({
      status_code: 'FAILED',
      last_error_message: '다시 만든 행 수(3)가 처음(2)과 달라 그 자리에서 고칠 수 없다',
    });
  });

  it('다시 만든 행의 키가 달라졌으면 고치지 않고 실패로 둔다 — 중계 표의 PK 는 못 바꾼다', async () => {
    const id = await rejectedThenRetried(`${RUN}-Z`);
    build = async () => [result(`${RUN}-Z`, 'G'), result(`${RUN}-Z2`, 'B')];

    await runner.tick();

    expect(relay.updated).toEqual([]);
    expect((await stateOf(id)).last_error_message).toBe(
      `다시 만든 행의 키가 처음(PL11|${RUN}-Z|2|A)과 달라 그 자리에서 고칠 수 없다`,
    );
  });

  it('그 사이 ERP 가 처리한 행은 고친 것으로 적지 않는다 — 회신 읽기가 맞춘다', async () => {
    const id = await rejectedThenRetried(`${RUN}-Y`);
    relay.updatedCount = 0;

    await runner.tick();

    expect((await rowsOf(id)).map((row) => row.status_code)).toEqual(['APPLIED', 'REJECTED']);
    expect((await stateOf(id)).status_code).toBe('PROCESSING');
  });

  it('보낼 행이 없으면 바로 완료한다', async () => {
    const id = await message();

    await runner.tick();

    expect(await stateOf(id)).toMatchObject({ status_code: 'DONE', sent_at: null, locked_by: null });
    expect((await stateOf(id)).completed_at).not.toBeNull();
    expect(relay.inserted).toEqual([]);
  });

  it('바꾸지 못하면 사유를 남기고 실패로 둔다', async () => {
    const id = await message();
    build = async () => {
      throw new Error('창고 S540 의 MES 짝이 없다');
    };

    await runner.tick();

    expect(await stateOf(id)).toMatchObject({
      status_code: 'FAILED',
      retry_count: 1,
      last_error_message: '창고 S540 의 MES 짝이 없다',
      locked_by: null,
    });
    expect(await rowsOf(id)).toEqual([]);
  });

  it('중계 DB 에 못 닿으면 키를 둔 채 대기로 돌려 미루고, 남은 메시지는 시도 없이 돌려놓는다', async () => {
    const first = await message();
    const second = await message();
    build = async () => [result(`${RUN}-B`, 'G')];
    relay.insertFailure = new mssql.ConnectionError('Failed to connect to 192.168.1.2:1433');
    const now = new Date();

    await runner.tick(now);

    const postponed = await stateOf(first);
    expect(postponed).toMatchObject({ status_code: 'PENDING', retry_count: 1, locked_by: null });
    expect(postponed.last_error_message).toContain('Failed to connect');
    expect(postponed.available_at.getTime()).toBe(now.getTime() + 60_000);
    expect((await rowsOf(first)).map((row) => row.status_code)).toEqual(['RESERVED']);
    expect(await stateOf(second)).toMatchObject({ status_code: 'PENDING', retry_count: 0, locked_by: null });
    expect(builds).toBe(1);

    relay.insertFailure = undefined;
    await runner.tick(new Date(now.getTime() + 61_000));

    // 미룬 메시지는 다시 바꾸지 않고 적은 키 그대로 넣는다.
    expect(builds).toBe(2);
    expect(relay.inserted.flat().map((row) => row.values.IF_SEQ)).toEqual([1, 2]);
    expect((await stateOf(first)).status_code).toBe('PROCESSING');
    expect((await stateOf(second)).status_code).toBe('PROCESSING');
  });

  it('중계 DB 가 거절한 묶음은 키를 지우고 실패로 둔다 — 재처리하면 새로 바꾼다', async () => {
    const id = await message();
    build = async () => [result(`${RUN}-C`, 'G')];
    relay.insertFailure = new mssql.RequestError('String or binary data would be truncated', 'EREQUEST');

    await runner.tick();

    expect(await stateOf(id)).toMatchObject({ status_code: 'FAILED', retry_count: 1 });
    expect(await rowsOf(id)).toEqual([]);

    relay.insertFailure = undefined;
    await prisma.integration_message.update({ where: { integration_message_id: id }, data: { status_code: 'PENDING' } });
    await runner.tick();

    expect(builds).toBe(2);
    expect((await stateOf(id)).status_code).toBe('PROCESSING');
  });

  it('교착은 거절이 아니다 — 대기로 돌려 다시 하고, 미룰 때마다 간격이 배로 는다', async () => {
    const id = await message();
    await prisma.integration_message.update({ where: { integration_message_id: id }, data: { retry_count: 3 } });
    build = async () => [result(`${RUN}-D`, 'G')];
    relay.insertFailure = Object.assign(new mssql.RequestError('deadlock victim', 'EREQUEST'), { number: 1205 });
    const now = new Date();

    await runner.tick(now);

    const state = await stateOf(id);
    expect(state).toMatchObject({ status_code: 'PENDING', retry_count: 4 });
    expect(state.available_at.getTime()).toBe(now.getTime() + 8 * 60_000);
  });

  it('잡힌 채 2분이 지난 메시지는 대기로 돌려, 바꾸지 않고 적은 키로 다시 넣는다', async () => {
    const stale = await message();
    const fresh = await message();
    await new OutboundRows(prisma).reserve(stale, [result(`${RUN}-E`, 'G')], () => 0);
    const lockedAt = (ago: number) => ({ status_code: 'PROCESSING', locked_by: 'dead-runner', locked_at: new Date(Date.now() - ago) });
    await prisma.integration_message.update({ where: { integration_message_id: stale }, data: lockedAt(LOCK_TTL_MS + 1_000) });
    await prisma.integration_message.update({ where: { integration_message_id: fresh }, data: lockedAt(60_000) });

    await runner.tick();

    expect(builds).toBe(0);
    expect(relay.inserted.flat().map((row) => row.values)).toEqual([
      expect.objectContaining({ PRODT_ORDER_NO: `${RUN}-E`, IF_SEQ: 1, CREATE_TYPE: 'A' }),
    ]);
    expect((await stateOf(stale)).status_code).toBe('PROCESSING');
    expect(await stateOf(fresh)).toMatchObject({ status_code: 'PROCESSING', locked_by: 'dead-runner' });
  });

  it('바꾸개가 없는 인터페이스는 잡지 않고, 남이 리스를 쥐면 아무것도 잡지 않는다', async () => {
    const other = await message(`${CODE}-OTHER`);
    await runner.tick();
    expect((await stateOf(other)).status_code).toBe('PENDING');

    const mine = await message();
    const holder = new SyncLease(prisma, LEASE);
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${LEASE}`;
    expect(await holder.acquire()).toBe(true);
    await runner.tick();
    await holder.release();

    expect((await stateOf(mine)).status_code).toBe('PENDING');
  });

  it('종료 신호 뒤에는 잡은 메시지를 보내지 않고 대기로 돌려놓는다', async () => {
    const id = await message();
    const stopped = new ErpSendRunner(false, prisma, lease, relay, [builder], RCV_TABLES);
    await stopped.onApplicationShutdown();

    await stopped.tick();

    expect(await stateOf(id)).toMatchObject({ status_code: 'PENDING', locked_by: null, retry_count: 0 });
    expect(builds).toBe(0);
  });
});

describeRelay('ERP 보내기 실행기 (e2e · 중계 DB)', () => {
  const COPY = { ...PROD_RSLT, name: 'E2E_IF_RCV_PROD_RSLT_SEND' };
  let prisma: PrismaService;
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;
  let runner: ErpSendRunner;
  let drafts: RowDraft[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    sa = await connectSa();
    await createCopy(sa, COPY.name, PROD_RSLT.name);
    relay = new RelayClient(RELAY);
    const builder: OutboundBuilder = { interfaceCode: `${CODE}-RELAY`, build: async () => drafts };
    runner = new ErpSendRunner(true, prisma, new SyncLease(prisma, `${LEASE}-relay`), relay, [builder], [COPY]);
  });

  afterAll(async () => {
    const where = { interface_code: `${CODE}-RELAY` };
    await prisma.erp_outbound_row.deleteMany({ where: { integration_message: where } });
    await prisma.integration_message.deleteMany({ where });
    await prisma.$executeRaw`DELETE FROM integration.sync_lease WHERE lease_name = ${`${LEASE}-relay`}`;
    await relay?.close();
    await dropCopy(sa, COPY.name);
    await sa?.close();
    await prisma.$disconnect();
  });

  const row = (order: string, changes: Record<string, string> = {}): RowDraft => ({
    table: COPY,
    values: {
      PLANT_CD: 'PL11', PRODT_ORDER_NO: order, OPR_NO: '010', REPORT_DT: '2026-10-22', REPORT_TYPE: 'G',
      PROD_QTY_IN_ORDER_UNIT: '10', SHIFT_CD: 'D', LOT_NO: '', LOT_SUB_NO: 0, INPUT_TYPE: 'D', ...changes,
    },
  });

  async function send(): Promise<bigint> {
    const created = await prisma.integration_message.create({
      data: {
        message_key: `${CODE}-RELAY:${Math.random()}`,
        interface_code: `${CODE}-RELAY`,
        direction_code: 'OUTBOUND',
        target_type_code: 'WORK_ORDER',
        target_id: 1n,
        payload: {},
        status_code: 'PENDING',
        available_at: READY(),
      },
    });
    await runner.tick();
    return created.integration_message_id;
  }

  it('중계 표에 남은 번호 뒤로 넣고, 중계 DB 가 거절하면 실패로 둔다', async () => {
    // MES 기록에 없는 시험 행이 중계 표에 남아 있다.
    await insertRow(sa, COPY.name, {
      ...row('E2E-SEND-1').values, IF_SEQ: 3, CREATE_TYPE: 'A', ERP_APPLY_FLAG: 'Y',
      INSRT_USER_ID: 'TEST', INSRT_DT: new Date(), UPDT_USER_ID: 'TEST', UPDT_DT: new Date(),
    });
    drafts = [row('E2E-SEND-1'), row('E2E-SEND-1', { REPORT_TYPE: 'B' })];

    const sent = await send();

    const relayed = await sa.request().query(
      `SELECT IF_SEQ, REPORT_TYPE, ERP_APPLY_FLAG, INSRT_USER_ID FROM dbo.${COPY.name} ORDER BY IF_SEQ`,
    );
    expect(relayed.recordset).toEqual([
      { IF_SEQ: 3, REPORT_TYPE: 'G', ERP_APPLY_FLAG: 'Y', INSRT_USER_ID: 'TEST' },
      { IF_SEQ: 4, REPORT_TYPE: 'G', ERP_APPLY_FLAG: 'N', INSRT_USER_ID: 'MES' },
      { IF_SEQ: 5, REPORT_TYPE: 'B', ERP_APPLY_FLAG: 'N', INSRT_USER_ID: 'MES' },
    ]);
    expect((await prisma.integration_message.findUniqueOrThrow({ where: { integration_message_id: sent } })).status_code).toBe('PROCESSING');

    // SHIFT_CD 는 varchar(2) — SQL Server 가 거절한다.
    drafts = [row('E2E-SEND-2', { SHIFT_CD: 'NIGHT' })];
    const rejected = await send();

    expect(await prisma.integration_message.findUniqueOrThrow({ where: { integration_message_id: rejected } })).toMatchObject({
      status_code: 'FAILED',
      retry_count: 1,
    });
  });
});
