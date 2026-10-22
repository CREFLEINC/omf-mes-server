/**
 * ERP 보내기 — 중계 DB 에 행을 넣는다. 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import * as mssql from 'mssql';

import { RelayValues } from '../src/integration/erp/outbound-rows';
import { PROD_RSLT } from '../src/integration/erp/rcv-tables';
import { RelayClient, RelayInsert } from '../src/integration/erp/relay-client';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy } from './erp-relay.fixture';

const RESULT = { ...PROD_RSLT, name: 'E2E_IF_RCV_PROD_RSLT_KO324' };

const result = (order: string, ifSeq: number, changes: RelayValues = {}): RelayInsert => ({
  table: RESULT,
  values: {
    PLANT_CD: 'PL11',
    PRODT_ORDER_NO: order,
    IF_SEQ: ifSeq,
    CREATE_TYPE: 'A',
    OPR_NO: '010',
    REPORT_DT: '2026-10-22',
    REPORT_TYPE: 'G',
    PROD_QTY_IN_ORDER_UNIT: '10',
    SHIFT_CD: 'D',
    LOT_NO: '',
    LOT_SUB_NO: 0,
    INPUT_TYPE: 'D',
    ERP_APPLY_FLAG: 'N',
    ...changes,
  },
});

describeRelay('ERP 보내기 — 중계 DB 넣기 (e2e · 중계 DB)', () => {
  let sa: mssql.ConnectionPool;
  let relay: RelayClient;

  beforeAll(async () => {
    sa = await connectSa();
    await createCopy(sa, RESULT.name, PROD_RSLT.name);
    // 고객 DB 의 받는 표에 트리거가 있어도 넣어져야 한다 — `OUTPUT` 절은 트리거가 있으면 실패한다.
    await sa
      .request()
      .query(`CREATE TRIGGER dbo.TR_${RESULT.name} ON dbo.${RESULT.name} AFTER INSERT AS SET NOCOUNT ON;`);
    relay = new RelayClient(RELAY);
  });

  afterAll(async () => {
    await relay?.close();
    await dropCopy(sa, RESULT.name);
    await sa?.close();
  });

  async function rowsOf(order: string): Promise<Record<string, unknown>[]> {
    const request = sa.request();
    request.input('order', order);
    const result = await request.query(
      `SELECT * FROM dbo.${RESULT.name} WHERE PRODT_ORDER_NO = @order ORDER BY MES_INF_ID`,
    );
    return result.recordset;
  }

  it('묶음의 행을 넣고 MES_INF_ID 를 순서대로 돌려준다 — 작성·수정자는 MES', async () => {
    const ids = await relay.insertRows([
      result('E2E-WO-1', 1),
      result('E2E-WO-1', 2, { REPORT_TYPE: 'B', PROD_QTY_IN_ORDER_UNIT: '3.5' }),
    ]);

    const rows = await rowsOf('E2E-WO-1');
    expect(rows.map((row) => Number(row.MES_INF_ID))).toEqual(ids);
    expect(rows.map((row) => [row.IF_SEQ, row.REPORT_TYPE, row.PROD_QTY_IN_ORDER_UNIT])).toEqual([
      [1, 'G', 10],
      [2, 'B', 3.5],
    ]);
    expect(rows[0]).toMatchObject({ INSRT_USER_ID: 'MES', UPDT_USER_ID: 'MES', ERP_APPLY_FLAG: 'N' });
    expect(rows[0].INSRT_DT).toBeInstanceOf(Date);
  });

  it('같은 키가 이미 있으면 넣지 않고 그 행의 MES_INF_ID 를 돌려준다', async () => {
    const [first] = await relay.insertRows([result('E2E-WO-2', 1)]);

    const again = await relay.insertRows([
      result('E2E-WO-2', 1, { PROD_QTY_IN_ORDER_UNIT: '99' }),
      result('E2E-WO-2', 2),
    ]);

    expect(again[0]).toBe(first);
    const rows = await rowsOf('E2E-WO-2');
    expect(rows.map((row) => [row.IF_SEQ, row.PROD_QTY_IN_ORDER_UNIT])).toEqual([
      [1, 10],
      [2, 10],
    ]);
  });

  it('한 행이라도 실패하면 묶음 전체가 들어가지 않는다', async () => {
    // SHIFT_CD 는 varchar(2) — 넘치면 SQL Server 가 그 INSERT 를 거절한다.
    await expect(
      relay.insertRows([result('E2E-WO-3', 1), result('E2E-WO-3', 2, { SHIFT_CD: 'NIGHT' })]),
    ).rejects.toThrow();

    expect(await rowsOf('E2E-WO-3')).toEqual([]);
  });

  it('칸 이름이 대문자·숫자·밑줄이 아니면 아무것도 넣지 않는다', async () => {
    await expect(
      relay.insertRows([result('E2E-WO-4', 1), result('E2E-WO-4', 2, { 'REMARK) --': 'x' })]),
    ).rejects.toThrow('중계 칸 이름이 아니다');

    expect(await rowsOf('E2E-WO-4')).toEqual([]);
  });

  it('키 칸이 빠지면 넣지 않는다', async () => {
    const { IF_SEQ: _ifSeq, ...withoutIfSeq } = result('E2E-WO-5', 1).values;

    await expect(relay.insertRows([{ table: RESULT, values: withoutIfSeq }])).rejects.toThrow(
      `${RESULT.name} 에 키 칸 IF_SEQ 이 없다`,
    );
  });

  it('그 건의 마지막 IF_SEQ 를 읽는다 — 없으면 0', async () => {
    expect(await relay.lastIfSeq(RESULT, { PLANT_CD: 'PL11', PRODT_ORDER_NO: 'E2E-WO-1' })).toBe(2);
    expect(await relay.lastIfSeq(RESULT, { PLANT_CD: 'PL13', PRODT_ORDER_NO: 'E2E-WO-1' })).toBe(0);
  });
});
