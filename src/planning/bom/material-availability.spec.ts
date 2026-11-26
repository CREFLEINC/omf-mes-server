import { Prisma } from '@prisma/client';

import { ContractException } from '../../common/errors';
import { materialAvailability } from './material-availability';

const d = (value: number | string) => new Prisma.Decimal(value);

/** 수지(재고 KG · BOM GR) · 라벨(재고 EA · BOM EA) · 필름(재고 M2 · BOM SH, 환산 없음). */
function fakeDb(overrides: { warehouses?: bigint[]; productionWarehouses?: bigint[]; plant?: unknown } = {}) {
  const groupBy = jest.fn(async () => [
    { warehouse_id: 10n, item_id: 101n, _sum: { available_qty: d(3) } },
    { warehouse_id: 20n, item_id: 101n, _sum: { available_qty: d(1.5) } },
    { warehouse_id: 10n, item_id: 102n, _sum: { available_qty: d(50) } },
    { warehouse_id: 10n, item_id: 103n, _sum: { available_qty: d(999) } },
  ]);
  const component = (id: bigint, itemId: bigint, uomId: bigint, qty: number, code: string) => ({
    bom_component_id: id,
    component_item_id: itemId,
    uom_id: uomId,
    required_qty: d(qty),
    bom: { base_qty: d(1) },
    item: { item_code: code, item_name: `${code} 이름` },
  });
  const db = {
    plant: { findUnique: jest.fn(async () => ('plant' in overrides ? overrides.plant : { timezone_code: 'Asia/Ho_Chi_Minh' })) },
    bom_component: {
      findMany: jest.fn(async () => [
        component(1n, 101n, 2n, 36.7, 'RESIN'),
        component(2n, 102n, 3n, 2, 'LABEL'),
        component(3n, 103n, 5n, 1, 'FILM'),
      ]),
    },
    item: {
      findMany: jest.fn(async () => [
        { item_id: 101n, item_code: 'RESIN', base_uom_id: 1n },
        { item_id: 102n, item_code: 'LABEL', base_uom_id: 3n },
        { item_id: 103n, item_code: 'FILM', base_uom_id: 4n },
      ]),
    },
    uom: {
      findMany: jest.fn(async () => [
        { uom_id: 1n, uom_code: 'KG', decimal_scale: 3 },
        { uom_id: 2n, uom_code: 'GR', decimal_scale: 3 },
        { uom_id: 3n, uom_code: 'EA', decimal_scale: 0 },
        { uom_id: 4n, uom_code: 'M2', decimal_scale: 3 },
        { uom_id: 5n, uom_code: 'SH', decimal_scale: 0 },
      ]),
    },
    item_uom_conversion: { findMany: jest.fn(async () => []) },
    warehouse: { findMany: jest.fn(async () => (overrides.warehouses ?? [10n]).map((id) => ({ warehouse_id: id }))) },
    department_production_warehouse: {
      findMany: jest.fn(async () => (overrides.productionWarehouses ?? [20n, 10n]).map((id) => ({ warehouse_id: id }))),
    },
    inventory_balance: { groupBy },
  };
  return db as unknown as Prisma.TransactionClient & { inventory_balance: { groupBy: jest.Mock } };
}

const body = {
  plantId: 1,
  lines: [
    { bomComponentId: 1, quantity: 120 },
    { bomComponentId: 2, quantity: 25 },
    { bomComponentId: 3, quantity: 10 },
  ],
};

describe('materialAvailability', () => {
  it('배포와 같은 식으로 재고 단위 필요 수량을 내고 자재·생산 창고 가용 합과 견준다', async () => {
    const db = fakeDb();
    const { items } = await materialAvailability(db, body, null);

    expect(items[0]).toMatchObject({
      itemCode: 'RESIN',
      requiredQty: 4404,
      bomUomCode: 'GR',
      stockUomCode: 'KG',
      requiredStockQty: 4.404,
      availableQty: 4.5,
      statusCode: 'ENOUGH',
    });
    expect(items[1]).toMatchObject({ requiredQty: 50, requiredStockQty: 50, availableQty: 50, statusCode: 'ENOUGH' });
    // 창고는 중복 없이 한 번씩 묻는다.
    expect(db.inventory_balance.groupBy.mock.calls[0][0].where.warehouse_id).toEqual({ in: [10n, 20n] });
  });

  it('모자라면 SHORT, 환산이 없으면 비교하지 않고 NOT_COMPARABLE', async () => {
    const { items } = await materialAvailability(fakeDb(), { plantId: 1, lines: [{ bomComponentId: 1, quantity: 200 }, { bomComponentId: 3, quantity: 1 }] }, null);

    expect(items[0]).toMatchObject({ requiredStockQty: 7.34, availableQty: 4.5, statusCode: 'SHORT' });
    expect(items[1]).toMatchObject({ requiredStockQty: null, availableQty: 999, statusCode: 'NOT_COMPARABLE' });
  });

  it('창고가 없으면 재고를 묻지 않고 가용 0', async () => {
    const db = fakeDb({ warehouses: [], productionWarehouses: [] });
    const { items } = await materialAvailability(db, body, null);

    expect(db.inventory_balance.groupBy).not.toHaveBeenCalled();
    expect(items[1]).toMatchObject({ availableQty: 0, statusCode: 'SHORT' });
  });

  it('없는 공장·구성 행은 400, 범위 밖 공장은 403', async () => {
    await expect(materialAvailability(fakeDb({ plant: null }), body, null)).rejects.toMatchObject({ status: 400 });
    await expect(
      materialAvailability(fakeDb(), { plantId: 1, lines: [{ bomComponentId: 9, quantity: 1 }] }, null),
    ).rejects.toBeInstanceOf(ContractException);
    await expect(materialAvailability(fakeDb(), body, [2n])).rejects.toMatchObject({ status: 403 });
  });
});
