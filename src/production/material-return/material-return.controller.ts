import {
  Body,
  Controller,
  Get,
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
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import type { PagedResponse } from '../../common/pagination';
import { MaterialReturnListQuery, MaterialReturnQueryService } from './material-return-query.service';
import { MaterialReturnView } from './material-return-view';
import { MaterialReturnCreate, MaterialReturnService } from './material-return.service';

/**
 * 자재 반출 조회 2건(PR ①) + 등록 1건(PR ③). 403 을 선언하는 것은 등록 하나이고 그 권한은
 * `manual-permissions.ts` 에 잠정 등록했다(소유 화면 미정 · 문의 050 · I-10 §4-1).
 * ⛔ `setEtag`·`ifMatchVersion`·`runVersioned` 를 부르지 않는다(I-10 §1-1·§6-2).
 * ⛔ 조회 둘은 403 미선언이라 권한 표를 손대지 않는다.
 */
@Controller('production/material-returns')
export class MaterialReturnController {
  constructor(
    private readonly queries: MaterialReturnQueryService,
    private readonly returns: MaterialReturnService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /production/material-returns')
  list(@Query() query: MaterialReturnListQuery): Promise<PagedResponse<MaterialReturnView>> {
    return this.queries.list(query);
  }

  @Get(':materialReturnId')
  @Contract('GET /production/material-returns/{materialReturnId}')
  detail(@Param('materialReturnId', ParseIntPipe) materialReturnId: number): Promise<MaterialReturnView> {
    return this.queries.detail(materialReturnId);
  }

  /**
   * 등록. ⛔ **ETag 를 안 내린다** — 계약 201 에 `headers` 가 없어 `runVersioned` 를 쓸 수 없다
   * (`shopfloor-receipt.controller.ts:63-74` 그대로). `If-Match` 는 「선택」이라 **받되 무시한다** —
   * 신규 생성이라 대조할 `version_no` 가 아직 없다. 400 도 내지 않는다.
   * `X-Worker-No` 는 계약 검증 가드가 안 보는 헤더라 서비스가 손으로 본다.
   */
  @Post()
  @Contract('POST /production/material-returns')
  create(@Req() request: Request, @Body() body: MaterialReturnCreate): Promise<MaterialReturnView> {
    const appUserId = userOf(request);
    const workerNo = request.headers['x-worker-no'];
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.returns.create(body, appUserId, typeof workerNo === 'string' ? workerNo : undefined),
    );
  }
}

function userOf(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new UnauthorizedException('세션이 없습니다.');
  return session.userId;
}
