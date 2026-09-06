import { Prisma } from '@prisma/client';

import { BomComponentRow, materialRequirements } from './requirement';

function component(id: bigint, requiredQty: string, itemId = 10n): BomComponentRow {
  return {
    bom_component_id: id,
    component_item_id: itemId,
    uom_id: 1n,
    required_qty: new Prisma.Decimal(requiredQty),
  };
}

describe('core/bom — BOM 소요식', () => {
  it('scrap_rate 를 곱하지 않는다', () => {
    // 스크랩률은 `BomComponentRow` 에 아예 없다 — 곱하려면 칸을 늘려야 한다(문의 037 · R-18).
    const [line] = materialRequirements(
      [component(1n, '0.5')],
      new Prisma.Decimal(100),
      new Prisma.Decimal(1),
    );

    // 5% 스크랩을 곱했다면 52.5 다.
    expect(line.requested_qty.toString()).toBe('50');
    expect(Object.keys(component(1n, '0.5'))).not.toContain('scrap_rate');
  });

  it('materialRequirements 는 Decimal 로 센다', () => {
    const lines = materialRequirements(
      [component(1n, '0.1', 10n), component(2n, '0.2', 11n)],
      new Prisma.Decimal(3),
      new Prisma.Decimal(7),
    );

    // 부동소수로 세면 0.1×3÷7 이 0.04285714285714286 으로 반올림 오차를 안는다.
    expect(lines.map((line) => line.requested_qty)).toEqual([
      new Prisma.Decimal('0.1').times(3).dividedBy(7),
      new Prisma.Decimal('0.2').times(3).dividedBy(7),
    ]);
    expect(lines[0].requested_qty).toBeInstanceOf(Prisma.Decimal);
    expect(lines.map((line) => line.line_no)).toEqual([1, 2]);
  });
});
