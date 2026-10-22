/**
 * ERP 보내기 — 중계 DB 에 넣기 전에 행의 키(IF_SEQ)를 정해 적는다.
 * 중계 DB 없이 Postgres 만으로 돈다.
 */
import { OutboundRows, RowDraft } from '../src/integration/erp/outbound-rows';
import { GOODS_ISSUE, PROD_RSLT } from '../src/integration/erp/rcv-tables';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN = `E2E${Date.now().toString(36).toUpperCase()}`;
const none = () => 0;

describe('ERP 보내기 행 예약 (e2e)', () => {
  let prisma: PrismaService;
  let rows: OutboundRows;
  const messages: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    rows = new OutboundRows(prisma);
  });

  afterAll(async () => {
    await prisma.erp_outbound_row.deleteMany({ where: { integration_message_id: { in: messages } } });
    await prisma.integration_message.deleteMany({ where: { integration_message_id: { in: messages } } });
    await prisma.$disconnect();
  });

  async function message(): Promise<bigint> {
    const created = await prisma.integration_message.create({
      data: {
        message_key: `e2e-erp-outbound:${RUN}:${messages.length}`,
        interface_code: 'IF-WO-CLOSE-SEND',
        direction_code: 'OUTBOUND',
        target_type_code: 'WORK_ORDER',
        target_id: 0n,
        payload: {},
        status_code: 'PENDING',
      },
    });
    messages.push(created.integration_message_id);
    return created.integration_message_id;
  }

  const result = (order: string, reportType: string): RowDraft => ({
    table: PROD_RSLT,
    values: { PLANT_CD: 'PL11', PRODT_ORDER_NO: order, REPORT_TYPE: reportType, PROD_QTY: '10' },
  });
  const issue = (dnReqNo: string, seq: number): RowDraft => ({
    table: GOODS_ISSUE,
    values: { DN_REQ_NO: dnReqNo, DN_REQ_SEQ: seq, GI_QTY: '5' },
  });

  it('한 메시지가 여러 표의 행이 되고, perRow 표는 행마다 번호를 올리고 perSend 표는 한 번호를 같이 쓴다', async () => {
    const order = `${RUN}-A`;
    const reserved = await rows.reserve(
      await message(),
      [result(order, 'G'), issue(`${RUN}-DN`, 1), result(order, 'B'), issue(`${RUN}-DN`, 2), result(order, 'B')],
      none,
    );

    expect(reserved.map((row) => [row.tableName, row.relayKey, row.statusCode])).toEqual([
      [PROD_RSLT.name, `PL11|${order}|1|A`, 'RESERVED'],
      [GOODS_ISSUE.name, `${RUN}-DN|1|A|1`, 'RESERVED'],
      [PROD_RSLT.name, `PL11|${order}|2|A`, 'RESERVED'],
      [GOODS_ISSUE.name, `${RUN}-DN|1|A|2`, 'RESERVED'],
      [PROD_RSLT.name, `PL11|${order}|3|A`, 'RESERVED'],
    ]);
    // 넣을 값 전부가 남는다 — 처리 표시는 표마다 다르다(제품출하만 두 단계·빈 값).
    expect(reserved[0].values).toEqual({
      PLANT_CD: 'PL11', PRODT_ORDER_NO: order, REPORT_TYPE: 'G', PROD_QTY: '10',
      IF_SEQ: 1, CREATE_TYPE: 'A', ERP_APPLY_FLAG: 'N',
    });
    expect(reserved[1].values).toMatchObject({ IF_SEQ: 1, CREATE_TYPE: 'A', ERP_APPLY_FLAG1: '', ERP_APPLY_FLAG2: '' });
    const stored = await prisma.erp_outbound_row.findFirstOrThrow({ where: { erp_outbound_row_id: reserved[2].id } });
    expect(stored).toMatchObject({ document_no: `PL11|${order}`, if_seq: 2, create_type_code: 'A', relay_inf_id: null });
  });

  it('IF_SEQ 는 같은 건의 마지막 번호 다음이다 — 다른 건과는 따로 센다', async () => {
    const order = `${RUN}-B`;
    await rows.reserve(await message(), [result(order, 'G'), result(order, 'B')], none);

    const next = await rows.reserve(await message(), [result(order, 'G'), result(`${RUN}-C`, 'G')], none);

    expect(next.map((row) => row.relayKey)).toEqual([`PL11|${order}|3|A`, `PL11|${RUN}-C|1|A`]);
  });

  it('중계 표에 더 큰 번호가 있으면 그 뒤를 쓴다', async () => {
    const order = `${RUN}-D`;
    const relayLast = (table: { name: string }, documentNo: string) =>
      table.name === PROD_RSLT.name && documentNo === `PL11|${order}` ? 7 : 0;

    const reserved = await rows.reserve(await message(), [result(order, 'G'), result(order, 'B')], relayLast);

    expect(reserved.map((row) => row.values.IF_SEQ)).toEqual([8, 9]);
  });

  it('이미 예약한 메시지는 적은 그대로 돌려준다 — 다시 만든 행으로 바꾸지 않는다', async () => {
    const id = await message();
    const first = await rows.reserve(id, [result(`${RUN}-E`, 'G')], none);

    const again = await rows.reserve(id, [result(`${RUN}-E`, 'G'), result(`${RUN}-E`, 'B')], () => 50);

    expect(again).toEqual(first);
    expect(await prisma.erp_outbound_row.count({ where: { integration_message_id: id } })).toBe(1);
  });

  it('키 칸이 비면 하나도 적지 않는다', async () => {
    const id = await message();
    const broken: RowDraft = { table: PROD_RSLT, values: { PLANT_CD: 'PL11', PRODT_ORDER_NO: '' } };

    await expect(rows.reserve(id, [result(`${RUN}-F`, 'G'), broken], none)).rejects.toThrow(
      `${PROD_RSLT.name}.PRODT_ORDER_NO 이 비었다`,
    );

    expect(await prisma.erp_outbound_row.count({ where: { integration_message_id: id } })).toBe(0);
  });

  it('보낼 행이 없으면 아무것도 적지 않는다', async () => {
    const id = await message();

    expect(await rows.reserve(id, [], none)).toEqual([]);
    expect(await prisma.erp_outbound_row.count({ where: { integration_message_id: id } })).toBe(0);
  });
});
