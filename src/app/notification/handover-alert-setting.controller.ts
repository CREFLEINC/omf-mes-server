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
    return this.settings.summary(plantId, sessionUserId(request));
  }

  @Get(':plantId/:alertTypeCode')
  @Contract('GET /app/handover-alert-settings/{plantId}/{alertTypeCode}')
  async detail(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('plantId', ParseIntPipe) plantId: number,
    @Param('alertTypeCode') alertTypeCode: string,
  ): Promise<HandoverAlertSettingView> {
    const { setting, versionNo } = await this.settings.detail(plantId, alertTypeCode, sessionUserId(request));
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
    const actorId = sessionUserId(request);
    const { setting, versionNo } = await runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) =>
      this.settings.replaceWithin(tx, plantId, alertTypeCode, ifMatchVersion(request), body, actorId),
    );
    setEtag(response, versionNo);
    return setting;
  }
}

/** 세 경로 모두 계정 세션 전용이다(W-CO-14 권한 가드 뒤). */
function sessionUserId(request: Request): number {
  const session = currentSession(request);
  if (session === undefined) throw new Error('세션 없이 권한 가드를 지났다');
  return session.userId;
}
