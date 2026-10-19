import { Prisma } from '@prisma/client';

import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { purchaseOrderTable } from './purchase-order.apply';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);
type Row = Record<string, unknown>;

const HEADER = {
  purchase_order_id: 50n,
  status_code: 'REGISTERED',
  supplier_id: 7n,
  plant_id: 11n,
  business_unit_id: 1n,
  order_date: new Date('2026-06-01T00:00:00.000Z'),
  expected_receipt_date: new Date('2026-06-30T00:00:00.000Z'),
  erp_order_type_code: 'PO',
  erp_purchase_group_code: 'P11',
  erp_io_type_code: 'IGR',
};
const LINE = {
  purchase_order_line_id: 60n,
  item_id: 101n,
  ordered_qty: D(1000),
  uom_id: 3n,
  received_qty: D(0),
  tolerance_over_qty: D(0),
  erp_storage_location_code: 'WH31',
  cancelled_at: null as Date | null,
};

/** 공장·거래처·품목·단위·발주. 쓰기는 `writes` 에 남기고 헤더 상태는 표에 반영한다. */
function fake(
  seed: { header?: Row | null; line?: Row | null; liveLines?: number; partner?: boolean } = {},
) {
  const writes: { op: string; data: Row }[] = [];
  let header = seed.header === undefined ? null : seed.header;
  const tx = {
    plant: {
      findMany: async () => [
        { plant_id: 11n, business_unit_id: 1n, timezone_code: 'Asia/Ho_Chi_Minh' },
      ],
    },
    partner: { findUnique: async () => (seed.partner === false ? null : { partner_id: 7n }) },
    item: {
      findMany: async () => [
        { item_code: '040102-00009', item_id: 101n },
        { item_code: '040102-00023', item_id: 102n },
      ],
    },
    uom: { findMany: async () => [{ uom_code: 'KG', uom_id: 3n }] },
    $queryRaw: async () =>
      header === null ? [] : [{ purchase_order_id: header.purchase_order_id }],
    purchase_order: {
      create: async (a: { data: Row }) => {
        writes.push({ op: 'po.create', data: a.data });
        header = { ...a.data, purchase_order_id: 50n };
        return { purchase_order_id: 50n };
      },
      findUniqueOrThrow: async () => header,
      update: async (a: { data: Row }) => {
        writes.push({ op: 'po.update', data: a.data });
        header = { ...header, ...a.data };
      },
    },
    purchase_order_line: {
      findUnique: async () => seed.line ?? null,
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
    PO_NO: 'PO2606001',
    PO_SEQ_NO: 1,
    PLANT_CD: 'PL11',
    ITEM_CD: '040102-00009',
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    PO_TYPE_CD: 'PO',
    PO_DT: '2026-06-01',
    PO_QTY: 1000,
    BASE_UNIT: 'KG',
    SL_CD: 'WH31',
    BP_CD: '100627',
    PUR_GRP_CD: 'P11',
    IO_TYPE_CD: 'IGR',
    DLVY_DT: new Date('2026-06-30T00:00:00.000Z'),
    ...extra,
  };
}

describe('purchaseOrderTable', () => {
  it('처음 받으면 ERP 번호 그대로 등록 상태 발주와 라인을 만든다', async () => {
    const f = fake();

    await purchaseOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'po.create',
        data: {
          purchase_order_no: 'PO2606001',
          erp_purchase_order_no: 'PO2606001',
          status_code: 'REGISTERED',
          supplier_id: 7n,
          plant_id: 11n,
          business_unit_id: 1n,
          order_date: new Date('2026-06-01T00:00:00.000Z'),
          expected_receipt_date: new Date('2026-06-30T00:00:00.000Z'),
          erp_order_type_code: 'PO',
          erp_purchase_group_code: 'P11',
          erp_io_type_code: 'IGR',
        },
      },
      {
        op: 'line.create',
        data: {
          purchase_order_id: 50n,
          line_no: 1,
          item_id: 101n,
          ordered_qty: D(1000),
          uom_id: 3n,
          erp_storage_location_code: 'WH31',
          cancelled_at: null,
        },
      },
    ]);
  });

  it('같은 값이면 아무것도 바꾸지 않는다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await purchaseOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('헤더 칸이 바뀌면 헤더를 고치고 판을 올린다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await purchaseOrderTable.apply(
      f.tx,
      erp({ IF_SEQ: 2, DLVY_DT: new Date('2026-07-15T00:00:00.000Z') }),
    );

    expect(f.writes).toEqual([
      {
        op: 'po.update',
        data: expect.objectContaining({
          expected_receipt_date: new Date('2026-07-15T00:00:00.000Z'),
          version_no: { increment: 1 },
        }),
      },
    ]);
  });

  it('라인 수량·창고가 바뀌면 라인을 고친다', async () => {
    const f = fake({ header: HEADER, line: LINE });

    await purchaseOrderTable.apply(f.tx, erp({ PO_QTY: 1500, SL_CD: 'WH32' }));

    expect(f.writes).toEqual([
      {
        op: 'line.update',
        data: expect.objectContaining({ ordered_qty: D(1500), erp_storage_location_code: 'WH32' }),
      },
    ]);
  });

  it('입고된 수량 밑으로 줄이면 고치지 않고 실패한다', async () => {
    const f = fake({ header: HEADER, line: { ...LINE, received_qty: D(800) } });

    await expect(purchaseOrderTable.apply(f.tx, erp({ PO_QTY: 500 }))).rejects.toThrow('입고 수량');
    expect(f.writes).toEqual([]);
  });

  it('입고가 있는 라인의 품목을 바꾸면 실패한다', async () => {
    const f = fake({ header: HEADER, line: { ...LINE, received_qty: D(1) } });

    await expect(purchaseOrderTable.apply(f.tx, erp({ ITEM_CD: '040102-00023' }))).rejects.toThrow(
      '품목·단위를 바꿀 수 없다',
    );
  });

  it('취소(C)면 라인에 취소 시각을 찍고, 산 라인이 없으면 헤더를 CANCELLED 로 둔다', async () => {
    const f = fake({ header: HEADER, line: LINE, liveLines: 0 });

    await purchaseOrderTable.apply(f.tx, erp({ CREATE_TYPE: 'C' }));

    expect(f.writes.map((w) => w.op)).toEqual(['line.update', 'po.update']);
    expect(f.writes[0].data.cancelled_at).toBeInstanceOf(Date);
    expect(f.writes[1].data).toMatchObject({ status_code: 'CANCELLED' });
  });

  it('취소된 라인이 다시 A 로 오면 살리고 헤더를 REGISTERED 로 되돌린다', async () => {
    const f = fake({
      header: { ...HEADER, status_code: 'CANCELLED' },
      line: { ...LINE, cancelled_at: new Date() },
      liveLines: 1,
    });

    await purchaseOrderTable.apply(f.tx, erp({ IF_SEQ: 2 }));

    expect(f.writes.map((w) => w.op)).toEqual(['line.update', 'po.update']);
    expect(f.writes[0].data).toMatchObject({ cancelled_at: null });
    expect(f.writes[1].data).toMatchObject({ status_code: 'REGISTERED' });
  });

  it('거래처가 없으면 실패한다', async () => {
    await expect(purchaseOrderTable.apply(fake({ partner: false }).tx, erp())).rejects.toThrow(
      '거래처 100627 이 없다',
    );
  });
});
