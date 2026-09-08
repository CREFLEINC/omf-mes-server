import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DocumentIssueListQuery,
  DocumentIssueQueryService,
} from './document-issue-query.service';
import { documentIssueReportContext } from './document-issue-report-context';
import {
  DocumentIssueReportInput,
  DocumentIssueReportService,
} from './document-issue-report.service';
import {
  DocumentIssueSummaryQuery,
  DocumentIssueSummaryResponse,
  DocumentIssueSummaryService,
} from './document-issue-summary.service';
import { DocumentIssueView } from './document-issue-view';

@Controller('app/document-issues')
export class DocumentIssueController {
  constructor(
    private readonly documentIssues: DocumentIssueQueryService,
    private readonly summaries: DocumentIssueSummaryService,
    private readonly reports: DocumentIssueReportService,
    private readonly idempotency: IdempotencyService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /app/document-issues')
  list(
    @Query() query: DocumentIssueListQuery,
  ): Promise<PagedResponse<DocumentIssueView>> {
    return this.documentIssues.list(query);
  }

  @Get('summary')
  @Contract('GET /app/document-issues/summary')
  summary(
    @Query() query: DocumentIssueSummaryQuery,
  ): Promise<DocumentIssueSummaryResponse> {
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
    const context = await documentIssueReportContext(
      request,
      this.jwt,
      this.prisma,
    );
    const outcome = await this.idempotency.run(context, (tx) =>
      this.reports.reportWithin(tx, documentIssueLogId, body, context),
    );
    return outcome.body;
  }

  @Get(':documentIssueLogId')
  @Contract('GET /app/document-issues/{documentIssueLogId}')
  get(
    @Param('documentIssueLogId') documentIssueLogId: number,
  ): Promise<DocumentIssueView> {
    return this.documentIssues.get(documentIssueLogId);
  }
}
