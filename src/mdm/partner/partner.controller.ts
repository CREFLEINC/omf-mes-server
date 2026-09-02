import { Body, Controller, Get, Param, ParseIntPipe, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runVersioned } from '../../common/master-write';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { ControlUpdate, JudgmentTypeControlService } from './judgment-type-control.service';
import { PartnerQuery, PartnerService } from './partner.service';

/**
 * 거래처. ⛔ 본체는 ERP 수신 마스터라 읽기만 한다 — 고치는 것은 «역할»뿐이다.
 * 화면은 `W-06-06` 「거래처 역할」 탭이다.
 */
@Controller('mdm/partners')
export class PartnerController {
  constructor(
    private readonly partners: PartnerService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/partners')
  list(@Query() query: PartnerQuery): Promise<PagedResponse<unknown>> {
    return this.partners.list(query);
  }

  @Get(':partnerId')
  @Contract('GET /mdm/partners/{partnerId}')
  get(@Param('partnerId', ParseIntPipe) partnerId: number): Promise<unknown> {
    return this.partners.get(partnerId);
  }

  @Get(':partnerId/roles')
  @Contract('GET /mdm/partners/{partnerId}/roles')
  async listRoles(
    @Param('partnerId', ParseIntPipe) partnerId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { items, versionNo } = await this.partners.listRoles(partnerId);
    setEtag(response, versionNo);
    // ⛔ 이 자리는 래퍼가 없다 — 계약이 배열을 그대로 낸다.
    return items.map((roleTypeCode) => ({ roleTypeCode }));
  }

  @Put(':partnerId/roles')
  @Contract('PUT /mdm/partners/{partnerId}/roles')
  async replaceRoles(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('partnerId', ParseIntPipe) partnerId: number,
    @Body() body: { roleTypeCodes: string[] },
  ): Promise<unknown> {
    const items = await runVersioned<string[], 'items'>(
      this.idempotency,
      request,
      response,
      'items',
      (version) =>
        this.partners.replaceRoles(
          partnerId,
          version,
          body.roleTypeCodes,
          currentSession(request)?.userId,
        ),
    );
    return items.map((roleTypeCode) => ({ roleTypeCode }));
  }
}

/** 판정유형별 물류 통제. 화면은 `W-06-04` §4-B 다. */
@Controller('mdm/judgment-type-controls')
export class JudgmentTypeControlController {
  constructor(
    private readonly controls: JudgmentTypeControlService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/judgment-type-controls')
  async list(): Promise<unknown> {
    return { items: await this.controls.list() };
  }

  @Put(':codeValueId')
  @Contract('PUT /mdm/judgment-type-controls/{codeValueId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('codeValueId', ParseIntPipe) codeValueId: number,
    @Body() body: ControlUpdate,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'control', async (version) => {
      const control = await this.controls.update(codeValueId, version, body);
      return { control, versionNo: control.versionNo };
    });
  }
}
