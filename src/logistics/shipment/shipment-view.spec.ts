import { ShipmentLotAllocationView } from '../shipment-allocation/shipment-allocation-view';
import {
  ShipmentLineRow,
  ShipmentRow,
  shipmentDetailView,
  shipmentLineView,
  shipmentView,
} from './shipment-view';

/**
 * ⭐⭐ **숫자 축을 모두 «다른» 값으로 둔다**(README §6-3 ⑵). `shipmentId`·`shipmentRequestId`·
 * `warehouseId`·`loadingWorkerId`·`carrierId`·`versionNo` 가 같은 값이면 출처를 뒤바꿔도 단언이
 * 초록이다 — I-22 PR ② 가 헤더 스키마를 0건 겨눠 세 변이가 살아남았던 자리다(§6-3 ⑴).
 */
function row(overrides: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    shipment_id: 11n,
    shipment_no: 'SH-20260910-0001',
    shipment_request_id: 22n,
    warehouse_id: 33n,
    vehicle_no: '51C-12345',
    driver_name: 'Nguyen',
    seal_no: 'SEAL-7',
    transport_document_no: 'TD-9',
    loading_worker_id: 44n,
    carrier_id: 55n,
    loaded_at: new Date('2026-09-10T01:00:00.000Z'),
    shipped_at: new Date('2026-09-10T02:00:00.000Z'),
    status_code: 'UNCONFIRMED',
    erp_delivery_no: null,
    remarks: '비고',
    created_at: new Date('2026-09-10T00:00:00.000Z'),
    created_by: 66n,
    updated_at: new Date('2026-09-10T00:00:00.000Z'),
    updated_by: null,
    version_no: 7,
    confirmed_at: null,
    confirmed_by: null,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason_code: null,
    expedited: false,
    expedite_reason: null,
    ...overrides,
  } as ShipmentRow;
}

