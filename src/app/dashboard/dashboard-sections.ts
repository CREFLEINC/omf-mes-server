/**
 * 대시보드 응답의 선택 섹션 — 계약보다 앞선 응답 확장이다(장부 P-59 · omf-all-around#118 2차).
 * MES DB 에 없는 값은 만들지 않고 null 로 둔다.
 */

export const EQUIPMENT_STATUSES = ['RUNNING', 'STOPPED', 'WAITING', 'CHANGEOVER', 'IDLE'] as const;
export type EquipmentStatusCode = (typeof EQUIPMENT_STATUSES)[number];

export interface DashboardEquipmentItem {
  equipmentId: number;
  equipmentCode: string;
  equipmentName: string;
  equipmentTypeCode: string;
  equipmentTypeName: string | null;
  productionLineId: number | null;
  productionLineName: string | null;
  statusCode: EquipmentStatusCode;
  statusSince: string | null;
  statusReasonCode: string | null;
  statusReasonName: string | null;
  todayTotalQty: number;
  /** 그 설비 실적의 불량+폐기+재작업. ⚠ 1차 카드와 달리 재작업 합격분 NG→양품 이동을 하지 않는다 — 재작업이 다른 설비에서 나면 NG 가 음수가 된다. */
  todayNgQty: number;
  defectRate: number | null;
  standardCycleTimeSec: number | null;
  currentWorkOrderNo: string | null;
  currentItemCode: string | null;
  currentItemName: string | null;
}

export interface DashboardEquipment {
  asOf: string;
  statusCounts: Record<EquipmentStatusCode, number>;
  items: DashboardEquipmentItem[];
}
