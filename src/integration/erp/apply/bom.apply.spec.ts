import { Prisma } from '@prisma/client';

import { Tx } from '../inbound-cycle';
import { RelayRow } from '../relay-tables';
import { bomTable } from './bom.apply';

const D = (value: number | string): Prisma.Decimal => new Prisma.Decimal(value);
type Row = Record<string, unknown>;

const ITEMS: Record<string, bigint> = {
  P1: 1n,
  C1: 11n,
  C2: 12n,
  C3: 13n,
  'FS-536（SD）': 20n,
};
const UOMS: Record<string, bigint> = { EA: 1n, GR: 2n, KG: 3n };

interface Component {
  bom_component_id: bigint;
  component_item_id: bigint;
  required_qty: Prisma.Decimal;
  uom_id: bigint;
  sequence_no: number;
  erp_child_item_seq: number | null;
  routing_operation_id: bigint | null;
  actual_use_process_id: bigint | null;
  lot_trace_required: boolean;
  backflush_allowed: boolean;
  scrap_rate: Prisma.Decimal;
  is_mandatory: boolean;
}

function component(
  id: number,
  itemId: bigint,
  qty: number,
  seq: number | null,
  extra: Partial<Component> = {},
): Component {
  return {
    bom_component_id: BigInt(id),
    component_item_id: itemId,
    required_qty: D(qty),
    uom_id: 1n,
    sequence_no: id,
    erp_child_item_seq: seq,
    routing_operation_id: null,
    actual_use_process_id: null,
    lot_trace_required: false,
    backflush_allowed: false,
    scrap_rate: D(0),
    is_mandatory: true,
    ...extra,
  };
}

function bom(components: Component[], extra: Row = {}): Row {
  return {
    bom_id: 100n,
    bom_version: 1,
    status_code: 'CONFIRMED',
    base_qty: D(1),
    base_uom_id: 1n,
    effective_from: new Date('2026-08-25T00:00:00.000Z'),
    bom_component: components,
    ...extra,
  };
}

/** 품목·단위·공장·BOM. 쓰기는 `writes` 에 남긴다. */
function fake(current: Row | null = null) {
  const writes: { op: string; args: Row }[] = [];
  const record = (op: string) => async (args: Row) => void writes.push({ op, args });
  const tx = {
    item: {
      findMany: async (a: { where: { item_code: { in: string[] } } }) =>
        a.where.item_code.in
          .filter((code) => ITEMS[code] !== undefined)
          .map((code) => ({ item_code: code, item_id: ITEMS[code] })),
      findUniqueOrThrow: async () => ({ base_uom_id: 1n }),
    },
    $queryRaw: async (_: TemplateStringsArray, normalized: string[]) =>
      Object.entries(ITEMS)
        .filter(([code]) => normalized.includes(code.normalize('NFKC')))
        .map(([item_code, item_id]) => ({ item_code, item_id })),
    uom: {
      findMany: async (a: { where: { uom_code: { in: string[] } } }) =>
        a.where.uom_code.in
          .filter((code) => UOMS[code] !== undefined)
          .map((code) => ({ uom_code: code, uom_id: UOMS[code] })),
    },
    plant: { findMany: async () => [{ timezone_code: 'Asia/Ho_Chi_Minh' }] },
    bom: {
      findFirst: async () => current,
      update: record('bom.update'),
      create: record('bom.create'),
    },
    bom_component: { update: record('component.update') },
  };
  return { tx: tx as unknown as Tx, writes };
}

function erp(child: string, seq: number, qty: number, extra: Row = {}): RelayRow {
  return {
    MES_INF_ID: seq + 1,
    PLANT_CD: 'PL11',
    PRNT_ITEM_CD: 'P1',
    CHILD_ITEM_SEQ: seq,
    CHILD_ITEM_CD: child,
    IF_SEQ: 1,
    CREATE_TYPE: 'A',
    PRNT_ITEM_QTY: 1,
    CHILD_ITEM_QTY: qty,
    PRNT_ITEM_UNIT: 'EA',
    CHILD_ITEM_UNIT: 'EA',
    ...extra,
  };
}

/** 새 판의 구성품을 (자품목, 수량, sequence_no, ERP 순번) 으로. */
function createdComponents(writes: { op: string; args: Row }[]): unknown[][] {
  const created = writes.find((w) => w.op === 'bom.create');
  const data = (created?.args.data ?? {}) as { bom_component: { create: Row[] } };
  return data.bom_component.create.map((c) => [
    c.component_item_id,
    (c.required_qty as Prisma.Decimal).toString(),
    c.sequence_no,
    c.erp_child_item_seq,
  ]);
}

