import { Controller, Get, Param, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import {
  DocumentIssueListQuery,
  DocumentIssueQueryService,
} from './document-issue-query.service';
import { DocumentIssueView } from './document-issue-view';

@Controller('app/document-issues')
export class DocumentIssueController {
  constructor(private readonly documentIssues: DocumentIssueQueryService) {}

  @Get()
  @Contract('GET /app/document-issues')
  list(
    @Query() query: DocumentIssueListQuery,
  ): Promise<PagedResponse<DocumentIssueView>> {
    return this.documentIssues.list(query);
  }

  @Get(':documentIssueLogId')
  @Contract('GET /app/document-issues/{documentIssueLogId}')
  get(
    @Param('documentIssueLogId') documentIssueLogId: number,
  ): Promise<DocumentIssueView> {
    return this.documentIssues.get(documentIssueLogId);
  }
}
