import { Controller, Get, Param, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  DocumentIssueListQuery,
  DocumentIssueQueryService,
} from './document-issue-query.service';
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

  @Get(':documentIssueLogId')
  @Contract('GET /app/document-issues/{documentIssueLogId}')
  get(
    @Param('documentIssueLogId') documentIssueLogId: number,
  ): Promise<DocumentIssueView> {
    return this.documentIssues.get(documentIssueLogId);
  }
}
