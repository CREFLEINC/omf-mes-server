import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recordTerminalWorkerAudit } from '../../audit/terminal-worker-audit';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { resolveWorkerId } from '../../common/master';
import { loadDocumentIssueReasons } from './document-issue-query.service';
import { DocumentIssueReportContext } from './document-issue-report-context';
import { loadDocumentIssueTargets } from './document-issue-target-lookup';
import {
  DOCUMENT_ISSUE_INCLUDE,
  DocumentIssueView,
  documentIssueView,
} from './document-issue-view';

export interface DocumentIssueReportInput {
  outcome: 'SUCCEEDED' | 'FAILED';
  failureReason?: string | null;
}

interface LockedIssue {
  document_issue_log_id: bigint;
  print_outcome_code: string | null;
}

@Injectable()
export class DocumentIssueReportService {
  async reportWithin(
    tx: Prisma.TransactionClient,
    documentIssueLogId: number,
    input: DocumentIssueReportInput,
    context: DocumentIssueReportContext,
  ): Promise<DocumentIssueView> {
    assertSafeId(documentIssueLogId);
    const locked = await lockIssue(tx, documentIssueLogId);
    assertPending(locked.print_outcome_code);
    const failureReason = reportFailureReason(input);
    const workerId = await resolveWorkerId(tx, context.workerNo);
    const row = await tx.document_issue_log.update({
      where: { document_issue_log_id: locked.document_issue_log_id },
      data: {
        print_outcome_code: input.outcome,
        print_failure_reason: failureReason,
        print_reported_at: new Date(),
        print_reported_worker_id: workerId,
        print_reported_by: context.appUserId === undefined ? null : BigInt(context.appUserId),
      },
      include: DOCUMENT_ISSUE_INCLUDE,
    });
    if (context.terminalAudit !== undefined) await recordTerminalWorkerAudit(tx, {
      actor: { ...context.terminalAudit, workerId },
      targetTypeCode: 'DOCUMENT_ISSUE_LOG',
      targetId: locked.document_issue_log_id,
      eventTypeCode: 'PRINT_REPORTED',
    });
    const [targets, reasons] = await Promise.all([
      loadDocumentIssueTargets(tx, [row]),
      loadDocumentIssueReasons(tx, [row]),
    ]);
    return documentIssueView(row, targets, reasons);
  }
}

async function lockIssue(
  tx: Prisma.TransactionClient,
  documentIssueLogId: number,
): Promise<LockedIssue> {
  const rows = await tx.$queryRaw<LockedIssue[]>(Prisma.sql`
    SELECT document_issue_log_id,print_outcome_code
      FROM app.document_issue_log
     WHERE document_issue_log_id=${BigInt(documentIssueLogId)}
     FOR UPDATE
  `);
  if (rows[0] === undefined) {
    throw new NotFoundException('없는 발행 기록입니다.');
  }
  return rows[0];
}

function assertPending(value: string | null): void {
  if (value === null || !['PENDING', 'SUCCEEDED', 'FAILED'].includes(value)) {
    throw new Error('Invalid stored document issue field: printOutcome');
  }
  if (value !== 'PENDING') {
    throw reportError(
      'outcome',
      ERROR_CODE.STATE_LOCKED,
      '이미 인쇄 결과가 보고된 발행 기록입니다.',
    );
  }
}

function reportFailureReason(input: DocumentIssueReportInput): string | null {
  const empty =
    input.failureReason == null || input.failureReason.trim() === '';
  if (input.outcome === 'FAILED') {
    if (empty) {
      throw reportError(
        'failureReason',
        ERROR_CODE.REQUIRED,
        '인쇄 실패 사유가 필요합니다.',
      );
    }
    return input.failureReason as string;
  }
  if (!empty) {
    throw reportError(
      'failureReason',
      ERROR_CODE.INVALID,
      '인쇄 성공에는 실패 사유를 지정할 수 없습니다.',
    );
  }
  return null;
}

function assertSafeId(documentIssueLogId: number): void {
  if (!Number.isSafeInteger(documentIssueLogId)) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        'documentIssueLogId',
        ERROR_CODE.RANGE,
        '발행 기록 식별자 범위가 너무 큽니다.',
      ),
    ]);
  }
}

function reportError(
  name: string,
  code: string,
  message: string,
): ContractException {
  return new ContractException(HttpStatus.UNPROCESSABLE_ENTITY, [
    field(name, code, message),
  ]);
}
