import { Prisma } from '@prisma/client';

import {
  ShipmentPickRow,
  ShipmentRequestRow,
  ShipmentRequestView,
  shipmentRequestView,
} from './shipment-request-view';

/**
 * ⭐⭐ 이 spec 이 널 정책의 **유일한 그물**이다 — `omitEmpty` 는 «e2e 로는» 반증할 수 없다.
 * `JSON.stringify` 가 값이 `undefined` 인 키를 이미 떨어뜨리므로 HTTP 응답만 보면 `omitEmpty` 를
 * 지워도 한 글자도 안 바뀐다. 그래서 저장소의 뷰 18벌이 전부 이 자리에 단위 spec 을 두고
 * `not.toHaveProperty` 로 「키가 «없다»」를 직접 본다(`inspection-result-view.spec.ts` 등).
 * ⛔ 이 파일을 지우면 §1-4-0 의 「널을 못 받는 선택 칸은 키를 생략한다」가 이 뷰에서 안 잠긴다.
 */

const T = new Date('2026-08-13T02:03:04.000Z');

function line(overrides: Partial<ShipmentRequestRow['shipment_request_line'][number]> = {}) {
  return {
    shipment_request_line_id: 501n,
    shipment_request_id: 1n,
    line_no: 1,
    sales_order_line_id: null,
    item_id: 41n,
    requested_qty: new Prisma.Decimal(120),
    allocated_qty: new Prisma.Decimal(90),
    shipped_qty: new Prisma.Decimal(30),
    uom_id: 21n,
    customer_lot_requirement: null,
    shipping_inspection_required: false,
    minimum_remaining_shelf_life_days: null,
    created_at: T,
    created_by: null,
    updated_at: T,
    updated_by: null,
    version_no: 1,
    ...overrides,
  };
}

function header(overrides: Partial<ShipmentRequestRow> = {}): ShipmentRequestRow {
  return {
    shipment_request_id: 1n,
    shipment_request_no: 'SR-2026-0813-0108',
    customer_id: 11n,
    ship_to_partner_id: 12n,
    requested_ship_date: new Date('2026-08-13T00:00:00.000Z'),
    status_code: 'STORED-NOT-EMITTED',
    created_at: T,
    created_by: null,
    updated_at: T,
    updated_by: null,
    version_no: 7,
    ship_time_slot_start: null,
    ship_time_slot_end: null,
    ship_time_slot_code: null,
    sales_order_id: null,
    shipment_request_line: [line()],
    ...overrides,
  };
}

function pick(overrides: Partial<ShipmentPickRow> = {}): ShipmentPickRow {
  return {
    inventory_reservation_id: 901n,
    reservation_no: 'RS-2026-000144',
    reservation_type_code: 'SHIPMENT',
    source_document_type_code: 'SHIPMENT_REQUEST_LINE',
    source_document_id: 501n,
    item_id: 41n,
    lot_id: 61n,
    warehouse_id: 31n,
    location_id: null,
    reserved_qty: new Prisma.Decimal(50),
    released_qty: new Prisma.Decimal(20),
    consumed_qty: new Prisma.Decimal(30),
    uom_id: 21n,
    status_code: 'REGISTERED',
    created_at: T,
    created_by: null,
    updated_at: T,
    updated_by: null,
    version_no: 1,
    lot: { lot_no: 'LOT-0001' },
    ...overrides,
  };
}

const picksOf = (...rows: ShipmentPickRow[]) => new Map([['501', rows]]);
const lineOf = (view: ShipmentRequestView) => (view.lines ?? [])[0];

describe('ShipmentRequest 뷰', () => {
  it('널 받는 5칸은 null 로, 나머지 선택 칸은 키를 생략한다 (omitEmpty)', () => {
    const view = shipmentRequestView(header(), picksOf(pick({ lot: null })), []);

    // `type: ['x','null']` 인 칸은 «키가 있고 값이 null» 이다 — 생략하면 화면이 못 읽는다.
    for (const key of ['salesOrderId', 'timeSlotCode']) {
      expect(Object.keys(view)).toContain(key);
      expect(view[key as 'salesOrderId']).toBeNull();
    }
    for (const key of ['salesOrderLineId', 'customerLotRequirement', 'minimumRemainingShelfLifeDays']) {
      expect(Object.keys(lineOf(view))).toContain(key);
    }
    expect(lineOf(view)).toMatchObject({
      salesOrderLineId: null,
      customerLotRequirement: null,
      minimumRemainingShelfLifeDays: null,
    });

    // ⭐ 반대쪽 — 널을 «못 받는» 선택 칸은 키 자체가 없어야 한다. `lot` 이 널인 예약 행이
    //   `omitEmpty` 의 유일한 도달 경로다(§1-4-0 7행).
    expect(Object.keys(lineOf(view).picks[0])).not.toContain('lotNo');
    expect(lineOf(view).picks[0]).not.toHaveProperty('lotNo');

    // 값이 있으면 그대로 싣는다 — 「늘 생략한다」로 짜면 여기서 깨진다.
    const filled = shipmentRequestView(
      header({ sales_order_id: 1001n, ship_time_slot_code: 'MORNING' }),
      picksOf(pick()),
      [],
    );
    expect(filled).toMatchObject({ salesOrderId: 1001, timeSlotCode: 'MORNING', versionNo: 7 });
    expect(lineOf(filled).picks[0].lotNo).toBe('LOT-0001');
  });

  it('picks 는 예약 행에서 나고 pickedQty 는 Σ(reserved − released) 다', () => {
    const view = shipmentRequestView(
      header(),
      picksOf(
        pick(),
        pick({
          inventory_reservation_id: 902n,
          reserved_qty: new Prisma.Decimal(15),
          released_qty: new Prisma.Decimal(0),
          consumed_qty: new Prisma.Decimal(0),
        }),
      ),
      [],
    );

    // 50 − 20 + 15 − 0 = 45. ⛔ `consumed_qty`(30)는 «안» 뺀다 — 빼면 15 가 되고 피킹 직후
    //   `P = 0` 이 되어 `PICKED` 가 영영 안 나온다(§1-4-1 · R-2 ⓒ안).
    expect(lineOf(view).pickedQty).toBe(45);
    // `picks[]` 는 예약 «행» 이라 그 `pickedQty` 는 `reserved_qty` 그대로다(넷이 required 넷과 1:1).
    expect(lineOf(view).picks).toEqual([
      { lotId: 61, lotNo: 'LOT-0001', pickedQty: 50, uomId: 21, pickedAt: T.toISOString() },
      { lotId: 61, lotNo: 'LOT-0001', pickedQty: 15, uomId: 21, pickedAt: T.toISOString() },
    ]);
    // 예약이 0건인 라인은 롤업이 0 이다 — `picks` 는 빈 배열이지 키 생략이 아니다(required).
    const bare = shipmentRequestView(header(), new Map(), []);
    expect(lineOf(bare).pickedQty).toBe(0);
    expect(lineOf(bare).picks).toEqual([]);
  });
});
