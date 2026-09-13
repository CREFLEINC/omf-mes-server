import { Prisma } from '@prisma/client';

import {
  InventoryCountLineRow,
  inventoryCountLineView,
  inventoryCountView,
} from './inventory-count-view';

const at = new Date('2026-09-09T01:02:03.000Z');

describe('재고 실사 응답 매핑', () => {
  it('헤더의 날짜와 bigint를 계약 필드로 옮긴다', () => {
    expect(
      inventoryCountView({
        inventory_count_id: 11n,
        inventory_count_no: 'IC-20260909-0001',
        count_type_code: 'CYCLE',
        warehouse_id: 21n,
        planned_date: new Date('2026-09-10T00:00:00.000Z'),
        blind_count: false,
        status_code: 'IN_PROGRESS',
        created_at: at,
        created_by: 1n,
        updated_at: at,
        updated_by: 1n,
        version_no: 3,
      }),
    ).toEqual({
      inventoryCountId: 11,
      inventoryCountNo: 'IC-20260909-0001',
      countTypeCode: 'CYCLE',
      warehouseId: 21,
      plannedDate: '2026-09-10',
      blindCount: false,
      statusCode: 'IN_PROGRESS',
    });
  });

  it('블라인드 미실사는 systemQty를 생략하고 차이를 0으로 가린다 — 통보 273', () => {
    const view = inventoryCountLineView(line({ counted: false }), true);

    expect(view).not.toHaveProperty('systemQty');
    expect(view).toMatchObject({ counted: false, countedQty: 0, varianceQty: 0 });
  });

  it('계수 완료 비블라인드 라인은 실제 수량·차이와 표시 필드를 전부 내린다', () => {
    expect(inventoryCountLineView(line({ counted: true }), false)).toMatchObject({
      inventoryCountLineId: 101,
      inventoryCountId: 11,
      lineNo: 2,
      locationId: 31,
      itemId: 41,
      lotId: 51,
      systemQty: 10,
      countedQty: 8,
      varianceQty: -2,
      uomId: 61,
      varianceReasonCode: 'COUNT_ERROR',
      countedBy: 71,
      countedAt: at.toISOString(),
      counted: true,
      itemCode: 'ITEM-1',
      itemName: '품목 1',
      lotNo: 'LOT-1',
      locationCode: 'A-01',
    });
  });
});

function line(over: Partial<InventoryCountLineRow>): InventoryCountLineRow {
  return {
    inventory_count_line_id: 101n,
    inventory_count_id: 11n,
    line_no: 2,
    location_id: 31n,
    item_id: 41n,
    lot_id: 51n,
    system_qty: new Prisma.Decimal(10),
    counted_qty: new Prisma.Decimal(8),
    variance_qty: new Prisma.Decimal(-2),
    uom_id: 61n,
    variance_reason_code: 'COUNT_ERROR',
    counted_by: 71n,
    counted_worker_id: null,
    counted_at: at,
    counted: true,
    created_at: at,
    created_by: 1n,
    item: { item_code: 'ITEM-1', item_name: '품목 1' },
    lot: { lot_no: 'LOT-1' },
    location: { location_code: 'A-01' },
    ...over,
  };
}
