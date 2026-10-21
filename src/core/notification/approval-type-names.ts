/**
 * 결재 유형 한국어 이름 — 계약 `ApprovalRequest.approvalTypeCode` enum 11값. 서버에 이름 맵이 없어
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
};

export function approvalTypeName(code: string): string {
  return APPROVAL_TYPE_NAMES[code] ?? code;
}
