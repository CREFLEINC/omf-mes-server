import { omitEmpty } from '../../common/http/omit-empty';
import {
  CancelBlockedReason,
  CancelEligibility,
  DocumentSuccessorRow,
  DocumentSuccessorType,
} from './cancel-eligibility.service';
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

/** 계약 `DocumentProgressStep.stepCode` — 전표의 진행 상태 4값과 같은 값집합(I-5.md §1-4 ⓗ). */
export type DocumentProgressStepCode = 'REGISTERED' | 'POSTED' | 'CANCEL_REQUESTED' | 'CANCELLED';

/** 계약 `DocumentProgressStep`. required 2 · 선택 3(전부 값 없으면 키 생략). */
export interface DocumentProgressStep {
  stepCode: DocumentProgressStepCode;
  occurredAt: string;
  actorName?: string;
  inventoryTransactionNo?: string;
  businessDate?: string;
}

/** 계약 `DocumentSuccessor`. `screenId` 는 §5-1 과 같은 이유로 언제나 키 생략(I-5.md §5-5). */
export interface DocumentSuccessor {
  successorTypeCode: DocumentSuccessorType;
  successorId: number;
  successorNo: string;
  qty: number;
}

/** 계약 `DocumentProgressDetail`. required 3 — 화면이 두 번 부르지 않는다. */
export interface DocumentProgressDetail {
  progress: DocumentProgress;
  steps: DocumentProgressStep[];
  successors: DocumentSuccessor[];
}

/** §4 함수가 준 행 그대로(중복 구현 금지) — bigint 만 JSON 가능한 number 로 바꾼다. */
export function documentSuccessorsView(rows: DocumentSuccessorRow[]): DocumentSuccessor[] {
  return rows.map((r) => ({
    successorTypeCode: r.successorTypeCode,
    successorId: Number(r.successorId),
    successorNo: r.successorNo,
    qty: r.qty,
  }));
}

export interface DocumentProgressStepInputs {
  registered: { occurredAt: Date; actorName?: string };
  /** ⛔ 원장이 있을 때만 채운다 — `updated_at` 근사 금지(§5-4). actorName 은 자동이라 없다. */
  posted?: { occurredAt: Date; transactionNo: string; businessDate: Date };
  cancelRequested?: { occurredAt: Date; actorName?: string };
  /** 역행은 전기 전 취소면 없다 — 그때는 번호·영업일을 생략한다. */
  cancelled?: { occurredAt: Date; actorName?: string; transactionNo?: string; businessDate?: Date };
}

/** `@db.Date` 아닌 timestamptz 를 `date` 로 자른다(P/O `documentDate` 와 같은 관행). */
function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * §5-4 — 최대 4줄 · 알 수 있는 것만 · `occurredAt` 오름차순. 체인을 거슬러 오르지 않는다
 * (전표 자기 자신의 상태 4값에 닿은 순간이다 — I-5.md §1-4 ⓗ).
 */
export function documentProgressSteps(inputs: DocumentProgressStepInputs): DocumentProgressStep[] {
  const steps: DocumentProgressStep[] = [
    omitEmpty({
      stepCode: 'REGISTERED',
      occurredAt: inputs.registered.occurredAt.toISOString(),
      actorName: inputs.registered.actorName,
    }),
  ];
  if (inputs.posted !== undefined) {
    steps.push(
      omitEmpty({
        stepCode: 'POSTED',
        occurredAt: inputs.posted.occurredAt.toISOString(),
        inventoryTransactionNo: inputs.posted.transactionNo,
        businessDate: dateOnly(inputs.posted.businessDate),
      }),
    );
  }
  if (inputs.cancelRequested !== undefined) {
    steps.push(
      omitEmpty({
        stepCode: 'CANCEL_REQUESTED',
        occurredAt: inputs.cancelRequested.occurredAt.toISOString(),
        actorName: inputs.cancelRequested.actorName,
      }),
    );
  }
  if (inputs.cancelled !== undefined) {
    steps.push(
      omitEmpty({
        stepCode: 'CANCELLED',
        occurredAt: inputs.cancelled.occurredAt.toISOString(),
        actorName: inputs.cancelled.actorName,
        inventoryTransactionNo: inputs.cancelled.transactionNo,
        businessDate: inputs.cancelled.businessDate === undefined ? undefined : dateOnly(inputs.cancelled.businessDate),
      }),
    );
  }
  return steps.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
