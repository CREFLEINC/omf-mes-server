import { Prisma } from '@prisma/client';

import { ReceiptDefaultsService } from '../../logistics/goods-receipt/receipt-defaults.service';
import { matchErpWarehouse } from './erp-warehouse-match';
import { resolveFgLocation } from './fg-location';

jest.mock('./erp-warehouse-match', () => {
  const actual = jest.requireActual<typeof import('./erp-warehouse-match')>('./erp-warehouse-match');
  return { ...actual, matchErpWarehouse: jest.fn(actual.matchErpWarehouse) };
});
jest.mock('../../logistics/goods-receipt/lot-receivable', () => ({
  inboundLineOfLot: jest.fn(async () => 1n),
  receivableQtyOf: jest.fn(async () => new Map([[1n, new Prisma.Decimal(5)]])),
  receivingInboundLotOf: jest.fn(async () => new Map()),
}));

/**
 * 같은 SL_CD 가 구매입고와 생산 완제품 위치에서 같은 창고로 풀리는지 — 두 곳이 «같은 매칭 함수»를 부르는 것을 고정한다.
 * 한쪽이 자기 매칭을 따로 두면 이 시험이 깨진다.
 */
describe('구매입고와 생산 완제품 위치는 같은 ERP 창고 매칭 함수를 쓴다', () => {
  const matcher = matchErpWarehouse as jest.Mock;
  const warehouses = [
    { warehouse_id: 10n, warehouse_code: 'S10', warehouse_name: '완제품', plant_id: 1n, warehouse_type_code: 'PRODUCT', is_active: true, is_defect: false, is_external: false },
    { warehouse_id: 13n, warehouse_code: 'S13', warehouse_name: '타공장', plant_id: 2n, warehouse_type_code: 'PRODUCT', is_active: true, is_defect: false, is_external: false },
  ];
  const locations = [{ location_id: 100n, warehouse_id: 10n, location_code: 'WH', location_name: '창고 전체', is_active: true, system_role_code: 'WAREHOUSE_WHOLE' }];
  const db = {
    warehouse: { findMany: jest.fn(async ({ where }: { where: { warehouse_code: { in: string[] } } }) => warehouses.filter((row) => where.warehouse_code.in.includes(row.warehouse_code))) },
    location: {
      findFirst: jest.fn(async ({ where }: { where: { system_role_code?: string | null } }) => {
        const row = locations.find((candidate) => where.system_role_code === undefined || candidate.system_role_code === where.system_role_code);
        return row === undefined ? null : { location_id: row.location_id };
      }),
      findMany: jest.fn(async () => locations.map((row) => ({ warehouse_id: row.warehouse_id, location_id: row.location_id, location_code: row.location_code }))),
      findUniqueOrThrow: jest.fn(async () => locations[0]),
    },
    lot: { findMany: jest.fn(async () => [{ lot_id: 1n, lot_no: 'L1', item_id: 1n, uom_id: 1n, status_code: 'NORMAL' }]) },
    inbound_receipt_line: {
      findMany: jest.fn(async () => [{
        inbound_receipt_line_id: 1n,
        inbound_receipt: { inbound_receipt_id: 1n, plant_id: 1n, status_code: 'ARRIVED' },
        inbound_receipt_po_allocation: [{ purchase_order_line: { erp_storage_location_code: 'S13' } }],
      }]),
    },
    department_production_warehouse: {},
  } as never;

  beforeEach(() => matcher.mockClear());

  it('구매입고 기본값이 매칭 함수를 부르고, 결과(다른 공장 창고)를 그대로 따른다', async () => {
    const [defaults] = await new ReceiptDefaultsService(db).of([1n]);

    expect(matcher).toHaveBeenCalledWith('S13', 1n, expect.any(Array));
    expect(defaults.issues.map((issue) => issue.code)).toEqual(['OTHER_PLANT_WAREHOUSE']);
  });

  it('생산 완제품 위치가 같은 매칭 함수를 부르고, 같은 입력에 같은 결론이다', async () => {
    const result = await resolveFgLocation(db, { plantId: 1n, erpCode: 'S13' });

    expect(matcher).toHaveBeenCalledWith('S13', 1n, expect.any(Array));
    expect(result).toEqual({ kind: 'LINK_FAILED', erpCode: 'S13', reason: 'FG_WAREHOUSE_OTHER_PLANT' });
  });

  it('같은 SL_CD 가 두 곳에서 같은 MES 창고로 풀린다', async () => {
    (db as unknown as { inbound_receipt_line: { findMany: jest.Mock } }).inbound_receipt_line.findMany.mockResolvedValueOnce([{
      inbound_receipt_line_id: 1n,
      inbound_receipt: { inbound_receipt_id: 1n, plant_id: 1n, status_code: 'ARRIVED' },
      inbound_receipt_po_allocation: [{ purchase_order_line: { erp_storage_location_code: 'S10' } }],
    }]);
    const [defaults] = await new ReceiptDefaultsService(db).of([1n]);
    const fg = await resolveFgLocation(db, { plantId: 1n, erpCode: 'S10' });

    expect(defaults.warehouseId).toBe(10);
    expect(fg).toMatchObject({ kind: 'ERP_STORAGE_LOCATION', warehouse: { id: 10n } });
  });
});
