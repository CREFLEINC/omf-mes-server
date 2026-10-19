/**
 * 대시보드 응답의 선택 섹션 — 계약보다 앞선 응답 확장이다(장부 P-59 · omf-all-around#118 2차).
 * MES DB 에 없는 값은 만들지 않고 null 로 둔다.
 */

/** 공장 단위 생산 합(KPI 띠의 종합 불량률·총 NG). totalQty 는 PRODUCTION_QTY 카드와 같은 값이다. */
export interface DashboardProduction {
  totalQty: number;
  goodQty: number;
  ngQty: number;
  holdQty: number;
  defectRate: number | null;
}

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

export interface DashboardShipment {
  todayShippedQty: number;
  todayShipmentCount: number;
  waitingRequestCount: number;
  /** 대기 요청(요청일 ≤ 기준일, 미출하) 중 가장 이른 요청일 — 출하 예정 목록(W-04-02) 시작일. 대기 0건이면 null. */
  oldestWaitingShipDate: string | null;
  nextShipment: {
    shipmentRequestId: number;
    shipmentRequestNo: string;
    customerName: string | null;
    requestedShipDate: string;
    /** 이름은 요청 수량이지만 값은 «남은 수량»이다(#118 2차 결정 6). */
    requestedQty: number;
  } | null;
  overdueCount: number;
}

export type JudgmentCode = 'ACCEPTED' | 'REJECTED' | 'HELD';
export interface LotCounts {
  accepted: number;
  rejected: number;
  held: number;
}
export interface DefectPhenomenon {
  defectCodeId: number;
  defectCode: string;
  defectName: string;
  qty: number;
}

export interface QualityTypeBlock {
  monthPassRate: number | null;
  prevMonthPassRate: number | null;
  dailyPassRates: { date: string; passRate: number | null }[];
  todayLots: LotCounts;
  monthLots: LotCounts;
  monthDefectQty: number;
  defectPhenomena: DefectPhenomenon[];
  recentLots: {
    inspectionResultId: number;
    inspectedAt: string;
    counterpartName: string | null;
    equipmentCode: string | null;
    itemCode: string;
    itemName: string;
    lotNo: string | null;
    qty: number;
    judgmentCode: JudgmentCode;
  }[];
}

export interface EquipmentDefectRate {
  equipmentId: number;
  equipmentCode: string;
  defectRate: number;
  ngQty: number;
}

/** 「n LOT · m건」 — LOT 없는 기록은 recordCount 에만 든다. */
export interface LotRecordCount {
  lotCount: number;
  recordCount: number;
}

/** 품질 「현재 현황」 상태별 건수 — 키는 상태별 LOT 목록의 `status` 값이다. */
export interface QualityStatusCounts {
  INSPECTION_HELD: LotRecordCount & { byType: Record<'IQC' | 'PQC' | 'OQC', LotRecordCount> };
  RECEIPT_HOLD: LotRecordCount;
  PQC_PENDING: LotRecordCount;
  NC_OPEN: LotRecordCount;
}

export interface DashboardQuality {
  iqc: QualityTypeBlock & {
    vendorDefects: { partnerId: number; partnerName: string; rejectedQty: number }[];
    itemDefects: { itemId: number; itemCode: string; itemName: string; qty: number }[];
    fullReinspect: { inputQty: number; restoredQty: number } | null;
    receiptHoldLotCount: number;
  };
  pqc: QualityTypeBlock & {
    pendingLotCount: number;
    reworkRequestCount: number;
    equipmentDefectRates: EquipmentDefectRate[];
  };
  oqc: QualityTypeBlock & { customerReturnQty: number };
  nonconformance: {
    monthQty: number;
    phenomena: DefectPhenomenon[];
    causeGroups: { causeCodeId: number; causeName: string; qty: number }[];
    scrapQty: number;
    reworkReleasedQty: number;
    openCount: number;
    /** 조치 기한(`action_due_date`)을 쓰는 경로가 없다 — 지금은 늘 null(#118 2차 결정 13). */
    overdueCount: number | null;
  };
  statusCounts: QualityStatusCounts;
}
