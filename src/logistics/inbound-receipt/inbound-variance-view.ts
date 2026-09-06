import { Prisma } from '@prisma/client';

/**
 * 계약 `InboundVariance` 로 옮기는 자리. 「한 번 등록하면 고칠 수 없다」(계약) — 감사 칸이
 * `created_at`·`created_by` 뿐이라 `version_no` 가 없다(I-3.md §2-4).
 */
export type InboundVarianceRow = Prisma.inbound_varianceGetPayload<object>;

export interface InboundVarianceView {
  inboundVarianceId: number;
  inboundReceiptLineId: number;
  varianceTypeCode: string;
  varianceQty: number;
  uomId: number;
  reasonCode: string | null;
  approvalRequestId: number | null;
}

export function inboundVarianceView(row: InboundVarianceRow): InboundVarianceView {
  return {
    inboundVarianceId: Number(row.inbound_variance_id),
    inboundReceiptLineId: Number(row.inbound_receipt_line_id),
    varianceTypeCode: row.variance_type_code,
    varianceQty: Number(row.variance_qty),
    uomId: Number(row.uom_id),
    reasonCode: row.reason_code,
    approvalRequestId: row.approval_request_id === null ? null : Number(row.approval_request_id),
  };
}
