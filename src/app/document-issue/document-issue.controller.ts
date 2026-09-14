import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentIssueListQuery, DocumentIssueQueryService } from './document-issue-query.service';
import { documentIssueReportContext } from './document-issue-report-context';
import { DocumentIssueReportInput, DocumentIssueReportService } from './document-issue-report.service';
import {
  DocumentIssueSummaryQuery,
  DocumentIssueSummaryResponse,
  DocumentIssueSummaryService,
} from './document-issue-summary.service';
import { DocumentIssueView } from './document-issue-view';
import { documentIssueWriteContext } from './document-issue-write-context';
import { DocumentIssueBatchResponse, DocumentIssueWriteService } from './document-issue-write.service';
import { DocumentIssueCreateInput } from './document-issue-create-rules';
import { runDocumentIssueWriteWithRetry } from './document-issue-sequence';
import { DocumentIssueRenditionService } from './document-issue-rendition.service';

@Controller('app/document-issues')
export class DocumentIssueController {
  constructor(
    private readonly documentIssues: DocumentIssueQueryService,
    private readonly summaries: DocumentIssueSummaryService,
    private readonly reports: DocumentIssueReportService,
    private readonly writes: DocumentIssueWriteService,
    private readonly idempotency: IdempotencyService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly renditions: DocumentIssueRenditionService,
  ) {}

  @Post()
  @Contract('POST /app/document-issues')
  @HttpCode(HttpStatus.CREATED)
  async create(@Req() request: Request, @Body() body: DocumentIssueCreateInput): Promise<DocumentIssueBatchResponse> {
    const context = await documentIssueWriteContext(request, this.jwt, this.prisma);
    return runDocumentIssueWriteWithRetry(async () => {
      const outcome = await this.idempotency.run(context, (tx) => this.writes.issueWithin(tx, body, context));
      return outcome.body;
    });
  }

  @Get()
  @Contract('GET /app/document-issues')
  list(@Query() query: DocumentIssueListQuery): Promise<PagedResponse<DocumentIssueView>> {
    return this.documentIssues.list(query);
  }

  @Get('summary')
  @Contract('GET /app/document-issues/summary')
  summary(@Query() query: DocumentIssueSummaryQuery): Promise<DocumentIssueSummaryResponse> {
    return this.summaries.summary(query);
  }

  @Post(':documentIssueLogId\\:report-print')
  @Contract('POST /app/document-issues/{documentIssueLogId}:report-print')
  @HttpCode(HttpStatus.OK)
  async reportPrint(
    @Req() request: Request,
    @Param('documentIssueLogId') documentIssueLogId: number,
    @Body() body: DocumentIssueReportInput,
  ): Promise<DocumentIssueView> {
    const context = await documentIssueReportContext(request, this.jwt, this.prisma);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.reports.reportWithin(tx, documentIssueLogId, body, context),
    );
    return outcome.body;
  }

  @Get(':documentIssueLogId')
  @Contract('GET /app/document-issues/{documentIssueLogId}')
  get(@Param('documentIssueLogId') documentIssueLogId: number): Promise<DocumentIssueView> {
    return this.documentIssues.get(documentIssueLogId);
  }

  @Get(':documentIssueLogId/rendition')
  @Contract('GET /app/document-issues/{documentIssueLogId}/rendition')
  async rendition(
    @Param('documentIssueLogId') documentIssueLogId: number,
    @Query('format') format: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (format !== undefined && format !== 'png' && format !== 'tspl') {
      throw new UnprocessableEntityException('이 출력물의 요청 형식은 지원하지 않습니다.');
    }
    const chosen = format ?? 'png';
    const bytes = await this.renditions.rendition(documentIssueLogId, chosen);
    response.status(HttpStatus.OK).type(chosen === 'tspl' ? 'application/vnd.tspl' : 'image/png').end(bytes);
  }
}
