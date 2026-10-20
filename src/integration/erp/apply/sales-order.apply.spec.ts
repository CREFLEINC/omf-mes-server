import { Prisma } from '@prisma/client';

import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { salesOrderTable } from './sales-order.apply';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);
type Row = Record<string, unknown>;

const HEADER = {
  sales_order_id: 70n,
  status_code: 'RECEIVED',
  customer_id: 9n,
  ship_to_partner_id: 9n,
  order_date: new Date('2026-06-01T00:00:00.000Z'),
  erp_order_type_code: 'ESOA',
  erp_movement_type_code: 'I44',
  erp_sales_group_code: 'S22',
};
const LINE = {
  sales_order_line_id: 80n,
  item_id: 201n,
  ordered_qty: D(84),
  uom_id: 1n,
  shipped_qty: D(0),
  erp_storage_location_code: 'S510',
  cancelled_at: null as Date | null,
};

/** 거래처·품목·단위·수주. 쓰기는 `writes` 에 남기고 헤더 상태는 표에 반영한다. */
function fake(seed: { header?: Row | null; line?: Row | null; liveLines?: number } = {}) {
  const writes: { op: string; data: Row }[] = [];
  let header = seed.header === undefined ? null : seed.header;
  const line = seed.line ?? null;
  const tx = {
    partner: { findUnique: async () => ({ partner_id: 9n }) },
    item: {
      findMany: async () => [
        { item_code: 'AAR4WY1', item_id: 201n },
        { item_code: 'AAR4WY2', item_id: 202n },
      ],
    },
    uom: { findMany: async () => [{ uom_code: 'EA', uom_id: 1n }] },
    $queryRaw: async () =>
      line === null ? [] : [{ sales_order_line_id: line.sales_order_line_id }],
    sales_order: {
      findFirst: async () => header,
      create: async (a: { data: Row }) => {
        writes.push({ op: 'so.create', data: a.data });
        header = { ...a.data, sales_order_id: 70n };
        return { sales_order_id: 70n };
      },
      findUniqueOrThrow: async () => header,
      update: async (a: { data: Row }) => {
        writes.push({ op: 'so.update', data: a.data });
        header = { ...header, ...a.data };
      },
    },
    sales_order_line: {
      findUniqueOrThrow: async () => line,
      create: async (a: { data: Row }) => writes.push({ op: 'line.create', data: a.data }),
      update: async (a: { data: Row }) => writes.push({ op: 'line.update', data: a.data }),
      count: async () => seed.liveLines ?? 1,
    },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    SO_NO: 'SN2606001',
    SO_SEQ_NO: 1,
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    PLANT_CD: 'PL13',
    ITEM_CD: 'AAR4WY1',
    SO_TYPE_CD: 'ESOA',
    SO_DT: '2026-06-01',
    SO_QTY: 84,
    BASE_UNIT: 'EA',
    SL_CD: 'S510',
    BP_CD: '100129',
    MOV_TYPE: 'I44',
    SALES_GRP_CD: 'S22',
    ...extra,
  };
}

describe('salesOrderTable', () => {
  it('처음 받으면 ERP 번호 그대로 접수 상태 수주와 라인을 만든다 — 판매처·납품처는 같은 거래처다', async () => {
    const f = fake();

    await salesOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'so.create',
        data: {
          sales_order_no: 'SN2606001',
          erp_sales_order_no: 'SN2606001',
          status_code: 'RECEIVED',
          customer_id: 9n,
          ship_to_partner_id: 9n,
          order_date: new Date('2026-06-01T00:00:00.000Z'),
          erp_order_type_code: 'ESOA',
          erp_movement_type_code: 'I44',
          erp_sales_group_code: 'S22',
        },
      },
      {
        op: 'line.create',
        data: {
          sales_order_id: 70n,
          line_no: 1,
          item_id: 201n,
          ordered_qty: D(84),
          uom_id: 1n,
          erp_storage_location_code: 'S510',
          cancelled_at: null,
        },
      },
    ]);
  });

  it('같은 값이면 아무것도 바꾸지 않는다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await salesOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('헤더 칸이 바뀌면 헤더를 고치고 판을 올린다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await salesOrderTable.apply(f.tx, erp({ IF_SEQ: 2, MOV_TYPE: 'I31' }));

    expect(f.writes).toEqual([
      {
        op: 'so.update',
        data: expect.objectContaining({
          erp_movement_type_code: 'I31',
          version_no: { increment: 1 },
        }),
      },
    ]);
  });

  it('라인 수량·창고가 바뀌면 라인을 고친다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await salesOrderTable.apply(f.tx, erp({ SO_QTY: 100, SL_CD: 'S520' }));

    expect(f.writes).toEqual([
      {
        op: 'line.update',
        data: expect.objectContaining({ ordered_qty: D(100), erp_storage_location_code: 'S520' }),
      },
    ]);
  });

  it('출하된 수량 밑으로 줄이면 고치지 않고 실패한다', async () => {
    const f = fake({ header: HEADER, line: { ...LINE, shipped_qty: D(50) } });

    await expect(salesOrderTable.apply(f.tx, erp({ SO_QTY: 40 }))).rejects.toThrow('출하 수량 50');
    expect(f.writes).toEqual([]);
  });

  it('출하가 있는 라인의 품목을 바꾸면 실패한다', async () => {
    const f = fake({ header: HEADER, line: { ...LINE, shipped_qty: D(1) } });

    await expect(salesOrderTable.apply(f.tx, erp({ ITEM_CD: 'AAR4WY2' }))).rejects.toThrow(
      '품목·단위를 바꿀 수 없다',
    );
  });

  it('산 라인에 취소(C)가 오면 취소 시각만 찍는다 — 수량은 보지 않는다', async () => {
    const f = fake({ header: HEADER, line: { ...LINE, shipped_qty: D(50) }, liveLines: 0 });

    await salesOrderTable.apply(f.tx, erp({ CREATE_TYPE: 'C', SO_QTY: 1 }));

    expect(f.writes.map((w) => w.op)).toEqual(['line.update', 'so.update']);
    expect(f.writes[0].data).toEqual({
      cancelled_at: expect.any(Date),
      updated_by: null,
      version_no: { increment: 1 },
    });
    expect(f.writes[1].data).toMatchObject({ status_code: 'CANCELLED' });
  });

  it('처음 받는 행이 취소(C)면 취소된 라인으로 만들고 수주를 CANCELLED 로 둔다', async () => {
    const f = fake({ liveLines: 0 });

    await salesOrderTable.apply(f.tx, erp({ CREATE_TYPE: 'C' }));

    expect(f.writes.map((w) => w.op)).toEqual(['so.create', 'line.create', 'so.update']);
    expect(f.writes[1].data.cancelled_at).toBeInstanceOf(Date);
    expect(f.writes[2].data).toMatchObject({ status_code: 'CANCELLED' });
  });

  it('취소된 라인이 다시 A 로 오면 살리고 수주를 RECEIVED 로 되돌린다', async () => {
    const f = fake({
      header: { ...HEADER, status_code: 'CANCELLED' },
      line: { ...LINE, cancelled_at: new Date() },
      liveLines: 1,
    });

    await salesOrderTable.apply(f.tx, erp({ IF_SEQ: 2 }));

    expect(f.writes.map((w) => w.op)).toEqual(['line.update', 'so.update']);
    expect(f.writes[0].data).toMatchObject({ cancelled_at: null });
    expect(f.writes[1].data).toMatchObject({ status_code: 'RECEIVED' });
  });
});
