import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { OutboundMessage } from '../outbound-builder';
import { goodsIssueBuilder } from './goods-issue.send';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

const ORDER = {
  erp_sales_order_no: 'SO2610010001',
  erp_movement_type_code: 'I31',
  partner_sales_order_customer_idTopartner: { erp_partner_code: 'C0001' },
};

function line(lineNo: number, changes: Record<string, unknown> = {}) {
  return {
    line_no: lineNo,
    shipped_qty: D(5),
    uom_id: 1n,
    item: { item_code: `ITEM-${lineNo}`, base_uom_id: 1n },
    uom: { uom_code: 'EA' },
    shipment_request_line: {
      requested_qty: D(6),
      sales_order_line: { erp_storage_location_code: 'S210', sales_order: ORDER } as Record<string, unknown> | null,
    },
    ...changes,
  };
}

function fake(changes: Record<string, unknown> = {}): PrismaService {
  const shipment = {
    shipment_no: 'SH-20261022-0001',
    // 하노이 2026-10-22 01:30:05 — UTC 로는 아직 21일이다.
    shipped_at: new Date('2026-10-21T18:30:05.000Z') as Date | null,
    confirmed_at: new Date('2026-10-21T19:00:00.000Z') as Date | null,
    warehouse: { plant: { plant_code: 'PL11', timezone_code: 'Asia/Ho_Chi_Minh' } },
    shipment_line: [line(1), line(2)],
    ...changes,
  };
  return { shipment: { findUniqueOrThrow: async () => shipment } } as unknown as PrismaService;
}

const MESSAGE: OutboundMessage = {
  id: 1n,
  interfaceCode: 'IF-SHIPMENT-PGI-SEND',
  targetTypeCode: 'SHIPMENT',
  targetId: 31n,
  payload: {},
};
const build = (changes: Record<string, unknown> = {}) => goodsIssueBuilder(fake(changes)).build(MESSAGE);
const withOrder = (changes: Record<string, unknown>, lineChanges: Record<string, unknown> = {}) => [
  line(1, {
    shipment_request_line: {
      requested_qty: D(6),
      sales_order_line: { erp_storage_location_code: 'S210', ...lineChanges, sales_order: { ...ORDER, ...changes } },
    },
  }),
];

describe('goodsIssueBuilder', () => {
  it('출하 라인마다 한 행 — 수불유형·출하처·창고는 ERP 수주에서, 출고 일시는 공장 현지 시각', async () => {
    const rows = await build();

    expect(rows.map((row) => [row.table.name, row.values.DN_REQ_SEQ])).toEqual([
      ['T_IF_RCV_GOODS_ISSUE_KO324', 1],
      ['T_IF_RCV_GOODS_ISSUE_KO324', 2],
    ]);
    expect(rows[0].values).toEqual({
      DN_REQ_NO: 'SH-20261022-0001',
      DN_REQ_SEQ: 1,
      MOV_TYPE: 'I31',
      SHIP_TO_PARTY: 'C0001',
      ACTUAL_GI_DT: '2026-10-22 01:30:05',
      PLANT_CD: 'PL11',
      SL_CD: 'S210',
      ITEM_CD: 'ITEM-1',
      LOT_NO: '',
      LOT_SUB_NO: 0,
      GI_UNIT: 'EA',
      REQ_QTY: '6',
      GI_QTY: '5',
      REF_NO1: '',
      REF_NO2: '',
      DN_SEQ_NO: 1,
    });
  });

  it('출고 시각이 없으면 확정 시각을 쓰고, 둘 다 없으면 실패한다', async () => {
    const [row] = await build({ shipped_at: null });
    expect(row.values.ACTUAL_GI_DT).toBe('2026-10-22 02:00:00');

    await expect(build({ shipped_at: null, confirmed_at: null })).rejects.toThrow(
      '출하 SH-20261022-0001 에 출고 시각이 없다',
    );
  });

  it('ERP 수주에 붙지 않은 라인은 빼고, 남는 라인이 없으면 보낼 것이 없다', async () => {
    const unlinked = line(2, { shipment_request_line: { requested_qty: D(6), sales_order_line: null } });
    const mesOrder = withOrder({ erp_sales_order_no: null })[0];

    expect((await build({ shipment_line: [line(1), unlinked] })).map((row) => row.values.DN_REQ_SEQ)).toEqual([1]);
    expect(await build({ shipment_line: [unlinked, mesOrder] })).toEqual([]);
  });

  it.each([
    [{ erp_movement_type_code: null }, {}, '출하 SH-20261022-0001 라인 1 — ERP 수주 SO2610010001 에 수불유형(MOV_TYPE)이 없다'],
    [{}, { erp_storage_location_code: null }, '출하 SH-20261022-0001 라인 1 — ERP 수주 SO2610010001 라인에 창고(SL_CD)가 없다'],
    [
      { partner_sales_order_customer_idTopartner: { erp_partner_code: null } },
      {},
      '출하 SH-20261022-0001 라인 1 — 수주 거래처에 ERP 거래처 코드가 없다',
    ],
  ])('ERP 값이 빠지면 실패한다 — %#', async (order, orderLine, message) => {
    await expect(build({ shipment_line: withOrder(order, orderLine) })).rejects.toThrow(message);
  });

  it('단위가 품목 기본단위와 다르면 실패한다 — 환산이 필요하다', async () => {
    await expect(build({ shipment_line: [line(1, { uom_id: 2n })] })).rejects.toThrow(
      '출하 SH-20261022-0001 라인 1 — 단위가 품목 기본단위와 달라 환산이 필요하다',
    );
  });

  it('출하번호가 출하요청번호 칸(18자)보다 길면 실패한다', async () => {
    await expect(build({ shipment_no: 'SH-PL11-20261022-0001' })).rejects.toThrow(
      '출하번호 SH-PL11-20261022-0001 가 출하요청번호 칸(18자)보다 길다',
    );
  });
});
