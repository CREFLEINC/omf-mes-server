import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ContractException, ERROR_CODE, field } from '../../common/errors';
import {
  PagedResponse,
  pageRequest,
  pagedResponse,
} from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { documentIssueTimeBoundary } from './document-issue-time-boundary';
import {
  DocumentTargetType,
  loadDocumentIssueTargets,
} from './document-issue-target-lookup';
import {
  DOCUMENT_ISSUE_INCLUDE,
  DocumentIssueRow,
  DocumentIssueView,
  ReasonLookup,
  documentIssueView,
} from './document-issue-view';

export interface DocumentIssueListQuery {
  documentTypeCode?: string;
  targetTypeCode?: DocumentTargetType;
  targetId?: number;
  lotId?: number;
  issuedFrom?: string;
  issuedTo?: string;
  printOutcome?: string;
  page?: number;
  size?: number;
}

@Injectable()
export class DocumentIssueQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: DocumentIssueListQuery,
  ): Promise<PagedResponse<DocumentIssueView>> {
    assertQuery(query);
    const page = pageRequest(query);
    if (!Number.isSafeInteger(page.skip))
      throw rangeError('page', '페이지 범위가 너무 큽니다.');
    const where = documentIssueWhere(query);
    return this.prisma.$transaction(
      async (tx) => {
        const [rows, total] = await Promise.all([
          tx.document_issue_log.findMany({
            where,
            include: DOCUMENT_ISSUE_INCLUDE,
            orderBy: [{ issued_at: 'desc' }, { document_issue_log_id: 'desc' }],
            skip: page.skip,
            take: page.take,
          }),
          tx.document_issue_log.count({ where }),
        ]);
        if (!Number.isSafeInteger(total))
          throw new Error('Document issue count exceeds safe range');
        const [targets, reasons] = await Promise.all([
          loadDocumentIssueTargets(tx, rows),
          loadReasons(tx, rows),
        ]);
        return pagedResponse(
          rows.map((row) => documentIssueView(row, targets, reasons)),
          total,
          page,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async get(documentIssueLogId: number): Promise<DocumentIssueView> {
    if (!Number.isSafeInteger(documentIssueLogId))
      throw rangeError(
        'documentIssueLogId',
        '발행 기록 식별자 범위가 너무 큽니다.',
      );
    return this.prisma.$transaction(
      async (tx) => {
        const row = await tx.document_issue_log.findUnique({
          where: { document_issue_log_id: BigInt(documentIssueLogId) },
          include: DOCUMENT_ISSUE_INCLUDE,
        });
        if (row === null) throw new NotFoundException('없는 발행 기록입니다.');
        const [targets, reasons] = await Promise.all([
          loadDocumentIssueTargets(tx, [row]),
          loadReasons(tx, [row]),
        ]);
        return documentIssueView(row, targets, reasons);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}

export function documentIssueWhere(
  query: DocumentIssueListQuery,
): Prisma.document_issue_logWhereInput {
  const issuedAt = {
    ...(query.issuedFrom === undefined
      ? {}
      : { gte: documentIssueTimeBoundary(query.issuedFrom) }),
    ...(query.issuedTo === undefined
      ? {}
      : { lt: documentIssueTimeBoundary(query.issuedTo) }),
  };
  return {
    ...(query.documentTypeCode === undefined
      ? {}
      : { document_type_code: query.documentTypeCode }),
    ...(query.targetTypeCode === undefined
      ? {}
      : { target_type_code: query.targetTypeCode }),
    ...(query.targetId === undefined
      ? {}
      : { target_id: BigInt(query.targetId) }),
    ...(query.lotId === undefined ? {} : { lot_id: BigInt(query.lotId) }),
    ...(query.printOutcome === undefined
      ? {}
      : { print_outcome_code: query.printOutcome }),
    ...(Object.keys(issuedAt).length === 0 ? {} : { issued_at: issuedAt }),
  };
}

function assertQuery(query: DocumentIssueListQuery): void {
  if ((query.targetTypeCode === undefined) !== (query.targetId === undefined)) {
    const missing =
      query.targetTypeCode === undefined ? 'targetTypeCode' : 'targetId';
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        missing,
        ERROR_CODE.PAIR,
        '대상 유형과 대상 식별자는 함께 지정해야 합니다.',
      ),
    ]);
  }
  for (const name of ['targetId', 'lotId'] as const) {
    if (query[name] !== undefined && !Number.isSafeInteger(query[name]))
      throw rangeError(name, '식별자 범위가 너무 큽니다.');
  }
}

function rangeError(name: string, message: string): ContractException {
  return new ContractException(HttpStatus.BAD_REQUEST, [
    field(name, ERROR_CODE.RANGE, message),
  ]);
}

async function loadReasons(
  tx: Prisma.TransactionClient,
  rows: DocumentIssueRow[],
): Promise<ReasonLookup> {
  const codes = [
    ...new Set(rows.flatMap((row) => row.reissue_reason_code ?? [])),
  ];
  if (codes.length === 0) return new Map();
  const values = await tx.code_value.findMany({
    where: {
      code: { in: codes },
      code_group: { group_code: 'REISSUE_REASON' },
    },
    select: { code: true, code_name: true },
  });
  return new Map(values.map((value) => [value.code, value.code_name]));
}
