import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination/pagination';
import { DocumentProgress, DocumentProgressDetail } from './document-progress-view';
import { DocumentProgressQuery, DocumentProgressQueryService } from './document-progress-query.service';
import { LogisticsDocumentType } from './document-type-registry';

/**
 * 물류 문서 진행현황 — 목록(PR ③a) + 상세(PR ③b). `documentTypeCode` 없음·enum 밖 400 은
 * 계약 검증 가드(`@Contract`)가 이미 낸다 — 여기서 다시 검사하지 않는다.
 * `:request-cancel`·`:cancel` 은 뒤 PR(④·⑤) 몫이다.
 */
@Controller('logistics/document-progress')
export class DocumentProgressController {
  constructor(private readonly queries: DocumentProgressQueryService) {}

  @Get()
  @Contract('GET /logistics/document-progress')
  list(@Query() query: DocumentProgressQuery): Promise<PagedResponse<DocumentProgress>> {
    return this.queries.list(query);
  }

  @Get(':documentTypeCode/:documentId')
  @Contract('GET /logistics/document-progress/{documentTypeCode}/{documentId}')
  detail(
    @Param('documentTypeCode') documentTypeCode: LogisticsDocumentType,
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<DocumentProgressDetail> {
    return this.queries.detail(documentTypeCode, BigInt(documentId));
  }
}
