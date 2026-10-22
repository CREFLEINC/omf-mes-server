/**
 * ERP 보내기 — 회신 읽기. 로컬 DB + 가짜 중계 DB.
 * 표시 칸(제품출하는 두 단계)을 읽는 것은 실제 MSSQL 로 `erp-send-relay.e2e-spec.ts` 가 본다.
 */
import { OutboundReplies } from '../src/integration/erp/outbound-replies';
import { OutboundRows, RowDraft } from '../src/integration/erp/outbound-rows';
import { PROD_RSLT, RCV_TABLES } from '../src/integration/erp/rcv-tables';
import { RelayReply } from '../src/integration/erp/relay-client';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN = `R${Date.now().toString(36).toUpperCase()}`;
const CODE = `E2E-IF-REPLY-${RUN}`;

describe('ERP 보내기 회신 읽기 (e2e · 대역)', () => {
  let prisma: PrismaService;
  let rows: OutboundRows;
  /** relay_key → 회신. 없는 키는 중계 표에서 사라진 행이다. */
  let relayed: Map<string, RelayReply>;
  let replies: OutboundReplies;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    rows = new OutboundRows(prisma);
    const relay = { replies: async () => relayed };
    replies = new OutboundReplies(prisma, relay, RCV_TABLES);
  });

  beforeEach(async () => {
    await cleanup();
    relayed = new Map();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    const where = { interface_code: CODE };
    await prisma.erp_outbound_row.deleteMany({ where: { integration_message: where } });
    await prisma.integration_message.deleteMany({ where });
  }

  const result = (order: string, reportType: string): RowDraft => ({
    table: PROD_RSLT,
    values: { PLANT_CD: 'PL11', PRODT_ORDER_NO: order, REPORT_TYPE: reportType, PROD_QTY_IN_ORDER_UNIT: '10' },
  });

  /** 넣은 뒤(처리중) 상태의 묶음 하나. */
  async function sent(order: string, statusCode = 'PROCESSING'): Promise<{ id: bigint; keys: string[] }> {
    const message = await prisma.integration_message.create({
      data: {
        message_key: `${CODE}:${order}`,
        interface_code: CODE,
        direction_code: 'OUTBOUND',
        target_type_code: 'WORK_ORDER',
        target_id: 1n,
        payload: {},
        status_code: statusCode,
        sent_at: new Date(),
      },
    });
    const id = message.integration_message_id;
    const reserved = await rows.reserve(id, [result(order, 'G'), result(order, 'B')], () => 0);
    await rows.markInserted(reserved.map((row, index) => ({ id: row.id, relayInfId: BigInt(index + 1) })), new Date());
    return { id, keys: reserved.map((row) => row.relayKey) };
  }

  const stateOf = (id: bigint) =>
    prisma.integration_message.findUniqueOrThrow({ where: { integration_message_id: id } });
  const rowsOf = async (id: bigint) =>
    (await rows.of(id)).map((row) => [row.statusCode, row.erpDocumentNo, row.erpErrorMessage]);
  const applied = (documentNo: string): RelayReply => ({ applied: true, documentNo, error: null });

  it('ERP 가 반영한 행은 APPLIED·전표번호 — 묶음이 다 반영돼야 메시지가 DONE', async () => {
    const { id, keys } = await sent(`${RUN}-A`);
    relayed.set(keys[0], applied('PR0001'));
    relayed.set(keys[1], { applied: false, documentNo: null, error: null });

    await replies.read();

    expect(await rowsOf(id)).toEqual([
      ['APPLIED', 'PR0001', null],
      ['INSERTED', null, null],
    ]);
    expect((await stateOf(id)).status_code).toBe('PROCESSING');

    relayed.set(keys[1], applied('PR0002'));
    await replies.read();

    const done = await stateOf(id);
    expect(done).toMatchObject({ status_code: 'DONE', last_error_message: null });
    expect(done.completed_at).not.toBeNull();
    const [row] = await prisma.erp_outbound_row.findMany({ where: { integration_message_id: id } });
    expect(row.erp_applied_at).not.toBeNull();
  });

  it('ERP 가 거절하면 FAILED — 거절이 풀리면 다시 처리중, 반영되면 DONE', async () => {
    const { id, keys } = await sent(`${RUN}-B`);
    relayed.set(keys[0], applied('PR0003'));
    relayed.set(keys[1], { applied: false, documentNo: null, error: '품목이 없습니다' });

    await replies.read();

    expect(await rowsOf(id)).toEqual([
      ['APPLIED', 'PR0003', null],
      ['REJECTED', null, '품목이 없습니다'],
    ]);
    expect(await stateOf(id)).toMatchObject({
      status_code: 'FAILED',
      retry_count: 1,
      last_error_message: 'ERP 가 거절했다 — 품목이 없습니다',
    });

    // ERP 쪽에서 원인을 고치고 오류를 지웠다 — 같은 행을 다시 처리하는 중이다.
    relayed.set(keys[1], { applied: false, documentNo: null, error: null });
    await replies.read();
    expect(await stateOf(id)).toMatchObject({ status_code: 'PROCESSING', last_error_message: null });

    relayed.set(keys[1], applied('PR0004'));
    await replies.read();
    expect((await stateOf(id)).status_code).toBe('DONE');
  });

  it('거절된 채 바로 반영돼도 DONE 이고, 반영된 행의 남은 오류는 지운다', async () => {
    const { id, keys } = await sent(`${RUN}-C`);
    relayed.set(keys[0], applied('PR0005'));
    relayed.set(keys[1], { applied: false, documentNo: null, error: '잠금 대기' });
    await replies.read();
    expect((await stateOf(id)).status_code).toBe('FAILED');

    relayed.set(keys[1], { applied: true, documentNo: 'PR0006', error: '잠금 대기' });
    await replies.read();

    expect(await rowsOf(id)).toEqual([
      ['APPLIED', 'PR0005', null],
      ['APPLIED', 'PR0006', null],
    ]);
    expect((await stateOf(id)).status_code).toBe('DONE');
  });

  it('다시 보내려고 대기 중인 메시지는 바꾸지 않는다 — 행만 적는다', async () => {
    const { id, keys } = await sent(`${RUN}-D`, 'PENDING');
    relayed.set(keys[0], applied('PR0007'));
    relayed.set(keys[1], applied('PR0008'));

    await replies.read();

    expect(await rowsOf(id)).toEqual([
      ['APPLIED', 'PR0007', null],
      ['APPLIED', 'PR0008', null],
    ]);
    expect((await stateOf(id)).status_code).toBe('PENDING');
  });

  it('모르는 표의 대기 행은 읽지 않는다 — 시험용 사본 표의 행이 남아 있어도 회신 읽기가 멈추지 않는다', async () => {
    const stray = await sent(`${RUN}-F`);
    await prisma.erp_outbound_row.updateMany({
      where: { integration_message_id: stray.id },
      data: { relay_table_name: 'E2E_IF_RCV_UNKNOWN' },
    });
    const { id, keys } = await sent(`${RUN}-G`);
    relayed.set(keys[0], applied('PR0009'));
    relayed.set(keys[1], applied('PR0010'));

    await replies.read();

    expect((await stateOf(id)).status_code).toBe('DONE');
  });

  it('중계 표에서 사라진 행은 그대로 둔다', async () => {
    const { id } = await sent(`${RUN}-E`);

    await replies.read();

    expect(await rowsOf(id)).toEqual([
      ['INSERTED', null, null],
      ['INSERTED', null, null],
    ]);
    expect((await stateOf(id)).status_code).toBe('PROCESSING');
  });
});
