import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentSession } from '../../auth/session-resolver.service';
import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { ifMatchVersion, setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import {
  NotificationSettingReplace,
  NotificationSettingService,
  NotificationSettingSummary,
  NotificationSettingView,
  RecipientCandidateQuery,
} from './notification-setting.service';

/**
 * 부서×이벤트 알림 설정(W-CO-11 · 장부 P-92). 행을 경로로 가른다 — 클라이언트 ETag 저장소가
 * 질의를 버리고 경로만 키로 쓰므로, 질의로 가르면 이벤트끼리 ETag 가 덮인다(research R-10).
 */
@Controller('app/notification-settings')
export class NotificationSettingController {
  constructor(
    private readonly settings: NotificationSettingService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /app/notification-settings')
  summary(@Query('departmentId') departmentId: number): Promise<NotificationSettingSummary> {
    return this.settings.summary(departmentId);
  }

  @Get('recipient-candidates')
  @Contract('GET /app/notification-settings/recipient-candidates')
  candidates(@Query() query: RecipientCandidateQuery): Promise<PagedResponse<unknown>> {
    return this.settings.candidates(query);
  }

  @Get(':departmentId/:eventCode')
  @Contract('GET /app/notification-settings/{departmentId}/{eventCode}')
  async detail(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Param('eventCode') eventCode: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<NotificationSettingView> {
    const { setting, versionNo } = await this.settings.detail(departmentId, eventCode);
    setEtag(response, versionNo);
    return setting;
  }

  @Put(':departmentId/:eventCode')
  @Contract('PUT /app/notification-settings/{departmentId}/{eventCode}')
  async replace(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Param('eventCode') eventCode: string,
    @Body() body: NotificationSettingReplace,
  ): Promise<NotificationSettingView> {
    const version = ifMatchVersion(request);
    if (version === undefined) throw new Error('If-Match 가 없는데 계약 가드를 지났다');
    const actorId = currentSession(request)?.userId;
    const { setting, versionNo } = await runIdempotent(this.idempotency, request, HttpStatus.OK, (tx) =>
      this.settings.replaceWithin(tx, departmentId, eventCode, version, body, actorId),
    );
    setEtag(response, versionNo);
    return setting;
  }
}
