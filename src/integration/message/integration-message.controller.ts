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
} from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { PagedResponse } from '../../common/pagination';
import { IntegrationMessageService, MessageQuery } from './integration-message.service';

/**
 * ⛔ 컬렉션에 붙는 액션(`/messages:retry-batch`)은 **컨트롤러 접두어를 짧게 잡아야** 한다.
 * Nest 는 컨트롤러 경로와 메서드 경로를 «슬래시로» 잇기 때문에, `@Controller('…/messages')`
 * 아래에 `@Post('\\:retry-batch')` 를 두면 `…/messages/:retry-batch` 가 되어 안 맞는다.
 * 그래서 이 하나만 한 단계 위에서 전체 경로를 적는다.
 */
@Controller('integration')
export class IntegrationMessageBatchController {
  constructor(
    private readonly messages: IntegrationMessageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('messages\\:retry-batch')
  @Contract('POST /integration/messages:retry-batch')
  @HttpCode(HttpStatus.OK)
  retryBatch(
    @Req() request: Request,
    @Body() body: { integrationMessageIds: number[] },
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.messages.retryBatch(body.integrationMessageIds),
    );
  }
}

/** 연계 메시지. 화면은 `W-06-10`(연계 동기화 현황·실패 재처리)이 소유한다. */
@Controller('integration/messages')
export class IntegrationMessageController {
  constructor(
    private readonly messages: IntegrationMessageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /integration/messages')
  list(@Query() query: MessageQuery): Promise<PagedResponse<unknown>> {
    return this.messages.list(query);
  }

  @Get(':integrationMessageId')
  @Contract('GET /integration/messages/{integrationMessageId}')
  get(@Param('integrationMessageId', ParseIntPipe) messageId: number): Promise<unknown> {
    return this.messages.get(messageId);
  }

  @Post(':integrationMessageId\\:retry')
  @Contract('POST /integration/messages/{integrationMessageId}:retry')
  @HttpCode(HttpStatus.OK)
  retry(
    @Req() request: Request,
    @Param('integrationMessageId', ParseIntPipe) messageId: number,
  ): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.OK, () =>
      this.messages.retry(messageId),
    );
  }
}
