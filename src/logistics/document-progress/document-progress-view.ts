import { omitEmpty } from '../../common/http/omit-empty';
import { CancelBlockedReason, CancelEligibility } from './cancel-eligibility.service';
import { LogisticsDocumentType } from './document-type-registry';

/** 계약 `DocumentProgress`. required 10 · 선택 4(전부 `[…,null]`) — 형제 `goods-issue-view.ts` 관행. */
export interface DocumentProgress {
  documentTypeCode: LogisticsDocumentType;
  documentId: number;
  documentNo: string;
  documentDate: string;
  documentSubTypeCode?: string;
  statusCode: string;
  plannedQty: number;
  processedQty: number;
  remainingQty: number;
  successorCount: number;
  cancellable: boolean;
  cancelBlockedReasonCode?: CancelBlockedReason;
  cancelApprovalRequestId?: number;
  /** ⛔ 채울 표가 없다 — 언제나 생략(I-5.md §5-1 · R-7 ⓑ 8). */
  screenId?: string;
}

/** 질의 서비스가 유형마다 다른 물리 표에서 뽑아 맞춘 한 형태. */
export interface DocumentProgressRow {
  documentId: bigint;
  documentNo: string;
  documentDate: Date;
  documentSubTypeCode: string | null;
  statusCode: string;
  /** 라인 합계. 계획 칸이 없으면(스키마에 없거나 합이 전부 NULL) `null` — R-7 ⓐ 가 처리한다. */
  plannedQty: number | null;
  processedQty: number;
}

export function documentProgressView(
  typeCode: LogisticsDocumentType,
  row: DocumentProgressRow,
  eligibility: CancelEligibility,
): DocumentProgress {
  // R-7 ⓐ — 계획 칸이 없거나(스키마 부재) 합이 NULL(전부 미기입)이면 계획 = 처리.
  const planned = row.plannedQty ?? row.processedQty;
  return omitEmpty({
    documentTypeCode: typeCode,
    documentId: Number(row.documentId),
    documentNo: row.documentNo,
    documentDate: row.documentDate.toISOString().slice(0, 10),
    documentSubTypeCode: row.documentSubTypeCode ?? undefined,
    statusCode: row.statusCode,
    plannedQty: planned,
    processedQty: row.processedQty,
    // 음수를 0 으로 접지 않는다(I-5.md §5-1) — 계약 문장에 그런 규칙이 없다.
    remainingQty: planned - row.processedQty,
    successorCount: eligibility.successorCount,
    cancellable: eligibility.cancellable,
    cancelBlockedReasonCode: eligibility.cancelBlockedReasonCode,
    cancelApprovalRequestId:
      eligibility.cancelApprovalRequestId === undefined ? undefined : Number(eligibility.cancelApprovalRequestId),
    screenId: undefined,
  });
}