describe('bomTable', () => {
  it('처음 받으면 판 1 을 만든다 — sequence_no 는 ERP 순번 순으로 1 부터, 순번 0·소요량 0 도 받는다', async () => {
    const f = fake();

    await bomTable.applyUnit(f.tx, [erp('C2', 10, 2.5), erp('C1', 0, 0)]);

    expect(f.writes.map((w) => w.op)).toEqual(['bom.create']);
    expect(f.writes[0].args.data).toMatchObject({
      parent_item_id: 1n,
      bom_code: 'ERP-P1',
      bom_version: 1,
      status_code: 'CONFIRMED',
      is_default: true,
      base_uom_id: 1n,
    });
    expect(createdComponents(f.writes)).toEqual([
      [11n, '0', 1, 0],
      [12n, '2.5', 2, 10],
    ]);
  });

  it('행마다 모품목 기준수량이 다르면 최소공배수로 맞춘다', async () => {
    const f = fake();

    await bomTable.applyUnit(f.tx, [
      erp('C1', 10, 3, { PRNT_ITEM_QTY: 16 }),
      erp('C2', 20, 2, { PRNT_ITEM_QTY: 1 }),
    ]);

    expect((f.writes[0].args.data as Row).base_qty).toEqual(D(16));
    expect(createdComponents(f.writes)).toEqual([
      [11n, '3', 1, 10],
      [12n, '32', 2, 20],
    ]);
  });

  it('결과가 같으면 판을 만들지 않는다', async () => {
    const f = fake(bom([component(1, 11n, 3, 10), component(2, 12n, 2, 20)]));

    await bomTable.applyUnit(f.tx, [erp('C1', 10, 3), erp('C2', 20, 2)]);

    expect(f.writes).toEqual([]);
  });

  it('바뀐 구성품이 오면 새 판을 만들고 이전 판을 OBSOLETE 로 닫으며 MES 확장 칸을 옮긴다', async () => {
    const f = fake(
      bom([
        component(1, 11n, 3, 10, { routing_operation_id: 7n, backflush_allowed: true }),
        component(2, 12n, 2, 20, { actual_use_process_id: 8n, lot_trace_required: true }),
      ]),
    );

    await bomTable.applyUnit(f.tx, [erp('C2', 20, 5, { IF_SEQ: 2 })]);

    expect(f.writes.map((w) => w.op)).toEqual(['bom.update', 'bom.create']);
    expect(f.writes[0].args).toMatchObject({
      where: { bom_id: 100n },
      data: { is_default: false, status_code: 'OBSOLETE', version_no: { increment: 1 } },
    });
    expect(f.writes[1].args.data).toMatchObject({ bom_version: 2 });
    expect(createdComponents(f.writes)).toEqual([
      [11n, '3', 1, 10],
      [12n, '5', 2, 20],
    ]);
    const created = (f.writes[1].args.data as { bom_component: { create: Row[] } }).bom_component
      .create;
    // 안 바뀐 구성품도, ERP 가 고친 구성품도 이전 판의 확장 칸을 이어받는다.
    expect(created[0]).toMatchObject({ routing_operation_id: 7n, backflush_allowed: true });
    expect(created[1]).toMatchObject({ actual_use_process_id: 8n, lot_trace_required: true });
  });

  it('구성품 하나를 취소하면 그 구성품이 빠진 새 판이 생긴다', async () => {
    const f = fake(bom([component(1, 11n, 3, 10), component(2, 12n, 2, 20)]));

    await bomTable.applyUnit(f.tx, [erp('C1', 10, 3, { CREATE_TYPE: 'C' })]);

    expect(createdComponents(f.writes)).toEqual([[12n, '2', 1, 20]]);
  });

  it('구성품이 모두 취소되면 이전 판만 닫는다', async () => {
    const f = fake(bom([component(1, 11n, 3, 10)]));

    await bomTable.applyUnit(f.tx, [erp('C1', 10, 3, { CREATE_TYPE: 'C' })]);

    expect(f.writes.map((w) => w.op)).toEqual(['bom.update']);
  });

  it('ERP 순번이 없는 기존 판(운영 초기 데이터)은 자품목 순서가 같으면 순번만 채운다', async () => {
    // 초기 데이터는 순번 0 이 있으면 +1 해서 sequence_no 로 넣었다.
    const f = fake(bom([component(1, 11n, 3, null), component(2, 12n, 2, null)]));

    await bomTable.applyUnit(f.tx, [erp('C1', 0, 3), erp('C2', 10, 2)]);

    expect(f.writes).toEqual([
      {
        op: 'component.update',
        args: { where: { bom_component_id: 1n }, data: { erp_child_item_seq: 0 } },
      },
      {
        op: 'component.update',
        args: { where: { bom_component_id: 2n }, data: { erp_child_item_seq: 10 } },
      },
    ]);
  });

  it('ERP 순번이 없는 기존 판이라도 값이 다르면 새 판을 만든다 — 초기 데이터가 0 을 1 로 넣은 자리', async () => {
    const f = fake(bom([component(1, 11n, 1, null), component(2, 12n, 2, null)]));

    await bomTable.applyUnit(f.tx, [erp('C1', 0, 0), erp('C2', 10, 2)]);

    expect(createdComponents(f.writes)).toEqual([
      [11n, '0', 1, 0],
      [12n, '2', 2, 10],
    ]);
  });

  it('ERP 순번이 없는 기존 판과 자품목 순서가 다르면 고르지 않고 실패한다', async () => {
    const f = fake(bom([component(1, 12n, 2, null), component(2, 11n, 3, null)]));

    await expect(bomTable.applyUnit(f.tx, [erp('C1', 0, 3), erp('C2', 10, 2)])).rejects.toThrow(
      '자품목 순서가 다르다',
    );
  });

  it('자품목을 못 찾으면 모품목 전체가 실패한다', async () => {
    const f = fake();

    await expect(bomTable.applyUnit(f.tx, [erp('C1', 10, 3), erp('NOPE', 20, 1)])).rejects.toThrow(
      '품목 NOPE 이 없다',
    );
    expect(f.writes).toEqual([]);
  });

  it('반각으로 적힌 품목코드는 NFKC 로 전각 품목을 찾는다', async () => {
    const f = fake();

    await bomTable.applyUnit(f.tx, [erp('FS-536(SD)', 10, 1)]);

    expect(createdComponents(f.writes)).toEqual([[20n, '1', 1, 10]]);
  });

  it('두 공장에서 온 BOM 은 실패한다', async () => {
    await expect(
      bomTable.applyUnit(fake().tx, [erp('C1', 10, 3), erp('C2', 20, 2, { PLANT_CD: 'PL13' })]),
    ).rejects.toThrow('두 공장');
  });
});
