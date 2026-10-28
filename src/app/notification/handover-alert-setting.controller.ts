import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import {
  HandoverAlertSettingReplace,
  HandoverAlertSettingService,
  HandoverAlertSettingSummary,
  HandoverAlertSettingView,
} from './handover-alert-setting.service';

/**
 * 공장 × 인계 작업 종류 알림 설정(W-CO-14 · 장부 P-134). 행을 경로로 가른다 — 클라이언트 ETag 저장소가
 * 경로만 키로 쓴다(W-CO-11 과 같은 이유).
 */
@Controller('app/handover-alert-settings')
export class HandoverAlertSettingController {
  constructor(
    private readonly settings: HandoverAlertSettingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/handover-alert-settings')
  summary(@Req() request: Request, @Query('plantId') plantId: number): Promise<HandoverAlertSettingSummary> {
    return this.settings.summary(plantId, currentSession(request)?.scopes ?? []);
  }

  @Get(':plantId/:alertTypeCode')
  @Contract('GET /app/handover-alert-settings/{plantId}/{alertTypeCode}')
  async detail(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('plantId', ParseIntPipe) plantId: number,
    @Param('alertTypeCode') alertTypeCode: string,
  ): Promise<HandoverAlertSettingView> {
    const { setting, versionNo } = await this.settings.detail(plantId, alertTypeCode, currentSession(request)?.scopes ?? []);
    setEtag(response, versionNo);
    return setting;
  }

  @Put(':plantId/:alertTypeCode')
  @Contract('PUT /app/handover-alert-settings/{plantId}/{alertTypeCode}')
  async replace(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('plantId', ParseIntPipe) plantId: number,
    @Param('alertTypeCode') alertTypeCode: string,
    @Body() body: HandoverAlertSettingReplace,
  ): Promise<HandoverAlertSettingView> {
    const session = currentSession(request);
    const { setting, versionNo } = await runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) =>
      this.settings.replaceWithin(
        tx,
        plantId,
        alertTypeCode,
        ifMatchVersion(request),
        body,
        session?.scopes ?? [],
        session?.userId,
      ),
    );
    setEtag(response, versionNo);
    return setting;
  }
}
