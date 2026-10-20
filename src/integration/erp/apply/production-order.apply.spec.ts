import { Prisma } from '@prisma/client';

import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { productionOrderTable } from './production-order.apply';

const D = (value: number): Prisma.Decimal => new Prisma.Decimal(value);
type Row = Record<string, unknown>;

const ORDER = {
  production_order_id: 90n,
  production_order_no: 'PD260523000018',
  erp_order_no: 'PD260523000018',
  plant_id: 13n,
  item_id: 301n,
  uom_id: 1n,
  order_qty: D(30),
  planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
  erp_operation_no: '010',
  erp_storage_location_code: 'S510',
  erp_rework_flag: 'N',
  remarks: null,
  status_code: 'RECEIVED',
};

/** 공장·품목·단위·ERP W/O. 쓰기는 `writes` 에 남긴다. */
function fake(order: Row | null = null) {
  const writes: { op: string; data: unknown }[] = [];
  const tx = {
    plant: {
      findMany: async () => [
        { plant_id: 13n, business_unit_id: 2n, timezone_code: 'Asia/Ho_Chi_Minh' },
      ],
    },
    item: {
      findMany: async () => [
        { item_code: 'A4F3WY7', item_id: 301n },
        { item_code: 'A3EPWYC', item_id: 302n },
      ],
    },
    uom: { findMany: async () => [{ uom_code: 'EA', uom_id: 1n }] },
    $queryRaw: async () =>
      order === null ? [] : [{ production_order_id: order.production_order_id }],
    production_order: {
      create: async (a: { data: Row }) => writes.push({ op: 'create', data: a.data }),
      findUniqueOrThrow: async () => order,
      update: async (a: { data: Row }) => writes.push({ op: 'update', data: a.data }),
    },
    production_order_change_field: {
      deleteMany: async () => writes.push({ op: 'fields.delete', data: null }),
      createMany: async (a: { data: Row[] }) => writes.push({ op: 'fields.create', data: a.data }),
    },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: 1,
    PLANT_CD: 'PL13',
    PRODT_ORDER_NO: 'PD260523000018',
    ITEM_CD: 'A4F3WY7',
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    OPR_NO: '010',
    PLAN_START_DT: '2026-06-08',
    PRODT_ORDER_QTY: 30,
    BASE_UNIT: 'EA',
    RE_WORK_FLG: 'N',
    REMARK: '',
    SL_CD: 'S510',
    ...extra,
  };
}

const updateOf = (writes: { op: string; data: unknown }[]) =>
  writes.find((w) => w.op === 'update')?.data as Row;
const fieldsOf = (writes: { op: string; data: unknown }[]) =>
  writes.find((w) => w.op === 'fields.create')?.data;

