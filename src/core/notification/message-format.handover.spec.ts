import { EVENT_PARAMS, HANDOVER_PARAMS, formatCalendarDate, formatQty, notificationMessage, templateData } from './message-format';

/** specs/002-terminal-task-alerts zalo-templates.md 의 「파라미터」 칸 그대로. */
const TEMPLATES: Record<string, string[]> = {
  PUTAWAY_REQUESTED: ['receipt_no', 'warehouse', 'task_count', 'event_time', 'actor'],
  MATERIAL_PICKING_REQUESTED: ['picking_no', 'wo_no', 'item_count', 'warehouse', 'required_at', 'event_time'],
  STOCK_TRANSFER_ARRIVAL_PENDING: ['transfer_no', 'from_warehouse', 'to_warehouse', 'item_count', 'event_time', 'actor'],
  SHIPMENT_PICKING_REQUESTED: ['request_no', 'customer', 'item_count', 'ship_date', 'event_time'],
  SHIPMENT_PACKING_REQUESTED: ['shipment_no', 'warehouse', 'ship_date', 'event_time', 'actor'],
  WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  EMERGENCY_WORK_ORDER_RELEASED: ['wo_no', 'item', 'plan_qty', 'process', 'equipment', 'event_time'],
  OQC_INSPECTION_REQUESTED: ['request_no', 'request_count', 'ship_date', 'event_time'],
  REWORK_WORK_ORDER_CREATED: ['wo_no', 'item', 'qty', 'ncr_no', 'process', 'event_time', 'actor'],
  IQC_INSPECTION_REQUESTED: ['receipt_no', 'lot_count', 'supplier', 'event_time'],
};

const AT = new Date('2026-10-28T02:05:00.000Z'); // 하노이 09:05

describe('인계 작업 알림 메시지', () => {
  it('SC-006 HANDOVER_PARAMS 10종 키가 zalo-templates.md 표와 정확히 같다', () => {
    expect(HANDOVER_PARAMS).toEqual(TEMPLATES);
  });

  it('SC-006 template_data 키 집합이 그 템플릿의 파라미터 그대로다', () => {
    for (const [code, keys] of Object.entries(TEMPLATES)) {
      expect(Object.keys(templateData(code, {}, AT, 100))).toEqual(keys);
    }
  });

  it('SC-006 기존 6종 키 집합은 그대로다', () => {
    expect(Object.keys(EVENT_PARAMS)).toHaveLength(6);
    expect(Object.keys(templateData('WORK_SESSION_STARTED', {}, AT, 100))).toEqual([
      'line', 'product', 'work_order', 'event_time',
    ]);
  });

  it('빈 값은 -, event_time 은 UTC+7 dd/MM/yyyy HH:mm, 값은 param_max_length 로 자른다', () => {
    const values = { receipt_no: 'IR-20261028-0001', lot_count: 3, supplier: 'ABCDEFGHIJ' };
    expect(templateData('IQC_INSPECTION_REQUESTED', values, AT, 100)).toMatchObject({ event_time: '28/10/2026 09:05' });
    expect(templateData('IQC_INSPECTION_REQUESTED', values, AT, 5)).toEqual({
      receipt_no: 'IR-20',
      lot_count: '3',
      supplier: 'ABCDE',
      event_time: '28/10',
    });
    expect(templateData('SHIPMENT_PACKING_REQUESTED', { shipment_no: 'SH-1' }, AT, 100)).toMatchObject({
      warehouse: '-',
      ship_date: '-',
      actor: '-',
    });
  });

  it('수량은 단위를 붙인 문자열, 달력 날짜는 dd/MM/yyyy 다', () => {
    expect(formatQty('1200.000', 'EA')).toBe('1,200 EA');
    expect(formatQty('12.500', 'KG')).toBe('12.5 KG');
    expect(formatQty(null, 'EA')).toBeNull();
    expect(formatCalendarDate(new Date('2026-10-28T00:00:00.000Z'))).toBe('28/10/2026');
  });

  it('알림센터 문장은 값을 라벨과 잇고 처리자·시각을 붙인다', () => {
    const message = notificationMessage(
      'MATERIAL_PICKING_REQUESTED',
      { picking_no: 'PK-1', wo_no: 'WO-1', item_count: 3, warehouse: '자재창고 A', required_at: null },
      AT,
    );
    expect(message).toBe('PK-1 · WO-1 · 품목 3 · 자재창고 A · 10-28 09:05');
    expect(notificationMessage('PUTAWAY_REQUESTED', { receipt_no: 'GR-1', warehouse: 'A', task_count: 2, actor: '홍길동' }, AT)).toBe(
      'GR-1 · A · 적치 2 · 홍길동 · 10-28 09:05',
    );
  });
});
