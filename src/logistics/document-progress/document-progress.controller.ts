import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination/pagination';
import { DocumentCancelService, isCancelableType } from './document-cancel.service';
import { DocumentProgress, DocumentProgressDetail } from './document-progress-view';
import { DocumentProgressQuery, DocumentProgressQueryService } from './document-progress-query.service';
import { LogisticsDocumentType } from './document-type-registry';

/**
 * 물류 문서 진행현황 — 목록(PR ③a) + 상세(PR ③b) + 취소 요청(PR ④). `documentTypeCode`
 * 없음·enum 밖 400 은 계약 검증 가드(`@Contract`)가 이미 낸다 — 여기서 다시 검사하지 않는다.
 * `:cancel` 실행은 뒤 PR(⑤) 몫이다.
 */
@Controller('logistics/document-progress')
export class DocumentProgressController {
  constructor(
    private readonly queries: DocumentProgressQueryService,
    private readonly cancels: DocumentCancelService,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  @Post(':documentTypeCode/:documentId\\:request-cancel')
  @Contract('POST /logistics/document-progress/{documentTypeCode}/{documentId}:request-cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  requestCancel(
    @Req() request: Request,
    @Param('documentTypeCode') documentTypeCode: string,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() body: { reason: string },
  ): Promise<{ approvalRequestId: number }> {
    if (!isCancelableType(documentTypeCode)) {
      throw new ContractException(HttpStatus.BAD_REQUEST, [
        {
          scope: 'screen',
          code: ERROR_CODE.TYPE_NOT_CANCELABLE,
          message: '취소할 수 없는 문서 유형입니다.',
        },
      ]);
    }
    // ⛔ `runVersioned` 를 못 쓴다 — 202 에 ETag 선언이 없어 새 토큰을 내릴 자리가 없다.
    //    토큰은 «대상 문서» 상세 GET 이 준 `version_no` 고 서비스가 비교만 한다(I-5.md §7-2).
    const version = ifMatchVersion(request);
    if (version === undefined) {
      throw new Error('If-Match 가 없는데 가드를 지났다 — 계약 선언과 가드가 어긋났다');
    }
    const session = currentSession(request);
    if (session === undefined) throw new UnauthorizedException('로그인이 필요합니다.');

    return runIdempotent(this.idempotency, request, HttpStatus.ACCEPTED, () =>
      this.cancels.requestCancel(
        documentTypeCode,
        BigInt(documentId),
        version,
        body.reason,
        session.userId,
      ),
    );
  }
}
