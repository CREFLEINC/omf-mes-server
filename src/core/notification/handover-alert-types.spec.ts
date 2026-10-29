import { HANDOVER_ALERT_TYPES } from './handover-alert-types';
import { NOTIFICATION_EVENTS } from './notification-events';

/** specs/002-terminal-task-alerts data-model §3 표 그대로. */
const EXPECTED: Record<string, string> = {
  PUTAWAY_REQUESTED: 'GOODS_RECEIPT',
  MATERIAL_PICKING_REQUESTED: 'PICKING_ORDER',
  STOCK_TRANSFER_ARRIVAL_PENDING: 'STOCK_TRANSFER',
  SHIPMENT_PICKING_REQUESTED: 'SHIPMENT_REQUEST',
  SHIPMENT_PACKING_REQUESTED: 'SHIPMENT',
  WORK_ORDER_RELEASED: 'WORK_ORDER',
  EMERGENCY_WORK_ORDER_RELEASED: 'WORK_ORDER',
  OQC_INSPECTION_REQUESTED: 'SHIPMENT_REQUEST',
  REWORK_WORK_ORDER_CREATED: 'WORK_ORDER',
  IQC_INSPECTION_REQUESTED: 'INBOUND_RECEIPT',
};

describe('인계 작업 알림 종류', () => {
  it('FR-021 10종 코드·대상 유형이 data-model §3 표와 같다', () => {
    expect(Object.fromEntries(HANDOVER_ALERT_TYPES.map((t) => [t.alertTypeCode, t.aggregateTypeCode]))).toEqual(EXPECTED);
    expect(HANDOVER_ALERT_TYPES).toHaveLength(10);
  });

  it('FR-021 이름·베트남어 이름·설명이 비어 있지 않다', () => {
    for (const type of HANDOVER_ALERT_TYPES) {
      expect(type.name.trim()).not.toBe('');
      expect(type.nameVi.trim()).not.toBe('');
      expect(type.description.trim()).not.toBe('');
    }
  });

  it('FR-021 기존 이벤트 목록과 코드가 겹치지 않고, 기존 목록은 6종 그대로다', () => {
    const existing = NOTIFICATION_EVENTS.map((event) => event.eventCode);
    expect(existing).toEqual([
      'WORK_SESSION_STARTED',
      'WORK_SESSION_STOPPED',
      'WORK_SESSION_ENDED',
      'WORK_ORDER_CLOSED',
      'EQUIPMENT_BREAKDOWN_OCCURRED',
      'APPROVAL_ACTION_REQUIRED',
    ]);
    expect(HANDOVER_ALERT_TYPES.filter((t) => existing.includes(t.alertTypeCode))).toEqual([]);
  });
});
