import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentTargetType } from './document-issue-target-lookup';

const PRINT_OUTCOMES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
type PrintOutcome = (typeof PRINT_OUTCOMES)[number];

export interface DocumentIssueSummaryQuery {
  targetTypeCode: DocumentTargetType;
  targetIds: number[];
  documentTypeCode?: string;
}

export interface DocumentIssueSummary {
  targetTypeCode: DocumentTargetType;
  targetId: number;
  issueCount: number;
  lastIssueSeq: number | null;
  lastIssuedAt: string | null;
  lastPrintOutcome: PrintOutcome | null;
}

export interface DocumentIssueSummaryResponse {
  items: DocumentIssueSummary[];
}

interface SummaryRow {
  target_id: bigint;
  issue_count: bigint;
  issue_seq: number;
  issued_at: Date;
  print_outcome_code: string | null;
}

@Injectable()
export class DocumentIssueSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    query: DocumentIssueSummaryQuery,
  ): Promise<DocumentIssueSummaryResponse> {
    assertTargetIds(query.targetIds);
    const distinctIds = [...new Set(query.targetIds)].map((id) => BigInt(id));
    const documentTypeFilter =
      query.documentTypeCode === undefined
        ? Prisma.empty
        : Prisma.sql`AND l.document_type_code = ${query.documentTypeCode}`;
    const rows = await this.prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
      /* I-27 document issue summary */
      WITH ranked AS (
        SELECT l.target_id,
               COUNT(*) OVER (PARTITION BY l.target_id) AS issue_count,
               l.issue_seq,
               l.issued_at,
               l.print_outcome_code,
               ROW_NUMBER() OVER (
                 PARTITION BY l.target_id
                 ORDER BY l.issued_at DESC, l.document_issue_log_id DESC
               ) AS row_rank
          FROM app.document_issue_log l
         WHERE l.target_type_code = ${query.targetTypeCode}
           AND l.target_id IN (${Prisma.join(distinctIds)})
           ${documentTypeFilter}
      )
      SELECT target_id, issue_count, issue_seq, issued_at, print_outcome_code
        FROM ranked
       WHERE row_rank = 1
    `);
    const byTarget = new Map(
      rows.map((row) => [row.target_id.toString(), row]),
    );
    return {
      items: query.targetIds.map((targetId) =>
        summaryView(
          query.targetTypeCode,
          targetId,
          byTarget.get(String(targetId)),
        ),
      ),
    };
  }
}

function summaryView(
  targetTypeCode: DocumentTargetType,
  targetId: number,
  row: SummaryRow | undefined,
): DocumentIssueSummary {
  if (row === undefined) {
    return {
      targetTypeCode,
      targetId,
      issueCount: 0,
      lastIssueSeq: null,
      lastIssuedAt: null,
      lastPrintOutcome: null,
    };
  }
  return {
    targetTypeCode,
    targetId,
    issueCount: safeCount(row.issue_count),
    lastIssueSeq: positiveInt(row.issue_seq),
    lastIssuedAt: validDate(row.issued_at).toISOString(),
    lastPrintOutcome: printOutcome(row.print_outcome_code),
  };
}

function assertTargetIds(targetIds: number[]): void {
  if (
    !Array.isArray(targetIds) ||
    targetIds.length < 1 ||
    targetIds.length > 1000
  ) {
    throw rangeError('대상 식별자는 1개 이상 1000개 이하여야 합니다.');
  }
  if (targetIds.some((id) => !Number.isSafeInteger(id))) {
    throw rangeError('대상 식별자 범위가 너무 큽니다.');
  }
}

function safeCount(value: bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid stored document issue summary: issueCount');
  }
  return count;
}

function positiveInt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid stored document issue summary: lastIssueSeq');
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error('Invalid stored document issue summary: lastIssuedAt');
  }
  return value;
}

function printOutcome(value: string | null): PrintOutcome | null {
  if (value !== null && !PRINT_OUTCOMES.includes(value as PrintOutcome)) {
    throw new Error('Invalid stored document issue summary: lastPrintOutcome');
  }
  return value as PrintOutcome | null;
}

function rangeError(message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field('targetIds', ERROR_CODE.RANGE, message),
  ]);
}