describe('productionOrderTable', () => {
  it('처음 받으면 ERP 번호 그대로 RECEIVED 로 만들고 계획 시작일을 담는다 — 납기는 비운다', async () => {
    const f = fake();

    await productionOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([
      {
        op: 'create',
        data: {
          production_order_no: 'PD260523000018',
          erp_order_no: 'PD260523000018',
          business_unit_id: 2n,
          plant_id: 13n,
          item_id: 301n,
          uom_id: 1n,
          order_qty: D(30),
          planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
          erp_operation_no: '010',
          erp_storage_location_code: 'S510',
          erp_rework_flag: 'N',
          remarks: null,
          status_code: 'RECEIVED',
        },
      },
    ]);
  });

  it('처음 받는 행이 취소(C)면 CANCELLED 로 만든다', async () => {
    const f = fake();

    await productionOrderTable.apply(f.tx, erp({ CREATE_TYPE: 'C' }));

    expect(f.writes[0].data).toMatchObject({ status_code: 'CANCELLED' });
  });

  it('같은 값이면 아무것도 바꾸지 않는다 — 수신 시각도 찍지 않는다', async () => {
    const f = fake(ORDER);

    await productionOrderTable.apply(f.tx, erp());

    expect(f.writes).toEqual([]);
  });

  it('수량이 바뀌면 이전 수량만 남기고 UPDATED·수신 시각·판을 올린다', async () => {
    const f = fake(ORDER);

    await productionOrderTable.apply(f.tx, erp({ IF_SEQ: 2, PRODT_ORDER_QTY: 20 }));

    expect(f.writes.map((w) => w.op)).toEqual(['fields.delete', 'fields.create', 'update']);
    expect(fieldsOf(f.writes)).toEqual([
      { production_order_id: 90n, field_code: 'ORDER_QTY', before_order_qty: D(30) },
    ]);
    expect(updateOf(f.writes)).toMatchObject({
      order_qty: D(20),
      status_code: 'UPDATED',
      last_change_received_at: expect.any(Date),
      version_no: { increment: 1 },
    });
  });

  it('계획 시작일이 바뀌면 이전 시작일을 남긴다', async () => {
    const f = fake(ORDER);

    await productionOrderTable.apply(f.tx, erp({ IF_SEQ: 2, PLAN_START_DT: '2026-06-10' }));

    expect(fieldsOf(f.writes)).toEqual([
      {
        production_order_id: 90n,
        field_code: 'PLANNED_START_DATE',
        before_planned_start_date: new Date('2026-06-08T00:00:00.000Z'),
      },
    ]);
  });

  it('세 항목 밖(창고)만 바뀌어도 변경으로 받는다 — 지난 항목 행은 비운다', async () => {
    const f = fake({ ...ORDER, status_code: 'UPDATED' });

    await productionOrderTable.apply(f.tx, erp({ IF_SEQ: 2, SL_CD: 'S520' }));

    expect(f.writes.map((w) => w.op)).toEqual(['fields.delete', 'update']);
    expect(updateOf(f.writes)).toMatchObject({
      erp_storage_location_code: 'S520',
      last_change_received_at: expect.any(Date),
    });
  });

  it('취소(C)면 CANCELLED 로 두고 이전 상태를 남긴다 — 다른 칸은 보지 않는다', async () => {
    const f = fake(ORDER);

    await productionOrderTable.apply(
      f.tx,
      erp({ CREATE_TYPE: 'C', PRODT_ORDER_QTY: 1, ITEM_CD: 'A3EPWYC' }),
    );

    expect(fieldsOf(f.writes)).toEqual([
      { production_order_id: 90n, field_code: 'STATUS_CODE', before_status_code: 'RECEIVED' },
    ]);
    expect(updateOf(f.writes)).toEqual({
      status_code: 'CANCELLED',
      last_change_received_at: expect.any(Date),
      updated_by: null,
      version_no: { increment: 1 },
    });
  });

  it('이미 취소된 ERP W/O 에 취소가 또 오면 아무것도 바꾸지 않는다', async () => {
    const f = fake({ ...ORDER, status_code: 'CANCELLED' });

    await productionOrderTable.apply(f.tx, erp({ CREATE_TYPE: 'C' }));

    expect(f.writes).toEqual([]);
  });

  it('취소된 ERP W/O 가 다시 A 로 오면 UPDATED 로 되살리고 이전 상태를 남긴다', async () => {
    const f = fake({ ...ORDER, status_code: 'CANCELLED' });

    await productionOrderTable.apply(f.tx, erp({ IF_SEQ: 2 }));

    expect(fieldsOf(f.writes)).toEqual([
      { production_order_id: 90n, field_code: 'STATUS_CODE', before_status_code: 'CANCELLED' },
    ]);
    expect(updateOf(f.writes)).toMatchObject({ status_code: 'UPDATED' });
  });

  it('품목이 바뀌면 고치지 않고 실패한다', async () => {
    const f = fake(ORDER);

    await expect(productionOrderTable.apply(f.tx, erp({ ITEM_CD: 'A3EPWYC' }))).rejects.toThrow(
      '공장·품목·단위가 바뀌었다',
    );
    expect(f.writes).toEqual([]);
  });

  it('MES 가 만든 같은 번호의 ERP W/O 가 있으면 실패한다', async () => {
    const f = fake({ ...ORDER, erp_order_no: null });

    await expect(productionOrderTable.apply(f.tx, erp())).rejects.toThrow('번호가 겹친다');
  });
});
