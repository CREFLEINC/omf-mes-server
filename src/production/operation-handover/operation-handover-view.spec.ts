import { OPERATION_HANDOVER_ORDER_BY } from './operation-handover-query.service';
import {
  OperationHandoverLineRow,
  OperationHandoverRow,
  operationHandoverLineView,
  operationHandoverView,
} from './operation-handover-view';

function lineRow(overrides: Partial<OperationHandoverLineRow> = {}): OperationHandoverLineRow {
  return {
    operation_handover_line_id: 111n,
    operation_handover_id: 10n,
    line_no: 7,
    source_lot_id: 200n,
    handover_qty: '120.5' as unknown as OperationHandoverLineRow['handover_qty'],
    received_qty: '0' as unknown as OperationHandoverLineRow['received_qty'],
    uom_id: 300n,
    source_location_id: 400n,
    destination_location_id: 500n,
    created_at: new Date('2026-09-08T04:00:00.000Z'),
    created_by: null,
    ...overrides,
  } as unknown as OperationHandoverLineRow;
}

function headerRow(overrides: Partial<OperationHandoverRow> = {}): OperationHandoverRow {
  return {
    operation_handover_id: 1n,
    handover_no: 'OH-20260908-0001',
    from_work_order_id: 10n,
    to_work_order_id: 20n,
    status_code: 'HANDED_OVER',
    // ⭐ 셋을 «서로 다른» 시각으로 둔다 — 동률이면 `handedOverAt ← created_at` 같은
    //    출처 변이가 안 잡힌다(PR #437 리뷰 Minor-2).
    handed_over_at: new Date('2026-09-08T01:00:00.000Z'),
    received_at: null,
    created_at: new Date('2026-09-08T02:00:00.000Z'),
    created_by: null,
    updated_at: new Date('2026-09-08T03:00:00.000Z'),
    updated_by: null,
    version_no: 1,
    operation_handover_line: [lineRow()],
    ...overrides,
  } as unknown as OperationHandoverRow;
}

describe('operationHandoverView', () => {
  it('receivedAt 이 NULL 이면 키를 생략한다', () => {
    const view = operationHandoverView(headerRow({ received_at: null }));
    expect(view).not.toHaveProperty('receivedAt');
  });

  it('receivedAt 이 있으면 ISO 문자열로 싣는다', () => {
    const view = operationHandoverView(
      headerRow({ received_at: new Date('2026-09-08T01:00:00.000Z') }),
    );
    expect(view.receivedAt).toBe('2026-09-08T01:00:00.000Z');
  });

  it('⭐ 여덟 칸이 «어느 물리 칸에서» 왔는지 전 칸으로 못박는다', () => {
    // 계약이 integer 로만 선언한 칸은 ajv 가 출처를 못 본다 — 값 단언만이 잡는다.
    expect(operationHandoverView(headerRow())).toEqual({
      operationHandoverId: 1,
      handoverNo: 'OH-20260908-0001',
      fromWorkOrderId: 10,
      toWorkOrderId: 20,
      statusCode: 'HANDED_OVER',
      handedOverAt: '2026-09-08T01:00:00.000Z',
      lines: [
        { operationHandoverLineId: 111, lotId: 200, handoverQty: 120.5, uomId: 300 },
      ],
    });
  });

  it('계약 8칸만 낸다 — version_no·감사 칸이 새지 않는다', () => {
    const view = operationHandoverView(headerRow());
    expect(Object.keys(view).sort()).toEqual([
      'fromWorkOrderId',
      'handedOverAt',
      'handoverNo',
      'lines',
      'operationHandoverId',
      'statusCode',
      'toWorkOrderId',
    ]);
  });
});

describe('operationHandoverLineView', () => {
  it('⚠ lotId 는 source_lot_id 에서 온다 — 이름이 다르다', () => {
    const view = operationHandoverLineView(lineRow({ source_lot_id: 999n }));
    expect(view.lotId).toBe(999);
  });

  it('⭐ 네 칸의 출처를 전 칸으로 못박는다 — uomId 가 위치 칸에서 오면 깨진다', () => {
    expect(operationHandoverLineView(lineRow())).toEqual({
      operationHandoverLineId: 111,
      lotId: 200,
      handoverQty: 120.5,
      uomId: 300,
    });
  });

  it('계약 4칸만 낸다 — line_no·received_qty·위치 두 칸이 새지 않는다', () => {
    const view = operationHandoverLineView(lineRow());
    expect(Object.keys(view).sort()).toEqual([
      'handoverQty',
      'lotId',
      'operationHandoverLineId',
      'uomId',
    ]);
  });

  it('Decimal(handover_qty) 이 number 로 바뀐다', () => {
    const view = operationHandoverLineView(lineRow({ handover_qty: '120.5' as unknown as OperationHandoverLineRow['handover_qty'] }));
    expect(view.handoverQty).toBe(120.5);
    expect(typeof view.handoverQty).toBe('number');
  });
});

describe('OPERATION_HANDOVER_ORDER_BY', () => {
  it('handed_over_at desc + operation_handover_id desc 로 고정된다', () => {
    expect(OPERATION_HANDOVER_ORDER_BY).toEqual([
      { handed_over_at: 'desc' },
      { operation_handover_id: 'desc' },
    ]);
  });
});
