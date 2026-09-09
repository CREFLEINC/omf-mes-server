import { Prisma } from '@prisma/client';

import { ShipmentAllocationRow, matchView, shipmentLotAllocationView } from './shipment-allocation-view';

/**
 * ⭐⭐ 이 spec 이 널 정책의 «유일한» 그물이다 — `omitEmpty` 는 e2e 로는 반증되지 않는다
 * (README §6-3 ⑹) — `JSON.stringify` 가 `undefined` 키를 이미 떨어뜨려, HTTP 응답만 보면
 * `omitEmpty` 를 지워도 한 글자도 안 바뀐다. ③b 가 이 자리를 빠뜨려 Major 를 받았다.
 */

function row(overrides: Partial<ShipmentAllocationRow> = {}): ShipmentAllocationRow {
  return {
    shipment_lot_allocation_id: 901n,
    shipment_id: 101n,
    shipment_line_id: 201n,
    item_id: 41n,
    item_code: 'ABC-123',
    lot_id: 61n,
    lot_no: 'LOT-0001',
    handling_unit_id: null,
    warehouse_id: 31n,
    allocated_qty: new Prisma.Decimal(120),
    uom_id: 21n,
    ...overrides,
  };
}

describe('ShipmentLotAllocation 뷰', () => {
  it('handlingUnitId 는 null 로 내리고 lotNo 는 값이 없으면 키를 생략한다', () => {
    const withHu = shipmentLotAllocationView(row({ handling_unit_id: 501n }), true);
    expect(withHu.handlingUnitId).toBe(501);

    const withoutHu = shipmentLotAllocationView(row({ handling_unit_id: null }), true);
    // `handlingUnitId` 는 널을 «받는» 칸 — 키가 있고 값이 null 이다(생략하면 화면이 못 읽는다).
    expect(Object.keys(withoutHu)).toContain('handlingUnitId');
    expect(withoutHu.handlingUnitId).toBeNull();

    const noLot = shipmentLotAllocationView(row({ lot_no: null }), true);
    expect(noLot).not.toHaveProperty('lotNo');
    const withLot = shipmentLotAllocationView(row({ lot_no: 'LOT-0002' }), true);
    expect(withLot.lotNo).toBe('LOT-0002');
  });

  it('packedQty 는 HU 없으면 0, 있으면 allocatedQty 다', () => {
    expect(shipmentLotAllocationView(row({ handling_unit_id: null, allocated_qty: new Prisma.Decimal(80) }), true).packedQty).toBe(0);
    expect(shipmentLotAllocationView(row({ handling_unit_id: 501n, allocated_qty: new Prisma.Decimal(80) }), true).packedQty).toBe(80);
  });

  it('oqcPassed 는 호출자가 넘긴 값을 그대로 싣는다', () => {
    expect(shipmentLotAllocationView(row(), true).oqcPassed).toBe(true);
    expect(shipmentLotAllocationView(row(), false).oqcPassed).toBe(false);
  });
});

describe('match 뷰', () => {
  it('⭐⭐ matched=true 면 reasonCode 키가 «없다» — null 을 실으면 ajv 가 깨진다(R-8)', () => {
    const matched = matchView(true);
    expect(matched).not.toHaveProperty('reasonCode');
    expect(matched.matched).toBe(true);
    // 원시 키 목록으로도 직접 본다 — `undefined` 값 자체가 있으면 안 된다.
    expect(Object.keys(matched)).toEqual(['matched']);
  });

  it('matched=false 는 사유 코드를 싣는다', () => {
    expect(matchView(false, 'LOT_NOT_ALLOCATED')).toEqual({
      matched: false,
      reasonCode: 'LOT_NOT_ALLOCATED',
    });
    expect(matchView(false, 'LABEL_ITEM_MISMATCH').reasonCode).toBe('LABEL_ITEM_MISMATCH');
  });
});
