import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { FAMILY_CONFLICT_CODE } from '../../common/idempotency';
import { PagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SerialNumberBatchCreate,
  SerialNumberBatchResult,
  SerialNumberCreateService,
} from './serial-number-create.service';
import {
  SerialNumberListQuery,
  SerialNumberQueryService,
} from './serial-number-query.service';
import { SerialNumberView } from './serial-number-view';
import { serialNumberWriteContext } from './serial-number-write-context';

@Controller('trace/serial-numbers')
export class SerialNumberController {
  constructor(
    private readonly serialNumbers: SerialNumberQueryService,
    private readonly creates: SerialNumberCreateService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract('GET /trace/serial-numbers')
  list(@Query() query: SerialNumberListQuery): Promise<PagedResponse<SerialNumberView>> {
    return this.serialNumbers.list(query);
  }

  /** 신규 생성이라 선택 If-Match는 형식만 공용 가드가 확인하고 자원 버전과 대조하지 않는다(통보 106). */
  @Post()
  @Contract('POST /trace/serial-numbers')
  async create(
    @Req() request: Request,
    @Body() body: SerialNumberBatchCreate,
  ): Promise<SerialNumberBatchResult> {
    const context = await serialNumberWriteContext(
      request,
      this.jwt,
      this.prisma,
    );
    return this.creates.create(body, {
      ...context,
      conflictCode: FAMILY_CONFLICT_CODE,
    });
  }
}
