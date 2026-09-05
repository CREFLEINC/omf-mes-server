import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { EffectiveView } from './operation-policy-rules';
import {
  EffectiveQuery,
  OperationPolicyService,
  PolicyCreate,
  PolicyQuery,
  PolicyUpdate,
} from './operation-policy.service';

/** 운영 정책. 화면은 `W-05-01` 이 소유하고, 실행 화면들이 `effective` 로 값을 묻는다. */
@Controller('app/operation-policies')
export class OperationPolicyController {
  constructor(
    private readonly policies: OperationPolicyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/operation-policies')
  list(@Query() query: PolicyQuery): Promise<PagedResponse<unknown>> {
    return this.policies.list(query);
  }

  /**
   * ⛔ `:operationPolicyId` «앞»에 있어야 한다. Nest 는 선언 순서로 맞추므로 뒤에 두면
   * `effective` 가 식별자로 읽혀 400 이 된다.
   */
  @Get('effective')
  @Contract('GET /app/operation-policies/effective')
  effective(@Query() query: EffectiveQuery): Promise<EffectiveView> {
    return this.policies.effective(query);
  }

  @Get(':operationPolicyId')
  @Contract('GET /app/operation-policies/{operationPolicyId}')
  async get(
    @Param('operationPolicyId', ParseIntPipe) operationPolicyId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { policy, versionNo } = await this.policies.get(operationPolicyId);
    setEtag(response, versionNo);
    return policy;
  }

  @Post()
  @Contract('POST /app/operation-policies')
  create(@Req() request: Request, @Body() body: PolicyCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.policies.create(body),
    );
  }

  @Put(':operationPolicyId')
  @Contract('PUT /app/operation-policies/{operationPolicyId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('operationPolicyId', ParseIntPipe) operationPolicyId: number,
    @Body() body: PolicyUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'policy', (version) =>
      this.policies.update(operationPolicyId, version, body),
    );
  }
}
