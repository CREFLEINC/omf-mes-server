/**
 * 결재 유형 한국어 이름 — 계약 `ApprovalRequest.approvalTypeCode` enum 12값. 서버에 이름 맵이 없어
 * 알림 문장·Zalo `approval_type` 용으로 여기 둔다(data-model §6). 모르는 코드는 코드 그대로 쓴다.
 */
export const APPROVAL_TYPE_NAMES: Readonly<Record<string, string>> = {
  GOODS_ISSUE_DISPOSAL: '폐기 출고',
  INVENTORY_ADJUSTMENT: '재고 조정',
  PURCHASE_ORDER: 'P/O',
  INBOUND_RECEIPT_CANCEL: '입하 취소',
  GOODS_RECEIPT_CANCEL: '입고 취소',
  GOODS_ISSUE_CANCEL: '출고 취소',
  SHIPMENT_CANCEL: '출하 취소',
  IQC_SKIP: 'IQC 생략',
  PRODUCTION_RESULT_CORRECT: '생산 실적 정정',
  CONCESSION: '특채',
  OQC_SKIP: 'OQC 생략',
  PQC_SKIP: 'PQC 생략',
};

export function approvalTypeName(code: string): string {
  return APPROVAL_TYPE_NAMES[code] ?? code;
}

/**
 * 결재 유형 영어 이름 — Zalo `request_type` 용. 템플릿 본문이 영어·베트남어라 한국어 이름을 싣지 않는다(server #878).
 */
export const APPROVAL_TYPE_NAMES_EN: Readonly<Record<string, string>> = {
  GOODS_ISSUE_DISPOSAL: 'Disposal issue',
  INVENTORY_ADJUSTMENT: 'Inventory adjustment',
  PURCHASE_ORDER: 'Purchase order',
  INBOUND_RECEIPT_CANCEL: 'Inbound receipt cancel',
  GOODS_RECEIPT_CANCEL: 'Goods receipt cancel',
  GOODS_ISSUE_CANCEL: 'Goods issue cancel',
  SHIPMENT_CANCEL: 'Shipment cancel',
  IQC_SKIP: 'IQC skip',
  PRODUCTION_RESULT_CORRECT: 'Production result correction',
  CONCESSION: 'Concession',
  OQC_SKIP: 'OQC skip',
};

export function approvalTypeNameEn(code: string): string {
  return APPROVAL_TYPE_NAMES_EN[code] ?? code;
}
