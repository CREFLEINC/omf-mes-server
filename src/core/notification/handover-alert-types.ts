/**
 * 인계 작업 알림 종류 — 기존 이벤트 목록(`NOTIFICATION_EVENTS`, 6종)과 «다른 목록»이다
 * (omf-all-around#190 · specs/002 research R-1). 6종 목록에 넣으면 W-CO-11 등 기존 화면·응답이 바뀐다.
 * 수신자는 부서가 아니라 공장 × 종류 담당자(`handover_alert_setting`)로 정한다.
 */

/** 알림 대상 — 발송 이력·알림센터의 `targetTypeCode` 로도 나간다. */
export type HandoverAggregate =
  | 'GOODS_RECEIPT'
  | 'PICKING_ORDER'
  | 'STOCK_TRANSFER'
  | 'SHIPMENT_REQUEST'
  | 'SHIPMENT'
  | 'WORK_ORDER'
  | 'INBOUND_RECEIPT'
  | 'LOT';

export interface HandoverAlertType {
  alertTypeCode: string;
  /** 대표 대상 유형. T10 은 LOT 단건 등록이면 `LOT` 으로도 쓴다. */
  aggregateTypeCode: HandoverAggregate;
  name: string;
  nameVi: string;
  description: string;
}

/** 순서는 업무 흐름 순서다 — W-CO-14 목록이 이 순서로 보인다(확정 2026-10-28). */
export const HANDOVER_ALERT_TYPES: readonly HandoverAlertType[] = [
  {
    alertTypeCode: 'IQC_INSPECTION_REQUESTED',
    aggregateTypeCode: 'INBOUND_RECEIPT',
    name: 'IQC 수입검사',
    nameVi: 'Kiểm tra IQC',
    description: '입하 등록으로 IQC 의뢰가 생길 때(입하 1건에 1회)',
  },
  {
    alertTypeCode: 'PUTAWAY_REQUESTED',
    aggregateTypeCode: 'GOODS_RECEIPT',
    name: '적치',
    nameVi: 'Cất hàng',
    description: '입고 처리로 적치 지시가 생길 때(입고 1건마다)',
  },
  {
    alertTypeCode: 'MATERIAL_PICKING_REQUESTED',
    aggregateTypeCode: 'PICKING_ORDER',
    name: '자재 출고 피킹',
    nameVi: 'Lấy nguyên vật liệu xuất kho',
    description: '출고 요청으로 피킹 지시가 생길 때(피킹 지시마다)',
  },
  {
    alertTypeCode: 'STOCK_TRANSFER_ARRIVAL_PENDING',
    aggregateTypeCode: 'STOCK_TRANSFER',
    name: '창고 이동 도착',
    nameVi: 'Xác nhận đến kho chuyển',
    description: '창고 이동이 등록(반출)될 때',
  },
  {
    alertTypeCode: 'WORK_ORDER_RELEASED',
    aggregateTypeCode: 'WORK_ORDER',
    name: '작업 시작',
    nameVi: 'Bắt đầu sản xuất',
    description: '일반 W/O 가 배포될 때',
  },
  {
    alertTypeCode: 'EMERGENCY_WORK_ORDER_RELEASED',
    aggregateTypeCode: 'WORK_ORDER',
    name: '긴급 W/O',
    nameVi: 'W/O khẩn cấp',
    description: '긴급 W/O 가 배포될 때',
  },
  {
    alertTypeCode: 'REWORK_WORK_ORDER_CREATED',
    aggregateTypeCode: 'WORK_ORDER',
    name: '재작업 실적',
    nameVi: 'Kết quả làm lại',
    description: '부적합 처분으로 재작업 W/O 가 생길 때',
  },
  {
    alertTypeCode: 'OQC_INSPECTION_REQUESTED',
    aggregateTypeCode: 'SHIPMENT_REQUEST',
    name: 'OQC 출하검사',
    nameVi: 'Kiểm tra OQC',
    description: '출하지시 등록으로 OQC 의뢰가 생길 때(출하지시 1건에 1회)',
  },
  {
    alertTypeCode: 'SHIPMENT_PICKING_REQUESTED',
    aggregateTypeCode: 'SHIPMENT_REQUEST',
    name: '제품 출하 피킹',
    nameVi: 'Lấy hàng xuất thành phẩm',
    description: '출하지시가 공장이 정해진 채 등록되거나 공장이 처음 정해질 때',
  },
  {
    alertTypeCode: 'SHIPMENT_PACKING_REQUESTED',
    aggregateTypeCode: 'SHIPMENT',
    name: '출하 포장',
    nameVi: 'Đóng gói xuất hàng',
    description: '출하 처리로 출하가 생길 때',
  },
];

export function handoverAlertType(alertTypeCode: string): HandoverAlertType | undefined {
  return HANDOVER_ALERT_TYPES.find((type) => type.alertTypeCode === alertTypeCode);
}
