import { Prisma } from '@prisma/client';

import { ErrorItem } from '../../common/errors';
import { OrderSort, SortableOrder, orderByOf, readSort, sortComputed } from './purchase-order-list-sort';

const d = (value: number) => new Prisma.Decimal(value);
/** 하노이 2026-10-24 오전 — 현지 오늘은 10-24. */
const NOW = new Date('2026-10-24T02:00:00.000Z');

const line = (ordered: number, received: number) => ({
  item_id: 1n,
  uom_id: 1n,
  ordered_qty: d(ordered),
  received_qty: d(received),
  cancelled_at: null,
  uom: { uom_code: 'EA' },
});

const order = (id: bigint, overrides: Partial<SortableOrder> = {}): SortableOrder => ({
  purchase_order_id: id,
  status_code: 'CONFIRMED',
  expected_receipt_date: new Date('2026-10-30T00:00:00.000Z'),
  plant: { timezone_code: 'Asia/Ho_Chi_Minh' },
  purchase_order_line: [line(10, 0)],
  ...overrides,
});

const ids = (rows: SortableOrder[]) => rows.map((row) => row.purchase_order_id);

describe('readSort — sort=열,방향', () => {
  const read = (sort: unknown) => {
    const errors: ErrorItem[] = [];
    return { sort: readSort({ sort }, errors), errors };
  };

  it('없으면 정렬 없음 · 방향을 빼면 asc', () => {
    expect(read(undefined)).toEqual({ sort: undefined, errors: [] });
    expect(read('orderDate').sort).toEqual({ key: 'orderDate', direction: 'asc' });
    expect(read('inboundStage,desc').sort).toEqual({ key: 'inboundStage', direction: 'desc' });
  });

  it.each(['nope', 'orderDate,up', 'orderDate,asc,x', ''])('「%s」는 400 sort INVALID 다', (value) => {
    expect(read(value).errors).toEqual([expect.objectContaining({ field: 'sort', code: 'INVALID' })]);
  });

  it('배열(sort 를 두 번 보냄)도 400 이다', () => {
    expect(read(['orderDate', 'purchaseOrderNo']).errors).toHaveLength(1);
  });
});

describe('orderByOf — DB 열', () => {
  it('없으면 지금 순서 그대로 — 발주일 최신 → id 내림', () => {
    expect(orderByOf(undefined)).toEqual([{ order_date: 'desc' }, { purchase_order_id: 'desc' }]);
  });

  it('납기는 방향과 상관없이 없는 것이 맨 뒤다', () => {
    expect(orderByOf({ key: 'expectedReceiptDate', direction: 'desc' })[0]).toEqual({
      expected_receipt_date: { sort: 'desc', nulls: 'last' },
    });
  });

  it('공급사명은 공급사의 이름으로, 같으면 id 내림이다', () => {
    expect(orderByOf({ key: 'supplierName', direction: 'asc' })).toEqual([
      { partner: { partner_name: 'asc' } },
      { purchase_order_id: 'desc' },
    ]);
  });
});

describe('sortComputed — 계산 열', () => {
  const sort = (key: OrderSort['key'], direction: OrderSort['direction'], rows: SortableOrder[], counts = new Map()) =>
    ids(sortComputed(rows, { key, direction }, NOW, counts));

  it('overdue asc — 지연 → 정상 → 끝남. 지연은 남은 발주이고 납기가 공장 현지 오늘보다 앞이다', () => {
    const rows = [
      order(1n, { purchase_order_line: [line(10, 10)] }), // 다 받음 → 끝남
      order(2n), // 납기 10-30 → 정상
      order(3n, { expected_receipt_date: new Date('2026-10-23T00:00:00.000Z') }), // 지연
      order(4n, { expected_receipt_date: new Date('2026-10-24T00:00:00.000Z') }), // 오늘 납기는 지연 아님
      order(5n, { status_code: 'CLOSED', expected_receipt_date: new Date('2026-10-01T00:00:00.000Z') }), // 닫힘 → 끝남
      order(6n, { expected_receipt_date: null }), // 납기 없음 → 정상
    ];
    expect(sort('overdue', 'asc', rows)).toEqual([3n, 6n, 4n, 2n, 5n, 1n]);
    expect(sort('overdue', 'desc', rows)).toEqual([5n, 1n, 6n, 4n, 2n, 3n]);
  });

  it('openLineCount — 미입고 라인 수, 같으면 id 내림', () => {
    const rows = [order(1n, { purchase_order_line: [line(10, 0), line(5, 0)] }), order(2n), order(3n, { purchase_order_line: [line(1, 1)] })];
    expect(sort('openLineCount', 'asc', rows)).toEqual([3n, 2n, 1n]);
    expect(sort('openLineCount', 'desc', rows)).toEqual([1n, 2n, 3n]);
  });

  it('inboundStage — 가장 뒤처진 묶음(흐름 순서) → 그 묶음 수 · 묶음이 없는 발주는 방향과 상관없이 맨 뒤', () => {
    const rows = [order(1n), order(2n), order(3n), order(4n), order(5n)];
    const counts = new Map([
      [1n, { PUTAWAY: 3 }],
      [2n, { LABEL: 1, RECEIPT: 9 }],
      [3n, { HELD: 2 }],
      [4n, {}],
      [5n, { LABEL: 2 }],
    ]);
    expect(sort('inboundStage', 'asc', rows, counts)).toEqual([2n, 5n, 3n, 1n, 4n]);
    expect(sort('inboundStage', 'desc', rows, counts)).toEqual([1n, 3n, 5n, 2n, 4n]);
  });
});
