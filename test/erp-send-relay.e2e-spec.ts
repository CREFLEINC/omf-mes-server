/**
 * ERP 보내기 — 중계 DB 에 행을 넣는다. 실제 MSSQL 에 붙는다(`erp-relay.fixture.ts`).
 */
import * as mssql from 'mssql';

import { RelayValues } from '../src/integration/erp/outbound-rows';
import { GOODS_ISSUE, PROD_RSLT } from '../src/integration/erp/rcv-tables';
import { RelayClient, RelayInsert } from '../src/integration/erp/relay-client';
import { RELAY, connectSa, createCopy, describeRelay, dropCopy } from './erp-relay.fixture';

const RESULT = { ...PROD_RSLT, name: 'E2E_IF_RCV_PROD_RSLT_KO324' };
const ISSUE = { ...GOODS_ISSUE, name: 'E2E_IF_RCV_GOODS_ISSUE_KO324' };

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
    await createCopy(sa, ISSUE.name, GOODS_ISSUE.name);
    // 고객 DB 의 받는 표에 트리거가 있어도 넣어져야 한다 — `OUTPUT` 절은 트리거가 있으면 실패한다.
    await sa
      .request()
      .query(`CREATE TRIGGER dbo.TR_${RESULT.name} ON dbo.${RESULT.name} AFTER INSERT AS SET NOCOUNT ON;`);
    relay = new RelayClient(RELAY);
  });

  afterAll(async () => {
    await relay?.close();
    await dropCopy(sa, RESULT.name);
    await dropCopy(sa, ISSUE.name);
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

  it('ERP 처리 결과를 PK 로 읽는다 — 반영(Y)·전표번호·오류, 사라진 행은 없다', async () => {
    await sa.request().query(
      `UPDATE dbo.${RESULT.name} SET ERP_APPLY_FLAG = 'Y', RCPT_ITEM_DOCUMENT_NO = 'PR2610220001' ` +
        `WHERE PRODT_ORDER_NO = 'E2E-WO-2' AND IF_SEQ = 1; ` +
        `UPDATE dbo.${RESULT.name} SET ERP_APPLY_ERROR = '품목이 없습니다' WHERE PRODT_ORDER_NO = 'E2E-WO-2' AND IF_SEQ = 2`,
    );

    const replies = await relay.replies(RESULT, [
      result('E2E-WO-2', 1).values,
      result('E2E-WO-2', 2).values,
      result('E2E-WO-1', 1).values,
      result('E2E-GONE', 1).values,
    ]);

    expect(Object.fromEntries(replies)).toEqual({
      'PL11|E2E-WO-2|1|A': { applied: true, documentNo: 'PR2610220001', error: null },
      'PL11|E2E-WO-2|2|A': { applied: false, documentNo: null, error: '품목이 없습니다' },
      'PL11|E2E-WO-1|1|A': { applied: false, documentNo: null, error: null },
    });
  });

  it('거절된 행을 그 자리에서 고친다 — 오류를 비우고, ERP 가 이미 처리한 행은 건드리지 않는다', async () => {
    // 앞 검사가 E2E-WO-2 의 1 은 반영(Y), 2 는 거절(오류)로 두었다.
    const counts = await relay.updateRows([
      result('E2E-WO-2', 2, { PROD_QTY_IN_ORDER_UNIT: '7' }),
      result('E2E-WO-2', 1, { PROD_QTY_IN_ORDER_UNIT: '8' }),
    ]);

    expect(counts).toEqual([1, 0]);
    const rows = await rowsOf('E2E-WO-2');
    expect(rows.map((row) => [row.IF_SEQ, row.PROD_QTY_IN_ORDER_UNIT, row.ERP_APPLY_FLAG, row.ERP_APPLY_ERROR])).toEqual([
      [1, 10, 'Y', null],
      [2, 7, 'N', null],
    ]);
    expect(rows[1]).toMatchObject({ UPDT_USER_ID: 'MES' });
  });

  it('제품출하는 두 단계의 끝(2)이 Y 여야 반영이다 — 1단계에서 발번한 DN_NO 는 먼저 읽는다', async () => {
    const issue: RelayInsert = {
      table: ISSUE,
      values: {
        DN_REQ_NO: 'E2E-DN-1', IF_SEQ: 1, CREATE_TYPE: 'A', DN_REQ_SEQ: 1, MOV_TYPE: 'I31', SHIP_TO_PARTY: 'C001',
        ACTUAL_GI_DT: '2026-10-22 10:00:00', PLANT_CD: 'PL11', SL_CD: 'S210', ITEM_CD: 'ITEM-1', LOT_NO: '',
        LOT_SUB_NO: 0, GI_UNIT: 'EA', REQ_QTY: '5', GI_QTY: '5', REF_NO1: '', REF_NO2: '', DN_SEQ_NO: 1,
        ERP_APPLY_FLAG1: '', ERP_APPLY_FLAG2: '',
      },
    };
    await relay.insertRows([issue]);
    const read = async () => (await relay.replies(ISSUE, [issue.values])).get('E2E-DN-1|1|A|1');

    await sa.request().query(`UPDATE dbo.${ISSUE.name} SET ERP_APPLY_FLAG1 = 'Y', DN_NO = 'DN2610220001'`);
    expect(await read()).toEqual({ applied: false, documentNo: 'DN2610220001', error: null });

    await sa.request().query(`UPDATE dbo.${ISSUE.name} SET ERP_APPLY_FLAG2 = 'Y'`);
    expect(await read()).toEqual({ applied: true, documentNo: 'DN2610220001', error: null });
  });

  it('그 건의 마지막 IF_SEQ 를 읽는다 — 없으면 0', async () => {
    expect(await relay.lastIfSeq(RESULT, { PLANT_CD: 'PL11', PRODT_ORDER_NO: 'E2E-WO-1' })).toBe(2);
    expect(await relay.lastIfSeq(RESULT, { PLANT_CD: 'PL13', PRODT_ORDER_NO: 'E2E-WO-1' })).toBe(0);
  });
});