describe('출하 헤더 뷰', () => {
  it('required 여섯 칸이 «각자의» 물리 칸에서 온다', () => {
    // ⛔ 값을 전부 다르게 둔 이유 — 셋이 같은 숫자면 출처를 뒤바꿔도 이 단언이 초록이다.
    expect(shipmentView(row())).toMatchObject({
      shipmentId: 11,
      shipmentNo: 'SH-20260910-0001',
      shipmentRequestId: 22,
      warehouseId: 33,
      statusCode: 'UNCONFIRMED',
      expedited: false,
    });
  });

  it('⛔ 목록 뷰는 lines 키를 «싣지 않는다»', () => {
    // `Shipment.required` 에 lines 가 없고 목록 화면 어느 열도 라인을 읽지 않는다. 키를 달면
    // 상세와 뜻이 갈린다. 이 부재는 HTTP 로 반증되지 않아(README §6-3 ⑹) 여기서 잠근다.
    expect(shipmentView(row())).not.toHaveProperty('lines');
  });

  it('계약이 널을 «받는» 넷은 null 을 내린다 — 키를 지우지 않는다', () => {
    const view = shipmentView(
      row({ loaded_at: null, shipped_at: null, erp_delivery_no: null, expedite_reason: null }),
    );
    // 화면이 「아직 안 나갔다」와 「모른다」를 구별한다 — 키를 지우면 둘이 같아진다.
    expect(view.loadedAt).toBeNull();
    expect(view.shippedAt).toBeNull();
    expect(view.erpDeliveryNo).toBeNull();
    expect(view.expediteReason).toBeNull();
    expect(view).toHaveProperty('shippedAt');
    expect(view).toHaveProperty('expediteReason');
  });

  it('널을 «못 받는» 선택 칸 여덟은 값이 없으면 키를 생략한다', () => {
    const view = shipmentView(
      row({
        vehicle_no: null,
        driver_name: null,
        seal_no: null,
        transport_document_no: null,
        loading_worker_id: null,
        carrier_id: null,
        remarks: null,
      }),
    );
    for (const key of [
      'vehicleNo',
      'driverName',
      'sealNo',
      'transportDocumentNo',
      'loadingWorkerId',
      'carrierId',
      'remarks',
    ]) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('선택 칸에 값이 있으면 «각자의» 칸에서 온다', () => {
    expect(shipmentView(row())).toMatchObject({
      vehicleNo: '51C-12345',
      driverName: 'Nguyen',
      sealNo: 'SEAL-7',
      transportDocumentNo: 'TD-9',
      loadingWorkerId: 44,
      carrierId: 55,
      remarks: '비고',
      versionNo: 7,
    });
  });

  it('긴급 건은 expedited 가 참이고 사유가 실린다', () => {
    expect(shipmentView(row({ expedited: true, expedite_reason: '고객 라인 정지' }))).toMatchObject({
      expedited: true,
      expediteReason: '고객 라인 정지',
    });
  });

  it('시각은 ISO 문자열이다 — Date 를 그대로 내리지 않는다', () => {
    const view = shipmentView(row());
    expect(view.loadedAt).toBe('2026-09-10T01:00:00.000Z');
    expect(view.shippedAt).toBe('2026-09-10T02:00:00.000Z');
  });
});

/** 숫자 축을 모두 «다른» 값으로 둔다 — 라인의 여섯 칸이 뒤바뀌어도 드러나게(§6-3 ⑴). */
function line(overrides: Partial<ShipmentLineRow> = {}): ShipmentLineRow {
  return {
    shipment_line_id: 101n,
    shipment_id: 11n,
    line_no: 1,
    shipment_request_line_id: 202n,
    item_id: 303n,
    shipped_qty: 12.5,
    uom_id: 404n,
    goods_issue_line_id: null,
    created_at: new Date('2026-09-10T00:00:00.000Z'),
    created_by: null,
    ...overrides,
  } as unknown as ShipmentLineRow;
}

const allocation = (id: number): ShipmentLotAllocationView =>
  ({ shipmentLotAllocationId: id }) as ShipmentLotAllocationView;

describe('출하 라인·상세 뷰', () => {
  it('라인 required 여섯 칸이 «각자의» 물리 칸에서 온다', () => {
    expect(shipmentLineView(line(), [])).toMatchObject({
      shipmentLineId: 101,
      lineNo: 1,
      shipmentRequestLineId: 202,
      itemId: 303,
      shippedQty: 12.5,
      uomId: 404,
    });
  });

  it('⚠ goodsIssueLineId 는 널을 «받는» 칸이다 — 키를 지우지 않는다', () => {
    // 계약이 「비어도 된다 — 출고 전표를 만들지 않고 원장에 직접 전기하는 구간이 있다」라 적었다.
    // ⭐ 그런데 이 슬라이스의 판정(§3-2 ⓐ)에서는 «값이 찬다» — PR ④ e2e 가 그것을 못 박는다.
    const empty = shipmentLineView(line(), []);
    expect(empty).toHaveProperty('goodsIssueLineId', null);
    // 같은 축에 값이 둘이라야 「늘 널로 내린다」 변이가 죽는다(§6-3 ⑵).
    expect(shipmentLineView(line({ goods_issue_line_id: 555n }), []).goodsIssueLineId).toBe(555);
  });

  it('배분은 라인 안에 «순서대로» 들어간다', () => {
    const view = shipmentLineView(line(), [allocation(1), allocation(2)]);
    expect(view.allocations.map((a) => a.shipmentLotAllocationId)).toEqual([1, 2]);
  });

  it('⭐ 상세는 목록 뷰에 lines 를 «얹는다» — 헤더를 두 벌로 적지 않는다', () => {
    const detail = shipmentDetailView(row(), [shipmentLineView(line(), [])]);

    // 헤더 칸이 목록과 «글자 그대로» 같아야 한다 — 갈리면 같은 출하를 두 화면이 다르게 그린다.
    const { lines, ...header } = detail;
    expect(header).toEqual(shipmentView(row()));
    expect(lines).toHaveLength(1);
  });
});
