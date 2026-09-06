import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination/pagination';
import { DocumentProgress } from './document-progress-view';
import { DocumentProgressQuery, DocumentProgressQueryService } from './document-progress-query.service';

/**
 * 물류 문서 진행현황 목록 — 9종을 한 형태로 맞춘다(I-5 PR ③a). `documentTypeCode` 없음·enum 밖
 * 400 은 계약 검증 가드(`@Contract`)가 이미 낸다 — 여기서 다시 검사하지 않는다.
 * 상세 GET·`:request-cancel`·`:cancel` 은 뒤 PR(③b·④·⑤) 몫이다.
 */
@Controller('logistics/document-progress')
export class DocumentProgressController {
  constructor(private readonly queries: DocumentProgressQueryService) {}

  @Get()
  @Contract('GET /logistics/document-progress')
  list(@Query() query: DocumentProgressQuery): Promise<PagedResponse<DocumentProgress>> {
    return this.queries.list(query);
  }
}
